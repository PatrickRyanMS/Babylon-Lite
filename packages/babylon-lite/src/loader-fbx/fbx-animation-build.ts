/**
 * FBX animation builder — DYNAMIC-imported by `load-fbx.ts` only when the file
 * declares animation, so a static FBX pays zero bytes for it. Handles three
 * kinds of animation, all driven from the same per-stack curve data:
 *
 *  - **Node (transform) animation (P7a).** For every animated model it
 *    reconstructs the FBX local matrix at each sample time from the SAMPLED Lcl
 *    Translation/Rotation/Scaling (static pivots/pre/post-rotation/order are read
 *    from the model), decomposes it into TRS, applies quaternion continuity, and
 *    bakes per-axis linear samplers. The controller writes evaluated TRS straight
 *    onto the live FBX SceneNodes, moving their child meshes.
 *
 *  - **Skeletal (bone) animation (P7b).** FBX bones ARE Model nodes, so their
 *    Lcl T/R/S curves already become node-TRS channels by the same path above —
 *    targeting the bones' node indices. We additionally supply the per-mesh
 *    {@link SkeletonBinding} (remapped from the FBX skeleton handoff so its
 *    `jointNodes` index the model-node array) in `skeletons`, so the controller
 *    recomputes each bone's world matrix from its animated node hierarchy and
 *    uploads `invMeshWorld · jointWorld · IBM` to the bone texture per frame. The
 *    skinned mesh node + ancestors and the bone (joint) nodes are added to
 *    `excludedNodeIndices` so node-TRS writeback never double-transforms them
 *    (mirrors the glTF loader).
 *
 *  - **Morph-weight animation (P7c).** A blend-shape channel's `DeformPercent`
 *    curve (0-100) is mapped to per-morph-target weights via the same crossfade
 *    (`calculateBlendShapeInfluences`) used at load, baked into a `PATH_WEIGHTS`
 *    sampler targeting the morph-bearing mesh's node, and paired with a
 *    {@link MorphBinding} so the controller uploads the weights buffer per frame.
 *
 * Each FBX AnimationStack becomes one {@link AnimationClip} → one
 * {@link AnimationGroup} (multi-clip). Node channels whose baked output is
 * constant are dropped — the affected node simply stays at its rest pose.
 *
 * Despite the `Gltf` name, {@link GltfAnimationData} is a structurally generic
 * animation container; the Lite animation runtime is loader-agnostic.
 */

import type { SceneNode } from "../scene/scene-node.js";
import type { FBXModelData } from "./interpreter/fbx-interpreter.js";
import type { FBXObjectMap } from "./interpreter/connections.js";
import type { FBXCurveNodeData, FBXCurveData, FBXAnimationStackData } from "./interpreter/animation.js";
import { extractAnimations, sampleFBXCurveAtTime } from "./interpreter/animation.js";
import { computeFBXLocalMatrix } from "./interpreter/transform.js";
import { fbxMatDecompose } from "./interpreter/fbx-mat4.js";
import { calculateBlendShapeInfluences } from "./fbx-morph-data.js";
import type { FbxSkeletonBinding } from "./fbx-skeleton-build.js";
import type { FbxMorphAnimBinding } from "./fbx-morph-build.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import { createAnimationGroups } from "../animation/animation-group.js";
import type { AnimationClip, AnimationSampler, AnimationChannel, NodeRest, AnimatedNodeTarget, GltfAnimationData, SkeletonBinding, MorphBinding } from "../animation/types.js";
import { INTERP_LINEAR, PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS } from "../animation/types.js";

/** Sample frame rate (Hz) used to bake the frame grid and as the clip frame rate. */
const FBX_ANIMATION_FPS = 30;
/** Constancy threshold for dropping a flat channel (matches BJS FBX loader). */
const CONSTANT_EPSILON = 1e-4;

/** A built FBX model node plus the data needed to drive it. Index = position in
 *  the `modelNodes` array passed to {@link buildFbxAnimationGroups}. */
