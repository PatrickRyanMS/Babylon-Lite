/**
 * FBX blend-shape → Lite morph-target wiring (DYNAMIC-imported only when an FBX
 * actually declares blend shapes).
 *
 * `load-fbx.ts` collects one record per geometry it built ({@link FbxMorphRecord})
 * and, only when the file contains a BlendShape deformer, lazy-imports this module
 * and calls {@link applyFbxMorphTargets}. This module in turn dynamic-imports the
 * pure blend-shape extractor and the GPU morph-target factory, so a morph-free
 * FBX never pays a single byte for any of this code.
 *
 * Each geometry's sparse blend-shape deltas are expanded to dense per-vertex
 * delta arrays (capped at four targets — the engine's vec4-weight limit), uploaded
 * via `createMorphTargets`, and assigned to every Mesh built from that geometry
 * (multi-material splits share the same vertex order, so one delta set fits all).
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MorphTargetData } from "../animation/types.js";
import type { FBXObjectMap } from "./interpreter/connections.js";
import type { FBXGeometryData } from "./interpreter/geometry.js";
import type { FBXModelData } from "./interpreter/fbx-interpreter.js";
import type { FBXBlendShapeData } from "./interpreter/blend-shapes.js";
import { computeFBXGeometricDeltaMatrix, computeFBXGeometricNormalMatrix } from "./interpreter/transform.js";
import { buildFbxMorphTargets, FBX_MAX_MORPH_TARGETS } from "./fbx-morph-data.js";

/** A geometry's built meshes plus the source data needed to expand its blend shape. */
export interface FbxMorphRecord {
    /** Every Mesh built from this geometry (one per material range when split). */
    meshes: Mesh[];
    /** The geometry the meshes were built from. */
    geometry: FBXGeometryData;
    /** The model whose geometric transform was baked into the base vertices. */
    model: FBXModelData;
}

/**
 * One blend-shape channel's slice of a mesh's built morph-target array, plus the
 * crossfade inputs the FBX animation builder (Phase 7c) needs to turn a
 * `DeformPercent` curve into per-target weights.
 *
 * A channel contributes its shapes to consecutive morph-target slots starting at
 * {@link targetStart} (mirroring `buildFbxMorphTargets`' walk order), but the hard
 * 4-target engine cap may truncate it: {@link emittedShapeCount} is how many of
 * the channel's {@link fullShapeCount} shapes actually became targets. The
 * crossfade (`calculateBlendShapeInfluences`) is always evaluated against the FULL
 * shape set, then only the emitted slice is written.
 */
export interface FbxMorphAnimChannel {
    /** BlendShapeChannel Deformer ID the `DeformPercent` curve targets. */
    readonly channelId: number;
    /** First morph-target slot this channel contributes to. */
    readonly targetStart: number;
    /** Number of this channel's shapes that became morph targets (≤ cap remaining). */
    readonly emittedShapeCount: number;
    /** Total shapes on the channel (drives the crossfade weighting). */
    readonly fullShapeCount: number;
    /** In-between FullWeights (0-100), or null for a single-shape channel. */
    readonly fullWeights: number[] | null;
    /** Authored DeformPercent fallback when the channel has no animation curve at a time. */
    readonly defaultDeformPercent: number;
}

/**
 * Per-mesh morph-target animation handoff for Phase 7c. Links a morph-bearing
 * mesh's owning FBX model (→ animation node index) to its GPU weights buffer and
 * the channel→target-slot map needed to bake `PATH_WEIGHTS` samplers.
 */
export interface FbxMorphAnimBinding {
    /** FBX Model ID that owns the morph-bearing geometry (→ animation node index). */
    readonly modelId: number;
    /** The built GPU morph targets (source of the weights buffer + count). */
    readonly morphTargets: MorphTargetData;
    /** Number of emitted morph targets (≤ 4). */
    readonly targetCount: number;
    /** Per-channel target-slot map + crossfade inputs (walk order matches the build). */
    readonly channels: FbxMorphAnimChannel[];
}

