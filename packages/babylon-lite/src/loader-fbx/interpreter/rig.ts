/**
 * FBX rig resolver — PURE interpreter pass.
 *
 * Ported faithfully from the Babylon.js FBX loader (`FBX/interpreter/rig.ts`):
 * groups skins that share a common skeleton root, merges their bones into one
 * ordered rig (parents before children), and produces a per-skin remap from the
 * skin's own bone index to the merged rig bone index. The output is plain data —
 * no engine, no GPU. Consumed by `fbx-skeleton-build.ts` to build per-mesh
 * skeleton GPU data with stable, rig-relative bone indices.
 */

import type { FBXObjectMap } from "./connections.js";
import type { FBXBoneData, FBXSkinData } from "./skeleton.js";
import { extractBoneTransform, isSkeletonModel } from "./skeleton.js";

import { cleanFBXName, getPropertyValue } from "../types/fbx-types.js";

/** A rig bone is structurally a skin bone, re-indexed into the merged rig. */
export type FBXRigBoneData = FBXBoneData;

/** Maps a single skin's bone indices onto the merged rig's bone indices. */
export interface FBXSkinBindingData {
    /** Skin deformer ID. */
    skinId: number;
    /** Geometry ID this skin is attached to. */
    geometryId: number;
    /** ID of the rig this skin binds to. */
    rigId: string;
    /** For each skin bone index, the corresponding rig bone index (-1 if absent). */
    skinBoneIndexToRigBoneIndex: number[];
    /** Model IDs of the skin's weighted cluster bones. */
    clusterModelIds: Set<number>;
}

/** A resolved rig: one merged bone hierarchy plus its per-skin bindings. */
export interface FBXRigData {
    /** Stable rig ID derived from its grouping root. */
    id: string;
    /** Model IDs of the rig's root bones (`parentIndex < 0`). */
    rootModelIds: number[];
    /** Merged, ordered bones (parents before children). */
    bones: FBXRigBoneData[];
    /** Maps a bone's Model ID to its rig bone index. */
    modelIdToBoneIndex: Map<number, number>;
    /** Model IDs of all weighted cluster bones across the grouped skins. */
    clusterModelIds: Set<number>;
    /** Per-skin bindings to this rig. */
    skinBindings: FBXSkinBindingData[];
    /** Recoverable rig-resolution warnings. */
    warnings: string[];
}

/** Group skins by shared skeleton root and resolve one merged rig per group. */
export function resolveRigs(objectMap: FBXObjectMap, skins: FBXSkinData[]): FBXRigData[] {
    if (skins.length === 0) {
        return [];
    }

    const groupByRoot = new Map<number, FBXSkinData[]>();

    for (const skin of skins) {
        const clusterModelIds = skin.bones.filter((bone) => bone.isCluster).map((bone) => bone.modelId);
        if (clusterModelIds.length === 0) {
            continue;
        }

        const rootModelId = findRigGroupingRoot(clusterModelIds, objectMap);
        const group = groupByRoot.get(rootModelId);
        if (group) {
            group.push(skin);
        } else {
            groupByRoot.set(rootModelId, [skin]);
        }
    }

    return Array.from(groupByRoot.entries())
        .sort(([a], [b]) => compareNumber(a, b))
        .map(([rootModelId, groupSkins]) => buildRig(rootModelId, groupSkins, objectMap));
}

