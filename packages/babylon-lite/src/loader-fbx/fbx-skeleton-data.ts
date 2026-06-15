/**
 * FBX skinning data — PURE math, no engine, no GPU.
 *
 * Two responsibilities, both unit-tested directly (`fbx-skeleton-data.test.ts`):
 *
 *  1. Per-output-vertex weight expansion ({@link buildFbxSkinningBuffers}) — the
 *     Lite analogue of BJS `_buildSkinningData`. The FBX skin stores bone
 *     indices + weights per CONTROL POINT; the Lite mesh has one output vertex
 *     per polygon-vertex, mapped back to a control point by
 *     `FBXGeometryData.controlPointIndices`. Per output vertex we gather the
 *     control point's influences, remap each skin-bone index to its rig-bone
 *     index, sort by descending weight, keep the top 4 (next 4 spill to the
 *     8-bone JOINTS_1/WEIGHTS_1 buffers), and normalize.
 *
 *  2. Rest bone-texture data ({@link computeFbxBoneTextureData} /
 *     {@link computeFbxRestSkeletonData}) — mirrors the glTF `computeBoneTextureData`
 *     formula `boneData[i] = inverse(meshWorld) · jointWorld[i] · IBM[i]`. Using
 *     the FBX cluster convention (`Transform` = mesh bind global, `TransformLink`
 *     = bone bind global) with `jointWorld[i] = TransformLink[i]`,
 *     `meshWorld = Transform`, and `IBM[i] = inverse(TransformLink[i]) · Transform`,
 *     the rest matrix is identity per bone, so the mesh renders at its bind pose.
 *
 * Matrix note: the cluster matrices are `Float64Array(16)` in BJS row-major flat
 * order, which is byte-identical to Lite column-major flat order for the same
 * transform (see `fbx-mat4.ts`), so they are used directly as Lite `Mat4` with
 * `mat4Multiply` / `mat4Invert` — no transpose.
 */

import type { Mat4, Mat4Storage } from "../math/types.js";
import { mat4Multiply } from "../math/mat4-multiply.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { computeFBXLocalMatrix } from "./interpreter/transform.js";
import { fbxMatDecompose } from "./interpreter/fbx-mat4.js";
import type { FBXSkinData, FBXBoneData } from "./interpreter/skeleton.js";
import type { FBXSkinBindingData, FBXRigBoneData } from "./interpreter/rig.js";

/** Maximum bone influences per vertex retained (4 primary + 4 extra). */
export const FBX_MAX_BONE_INFLUENCES = 8;

/** Authored-vs-bind scale ratio above which BJS switches to a bind-rest pose.
 *  We only detect it here and emit a diagnostic — Phase 5 always uses the
 *  straightforward bind path (REST renders the undeformed mesh either way). */
export const FBX_BIND_REST_SCALE_RATIO_THRESHOLD = 10;

/** Per-output-vertex skinning attributes ready for `createSkeleton`. */
export interface FbxSkinningBuffers {
    /** Primary 4-bone indices, 4 per output vertex (rig-relative). */
    joints: Uint16Array;
    /** Primary 4-bone weights, 4 per output vertex. */
    weights: Float32Array;
    /** Extra 4-bone indices for 8-bone skinning, or null when ≤ 4 influences. */
    joints1: Uint16Array | null;
    /** Extra 4-bone weights for 8-bone skinning, or null when ≤ 4 influences. */
    weights1: Float32Array | null;
    /** Maximum influences used by any output vertex (1..8). */
    numBoneInfluencers: number;
    /** True when at least one control point had more than 8 influences (clamped). */
    overInfluenced: boolean;
}

/**
 * Build per-output-vertex joints/weights from a skin's per-control-point data.
 * Mirrors BJS `_buildSkinningData`. Throws if a skin-bone index has no rig
 * mapping (mirrors BJS).
 *
 * @param controlPointIndices - Output vertex → control point map (one per output vertex).
 * @param vertexCount - Number of output vertices (`positions.length / 3`).
 * @param skin - The skin whose `boneIndices`/`boneWeights` are per control point.
 * @param skinBinding - Optional skin→rig bone remap; identity remap when omitted.
 */
