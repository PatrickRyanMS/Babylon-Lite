/**
 * FBX skin → Lite skeleton wiring (DYNAMIC-imported only when an FBX actually
 * declares a skin deformer).
 *
 * `load-fbx.ts` reuses the same per-geometry records it collects for morph
 * targets ({@link FbxSkinRecord}) and, only when the file contains a Skin/Cluster
 * deformer, lazy-imports this module and calls {@link applyFbxSkeletons}. This
 * module in turn dynamic-imports the pure skin/rig interpreter passes and the GPU
 * skeleton factory, so a skin-free FBX never pays a single byte for any of this.
 *
 * For each skinned geometry it:
 *   1. expands the skin's per-control-point weights to per-output-vertex
 *      joints/weights (rig-relative bone indices), via `fbx-skeleton-data.ts`;
 *   2. computes the rest bone-texture data (poses the mesh into its authored bind/rest pose);
 *   3. uploads them with `createSkeleton` and assigns `mesh.skeleton` to every
 *      Mesh built from that geometry (multi-material splits share vertex order);
 *   4. returns an {@link FbxSkeletonBinding} per skinned mesh — a superset of the
 *      engine's {@link SkeletonBinding} carrying the extra rig data the FBX
 *      animation builder (Phase 7b) needs to drive bones per frame.
 *
 * Visual skinning is out of scope here (Standard-pipeline skeleton rendering is
 * wired in a later phase); m09 therefore renders at its REST/bind pose. This
 * module gets the DATA correct.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Mat4 } from "../math/types.js";
import type { SkeletonBinding } from "../animation/types.js";
import type { FBXObjectMap } from "./interpreter/connections.js";
import type { FBXGeometryData } from "./interpreter/geometry.js";
import type { FBXModelData } from "./interpreter/fbx-interpreter.js";
import type { FBXSkinData } from "./interpreter/skeleton.js";
import type { FBXRigData, FBXSkinBindingData } from "./interpreter/rig.js";
import { buildFbxSkinningBuffers, computeFbxRestSkeletonData, FBX_MAX_BONE_INFLUENCES } from "./fbx-skeleton-data.js";
import { enableStandardSkeleton } from "../material/standard/enable-standard-mesh-features.js";

/** A geometry's built meshes plus the source data the skeleton pass needs.
 *  Structurally identical to `load-fbx.ts`'s `FbxMorphRecord`, so the loader can
 *  pass the very same record array it already collected for morph targets. */
export interface FbxSkinRecord {
    /** Every Mesh built from this geometry (one per material range when split). */
    meshes: Mesh[];
    /** The geometry the meshes were built from. */
    geometry: FBXGeometryData;
    /** The model the geometry belongs to. */
    model: FBXModelData;
}

/**
 * Skeleton binding handed off to the FBX animation builder (Phase 7b).
 *
 * Superset of the engine's {@link SkeletonBinding} (so the same per-frame upload
 * path can consume it) plus the extra rig topology Phase 7b needs to rebuild the
 * bone node array and animate it: the bind-time mesh world, per-bone parent
 * links, rest local matrices, FBX Model IDs (to bind animation curves), bone
 * names and inherit-types.
 *
 * `jointNodes` is the identity map `[0..boneCount-1]` into this rig's own bone
 * array (Phase 7b reconstructs that array from `boneModelIds`/`boneParents`/
 * `boneRestLocals`), unlike glTF where `jointNodes` indexes a flat scene-node
 * list.
 */
export interface FbxSkeletonBinding extends SkeletonBinding {
    /** Mesh bind-global matrix (FBX cluster `Transform`). */
    readonly meshWorld: Mat4;
    /** Bone absolute (world) matrices at the bind pose (16 floats per bone). */
    readonly jointRestWorld: Float32Array;
    /** Bone rest local matrices, authored Lcl transform (16 floats per bone). */
    readonly boneRestLocals: Float32Array;
    /** Parent bone index per bone (-1 for root). */
    readonly boneParents: readonly number[];
    /** FBX Model ID per bone (links each bone to its animation curves). */
    readonly boneModelIds: readonly number[];
    /** Bone names. */
    readonly boneNames: readonly string[];
    /** FBX inherit-type per bone (0=RrSs, 1=RSrs, 2=Rrs). */
    readonly inheritTypes: readonly number[];
    /** Geometry ID the skinned mesh was built from. */
    readonly geometryId: number;
    /** Stable rig ID this binding belongs to. */
    readonly rigId: string;
}