function buildRig(rootModelId: number, skins: FBXSkinData[], objectMap: FBXObjectMap): FBXRigData {
    const clusterModelIds = new Set<number>();
    const rigModelIds = new Set<number>();
    const sourceBonesByModelId = new Map<number, FBXBoneData[]>();
    const sourceOrderByModelId = new Map<number, number>();

    for (const skin of skins) {
        for (const bone of skin.bones) {
            if (!sourceOrderByModelId.has(bone.modelId)) {
                sourceOrderByModelId.set(bone.modelId, sourceOrderByModelId.size);
            }

            let sources = sourceBonesByModelId.get(bone.modelId);
            if (!sources) {
                sources = [];
                sourceBonesByModelId.set(bone.modelId, sources);
            }
            sources.push(bone);

            if (!bone.isCluster) {
                continue;
            }

            clusterModelIds.add(bone.modelId);
            for (const ancestorId of getModelAncestorChain(bone.modelId, objectMap)) {
                rigModelIds.add(ancestorId);
            }
        }
    }

    const warnings = collectTransformLinkWarnings(sourceBonesByModelId);
    const preferredBoneByModelId = new Map<number, FBXBoneData>();
    for (const [modelId, sources] of Array.from(sourceBonesByModelId)) {
        preferredBoneByModelId.set(modelId, choosePreferredBoneSource(sources));
    }

    const parentByModelId = buildParentMap(rigModelIds, objectMap);
    const orderedModelIds = orderParentsBeforeChildren(rigModelIds, parentByModelId, sourceOrderByModelId);
    const bones: FBXRigBoneData[] = [];
    const modelIdToBoneIndex = new Map<number, number>();

    for (const modelId of orderedModelIds) {
        const sourceBone = preferredBoneByModelId.get(modelId) ?? createFallbackBone(modelId, objectMap);
        if (!sourceBone) {
            continue;
        }

        const parentModelId = parentByModelId.get(modelId);
        const parentIndex = parentModelId === undefined ? -1 : (modelIdToBoneIndex.get(parentModelId) ?? -1);
        const index = bones.length;
        const bone: FBXRigBoneData = {
            ...sourceBone,
            index,
            parentIndex,
            isCluster: clusterModelIds.has(modelId),
        };
        bones.push(bone);
        modelIdToBoneIndex.set(modelId, index);
    }

    const skinBindings = skins.map((skin) => buildSkinBinding(skin, `rig_${rootModelId.toString()}`, modelIdToBoneIndex));

    return {
        id: `rig_${rootModelId.toString()}`,
        rootModelIds: bones.filter((bone) => bone.parentIndex < 0).map((bone) => bone.modelId),
        bones,
        modelIdToBoneIndex,
        clusterModelIds,
        skinBindings,
        warnings,
    };
}

function buildSkinBinding(skin: FBXSkinData, rigId: string, modelIdToBoneIndex: Map<number, number>): FBXSkinBindingData {
    const skinBoneIndexToRigBoneIndex = skin.bones.map((bone) => {
        const rigBoneIndex = modelIdToBoneIndex.get(bone.modelId);
        if (rigBoneIndex === undefined && bone.isCluster) {
            throw new Error(`FBX rig resolver: cluster bone ${bone.name} is missing from resolved rig ${rigId}`);
        }
        return rigBoneIndex ?? -1;
    });

    return {
        skinId: skin.id,
        geometryId: skin.geometryId,
        rigId,
        skinBoneIndexToRigBoneIndex,
        clusterModelIds: new Set(skin.bones.filter((bone) => bone.isCluster).map((bone) => bone.modelId)),
    };
}

function findRigGroupingRoot(clusterModelIds: number[], objectMap: FBXObjectMap): number {
    const lca = findLowestCommonAncestor(clusterModelIds, objectMap) ?? clusterModelIds[0]!;
    let root = lca;
    let parentId = findModelParentId(root, objectMap);

    while (parentId !== undefined) {
        const parentNode = objectMap.objects.get(parentId);
        if (!parentNode || parentNode.name !== "Model" || !isSkeletonModel(parentNode)) {
            break;
        }

        root = parentId;
        parentId = findModelParentId(parentId, objectMap);
    }

    return root;
}

function findLowestCommonAncestor(modelIds: number[], objectMap: FBXObjectMap): number | undefined {
    if (modelIds.length === 0) {
        return undefined;
    }

    const chains = modelIds.map((modelId) => getModelAncestorChain(modelId, objectMap));
    const common = new Set(chains[0]);
    for (const chain of chains.slice(1)) {
        for (const modelId of Array.from(common)) {
            if (!chain.includes(modelId)) {
                common.delete(modelId);
            }
        }
    }

    return chains[0]!.find((modelId) => common.has(modelId));
}

function getModelAncestorChain(modelId: number, objectMap: FBXObjectMap): number[] {
    const chain: number[] = [];
    let currentId: number | undefined = modelId;

    while (currentId !== undefined) {
        const node = objectMap.objects.get(currentId);
        if (!node || node.name !== "Model") {
            break;
        }

        chain.push(currentId);
        currentId = findModelParentId(currentId, objectMap);
    }

    return chain;
}

