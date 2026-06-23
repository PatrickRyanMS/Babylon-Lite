/**
 * FBX blend-shape → Lite morph-target delta expansion (PURE, no engine/GPU dependency).
 *
 * FBX `Shape` nodes store SPARSE per-CONTROL-POINT position deltas (`Vertices`
 * paired with `Indexes`, the control points each delta belongs to). The Lite
 * mesh produced by `fbx-mesh-data.ts` has one output vertex per polygon-vertex,
 * and `FBXGeometryData.controlPointIndices[i]` maps output vertex `i` back to its
 * original control point. This module expands the sparse deltas into the dense,
 * zero-filled `Float32Array` delta arrays the Lite morph system stores (the morph
 * shader adds `weight * delta` to the base attribute), baking the geometric delta
 * transform so the deltas live in the same space the base vertices were baked in.
 *
 * Unlike the BJS port (which emits absolute `base + delta` positions for
 * `MorphTarget.setPositions`), Lite morph targets are pure DELTAS, so unaffected
 * vertices stay zero.
 */

import { F32 } from "../engine/typed-arrays.js";
import type { Mat4, Mat4Storage } from "../math/types.js";
import type { FBXShapeData, FBXBlendShapeData } from "./interpreter/blend-shapes.js";

/** One Lite morph target: dense per-output-vertex position deltas (+ optional normal deltas). */
export interface FbxMorphTargetData {
    /** Position deltas `[x,y,z, …]`, length `vertexCount * 3`, zero where unaffected. */
    positions: Float32Array;
    /** Normal deltas `[x,y,z, …]`, or null when the shape carries no normal deltas. */
    normals: Float32Array | null;
}

/** Result of building every morph target for a single geometry's blend shape. */
export interface FbxBuiltMorphTargets {
    /** Dense per-target delta arrays, capped at `maxTargets`. */
    targets: FbxMorphTargetData[];
    /** Initial weight per emitted target (from DeformPercent / FullWeights). */
    weights: number[];
    /** True when more channels/shapes existed than the engine cap allowed. */
    truncated: boolean;
}

/** Hard engine cap: the Lite morph system supports at most four targets (vec4 weights). */
export const FBX_MAX_MORPH_TARGETS = 4;

/** Transform a delta DIRECTION by a column-major `Mat4`, ignoring the translation
 *  column (indices 12,13,14) — matching how `fbx-mesh-data.ts` bakes positions. */
function transformDelta(m: Mat4Storage, x: number, y: number, z: number, out: [number, number, number]): void {
    out[0] = m[0]! * x + m[4]! * y + m[8]! * z;
    out[1] = m[1]! * x + m[5]! * y + m[9]! * z;
    out[2] = m[2]! * x + m[6]! * y + m[10]! * z;
}

/**
 * Expand one sparse FBX `Shape` into a dense Lite morph target.
 *
 * @param shape               - Sparse shape (control-point indices + position/normal deltas).
 * @param controlPointIndices - Output-vertex → control-point map (`vertexCount` long).
 * @param vertexCount         - Number of output vertices (geometry.positions.length / 3).
 * @param deltaMatrix         - Geometric delta matrix applied to position deltas, or null for none.
 * @param normalMatrix        - Geometric normal matrix applied to normal deltas, or null for none.
 */