/**
 * Build and assign Lite morph targets for every record whose geometry has a
 * matching blend shape. Truncation past the engine cap emits a single
 * `console.warn` and is recorded in `diagnostics`.
 *
 * @returns Per-mesh morph-target animation bindings (Phase 7c handoff) — one per
 *          morph-bearing mesh, carrying the GPU weights buffer + channel→slot map.
 */
export async function applyFbxMorphTargets(engine: EngineContext, objectMap: FBXObjectMap, records: FbxMorphRecord[], diagnostics: string[]): Promise<FbxMorphAnimBinding[]> {
    const { extractBlendShapes } = await import("./interpreter/blend-shapes.js");
    const blendShapes = extractBlendShapes(objectMap);
    if (blendShapes.length === 0) {
        return [];
    }

    const { createMorphTargets } = await import("../morph/create-morph-targets.js");

    // Last blend shape wins per geometry (FBX attaches at most one in practice).
    const blendShapeByGeometry = new Map<number, FBXBlendShapeData>();
    for (const bs of blendShapes) {
        blendShapeByGeometry.set(bs.geometryId, bs);
    }

    let warned = false;
    const animBindings: FbxMorphAnimBinding[] = [];

    for (const record of records) {
        const blendShape = blendShapeByGeometry.get(record.geometry.id);
        if (!blendShape || record.meshes.length === 0) {
            continue;
        }
        const controlPointIndices = record.geometry.controlPointIndices;
        if (!controlPointIndices) {
            continue;
        }

        const vertexCount = record.geometry.positions.length / 3;
        // Deltas live in the same baked space as the base vertices: positions get
        // the geometric delta (rotation+scale) matrix, normals the geometric
        // normal (inverse-scale·rotation) matrix.
        const deltaMatrix = computeFBXGeometricDeltaMatrix(record.model.geometricRotation, record.model.geometricScaling);
        const normalMatrix = computeFBXGeometricNormalMatrix(record.model.geometricRotation, record.model.geometricScaling);

        const built = buildFbxMorphTargets(blendShape, controlPointIndices, vertexCount, deltaMatrix, normalMatrix);
        if (built.targets.length === 0) {
            continue;
        }

        if (built.truncated && !warned) {
            warned = true;
            const message =
                `FBX blend shape on geometry "${record.geometry.name}" has ${blendShape.channels.length} channels; ` +
                `only the first ${FBX_MAX_MORPH_TARGETS} morph targets are applied (engine cap).`;
            console.warn(`[loadFbx] ${message}`);
            diagnostics.push(message);
        }

        // Build once per geometry and share across the (multi-material) split meshes
        // — they reference identical vertex IDs, so the same delta set applies.
        const morphTargets = createMorphTargets(engine, built.targets, vertexCount, built.weights);
        for (const mesh of record.meshes) {
            mesh.morphTargets = morphTargets;
        }

        // Map each channel to its morph-target slot range, replicating the exact
        // walk order of `buildFbxMorphTargets` so the animation builder can route a
        // `DeformPercent` curve to the right per-target weights. Stops at the cap.
        const channels: FbxMorphAnimChannel[] = [];
        let cursor = 0;
        for (const channel of blendShape.channels) {
            if (cursor >= FBX_MAX_MORPH_TARGETS) {
                break;
            }
            const emittedShapeCount = Math.min(channel.shapes.length, FBX_MAX_MORPH_TARGETS - cursor);
            if (emittedShapeCount <= 0) {
                continue;
            }
            channels.push({
                channelId: channel.id,
                targetStart: cursor,
                emittedShapeCount,
                fullShapeCount: channel.shapes.length,
                fullWeights: channel.fullWeights,
                defaultDeformPercent: channel.deformPercent,
            });
            cursor += emittedShapeCount;
        }

        animBindings.push({ modelId: record.model.id, morphTargets, targetCount: morphTargets.count, channels });
    }

    return animBindings;
}
