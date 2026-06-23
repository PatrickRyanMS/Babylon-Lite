import { describe, expect, it } from "vitest";

import {
    buildFbxSkinningBuffers,
    computeFbxBoneTextureData,
    computeFbxRestSkeletonData,
    FBX_MAX_BONE_INFLUENCES,
} from "../../../packages/babylon-lite/src/loader-fbx/fbx-skeleton-data.js";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity.js";
import { mat4Invert } from "../../../packages/babylon-lite/src/math/mat4-invert.js";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import type { FBXSkinData, FBXBoneData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/skeleton.js";
import type { FBXSkinBindingData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/rig.js";

// ─── Synthetic builders ─────────────────────────────────────────────────────

/** Column-major translation matrix as a 16-element Float64Array (FBX cluster
 *  matrices are Float64Array(16) used directly as Lite column-major Mat4). */
function translation(tx: number, ty: number, tz: number): Float64Array {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    return m;
}

/** A minimal skin carrying only the per-control-point weight data the buffer
 *  builder reads. `bones`/`meshBindPoseMatrix` are filled for the rest path. */
function makeSkin(opts: { boneIndices: number[][]; boneWeights: number[][]; bones?: FBXBoneData[]; meshBindPoseMatrix?: Float64Array | null }): FBXSkinData {
    return {
        id: 1,
        geometryId: 100,
        meshBindPoseMatrix: opts.meshBindPoseMatrix ?? null,
        bones: opts.bones ?? [],
        boneIndices: opts.boneIndices,
        boneWeights: opts.boneWeights,
        diagnostics: [],
    };
}

/** A per-skin binding with an explicit skin→rig bone remap. */
function makeBinding(skinBoneIndexToRigBoneIndex: number[]): FBXSkinBindingData {
    return {
        skinId: 1,
        geometryId: 100,
        rigId: "rig_test",
        skinBoneIndexToRigBoneIndex,
        clusterModelIds: new Set(),
    };
}

/** A bone with identity authored transform; overridable bind matrices. */
function makeBone(opts: {
    index: number;
    parentIndex: number;
    modelId?: number;
    name?: string;
    isCluster?: boolean;
    inheritType?: number;
    translation?: [number, number, number];
    transformLink?: Float64Array | null;
    bindPose?: Float64Array | null;
}): FBXBoneData {
    return {
        modelId: opts.modelId ?? 1000 + opts.index,
        name: opts.name ?? `Bone${opts.index}`,
        index: opts.index,
        parentIndex: opts.parentIndex,
        isCluster: opts.isCluster ?? true,
        translation: opts.translation ?? [0, 0, 0],
        rotation: [0, 0, 0],
        preRotation: [0, 0, 0],
        postRotation: [0, 0, 0],
        rotationPivot: [0, 0, 0],
        scalingPivot: [0, 0, 0],
        rotationOffset: [0, 0, 0],
        scalingOffset: [0, 0, 0],
        scale: [1, 1, 1],
        rotationOrder: 0,
        inheritType: opts.inheritType ?? 1,
        clusterMode: "Normalize",
        bindPoseMatrix: opts.bindPose ?? null,
        transformLinkMatrix: opts.transformLink ?? null,
        transformAssociateModelMatrix: null,
        modelBindPoseMatrix: null,
        diagnostics: [],
    };
}

/** Max abs deviation of bone `i`'s 4×4 block from the identity matrix. */
function identityDeviation(buf: Float32Array, boneIndex: number): number {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let max = 0;
    for (let k = 0; k < 16; k++) {
        max = Math.max(max, Math.abs(buf[boneIndex * 16 + k]! - identity[k]!));
    }
    return max;
}

/** Copy `src`'s 16 elements into `dst` at bone slot `i`. */
function writeMat(dst: Float32Array, i: number, src: Float64Array | Float32Array): void {
    for (let k = 0; k < 16; k++) {
        dst[i * 16 + k] = src[k]!;
    }
}

/** Assert a 4-weight slice matches expected values within Float32 precision. */
function expectWeights(actual: Float32Array, expected: number[]): void {
    for (let k = 0; k < expected.length; k++) {
        expect(actual[k]!).toBeCloseTo(expected[k]!, 6);
    }
}

// ─── Per-output-vertex weight expansion ─────────────────────────────────────

describe("fbx-skeleton-data — buildFbxSkinningBuffers per-vertex expansion", () => {
    it("expands each output vertex's top-4 joints/weights from its control point, sorted descending and normalized", () => {
        const skin = makeSkin({
            // cp0: already sorted, sums to 1. cp1: UNSORTED, sums to 1.
            boneIndices: [
                [0, 1, 2],
                [1, 2],
            ],
            boneWeights: [
                [0.5, 0.3, 0.2],
                [0.25, 0.75],
            ],
        });
        // Output vertices 0,2 → cp0; vertex 1 → cp1.
        const controlPointIndices = new Uint32Array([0, 1, 0]);

        const out = buildFbxSkinningBuffers(controlPointIndices, 3, skin);

        // 3 influences max, so no 8-bone spill.
        expect(out.numBoneInfluencers).toBe(3);
        expect(out.joints1).toBeNull();
        expect(out.weights1).toBeNull();
        expect(out.overInfluenced).toBe(false);

        // vertex 0 (cp0)
        expect(Array.from(out.joints.subarray(0, 4))).toEqual([0, 1, 2, 0]);
        expectWeights(out.weights.subarray(0, 4), [0.5, 0.3, 0.2, 0]);
        // vertex 1 (cp1): sorted desc → bone 2 (0.75) before bone 1 (0.25)
        expect(Array.from(out.joints.subarray(4, 8))).toEqual([2, 1, 0, 0]);
        expectWeights(out.weights.subarray(4, 8), [0.75, 0.25, 0, 0]);
        // vertex 2 (cp0) again
        expect(Array.from(out.joints.subarray(8, 12))).toEqual([0, 1, 2, 0]);
        expectWeights(out.weights.subarray(8, 12), [0.5, 0.3, 0.2, 0]);
    });

    it("normalizes weights that do not sum to 1", () => {
        const skin = makeSkin({ boneIndices: [[0, 1, 2]], boneWeights: [[2, 1, 1]] });
        const out = buildFbxSkinningBuffers(new Uint32Array([0]), 1, skin);
        // 2:1:1 → 0.5:0.25:0.25
        expect(out.weights[0]!).toBeCloseTo(0.5, 6);
        expect(out.weights[1]!).toBeCloseTo(0.25, 6);
        expect(out.weights[2]!).toBeCloseTo(0.25, 6);
        expect(out.weights[0]! + out.weights[1]! + out.weights[2]! + out.weights[3]!).toBeCloseTo(1, 6);
    });

    it("remaps skin-bone indices to rig-bone indices via the skin binding", () => {
        const skin = makeSkin({ boneIndices: [[0, 1, 2]], boneWeights: [[0.6, 0.3, 0.1]] });
        // skin bone 0→5, 1→6, 2→7
        const binding = makeBinding([5, 6, 7]);
        const out = buildFbxSkinningBuffers(new Uint32Array([0]), 1, skin, binding);
        expect(Array.from(out.joints.subarray(0, 4))).toEqual([5, 6, 7, 0]);
    });

    it("spills influences beyond 4 into joints1/weights1 for 8-bone skinning", () => {
        const skin = makeSkin({
            boneIndices: [[0, 1, 2, 3, 4, 5]],
            boneWeights: [[0.3, 0.25, 0.2, 0.1, 0.1, 0.05]],
        });
        const out = buildFbxSkinningBuffers(new Uint32Array([0]), 1, skin);

        expect(out.numBoneInfluencers).toBe(6);
        expect(out.joints1).not.toBeNull();
        expect(out.weights1).not.toBeNull();
        // Top 4 in the primary buffers.
        expect(Array.from(out.joints.subarray(0, 4))).toEqual([0, 1, 2, 3]);
        // Influences 5,6 spill into the first two slots of joints1.
        expect(Array.from(out.joints1!.subarray(0, 4))).toEqual([4, 5, 0, 0]);
        // All 8 weights sum to 1.
        let sum = 0;
        for (let k = 0; k < 4; k++) {
            sum += out.weights[k]! + out.weights1![k]!;
        }
        expect(sum).toBeCloseTo(1, 6);
    });

    it("flags overInfluenced and clamps to 8 when a control point has more than 8 influences", () => {
        const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
        const skin = makeSkin({ boneIndices: [indices], boneWeights: [weights] });

        const out = buildFbxSkinningBuffers(new Uint32Array([0]), 1, skin);

        expect(out.overInfluenced).toBe(true);
        expect(out.numBoneInfluencers).toBe(FBX_MAX_BONE_INFLUENCES); // 8 kept
        // Top 4 kept, then next 4; the two smallest (8,9) are dropped.
        expect(Array.from(out.joints.subarray(0, 4))).toEqual([0, 1, 2, 3]);
        expect(Array.from(out.joints1!.subarray(0, 4))).toEqual([4, 5, 6, 7]);
        // Kept-8 weights renormalize to 1 (sum of kept raw = 52).
        let sum = 0;
        for (let k = 0; k < 4; k++) {
            sum += out.weights[k]! + out.weights1![k]!;
        }
        expect(sum).toBeCloseTo(1, 6);
        expect(out.weights[0]!).toBeCloseTo(10 / 52, 6);
    });

    it("throws when a skin-bone index has no rig mapping (mirrors BJS)", () => {
        const skin = makeSkin({ boneIndices: [[0, 1]], boneWeights: [[0.5, 0.5]] });
        const binding = makeBinding([0, -1]); // skin bone 1 is absent from the rig
        expect(() => buildFbxSkinningBuffers(new Uint32Array([0]), 1, skin, binding)).toThrow(/missing rig bone mapping/);
    });
});

// ─── Rest bone-texture data ─────────────────────────────────────────────────

describe("fbx-skeleton-data — computeFbxBoneTextureData (inv(meshWorld)·absolute·IBM)", () => {
    it("yields identity per bone when the absolute is the bind (meshWorld = identity, IBM = inverse(jointWorld))", () => {
        // Feeding the BIND absolute (jointWorld) makes jointWorld·IBM cancel to identity
        // — this is the glTF / FBX-bind-pose case (mesh stays at its bind-posed vertices).
        const jointWorld = [translation(0, 1, 0) as unknown as Mat4, translation(3, -2, 5) as unknown as Mat4];
        const ibm = new Float32Array(jointWorld.length * 16);
        for (let i = 0; i < jointWorld.length; i++) {
            const inv = mat4Invert(jointWorld[i]!)!;
            writeMat(ibm, i, inv as unknown as Float32Array);
        }
        const boneData = computeFbxBoneTextureData(jointWorld, ibm, mat4Identity());

        expect(identityDeviation(boneData, 0)).toBeLessThan(1e-5);
        expect(identityDeviation(boneData, 1)).toBeLessThan(1e-5);
    });

    it("computes inverse(meshWorld)·absolute·IBM for a non-identity meshWorld", () => {
        // meshWorld = T(1,0,0), absolute = T(0,2,0), IBM = identity.
        // boneData = T(-1,0,0)·T(0,2,0) = T(-1,2,0).
        const absolute = [translation(0, 2, 0) as unknown as Mat4];
        const ibm = new Float32Array(16);
        writeMat(ibm, 0, mat4Identity() as unknown as Float32Array);
        const boneData = computeFbxBoneTextureData(absolute, ibm, translation(1, 0, 0) as unknown as Mat4);

        // Column-major translation lives in elements 12,13,14.
        expect(boneData[12]!).toBeCloseTo(-1, 5);
        expect(boneData[13]!).toBeCloseTo(2, 5);
        expect(boneData[14]!).toBeCloseTo(0, 5);
    });
});

describe("fbx-skeleton-data — computeFbxRestSkeletonData", () => {
    it("yields identity-per-bone boneData when the authored rest equals the cluster bind (no deformation — mirrors glTF)", () => {
        // Authored Lcl rest (per-bone translations) is propagated to absolutes
        // bone0 = T(0,1,0), bone1 = T(0,1,0)·T(0,1,0) = T(0,2,0). The cluster bind
        // (TransformLink) is set EQUAL to those absolutes, so authoredAbsolute == jointWorld
        // and the rest deformation D[i] = authoredAbsolute·inverse(jointWorld) is identity —
        // exactly the glTF / non-deforming FBX case where the mesh stays at its bind pose.
        const meshWorld = translation(1, 2, 3);
        const bone0 = makeBone({ index: 0, parentIndex: -1, translation: [0, 1, 0], transformLink: translation(0, 1, 0), bindPose: meshWorld });
        const bone1 = makeBone({ index: 1, parentIndex: 0, translation: [0, 1, 0], transformLink: translation(0, 2, 0), bindPose: meshWorld });
        const bones = [bone0, bone1];
        const skin = makeSkin({ boneIndices: [], boneWeights: [], bones });

        const rest = computeFbxRestSkeletonData(bones, skin);

        expect(rest.boneCount).toBe(2);
        // Authored rest == cluster bind ⇒ rest matrices collapse to identity per bone.
        expect(identityDeviation(rest.boneData, 0)).toBeLessThan(1e-5);
        expect(identityDeviation(rest.boneData, 1)).toBeLessThan(1e-5);
        // Topology handed to Phase 7b.
        expect(rest.boneParents).toEqual([-1, 0]);
        expect(rest.boneModelIds).toEqual([bone0.modelId, bone1.modelId]);
        expect(rest.inheritTypes).toEqual([1, 1]);
        expect(rest.inverseBindMatrices.length).toBe(2 * 16);
        expect(rest.jointRestWorld.length).toBe(2 * 16);
        expect(rest.boneRestLocals.length).toBe(2 * 16);
        // No unmodeled-bind diagnostics for this straightforward rig.
        expect(rest.diagnostics).toEqual([]);
    });

    it("poses the rest mesh into the authored absolute when the cluster bind differs (FBX bind ≠ rest)", () => {
        // This is the m09_skinning case: the FBX mesh control points are NOT pre-posed,
        // and the authored Lcl rest (bone0 = T(0,1,0), bone1 = T(0,2,0)) differs from the
        // cluster bind (TransformLink = identity, so the bones bind at the origin). With
        // meshWorld = identity and jointWorld = identity ⇒ IBM = identity, the rest
        // boneData = inv(meshWorld)·authoredAbsolute·IBM = authoredAbsolute: the rest pose
        // applies the authored bone transforms (NOT identity — the old buggy behavior that
        // rendered the mesh at its raw control points).
        const identityM = translation(0, 0, 0);
        const bone0 = makeBone({ index: 0, parentIndex: -1, translation: [0, 1, 0], transformLink: identityM, bindPose: identityM });
        const bone1 = makeBone({ index: 1, parentIndex: 0, translation: [0, 1, 0], transformLink: identityM, bindPose: identityM });
        const bones = [bone0, bone1];
        const skin = makeSkin({ boneIndices: [], boneWeights: [], bones });

        const rest = computeFbxRestSkeletonData(bones, skin);

        // boneData[i] == authoredAbsolute[i] (column-major translation at 12,13,14).
        expect(rest.boneData[0 * 16 + 12]!).toBeCloseTo(0, 5);
        expect(rest.boneData[0 * 16 + 13]!).toBeCloseTo(1, 5);
        expect(rest.boneData[0 * 16 + 14]!).toBeCloseTo(0, 5);
        expect(rest.boneData[1 * 16 + 12]!).toBeCloseTo(0, 5);
        expect(rest.boneData[1 * 16 + 13]!).toBeCloseTo(2, 5);
        expect(rest.boneData[1 * 16 + 14]!).toBeCloseTo(0, 5);
        // Explicitly NOT identity — the authored rest deformation is applied.
        expect(identityDeviation(rest.boneData, 0)).toBeGreaterThan(0.5);
        expect(identityDeviation(rest.boneData, 1)).toBeGreaterThan(0.5);
        // jointRestWorld / IBM still come from the cluster bind (Phase 7b handoff intact):
        // jointRestWorld[0] is the bind absolute (identity here), not the authored rest.
        expect(identityDeviation(rest.jointRestWorld, 0)).toBeLessThan(1e-5);
    });

    it("emits a diagnostic for inheritType=2 bones (scale-compensated)", () => {
        const identity = translation(0, 0, 0);
        const bone = makeBone({ index: 0, parentIndex: -1, inheritType: 2, transformLink: identity, bindPose: identity });
        const bones = [bone];
        const skin = makeSkin({ boneIndices: [], boneWeights: [], bones });

        const rest = computeFbxRestSkeletonData(bones, skin);

        expect(rest.diagnostics.some((d) => d.includes("inheritType=2"))).toBe(true);
    });
});
