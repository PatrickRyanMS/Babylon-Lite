import { describe, expect, it } from "vitest";

import type { FBXModelData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/fbx-interpreter.js";
import type { FBXAnimationStackData, FBXCurveNodeData, FBXKeyframe } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/animation.js";
import type { FbxAnimatedModel } from "../../../packages/babylon-lite/src/loader-fbx/fbx-animation-build.js";
import { buildFbxAnimationData } from "../../../packages/babylon-lite/src/loader-fbx/fbx-animation-build.js";
import type { FbxMorphAnimBinding, FbxMorphAnimChannel } from "../../../packages/babylon-lite/src/loader-fbx/fbx-morph-build.js";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node.js";
import { createAnimationGroups } from "../../../packages/babylon-lite/src/animation/animation-group.js";
import type { AnimationSampler, MorphTargetData } from "../../../packages/babylon-lite/src/animation/types.js";
import { PATH_WEIGHTS } from "../../../packages/babylon-lite/src/animation/types.js";

function makeModel(id: number): FBXModelData {
    return {
        id,
        name: `model_${id}`,
        subType: "Mesh",
        geometry: undefined,
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

function modelNode(model: FBXModelData, parentIndex: number): FbxAnimatedModel {
    return { model, node: createSceneNode(model.name), parentIndex };
}

function stack(name: string, curveNodes: FBXCurveNodeData[], duration = 1): FBXAnimationStackData {
    return { name, startTime: 0, stopTime: duration, duration, curveNodes, layers: [], unsupportedCurveNodes: [], diagnostics: [] };
}

function deformCurveNode(channelId: number, keys: FBXKeyframe[]): FBXCurveNodeData {
    return { type: "DeformPercent", targetModelId: channelId, curves: [{ channel: "d|DeformPercent", keys }] };
}

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

/** Stub GPU morph data — buildFbxAnimationData only stores references to these. */
function makeMorphTargets(count: number): MorphTargetData {
    return {
        texture: {} as GPUTexture,
        count,
        weightsBuffer: {} as GPUBuffer,
        targets: [],
        weights: new Float32Array(count),
    };
}

function makeMorphBinding(modelId: number, targetCount: number, channels: FbxMorphAnimChannel[]): FbxMorphAnimBinding {
    return { modelId, morphTargets: makeMorphTargets(targetCount), targetCount, channels };
}

/** Read the `targetCount` weights baked at the keyframe nearest `time`. */
function weightsAtTime(sampler: AnimationSampler, tc: number, time: number): number[] {
    const idx = [...sampler.input].findIndex((t) => Math.abs(t - time) < 1e-6);
    expect(idx).toBeGreaterThanOrEqual(0);
    return [...sampler.output.slice(idx * tc, idx * tc + tc)];
}

const MESH_ID = 30;
const CHANNEL_ID = 200;

describe("buildFbxAnimationData — morph-weight animation", () => {
    it("bakes a PATH_WEIGHTS sampler that targets the morph mesh node", () => {
        const modelNodes = [modelNode(makeModel(MESH_ID), -1)];
        const modelIdToIndex = new Map<number, number>([[MESH_ID, 0]]);
        const channel: FbxMorphAnimChannel = { channelId: CHANNEL_ID, targetStart: 0, emittedShapeCount: 1, fullShapeCount: 1, fullWeights: null, defaultDeformPercent: 0 };
        const binding = makeMorphBinding(MESH_ID, 1, [channel]);
        const curve = deformCurveNode(CHANNEL_ID, [
            { time: 0, value: 0, interpolation: "linear" },
            { time: 1, value: 100, interpolation: "linear" },
        ]);

        const data = buildFbxAnimationData([stack("Take 001", [curve])], modelNodes, modelIdToIndex, [], [binding]);
        expect(data).not.toBeNull();

        const weightChannels = data!.clips[0]!.channels.filter((ch) => ch.path === PATH_WEIGHTS);
        expect(weightChannels.length).toBe(1);
        expect(weightChannels[0]!.nodeIdx).toBe(0);

        // Single-shape crossfade: weight == clamp01(percent / 100) == time (linear 0→100 over 0→1s).
        const sampler = data!.clips[0]!.samplers[weightChannels[0]!.samplerIdx]!;
        expect(sampler.output.length).toBe(sampler.input.length * 1);
        for (let i = 0; i < sampler.input.length; i++) {
            expect(sampler.output[i]).toBeCloseTo(sampler.input[i]!, 5);
        }
    });

    it("applies the in-between FullWeights crossfade across two morph-target slots", () => {
        const modelNodes = [modelNode(makeModel(MESH_ID), -1)];
        const modelIdToIndex = new Map<number, number>([[MESH_ID, 0]]);
        // One channel with two shapes and in-between weights at 50% / 100%.
        const channel: FbxMorphAnimChannel = { channelId: CHANNEL_ID, targetStart: 0, emittedShapeCount: 2, fullShapeCount: 2, fullWeights: [50, 100], defaultDeformPercent: 0 };
        const binding = makeMorphBinding(MESH_ID, 2, [channel]);
        // Percent ramps 0 → 100 with explicit keys at 25/50/75 so those times are sampled.
        const curve = deformCurveNode(CHANNEL_ID, [
            { time: 0, value: 0, interpolation: "linear" },
            { time: 0.25, value: 25, interpolation: "linear" },
            { time: 0.5, value: 50, interpolation: "linear" },
            { time: 0.75, value: 75, interpolation: "linear" },
            { time: 1, value: 100, interpolation: "linear" },
        ]);

        const data = buildFbxAnimationData([stack("Take 001", [curve])], modelNodes, modelIdToIndex, [], [binding]);
        const ch = data!.clips[0]!.channels.find((c) => c.path === PATH_WEIGHTS)!;
        const sampler = data!.clips[0]!.samplers[ch.samplerIdx]!;

        // percent 25 → first slot half-on; percent 50 → first slot fully on.
        expect(weightsAtTime(sampler, 2, 0.25)).toEqual([expect.closeTo(0.5, 5), expect.closeTo(0, 5)]);
        expect(weightsAtTime(sampler, 2, 0.5)).toEqual([expect.closeTo(1, 5), expect.closeTo(0, 5)]);
        // percent 75 → crossfading equally between the two shapes.
        expect(weightsAtTime(sampler, 2, 0.75)).toEqual([expect.closeTo(0.5, 5), expect.closeTo(0.5, 5)]);
        // percent 100 → second slot fully on.
        expect(weightsAtTime(sampler, 2, 1)).toEqual([expect.closeTo(0, 5), expect.closeTo(1, 5)]);
    });

    it("carries the morph binding wired to the mesh node + GPU weights buffer", () => {
        const modelNodes = [modelNode(makeModel(MESH_ID), -1)];
        const modelIdToIndex = new Map<number, number>([[MESH_ID, 0]]);
        const channel: FbxMorphAnimChannel = { channelId: CHANNEL_ID, targetStart: 0, emittedShapeCount: 1, fullShapeCount: 1, fullWeights: null, defaultDeformPercent: 0 };
        const binding = makeMorphBinding(MESH_ID, 1, [channel]);
        const curve = deformCurveNode(CHANNEL_ID, [
            { time: 0, value: 0, interpolation: "linear" },
            { time: 1, value: 100, interpolation: "linear" },
        ]);

        const data = buildFbxAnimationData([stack("Take 001", [curve])], modelNodes, modelIdToIndex, [], [binding]);
        expect(data!.morphBindings.length).toBe(1);
        const mb = data!.morphBindings[0]!;
        expect(mb.nodeIdx).toBe(0);
        expect(mb.targetCount).toBe(1);
        expect(mb.weightsBuffer).toBe(binding.morphTargets.weightsBuffer);
        expect(mb.runtimeMorphTargets).toBe(binding.morphTargets);
    });
});

describe("buildFbxAnimationData — multiclip (multiple animation stacks)", () => {
    const MODEL_ID = 40;

    function buildScene(): { modelNodes: FbxAnimatedModel[]; modelIdToIndex: Map<number, number> } {
        const modelNodes = [modelNode(makeModel(MODEL_ID), -1)];
        const modelIdToIndex = new Map<number, number>([[MODEL_ID, 0]]);
        return { modelNodes, modelIdToIndex };
    }

    it("emits one clip per animation stack with the stack's name + duration", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        const walk = stack("Walk", [trsCurveNode("T", MODEL_ID, "d|X", 0, 5)], 1);
        const run = stack("Run", [trsCurveNode("T", MODEL_ID, "d|X", 0, 10)], 2);

        const data = buildFbxAnimationData([walk, run], modelNodes, modelIdToIndex, [], []);
        expect(data).not.toBeNull();
        expect(data!.clips.length).toBe(2);
        expect(data!.clips.map((c) => c.name)).toEqual(["Walk", "Run"]);
        expect(data!.clips[0]!.duration).toBe(1);
        expect(data!.clips[1]!.duration).toBe(2);
    });

    it("yields one AnimationGroup per stack via createAnimationGroups", () => {
        const { modelNodes, modelIdToIndex } = buildScene();
        const walk = stack("Walk", [trsCurveNode("T", MODEL_ID, "d|X", 0, 5)], 1);
        const run = stack("Run", [trsCurveNode("T", MODEL_ID, "d|X", 0, 10)], 2);

        const data = buildFbxAnimationData([walk, run], modelNodes, modelIdToIndex, [], [])!;
        const groups = createAnimationGroups(data);
        expect(groups.length).toBe(2);
        expect(groups.map((g) => g.name)).toEqual(["Walk", "Run"]);
        expect(groups[0]!.duration).toBe(1);
        expect(groups[1]!.duration).toBe(2);
    });
});