function buildParentMap(modelIds: Set<number>, objectMap: FBXObjectMap): Map<number, number> {
    const parentByModelId = new Map<number, number>();

    for (const modelId of Array.from(modelIds)) {
        const parentId = findModelParentId(modelId, objectMap);
        if (parentId !== undefined && modelIds.has(parentId)) {
            parentByModelId.set(modelId, parentId);
        }
    }

    return parentByModelId;
}

function orderParentsBeforeChildren(modelIds: Set<number>, parentByModelId: Map<number, number>, sourceOrderByModelId: Map<number, number>): number[] {
    const childrenByModelId = new Map<number, number[]>();
    for (const modelId of Array.from(modelIds)) {
        const parentId = parentByModelId.get(modelId);
        if (parentId === undefined) {
            continue;
        }

        let children = childrenByModelId.get(parentId);
        if (!children) {
            children = [];
            childrenByModelId.set(parentId, children);
        }
        children.push(modelId);
    }

    for (const children of Array.from(childrenByModelId.values())) {
        children.sort((a, b) => compareSourceOrder(a, b, sourceOrderByModelId));
    }

    const roots = Array.from(modelIds)
        .filter((modelId) => !parentByModelId.has(modelId))
        .sort((a, b) => compareSourceOrder(a, b, sourceOrderByModelId));
    const ordered: number[] = [];
    const queue = [...roots];

    while (queue.length > 0) {
        const modelId = queue.shift()!;
        ordered.push(modelId);
        queue.push(...(childrenByModelId.get(modelId) ?? []));
    }

    return ordered;
}

function findModelParentId(modelId: number, objectMap: FBXObjectMap): number | undefined {
    const parentConnection = objectMap.connections.find((conn) => conn.type === "OO" && conn.childId === modelId && objectMap.objects.get(conn.parentId)?.name === "Model");
    return parentConnection?.parentId;
}

function choosePreferredBoneSource(sources: FBXBoneData[]): FBXBoneData {
    return (
        sources.find((bone) => bone.isCluster && bone.transformLinkMatrix) ??
        sources.find((bone) => bone.isCluster) ??
        sources.find((bone) => bone.modelBindPoseMatrix) ??
        sources[0]!
    );
}

function collectTransformLinkWarnings(sourceBonesByModelId: Map<number, FBXBoneData[]>): string[] {
    const warnings: string[] = [];

    for (const [modelId, sources] of Array.from(sourceBonesByModelId)) {
        const matrices = sources.filter((bone) => bone.isCluster && bone.transformLinkMatrix).map((bone) => bone.transformLinkMatrix!);
        if (matrices.length < 2) {
            continue;
        }

        const first = matrices[0]!;
        if (matrices.some((matrix) => !areMatricesEquivalent(first, matrix, 1e-5))) {
            warnings.push(`Model ${modelId.toString()} has differing Cluster.TransformLink matrices across skins`);
        }
    }

    return warnings;
}

function areMatricesEquivalent(a: Float64Array, b: Float64Array, epsilon: number): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i]! - b[i]!) > epsilon) {
            return false;
        }
    }
    return true;
}

function createFallbackBone(modelId: number, objectMap: FBXObjectMap): FBXBoneData | null {
    const modelNode = objectMap.objects.get(modelId);
    if (!modelNode || modelNode.name !== "Model") {
        return null;
    }

    const transform = extractBoneTransform(modelNode);
    return {
        modelId,
        name: cleanFBXName(getPropertyValue<string>(modelNode, 1) ?? `Bone${modelId.toString()}`),
        index: -1,
        parentIndex: -1,
        isCluster: false,
        translation: transform.translation,
        rotation: transform.rotation,
        preRotation: transform.preRotation,
        postRotation: transform.postRotation,
        rotationPivot: transform.rotationPivot,
        scalingPivot: transform.scalingPivot,
        rotationOffset: transform.rotationOffset,
        scalingOffset: transform.scalingOffset,
        scale: transform.scale,
        rotationOrder: transform.rotationOrder,
        inheritType: transform.inheritType,
        clusterMode: "Unknown",
        bindPoseMatrix: null,
        transformLinkMatrix: null,
        transformAssociateModelMatrix: null,
        modelBindPoseMatrix: null,
        diagnostics: [],
    };
}

function compareNumber(a: number, b: number): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareSourceOrder(a: number, b: number, sourceOrderByModelId: Map<number, number>): number {
    const aOrder = sourceOrderByModelId.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = sourceOrderByModelId.get(b) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || compareNumber(a, b);
}