export function expandFbxMorphTarget(
    shape: FBXShapeData,
    controlPointIndices: Uint32Array,
    vertexCount: number,
    deltaMatrix: Mat4 | null,
    normalMatrix: Mat4 | null
): FbxMorphTargetData {
    const positions = new F32(vertexCount * 3);
    const hasNormals = shape.normals !== null;
    const normals = hasNormals ? new F32(vertexCount * 3) : null;

    // Sparse control-point → shape-row lookup.
    const cpToShapeIdx = new Map<number, number>();
    for (let i = 0; i < shape.indices.length; i++) {
        cpToShapeIdx.set(shape.indices[i]!, i);
    }

    const dm = deltaMatrix as unknown as Mat4Storage | null;
    const nm = normalMatrix as unknown as Mat4Storage | null;
    const out: [number, number, number] = [0, 0, 0];

    for (let vi = 0; vi < vertexCount; vi++) {
        const cpIdx = controlPointIndices[vi]!;
        const shapeIdx = cpToShapeIdx.get(cpIdx);
        if (shapeIdx === undefined) {
            continue;
        }

        let dx = shape.vertices[shapeIdx * 3]!;
        let dy = shape.vertices[shapeIdx * 3 + 1]!;
        let dz = shape.vertices[shapeIdx * 3 + 2]!;
        if (dm) {
            transformDelta(dm, dx, dy, dz, out);
            dx = out[0];
            dy = out[1];
            dz = out[2];
        }
        positions[vi * 3] = dx;
        positions[vi * 3 + 1] = dy;
        positions[vi * 3 + 2] = dz;

        if (normals && shape.normals) {
            let nx = shape.normals[shapeIdx * 3]!;
            let ny = shape.normals[shapeIdx * 3 + 1]!;
            let nz = shape.normals[shapeIdx * 3 + 2]!;
            if (nm) {
                transformDelta(nm, nx, ny, nz, out);
                nx = out[0];
                ny = out[1];
                nz = out[2];
                // Match BJS: normalize the transformed normal delta when non-degenerate.
                const len = Math.hypot(nx, ny, nz);
                if (len > 0) {
                    nx /= len;
                    ny /= len;
                    nz /= len;
                }
            }
            normals[vi * 3] = nx;
            normals[vi * 3 + 1] = ny;
            normals[vi * 3 + 2] = nz;
        }
    }

    return { positions, normals };
}

/**
 * Build every Lite morph target for one geometry's blend shape, applying the
 * hard 4-target engine cap. Channels are walked in order; each channel's shapes
 * become targets (in-between shapes included) until the cap is reached.
 *
 * @returns Dense delta arrays + initial weights, plus a `truncated` flag set when
 *          more targets existed than the cap allowed.
 */
export function buildFbxMorphTargets(
    blendShape: FBXBlendShapeData,
    controlPointIndices: Uint32Array,
    vertexCount: number,
    deltaMatrix: Mat4 | null,
    normalMatrix: Mat4 | null,
    maxTargets: number = FBX_MAX_MORPH_TARGETS
): FbxBuiltMorphTargets {
    const targets: FbxMorphTargetData[] = [];
    const weights: number[] = [];
    let truncated = false;

    for (const channel of blendShape.channels) {
        const influences = calculateBlendShapeInfluences(channel.deformPercent, channel.fullWeights, channel.shapes.length);
        for (let shapeIndex = 0; shapeIndex < channel.shapes.length; shapeIndex++) {
            const shape = channel.shapes[shapeIndex];
            if (!shape) {
                continue;
            }
            if (targets.length >= maxTargets) {
                truncated = true;
                return { targets, weights, truncated };
            }
            targets.push(expandFbxMorphTarget(shape, controlPointIndices, vertexCount, deltaMatrix, normalMatrix));
            weights.push(influences[shapeIndex] ?? 0);
        }
    }

    return { targets, weights, truncated };
}

/**
 * Convert an FBX channel DeformPercent (+ optional in-between FullWeights) into a
 * per-shape influence array. Faithful port of the BJS FBX loader crossfade logic.
 */
export function calculateBlendShapeInfluences(deformPercent: number, fullWeights: number[] | null, shapeCount: number): number[] {
    if (shapeCount <= 0) {
        return [];
    }
    if (!fullWeights || fullWeights.length !== shapeCount || shapeCount === 1) {
        const denominator = fullWeights?.[0] && fullWeights[0] !== 0 ? fullWeights[0] : 100;
        return [clamp01(deformPercent / denominator)];
    }

    const influences = new Array<number>(shapeCount).fill(0);
    if (deformPercent <= fullWeights[0]!) {
        influences[0] = fullWeights[0] === 0 ? (deformPercent <= 0 ? 1 : 0) : clamp01(deformPercent / fullWeights[0]!);
        return influences;
    }

    for (let i = 1; i < fullWeights.length; i++) {
        const previousWeight = fullWeights[i - 1]!;
        const nextWeight = fullWeights[i]!;
        if (deformPercent > nextWeight) {
            continue;
        }

        const range = nextWeight - previousWeight;
        if (Math.abs(range) < 1e-6) {
            influences[i] = 1;
            return influences;
        }

        const t = clamp01((deformPercent - previousWeight) / range);
        influences[i - 1] = 1 - t;
        influences[i] = t;
        return influences;
    }

    influences[shapeCount - 1] = 1;
    return influences;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