export function buildFbxSkinningBuffers(controlPointIndices: Uint32Array, vertexCount: number, skin: FBXSkinData, skinBinding?: FBXSkinBindingData): FbxSkinningBuffers {
    // Precompute, once per control point: remap skin-bone → rig-bone, sort by
    // descending weight, clamp to 8 (flagging over-influence), and normalize.
    const cpCount = skin.boneIndices.length;
    const cpIndices: Int32Array[] = new Array(cpCount);
    const cpWeights: Float32Array[] = new Array(cpCount);
    let overInfluenced = false;

    for (let cp = 0; cp < cpCount; cp++) {
        const rawIndices = skin.boneIndices[cp] ?? [];
        const rawWeights = skin.boneWeights[cp] ?? [];
        const pairs: { index: number; weight: number }[] = [];
        for (let k = 0; k < rawIndices.length; k++) {
            const skinBoneIndex = rawIndices[k]!;
            const rigBoneIndex = skinBinding ? skinBinding.skinBoneIndexToRigBoneIndex[skinBoneIndex] : skinBoneIndex;
            if (rigBoneIndex === undefined || rigBoneIndex < 0) {
                throw new Error(`FBX skinning: missing rig bone mapping for skin bone index ${skinBoneIndex}`);
            }
            pairs.push({ index: rigBoneIndex, weight: rawWeights[k] ?? 0 });
        }
        pairs.sort((a, b) => b.weight - a.weight);
        if (pairs.length > FBX_MAX_BONE_INFLUENCES) {
            overInfluenced = true;
            pairs.length = FBX_MAX_BONE_INFLUENCES;
        }

        let sum = 0;
        for (let k = 0; k < pairs.length; k++) {
            sum += pairs[k]!.weight;
        }
        const idx = new Int32Array(pairs.length);
        const wt = new Float32Array(pairs.length);
        for (let k = 0; k < pairs.length; k++) {
            idx[k] = pairs[k]!.index;
            wt[k] = sum > 0 ? pairs[k]!.weight / sum : pairs[k]!.weight;
        }
        cpIndices[cp] = idx;
        cpWeights[cp] = wt;
    }

    // Maximum influences across the referenced output vertices decides whether
    // the extra 8-bone buffers are needed.
    let numBoneInfluencers = 0;
    for (let i = 0; i < vertexCount; i++) {
        const cp = controlPointIndices[i]!;
        const n = cpIndices[cp]?.length ?? 0;
        if (n > numBoneInfluencers) {
            numBoneInfluencers = n;
        }
    }

    const joints = new Uint16Array(vertexCount * 4);
    const weights = new Float32Array(vertexCount * 4);
    let joints1: Uint16Array | null = null;
    let weights1: Float32Array | null = null;
    if (numBoneInfluencers > 4) {
        joints1 = new Uint16Array(vertexCount * 4);
        weights1 = new Float32Array(vertexCount * 4);
    }

    for (let i = 0; i < vertexCount; i++) {
        const cp = controlPointIndices[i]!;
        const idx = cpIndices[cp];
        const wt = cpWeights[cp];
        if (!idx || !wt) {
            continue;
        }
        const count = Math.min(idx.length, FBX_MAX_BONE_INFLUENCES);
        for (let j = 0; j < count; j++) {
            const base = i * 4 + (j % 4);
            if (j < 4) {
                joints[base] = idx[j]!;
                weights[base] = wt[j]!;
            } else if (joints1 && weights1) {
                joints1[base] = idx[j]!;
                weights1[base] = wt[j]!;
            }
        }
    }

    return { joints, weights, joints1, weights1, numBoneInfluencers: Math.max(numBoneInfluencers, 1), overInfluenced };
}

/**
 * Rest bone-texture data: `boneData[i] = inverse(meshWorld) · jointWorld[i] · IBM[i]`.
 * Mirrors the glTF `computeBoneTextureData`; identity per bone at bind pose.
 *
 * @param jointWorldMatrices - Bone world matrices at rest (one `Mat4` per bone).
 * @param inverseBindMatrices - Flat IBM buffer (16 floats per bone).
 * @param meshWorld - Mesh bind-global matrix (FBX cluster `Transform`).
 */
