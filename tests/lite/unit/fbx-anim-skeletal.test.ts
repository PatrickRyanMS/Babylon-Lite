import { describe, expect, it } from "vitest";

import type { FBXModelData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/fbx-interpreter.js";
import type { FBXAnimationStackData, FBXCurveNodeData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/animation.js";
import type { FbxAnimatedModel } from "../../../packages/babylon-lite/src/loader-fbx/fbx-animation-build.js";
import { buildFbxAnimationData } from "../../../packages/babylon-lite/src/loader-fbx/fbx-animation-build.js";
import type { FbxSkeletonBinding } from "../../../packages/babylon-lite/src/loader-fbx/fbx-skeleton-build.js";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node.js";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity.js";
import { PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE } from "../../../packages/babylon-lite/src/animation/types.js";

/** Build a fully-formed FBXModelData with identity transform (override as needed). */
function makeModel(id: number, geometryId?: number): FBXModelData {
    return {
        id,
        name: `model_${id}`,
        subType: geometryId !== undefined ? "Mesh" : "LimbNode",
        geometry: geometryId !== undefined ? ({ id: geometryId } as NonNullable<FBXModelData["geometry"]>) : undefined,
        materials: [],
        children: [],
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        preRotation: [0, 0, 0],
        postRotation: [0, 0, 0],
        rotationPivot: [0, 0, 0],
        scalingPivot: [0, 0, 0],
        rotationOffset: [0, 0, 0],
        scalingOffset: [0, 0, 0],
        geometricTranslation: [0, 0, 0],
        geometricRotation: [0, 0, 0],
        geometricScaling: [1, 1, 1],
        rotationOrder: 0,
        inheritType: 0,
        cullingOff: false,
        diagnostics: [],
    };
}

/** A model node entry as produced by load-fbx. */
function modelNode(model: FBXModelData, parentIndex: number): FbxAnimatedModel {
    return { model, node: createSceneNode(model.name), parentIndex };
}

/** A single-axis linear T/R/S curve node targeting a model. */
function trsCurveNode(type: "T" | "R" | "S", targetModelId: number, axis: "d|X" | "d|Y" | "d|Z", from: number, to: number): FBXCurveNodeData {
    return {
        type,
        targetModelId,
        curves: [
            {
                channel: axis,
                keys: [
                    { time: 0, value: from, interpolation: "linear" },
                    { time: 1, value: to, interpolation: "linear" },
                ],
            },
        ],
    };
}

function stack(name: string, curveNodes: FBXCurveNodeData[], duration = 1): FBXAnimationStackData {
    return { name, startTime: 0, stopTime: duration, duration, curveNodes, layers: [], unsupportedCurveNodes: [], diagnostics: [] };
}

/** A stub skeleton handoff. Matrices are never read by buildFbxAnimationData
 *  (it only stores references), so identity/zero buffers are fine. */
function makeSkeletonBinding(boneModelIds: number[], geometryId: number, rigId = "rig0"): FbxSkeletonBinding {
    const boneCount = boneModelIds.length;
    return {
        // Rig-relative identity: the builder must remap these to model-node indices.
        jointNodes: boneModelIds.map((_, i) => i),
        inverseBindMatrices: new Float32Array(boneCount * 16),
        invMeshWorld: mat4Identity(),
        boneTexture: {} as GPUTexture,
        boneCount,
        boneMatrices: new Float32Array(boneCount * 16),
        meshWorld: mat4Identity(),
        jointRestWorld: new Float32Array(boneCount * 16),
        boneRestLocals: new Float32Array(boneCount * 16),
        boneParents: boneModelIds.map((_, i) => i - 1),
        boneModelIds,
        boneNames: boneModelIds.map((id) => `bone_${id}`),
        inheritTypes: boneModelIds.map(() => 0),
        geometryId,
        rigId,
    };
}

describe("buildFbxAnimationData — skeletal (bone) animation", () => {
    // Scene: skinned mesh (model 10, geometry 100) at node 0; two bones
    // (models 20, 21) at nodes 1, 2. The animation drives the bones.
    const MESH_ID = 10;
    const GEO_ID = 100;
    const BONE0_ID = 20;
    const BONE1_ID = 21;

    function buildScene(): { modelNodes: FbxAnimatedModel[]; modelIdToIndex: Map<number, number> } {
        const modelNodes: FbxAnimatedModel[] = [
            modelNode(makeModel(MESH_ID, GEO_ID), -1), // 0: skinned mesh (root)
            modelNode(makeModel(BONE0_ID), 0), // 1: bone 0 (child of mesh)
            modelNode(makeModel(BONE1_ID), 1), // 2: bone 1 (child of bone 0)
        ];
        const modelIdToIndex = new Map<number, number>([
            [MESH_ID, 0],
            [BONE0_ID, 1],
            [BONE1_ID, 2],
        ]);
        return { modelNodes, modelIdToIndex };
    }

    function boneCurves(): FBXCurveNodeData[] {
        return [trsCurveNode("T", BONE0_ID, "d|X", 0, 5), trsCurveNode("R", BONE0_ID, "d|Z", 0, 90), trsCurveNode("T", BONE1_ID, "d|Y", 0, 3)];
    }

    it("emits TRS channels targeting the bone node indices (not the rig-relative indices)", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        const binding = makeSkeletonBinding([BONE0_ID, BONE1_ID], GEO_ID);
        const data = buildFbxAnimationData([stack("Take 001", boneCurves())], modelNodes, modelIdToIndex, [binding], []);

        expect(data).not.toBeNull();
        const clip = data!.clips[0]!;

        const transformPaths = new Set([PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE]);
        const trsChannels = clip.channels.filter((ch) => transformPaths.has(ch.path));
        // All transform channels must target bone node indices (1 = bone0, 2 = bone1).
        expect(trsChannels.length).toBeGreaterThan(0);
        for (const ch of trsChannels) {
            expect([1, 2]).toContain(ch.nodeIdx);
        }

        // Bone 0 was given T(d|X) and R(d|Z) → at least a translation and rotation channel on node 1.
        const bone0Paths = trsChannels.filter((ch) => ch.nodeIdx === 1).map((ch) => ch.path);
        expect(bone0Paths).toContain(PATH_TRANSLATION);
        expect(bone0Paths).toContain(PATH_ROTATION);
        // Bone 1 was given T(d|Y) → a translation channel on node 2.
        const bone1Paths = trsChannels.filter((ch) => ch.nodeIdx === 2).map((ch) => ch.path);
        expect(bone1Paths).toContain(PATH_TRANSLATION);
    });

    it("carries the skeleton binding with jointNodes remapped to model-node indices", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        const binding = makeSkeletonBinding([BONE0_ID, BONE1_ID], GEO_ID);
        const data = buildFbxAnimationData([stack("Take 001", boneCurves())], modelNodes, modelIdToIndex, [binding], []);

        expect(data!.skeletons.length).toBe(1);
        // Rig-relative [0, 1] → model-node indices [1, 2].
        expect([...data!.skeletons[0]!.jointNodes]).toEqual([1, 2]);
        // The original binding fields are passed through untouched.
        expect(data!.skeletons[0]!.boneCount).toBe(2);
        expect(data!.skeletons[0]!.boneTexture).toBe(binding.boneTexture);
    });

    it("excludes the skinned-mesh node, its ancestors, and the bone nodes from node-TRS writeback", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        const binding = makeSkeletonBinding([BONE0_ID, BONE1_ID], GEO_ID);
        const data = buildFbxAnimationData([stack("Take 001", boneCurves())], modelNodes, modelIdToIndex, [binding], []);

        // Skinned mesh node (0) is excluded so the baked invMeshWorld is not double-applied.
        expect(data!.excludedNodeIndices.has(0)).toBe(true);
        // Bone nodes (1, 2) are excluded — they are driven by the skeleton path.
        expect(data!.excludedNodeIndices.has(1)).toBe(true);
        expect(data!.excludedNodeIndices.has(2)).toBe(true);
    });

    it("builds one rest-pose NodeRest per model node and one nodeTarget per node", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        const binding = makeSkeletonBinding([BONE0_ID, BONE1_ID], GEO_ID);
        const data = buildFbxAnimationData([stack("Take 001", boneCurves())], modelNodes, modelIdToIndex, [binding], []);

        expect(data!.nodes.length).toBe(modelNodes.length);
        expect(data!.nodeTargets.length).toBe(modelNodes.length);
        // Parent links survive into the rest hierarchy.
        expect(data!.nodes[1]!.parentIdx).toBe(0);
        expect(data!.nodes[2]!.parentIdx).toBe(1);
    });

    it("skips a skeleton binding whose bone has no built model node", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        // BONE1 (21) intentionally missing from the rig → unmapped → skipped.
        const binding = makeSkeletonBinding([BONE0_ID, 999], GEO_ID);
        const data = buildFbxAnimationData([stack("Take 001", boneCurves())], modelNodes, modelIdToIndex, [binding], []);

        // Node channels still build (bone curves target real nodes), but no skeleton survives.
        expect(data).not.toBeNull();
        expect(data!.skeletons.length).toBe(0);
    });
});