export interface FbxAnimatedModel {
    /** The interpreted model (carries static T/R/S + pivots/pre/post/order). */
    readonly model: FBXModelData;
    /** Live scene node built as a writeable TRS node (decomposed rest pose). */
    readonly node: SceneNode;
    /** Index of the parent model in the same array, or -1 for a root model. */
    readonly parentIndex: number;
}

/**
 * Build animation groups for an FBX scene. Returns `[]` when no stack drives a
 * known model (so the caller can simply skip assigning `container.animationGroups`).
 *
 * @param objectMap        - Resolved FBX object table (source of the animation graph).
 * @param modelNodes       - Built model nodes (bones included) indexed by node index.
 * @param modelIdToIndex   - FBX Model ID → node index map.
 * @param skeletonBindings - Per-mesh skeletal handoff from the skeleton-build pass (P7b).
 * @param morphBindings    - Per-mesh morph handoff from the morph-build pass (P7c).
 */
export function buildFbxAnimationGroups(
    objectMap: FBXObjectMap,
    modelNodes: readonly FbxAnimatedModel[],
    modelIdToIndex: ReadonlyMap<number, number>,
    skeletonBindings: readonly FbxSkeletonBinding[] = [],
    morphBindings: readonly FbxMorphAnimBinding[] = []
): AnimationGroup[] {
    const stacks = extractAnimations(objectMap);
    const animData = buildFbxAnimationData(stacks, modelNodes, modelIdToIndex, skeletonBindings, morphBindings);
    return animData ? createAnimationGroups(animData) : [];
}

/** A morph binding resolved to its animation node index, paired with its handoff. */
interface ResolvedMorph {
    readonly nodeIdx: number;
    readonly binding: FbxMorphAnimBinding;
}

/**
 * Assemble the generic {@link GltfAnimationData} from already-extracted FBX
 * animation stacks. Split out from {@link buildFbxAnimationGroups} so it can be
 * unit-tested with synthetic stacks/bindings (no FBX object map or GPU required).
 * Returns null when nothing animates.
 */