/**
 * Build and assign Lite skeletons for every record whose geometry carries a skin,
 * and return the per-mesh {@link FbxSkeletonBinding} handoff for Phase 7b.
 *
 * @param engine - Engine context (provides the GPUDevice for the bone texture).
 * @param objectMap - Resolved FBX object table.
 * @param records - Per-geometry built meshes (reused from the morph pass).
 * @param diagnostics - Sink for recoverable warnings (also `console.warn`-ed).
 */
export async function applyFbxSkeletons(engine: EngineContext, objectMap: FBXObjectMap, records: FbxSkinRecord[], diagnostics: string[]): Promise<FbxSkeletonBinding[]> {
    const { extractSkins } = await import("./interpreter/skeleton.js");
    const skins = extractSkins(objectMap);
    if (skins.length === 0) {
        return [];
    }

    const { resolveRigs } = await import("./interpreter/rig.js");
    const rigs = resolveRigs(objectMap, skins);

    const { createSkeleton } = await import("../skeleton/create-skeleton.js");
    // Skinned meshes present → opt the Standard material into skeletal skinning (installs the
    // dispatch + folds the feature in; net-neutral for scenes that never load skinned meshes).
    enableStandardSkeleton();

    // Map each skin to its resolved rig + per-skin binding, and each geometry to
    // its skin (skins attach to geometries by geometry ID).
    const rigBySkinId = new Map<number, { rig: FBXRigData; binding: FBXSkinBindingData }>();
    for (const rig of rigs) {
        for (const warning of rig.warnings) {
            emit(diagnostics, `Rig ${rig.id}: ${warning}`);
        }
        for (const binding of rig.skinBindings) {
            rigBySkinId.set(binding.skinId, { rig, binding });
        }
    }
    const skinByGeometryId = new Map<number, FBXSkinData>();
    for (const skin of skins) {
        skinByGeometryId.set(skin.geometryId, skin);
    }

    const bindings: FbxSkeletonBinding[] = [];
    let overInfluencedWarned = false;

    for (const record of records) {
        const skin = skinByGeometryId.get(record.geometry.id);
        if (!skin || record.meshes.length === 0) {
            continue;
        }
        const controlPointIndices = record.geometry.controlPointIndices;
        if (!controlPointIndices) {
            continue;
        }
        const resolved = rigBySkinId.get(skin.id);
        if (!resolved) {
            continue;
        }
        const { rig, binding } = resolved;

        // Rest skeleton data (authored bind/rest-pose boneData) + Phase 7b topology.
        const rest = computeFbxRestSkeletonData(rig.bones, skin);
        for (const message of rest.diagnostics) {
            emit(diagnostics, message);
        }

        // Per-output-vertex joints/weights (rig-relative bone indices).
        const vertexCount = record.geometry.positions.length / 3;
        const buffers = buildFbxSkinningBuffers(controlPointIndices, vertexCount, skin, binding);
        if (buffers.overInfluenced && !overInfluencedWarned) {
            overInfluencedWarned = true;
            emit(
                diagnostics,
                `FBX skin on geometry "${record.geometry.name}" has a control point with more than ${FBX_MAX_BONE_INFLUENCES} influences; extra influences were dropped.`
            );
        }

        // Build once per geometry; share across the (multi-material) split meshes —
        // they reference identical vertex IDs, so the same skinning data applies.
        const skeleton = createSkeleton(engine, buffers.joints, buffers.weights, rest.boneCount, rest.boneData, buffers.joints1, buffers.weights1);
        for (const mesh of record.meshes) {
            mesh.skeleton = skeleton;
        }

        bindings.push({
            jointNodes: rest.boneParents.map((_, i) => i),
            inverseBindMatrices: rest.inverseBindMatrices,
            invMeshWorld: rest.invMeshWorld,
            boneTexture: skeleton.boneTexture,
            boneCount: rest.boneCount,
            boneMatrices: skeleton.boneMatrices,
            runtimeSkeleton: skeleton,
            meshWorld: rest.meshWorld,
            jointRestWorld: rest.jointRestWorld,
            boneRestLocals: rest.boneRestLocals,
            boneParents: rest.boneParents,
            boneModelIds: rest.boneModelIds,
            boneNames: rest.boneNames,
            inheritTypes: rest.inheritTypes,
            geometryId: record.geometry.id,
            rigId: rig.id,
        });
    }

    return bindings;
}

/** Record a diagnostic and surface it on the console (mirrors the morph path). */
function emit(diagnostics: string[], message: string): void {
    console.warn(`[loadFbx] ${message}`);
    diagnostics.push(message);
}