export function computeFbxBoneTextureData(jointWorldMatrices: readonly Mat4[], inverseBindMatrices: Float32Array, meshWorld: Mat4): Float32Array {
    const numBones = jointWorldMatrices.length;
    const data = new Float32Array(numBones * 16);
    const invMeshWorld = mat4Invert(meshWorld) ?? mat4Identity();
    for (let i = 0; i < numBones; i++) {
        const tmp = mat4Multiply(invMeshWorld, jointWorldMatrices[i]!);
        const ibm = inverseBindMatrices.subarray(i * 16, i * 16 + 16) as unknown as Mat4;
        const bone = mat4Multiply(tmp, ibm);
        data.set(bone as unknown as Float32Array, i * 16);
    }
    return data;
}

/** Resolved rest skeleton data for one skinned mesh — feeds `createSkeleton` and
 *  the Phase 7b animation handoff. All matrix buffers are 16 floats per bone. */
export interface FbxRestSkeletonData {
    /** Number of bones in the rig. */
    boneCount: number;
    /** Bone-texture matrices (identity per bone at rest). */
    boneData: Float32Array;
    /** Inverse-bind matrices: mesh-local → bone-local at bind. */
    inverseBindMatrices: Float32Array;
    /** Bone absolute (world) matrices at the bind pose. */
    jointRestWorld: Float32Array;
    /** Bone rest local matrices (authored Lcl transform per bone). */
    boneRestLocals: Float32Array;
    /** Parent bone index per bone (-1 for root). */
    boneParents: number[];
    /** FBX Model ID per bone (links to animation curves in Phase 7b). */
    boneModelIds: number[];
    /** Bone names. */
    boneNames: string[];
    /** FBX inherit-type per bone (0=RrSs, 1=RSrs, 2=Rrs). */
    inheritTypes: number[];
    /** Mesh bind-global matrix (FBX cluster `Transform`). */
    meshWorld: Mat4;
    /** Inverse of {@link meshWorld}. */
    invMeshWorld: Mat4;
    /** Recoverable diagnostics (inherit-type 2, bind-vs-rest mismatch, …). */
    diagnostics: string[];
}

/**
 * Resolve the rest skeleton data for one skinned mesh from its rig bones + skin.
 * Produces identity-per-bone `boneData` at the bind pose, the IBMs and rest
 * locals Phase 7b needs, and diagnostics for the cases Phase 5 does not yet
 * model (inherit-type 2 scale compensation, severe bind-vs-rest scale mismatch).
 *
 * @param rigBones - The merged rig bones (parents before children).
 * @param skin - The skin bound to this mesh (source of the mesh bind global).
 */
export function computeFbxRestSkeletonData(rigBones: readonly FBXRigBoneData[], skin: FBXSkinData): FbxRestSkeletonData {
    const n = rigBones.length;
    const identity = mat4Identity();
    const diagnostics: string[] = [];

    // Mesh bind global (FBX cluster `Transform`): all clusters in a skin share it.
    const meshWorld = pickMeshBindGlobal(skin) ?? mat4Identity();
    const invMeshWorld = mat4Invert(meshWorld) ?? mat4Identity();

    // Rest local matrices (authored Lcl) — also the absolute-bind fallback source.
    const restLocals: Mat4[] = rigBones.map((bone) => computeFBXLocalMatrix(bone));
    const authoredAbsolute: Mat4[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const parent = rigBones[i]!.parentIndex;
        authoredAbsolute[i] = parent < 0 ? restLocals[i]! : mat4Multiply(authoredAbsolute[parent]!, restLocals[i]!);
    }

    // Bone absolute bind world: prefer the cluster TransformLink, then the
    // BindPose model matrix, then the authored absolute (mirrors BJS).
    const jointWorld: Mat4[] = rigBones.map((bone, i) => {
        const link = bone.transformLinkMatrix ?? bone.modelBindPoseMatrix;
        return link ? (link as unknown as Mat4) : authoredAbsolute[i]!;
    });

    // IBM[i] = inverse(jointWorld[i]) · meshWorld (mesh-local → bone-local at bind).
    const inverseBindMatrices = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) {
        const ibm = mat4Multiply(mat4Invert(jointWorld[i]!) ?? identity, meshWorld);
        inverseBindMatrices.set(ibm as unknown as Float32Array, i * 16);
    }

    const boneData = computeFbxBoneTextureData(jointWorld, inverseBindMatrices, meshWorld);

    // Flatten joint world + rest local matrices for the Phase 7b handoff.
    const jointRestWorld = packMat4Array(jointWorld);
    const boneRestLocals = packMat4Array(restLocals);

    const boneParents = rigBones.map((bone) => bone.parentIndex);
    const boneModelIds = rigBones.map((bone) => bone.modelId);
    const boneNames = rigBones.map((bone) => bone.name);
    const inheritTypes = rigBones.map((bone) => bone.inheritType);

    detectUnmodeledBindCases(rigBones, restLocals, jointWorld, diagnostics);

    return {
        boneCount: n,
        boneData,
        inverseBindMatrices,
        jointRestWorld,
        boneRestLocals,
        boneParents,
        boneModelIds,
        boneNames,
        inheritTypes,
        meshWorld,
        invMeshWorld,
        diagnostics,
    };
}