export function buildFbxAnimationData(
    stacks: readonly FBXAnimationStackData[],
    modelNodes: readonly FbxAnimatedModel[],
    modelIdToIndex: ReadonlyMap<number, number>,
    skeletonBindings: readonly FbxSkeletonBinding[],
    morphBindings: readonly FbxMorphAnimBinding[]
): GltfAnimationData | null {
    if (stacks.length === 0) {
        return null;
    }

    // Rest-pose TRS + parent links, one entry per model node (bones included).
    const nodes: NodeRest[] = modelNodes.map((mn) => {
        const trs = fbxMatDecompose(computeFBXLocalMatrix(mn.model));
        return {
            parentIdx: mn.parentIndex,
            tx: trs.t[0],
            ty: trs.t[1],
            tz: trs.t[2],
            rx: trs.q[0],
            ry: trs.q[1],
            rz: trs.q[2],
            rw: trs.q[3],
            sx: trs.s[0],
            sy: trs.s[1],
            sz: trs.s[2],
        };
    });

    // Live scene nodes are structurally compatible with AnimatedNodeTarget.
    const nodeTargets: (AnimatedNodeTarget | undefined)[] = modelNodes.map((mn) => mn.node);

    // Skeletal bindings: remap each FBX rig's bone indices to model-node indices
    // (FBX bones are Model nodes, so the controller drives them through the same
    // node hierarchy). Skinned-mesh nodes + ancestors and the bone nodes are
    // excluded from node-TRS writeback so they aren't double-transformed.
    const skeletons: SkeletonBinding[] = [];
    const excludedNodeIndices = new Set<number>();
    for (const binding of skeletonBindings) {
        const jointNodes = remapJointNodes(binding, modelIdToIndex);
        if (!jointNodes) {
            console.warn(`[loadFbx] FBX skeletal animation: rig ${binding.rigId} has a bone with no model node; skipping its skeleton binding.`);
            continue;
        }
        skeletons.push({
            jointNodes,
            inverseBindMatrices: binding.inverseBindMatrices,
            invMeshWorld: binding.invMeshWorld,
            boneTexture: binding.boneTexture,
            boneCount: binding.boneCount,
            boneMatrices: binding.boneMatrices,
            runtimeSkeleton: binding.runtimeSkeleton,
        });
        // Bones are driven by the skeleton path (bone texture), not scene writeback.
        for (const jn of jointNodes) {
            excludedNodeIndices.add(jn);
        }
        // The skinned mesh world is baked into invMeshWorld at load; moving the
        // mesh node (or any ancestor) at runtime would double-transform it.
        const meshNodeIdx = findGeometryNodeIndex(modelNodes, binding.geometryId);
        if (meshNodeIdx >= 0) {
            addNodeAndAncestors(meshNodeIdx, modelNodes, excludedNodeIndices);
        }
    }

    // Resolve each morph handoff to its node index + build the engine MorphBinding
    // list the controller uploads each frame.
    const resolvedMorphs: ResolvedMorph[] = [];
    const animMorphBindings: MorphBinding[] = [];
    for (const binding of morphBindings) {
        const nodeIdx = modelIdToIndex.get(binding.modelId);
        if (nodeIdx === undefined) {
            continue;
        }
        resolvedMorphs.push({ nodeIdx, binding });
        animMorphBindings.push({
            nodeIdx,
            weightsBuffer: binding.morphTargets.weightsBuffer,
            weights: binding.morphTargets.weights,
            targetCount: binding.targetCount,
            runtimeMorphTargets: binding.morphTargets,
        });
    }

    const clips: AnimationClip[] = [];
    for (const stack of stacks) {
        const clip = buildClip(stack.name, stack.curveNodes, stack.startTime, stack.stopTime, stack.duration, modelNodes, modelIdToIndex, resolvedMorphs);
        if (clip) {
            clips.push(clip);
        }
    }

    if (clips.length === 0) {
        return null;
    }

    return {
        clips,
        nodes,
        skeletons,
        morphBindings: animMorphBindings,
        nodeTargets,
        excludedNodeIndices,
    };
}

/** Remap a skeleton binding's rig-relative bones to model-node indices, or null
 *  when any bone has no built model node. */
function remapJointNodes(binding: FbxSkeletonBinding, modelIdToIndex: ReadonlyMap<number, number>): number[] | null {
    const jointNodes: number[] = [];
    for (const modelId of binding.boneModelIds) {
        const idx = modelIdToIndex.get(modelId);
        if (idx === undefined) {
            return null;
        }
        jointNodes.push(idx);
    }
    return jointNodes;
}

/** Find the node index of the model that owns a given geometry, or -1. */
function findGeometryNodeIndex(modelNodes: readonly FbxAnimatedModel[], geometryId: number): number {
    for (let i = 0; i < modelNodes.length; i++) {
        if (modelNodes[i]!.model.geometry?.id === geometryId) {
            return i;
        }
    }
    return -1;
}

/** Add a node and all its ancestors (via parentIndex) to the exclusion set. */
function addNodeAndAncestors(nodeIdx: number, modelNodes: readonly FbxAnimatedModel[], set: Set<number>): void {
    let p = nodeIdx;
    while (p >= 0 && !set.has(p)) {
        set.add(p);
        p = modelNodes[p]!.parentIndex;
    }
}

/** Build one clip from a stack's curve nodes. Returns null when nothing animates. */
function buildClip(
    name: string,
    curveNodes: readonly FBXCurveNodeData[],
    startTime: number,
    stopTime: number,
    duration: number,
    modelNodes: readonly FbxAnimatedModel[],
    modelIdToIndex: ReadonlyMap<number, number>,
    resolvedMorphs: readonly ResolvedMorph[]
): AnimationClip | null {
    // Group T/R/S curve nodes by the model they target (skip unknown models).
    // FBX bones are Model nodes too, so this same pass produces the bone-node TRS
    // channels the skeleton path consumes.
    const byModel = new Map<number, FBXCurveNodeData[]>();
    for (const cn of curveNodes) {
        if (cn.type !== "T" && cn.type !== "R" && cn.type !== "S") {
            continue;
        }
        if (!modelIdToIndex.has(cn.targetModelId)) {
            continue;
        }
        let list = byModel.get(cn.targetModelId);
        if (!list) {
            list = [];
            byModel.set(cn.targetModelId, list);
        }
        list.push(cn);
    }

    const samplers: AnimationSampler[] = [];
    const channels: AnimationChannel[] = [];

    for (const [modelId, modelCurveNodes] of byModel) {
        const nodeIdx = modelIdToIndex.get(modelId)!;
        const model = modelNodes[nodeIdx]!.model;
        buildModelChannels(model, modelCurveNodes, nodeIdx, startTime, stopTime, samplers, channels);
    }

    // Morph-weight channels: blend-shape DeformPercent curves → PATH_WEIGHTS.
    buildMorphWeightChannels(curveNodes, resolvedMorphs, startTime, stopTime, samplers, channels);

    if (channels.length === 0) {
        return null;
    }

    return { name, channels, samplers, duration, frameRate: FBX_ANIMATION_FPS };
}

/**
 * Bake a `PATH_WEIGHTS` sampler per morph-bearing mesh whose blend-shape channels
 * this stack animates. At each sample time every relevant `DeformPercent` curve is
 * mapped to its per-target weights via the load-time crossfade
 * (`calculateBlendShapeInfluences`), packed `targetCount` floats per keyframe so the
 * controller can upload them straight to the weights buffer.
 */
function buildMorphWeightChannels(
    curveNodes: readonly FBXCurveNodeData[],
    resolvedMorphs: readonly ResolvedMorph[],
    startTime: number,
    stopTime: number,
    samplers: AnimationSampler[],
    channels: AnimationChannel[]
): void {
    for (const rm of resolvedMorphs) {
        const channelById = new Map(rm.binding.channels.map((c) => [c.channelId, c]));
        const relevant = curveNodes.filter((cn) => cn.type === "DeformPercent" && channelById.has(cn.targetModelId));
        if (relevant.length === 0) {
            continue;
        }

        const times = collectAnimationSampleTimes(relevant, FBX_ANIMATION_FPS, startTime, stopTime);
        if (times.length === 0) {
            continue;
        }

        const tc = rm.binding.targetCount;
        const count = times.length;
        const input = new Float32Array(count);
        const output = new Float32Array(count * tc);

        for (let i = 0; i < count; i++) {
            const time = times[i]!;
            input[i] = time;
            for (const cn of relevant) {
                const ac = channelById.get(cn.targetModelId)!;
                const percent = sampleFBXCurveAtTime(cn.curves[0], time) ?? ac.defaultDeformPercent;
                const influences = calculateBlendShapeInfluences(percent, ac.fullWeights, ac.fullShapeCount);
                for (let s = 0; s < ac.emittedShapeCount; s++) {
                    const ti = ac.targetStart + s;
                    if (ti < tc) {
                        output[i * tc + ti] = influences[s] ?? 0;
                    }
                }
            }
        }

        channels.push({ samplerIdx: samplers.length, nodeIdx: rm.nodeIdx, path: PATH_WEIGHTS });
        samplers.push({ input, output, interpolation: INTERP_LINEAR });
    }
}