/** Pick a skin's mesh bind-global matrix: a cluster `Transform`, else the
 *  BindPose mesh matrix. Returns null when neither is present. */
function pickMeshBindGlobal(skin: FBXSkinData): Mat4 | null {
    for (const bone of skin.bones) {
        if (bone.isCluster && bone.bindPoseMatrix) {
            return bone.bindPoseMatrix as unknown as Mat4;
        }
    }
    return skin.meshBindPoseMatrix ? (skin.meshBindPoseMatrix as unknown as Mat4) : null;
}

/** Flatten a list of Mat4 into one Float32Array (16 floats per matrix). */
function packMat4Array(mats: readonly Mat4[]): Float32Array {
    const out = new Float32Array(mats.length * 16);
    for (let i = 0; i < mats.length; i++) {
        const m = mats[i]! as unknown as Mat4Storage;
        for (let k = 0; k < 16; k++) {
            out[i * 16 + k] = m[k]!;
        }
    }
    return out;
}

/** Detect the bind cases Phase 5 does not yet model and record a diagnostic.
 *  Phase 5 always uses the straightforward bind path (REST = undeformed mesh). */
function detectUnmodeledBindCases(rigBones: readonly FBXBoneData[], restLocals: readonly Mat4[], jointWorld: readonly Mat4[], diagnostics: string[]): void {
    if (rigBones.some((bone) => bone.inheritType === 2)) {
        diagnostics.push("FBX skeleton has inheritType=2 (scale-compensated) bones; Phase 5 uses the straightforward bind path (no per-frame scale compensation).");
    }

    // Bind-vs-rest scale ratio: localBind[i] = inverse(absBind[parent]) · absBind[i].
    let maxRatio = 0;
    for (let i = 0; i < rigBones.length; i++) {
        if (!rigBones[i]!.isCluster) {
            continue;
        }
        const parent = rigBones[i]!.parentIndex;
        const localBind = parent < 0 ? jointWorld[i]! : mat4Multiply(mat4Invert(jointWorld[parent]!) ?? mat4Identity(), jointWorld[i]!);
        const authoredScale = fbxMatDecompose(restLocals[i]!).s;
        const bindScale = fbxMatDecompose(localBind).s;
        maxRatio = Math.max(maxRatio, scaleRatio(authoredScale[0], bindScale[0]), scaleRatio(authoredScale[1], bindScale[1]), scaleRatio(authoredScale[2], bindScale[2]));
    }
    if (maxRatio >= FBX_BIND_REST_SCALE_RATIO_THRESHOLD) {
        diagnostics.push(
            `FBX skeleton has a severe bind-vs-rest scale mismatch (ratio ${maxRatio.toFixed(1)} ≥ ${FBX_BIND_REST_SCALE_RATIO_THRESHOLD}); ` +
                `Phase 5 uses the straightforward bind path (animation curves may need bind-rest remapping in a later phase).`
        );
    }
}

function scaleRatio(a: number, b: number): number {
    const absA = Math.abs(a);
    const absB = Math.abs(b);
    if (absA < 1e-6 || absB < 1e-6) {
        return absA < 1e-6 && absB < 1e-6 ? 1 : Number.POSITIVE_INFINITY;
    }
    return Math.max(absA / absB, absB / absA);
}