/** Bake T/R/S keyframes for one model and append non-constant samplers/channels. */
function buildModelChannels(
    model: FBXModelData,
    curveNodes: readonly FBXCurveNodeData[],
    nodeIdx: number,
    startTime: number,
    stopTime: number,
    samplers: AnimationSampler[],
    channels: AnimationChannel[]
): void {
    const times = collectAnimationSampleTimes(curveNodes, FBX_ANIMATION_FPS, startTime, stopTime);
    if (times.length === 0) {
        return;
    }

    const tNode = curveNodes.find((cn) => cn.type === "T");
    const rNode = curveNodes.find((cn) => cn.type === "R");
    const sNode = curveNodes.find((cn) => cn.type === "S");

    const txCurve = findCurve(tNode, "d|X");
    const tyCurve = findCurve(tNode, "d|Y");
    const tzCurve = findCurve(tNode, "d|Z");
    const rxCurve = findCurve(rNode, "d|X");
    const ryCurve = findCurve(rNode, "d|Y");
    const rzCurve = findCurve(rNode, "d|Z");
    const sxCurve = findCurve(sNode, "d|X");
    const syCurve = findCurve(sNode, "d|Y");
    const szCurve = findCurve(sNode, "d|Z");

    const count = times.length;
    const posOut = new Float32Array(count * 3);
    const rotOut = new Float32Array(count * 4);
    const sclOut = new Float32Array(count * 3);
    const input = new Float32Array(count);

    let prevQx = 0;
    let prevQy = 0;
    let prevQz = 0;
    let prevQw = 0;
    let hasPrev = false;

    for (let i = 0; i < count; i++) {
        const time = times[i]!;
        input[i] = time;

        // Sample animated components, falling back to the model's static base.
        const tx = sampleFBXCurveAtTime(txCurve, time) ?? model.translation[0];
        const ty = sampleFBXCurveAtTime(tyCurve, time) ?? model.translation[1];
        const tz = sampleFBXCurveAtTime(tzCurve, time) ?? model.translation[2];
        const rx = sampleFBXCurveAtTime(rxCurve, time) ?? model.rotation[0];
        const ry = sampleFBXCurveAtTime(ryCurve, time) ?? model.rotation[1];
        const rz = sampleFBXCurveAtTime(rzCurve, time) ?? model.rotation[2];
        const sx = sampleFBXCurveAtTime(sxCurve, time) ?? model.scale[0];
        const sy = sampleFBXCurveAtTime(syCurve, time) ?? model.scale[1];
        const sz = sampleFBXCurveAtTime(szCurve, time) ?? model.scale[2];

        // Reconstruct the full FBX local matrix (with pivots) and decompose to TRS.
        const local = computeFBXLocalMatrix(makeSampledComponents(model, tx, ty, tz, rx, ry, rz, sx, sy, sz));
        const { t, q, s } = fbxMatDecompose(local);

        // Quaternion continuity: keep the shortest arc between consecutive keys.
        let qx = q[0];
        let qy = q[1];
        let qz = q[2];
        let qw = q[3];
        if (hasPrev && prevQx * qx + prevQy * qy + prevQz * qz + prevQw * qw < 0) {
            qx = -qx;
            qy = -qy;
            qz = -qz;
            qw = -qw;
        }
        prevQx = qx;
        prevQy = qy;
        prevQz = qz;
        prevQw = qw;
        hasPrev = true;

        posOut[i * 3] = t[0];
        posOut[i * 3 + 1] = t[1];
        posOut[i * 3 + 2] = t[2];
        rotOut[i * 4] = qx;
        rotOut[i * 4 + 1] = qy;
        rotOut[i * 4 + 2] = qz;
        rotOut[i * 4 + 3] = qw;
        sclOut[i * 3] = s[0];
        sclOut[i * 3 + 1] = s[1];
        sclOut[i * 3 + 2] = s[2];
    }

    if (!isVec3Constant(posOut, count)) {
        channels.push({ samplerIdx: samplers.length, nodeIdx, path: PATH_TRANSLATION });
        samplers.push({ input, output: posOut, interpolation: INTERP_LINEAR });
    }
    if (!isQuatConstant(rotOut, count)) {
        channels.push({ samplerIdx: samplers.length, nodeIdx, path: PATH_ROTATION });
        samplers.push({ input, output: rotOut, interpolation: INTERP_LINEAR });
    }
    if (!isVec3Constant(sclOut, count)) {
        channels.push({ samplerIdx: samplers.length, nodeIdx, path: PATH_SCALE });
        samplers.push({ input, output: sclOut, interpolation: INTERP_LINEAR });
    }
}

/** Clone the model's transform components with overridden T/R/S values. */
function makeSampledComponents(
    model: FBXModelData,
    tx: number,
    ty: number,
    tz: number,
    rx: number,
    ry: number,
    rz: number,
    sx: number,
    sy: number,
    sz: number
): Parameters<typeof computeFBXLocalMatrix>[0] {
    return {
        translation: [tx, ty, tz],
        rotation: [rx, ry, rz],
        scale: [sx, sy, sz],
        preRotation: model.preRotation,
        postRotation: model.postRotation,
        rotationPivot: model.rotationPivot,
        scalingPivot: model.scalingPivot,
        rotationOffset: model.rotationOffset,
        scalingOffset: model.scalingOffset,
        rotationOrder: model.rotationOrder,
        inheritType: model.inheritType,
    };
}

function findCurve(node: FBXCurveNodeData | undefined, channel: string): FBXCurveData | undefined {
    return node?.curves.find((c) => c.channel === channel);
}

/**
 * Union of curve key times (clamped to [startTime, stopTime]) with the range
 * endpoints and a uniform frame grid. Faithful port of the BJS FBX loader's
 * `collectAnimationSampleTimes`.
 */
function collectAnimationSampleTimes(curveNodes: readonly FBXCurveNodeData[], fps: number, startTime: number, stopTime: number): number[] {
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    const sourceTimes = new Set<number>();

    for (const curveNode of curveNodes) {
        for (const curve of curveNode.curves) {
            for (const key of curve.keys) {
                minTime = Math.min(minTime, key.time);
                maxTime = Math.max(maxTime, key.time);
                if (key.time >= startTime && key.time <= stopTime) {
                    sourceTimes.add(key.time);
                }
            }
        }
    }

    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
        return [];
    }

    const rangeStart = stopTime > startTime ? startTime : minTime;
    const rangeStop = stopTime > startTime ? stopTime : maxTime;
    const times = new Set<number>([rangeStart, rangeStop, ...sourceTimes]);
    const startFrame = Math.ceil(rangeStart * fps);
    const stopFrame = Math.floor(rangeStop * fps);

    for (let frame = startFrame; frame <= stopFrame; frame++) {
        times.add(frame / fps);
    }

    return [...times].sort((a, b) => a - b);
}

/** True when every vec3 key matches the first within {@link CONSTANT_EPSILON}. */
function isVec3Constant(output: Float32Array, count: number): boolean {
    if (count < 2) {
        return true;
    }
    const x0 = output[0]!;
    const y0 = output[1]!;
    const z0 = output[2]!;
    for (let i = 1; i < count; i++) {
        if (Math.abs(output[i * 3]! - x0) > CONSTANT_EPSILON || Math.abs(output[i * 3 + 1]! - y0) > CONSTANT_EPSILON || Math.abs(output[i * 3 + 2]! - z0) > CONSTANT_EPSILON) {
            return false;
        }
    }
    return true;
}

/** True when every quaternion key matches the first within {@link CONSTANT_EPSILON}. */
function isQuatConstant(output: Float32Array, count: number): boolean {
    if (count < 2) {
        return true;
    }
    const x0 = output[0]!;
    const y0 = output[1]!;
    const z0 = output[2]!;
    const w0 = output[3]!;
    for (let i = 1; i < count; i++) {
        if (
            Math.abs(output[i * 4]! - x0) > CONSTANT_EPSILON ||
            Math.abs(output[i * 4 + 1]! - y0) > CONSTANT_EPSILON ||
            Math.abs(output[i * 4 + 2]! - z0) > CONSTANT_EPSILON ||
            Math.abs(output[i * 4 + 3]! - w0) > CONSTANT_EPSILON
        ) {
            return false;
        }
    }
    return true;
}
