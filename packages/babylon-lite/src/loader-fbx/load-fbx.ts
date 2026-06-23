/**
 * FBX loader — core static-mesh path.
 *
 * Scope: geometry + per-model Standard materials (colors **and** textures —
 * embedded or external, with multi-material splits) + the node hierarchy,
 * returned as an {@link AssetContainer} that renders. Cameras and lights are
 * supported but their builders (`fbx-camera-build.ts` / `fbx-light-build.ts`)
 * are DYNAMIC-imported only when the file declares them, so a camera/light-free
 * FBX pays zero bytes for them. Morph targets, skeletons and node animation are
 * likewise DYNAMIC-imported only when the file declares them (see below), so a
 * plain static model pays zero bytes for any of them.
 *
 * Coordinate handling mirrors the glTF loader: geometry stays in its original
 * right-handed space and a synthetic `__root__` node with scale `[-1, 1, 1]`
 * applies the RH→LH flip for the whole hierarchy (BJS FBX uses rotation.y = π
 * plus scale.z = -1, which nets to the identical diag(-1, 1, 1) X-flip).
 *
 * Morph targets (FBX blend shapes) are handled by `fbx-morph-build.ts`, skeletons
 * (FBX skin deformers) by `fbx-skeleton-build.ts`, and node animation by
 * `fbx-animation-build.ts` — each DYNAMIC-imported only when the file declares the
 * matching deformer/curves, so a static model never imports any of them. Visual
 * skinning (Standard-pipeline skeleton rendering) is wired in a later phase; the
 * skeleton pass here gets the skinning + bind DATA correct (rest/bind pose).
 */

import type { EngineContext } from "../engine/engine.js";
import type { AssetContainer } from "../asset-container.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Mat4, Mat4Storage } from "../math/types.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";

import { createSceneNode, createSceneNodeFromMatrix } from "../scene/scene-node.js";
import { createTransformNode } from "../scene/transform-node.js";
import { uploadMeshToGPU, initMeshTransform } from "../mesh/mesh.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { enableStandardVertexColor, enableStandardNormalTangent } from "../material/standard/enable-standard-mesh-features.js";
import { mat4Multiply } from "../math/mat4-multiply.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { computeAabb } from "../math/compute-aabb.js";

import { parseBinaryFBX } from "./parsers/fbx-binary-parser.js";
import { parseAsciiFBX } from "./parsers/fbx-ascii-parser.js";
import { interpretFBX } from "./interpreter/fbx-interpreter.js";
import type { FBXModelData } from "./interpreter/fbx-interpreter.js";
import type { FBXObjectMap } from "./interpreter/connections.js";
import { getPropertyValue } from "./types/fbx-types.js";
import { computeFBXLocalMatrix } from "./interpreter/transform.js";
import { fbxMatDecompose } from "./interpreter/fbx-mat4.js";
import { buildFbxMeshData } from "./fbx-mesh-data.js";
import { groupTrianglesByMaterial } from "./fbx-multimaterial.js";
import { computeFbxAxisConversionMatrix } from "./fbx-axis.js";
import { buildFbxMaterials } from "./fbx-material-build.js";

/** First 21 bytes of every binary FBX file. */
const FBX_BINARY_MAGIC = "Kaydara FBX Binary  \0";

/** Detect a binary FBX by its leading magic; everything else is treated as ASCII. */
function isBinaryFbx(bytes: Uint8Array): boolean {
    if (bytes.length < FBX_BINARY_MAGIC.length) {
        return false;
    }
    for (let i = 0; i < FBX_BINARY_MAGIC.length; i++) {
        if (bytes[i] !== FBX_BINARY_MAGIC.charCodeAt(i)) {
            return false;
        }
    }
    return true;
}

/**
 * Map an FBX material to Standard-material props (BJS `_createMaterial` rules:
 * Lambert → no specular, factors fold into colours, alpha from opacity /
 * transparency, plus diffuse/normal/emissive/specular/ambient/opacity/reflection
 * texture slots) plus async texture loading lives in `fbx-material-build.ts`;
 * `loadFbx` builds the full material map (textures included) up front and passes
 * it down, so mesh building stays synchronous.
 */

/** Build one or more identity-transform Meshes for a model's geometry. The
 *  model's node carries the transform; the geometric transform is baked into the
 *  vertices. A geometry whose triangles reference several materials yields one
 *  Mesh per material range — all share the same vertex buffers but draw a
 *  contiguous slice of a reordered index buffer (mirrors the `.babylon` loader). */
function buildFbxMeshes(engine: EngineContext, model: FBXModelData, nodeWorld: Mat4, materialMap: Map<number, StandardMaterialProps>): Mesh[] {
    const geom = model.geometry!;
    const data = buildFbxMeshData(geom, model.geometricTranslation, model.geometricRotation, model.geometricScaling);
    // Opt the Standard material into the vertex-color / explicit-tangent normal-map features this
    // geometry needs. These enablers install the dispatch + fold the feature in (net-neutral when no
    // FBX scene uses them); idempotent, so calling per-model is fine.
    if (data.colors) {
        enableStandardVertexColor();
    }
    if (data.tangents) {
        enableStandardNormalTangent();
    }
    const grouped = groupTrianglesByMaterial(data.indices, geom.materialIndices);
    const [boundMin, boundMax] = computeAabb(data.positions, nodeWorld);
    const baseName = geom.name || model.name || `fbx_mesh_${model.id}`;
    const multi = grouped.ranges.length > 1;

    const meshes: Mesh[] = [];
    for (const range of grouped.ranges) {
        const subIndices = grouped.reordered.slice(range.start, range.start + range.count);
        // Pass tight-RGB vertex colors (8th arg) and per-vertex tangents (7th arg) through
        // to the GPU. The Standard pipeline renders vertex colors via the tree-shaken
        // vertex-color fragment and normal maps via the tree-shaken explicit-tangent path
        // when tangents are present (Babylon parity), falling back to the cotangent frame
        // otherwise. uvs2 is unused here.
        const gpu = uploadMeshToGPU(engine, data.positions, data.normals, subIndices, data.uvs ?? undefined, undefined, data.tangents ?? undefined, data.colors ?? undefined);
        const fbxMat = model.materials[range.materialIndex] ?? model.materials[0];
        const material = (fbxMat ? materialMap.get(fbxMat.id) : undefined) ?? createStandardMaterial();

        const mesh = {
            name: multi ? `${baseName}_sub${range.materialIndex}` : baseName,
            id: String(model.id),
            material,
            receiveShadows: false,
            boundMin,
            boundMax,
            skeleton: null,
            morphTargets: null,
            _materialDirty: false,
            _gpu: gpu,
        } as unknown as Mesh;
        initMeshTransform(mesh); // identity — transform lives on the parent node

        // Retain CPU geometry for picking / AABB refresh, mirroring the glTF path.
        mesh._cpuPositions = data.positions;
        mesh._cpuNormals = data.normals;
        mesh._cpuUvs = data.uvs ?? undefined;
        mesh._cpuIndices = subIndices;

        meshes.push(mesh);
    }

    return meshes;
}

/** A geometry's built meshes plus the source data a later morph-target pass needs.
 *  Defined locally (structurally identical to `fbx-morph-build.ts`'s `FbxMorphRecord`)
 *  so this core module never STATICALLY imports the morph code path. */
interface FbxMorphRecord {
    meshes: Mesh[];
    geometry: NonNullable<FBXModelData["geometry"]>;
    model: FBXModelData;
}

/** Cheap blend-shape probe: a single pass over the resolved object table looking
 *  for a `BlendShape` deformer — the exact signal the morph extractor keys on, so
 *  it's both cheap and reliable. Returning false means no morph code is imported. */
function hasFbxBlendShapes(objectMap: FBXObjectMap): boolean {
    for (const node of objectMap.objects.values()) {
        if (node.name === "Deformer" && getPropertyValue<string>(node, 2) === "BlendShape") {
            return true;
        }
    }
    return false;
}

/** Cheap animation probe: a single pass over the resolved object table looking
 *  for an `AnimationCurveNode` — the signal the animation extractor keys on.
 *  Returning false means no animation code is imported and every model node is
 *  built as a static matrix node (byte-identical to the pre-animation path). */
function hasFbxAnimation(objectMap: FBXObjectMap): boolean {
    for (const node of objectMap.objects.values()) {
        if (node.name === "AnimationCurveNode" || node.name === "AnimationStack") {
            return true;
        }
    }
    return false;
}

/** Cheap skin probe: a single pass over the resolved object table looking for a
 *  `Skin`/`Cluster` deformer — the exact signal the skin extractor keys on, so
 *  it's both cheap and reliable. Returning false means no skeleton code is
 *  imported and every mesh keeps `skeleton = null` (byte-identical to the
 *  pre-skinning path). */
function hasFbxSkins(objectMap: FBXObjectMap): boolean {
    for (const node of objectMap.objects.values()) {
        if (node.name === "Deformer") {
            const subType = getPropertyValue<string>(node, 2);
            if (subType === "Skin" || subType === "Cluster") {
                return true;
            }
        }
    }
    return false;
}

/** An FBX model node plus the data the animation builder needs to drive it.
 *  Defined locally (structurally identical to `fbx-animation-build.ts`'s
 *  `FbxAnimatedModel`) so this core module never STATICALLY imports the animation
 *  code path. Index = position in the array (= the animation node index). */
interface FbxAnimatedModel {
    model: FBXModelData;
    node: SceneNode;
    parentIndex: number;
}

/** Recursively build a scene node for an FBX model and its children.
 *  `parentWorld` is the accumulated node world matrix (the synthetic root flip is
 *  excluded; the axis-conversion matrix, when present, seeds the recursion so the
 *  baked mesh AABBs match the rendered world space) used only for mesh AABB
 *  computation / camera framing.
 *
 *  `worldMap` collects each model's FULL Lite-space world matrix (root flip
 *  composed back in via `rootFlip`) keyed by model id, so the camera/light
 *  builders can place those nodes in the same space the meshes render in. */
function buildModelNode(
    engine: EngineContext,
    model: FBXModelData,
    parentWorld: Mat4,
    materialMap: Map<number, StandardMaterialProps>,
    worldMap: Map<number, Mat4>,
    rootFlip: Mat4,
    morphRecords: FbxMorphRecord[],
    animated: boolean,
    modelNodes: FbxAnimatedModel[],
    modelIdToIndex: Map<number, number>,
    parentIndex: number
): SceneNode {
    const local = computeFBXLocalMatrix(model);
    const name = model.name || `fbx_model_${model.id}`;
    // Animated files build every model as a writeable TRS node (decomposed from
    // the same local matrix), so the animation controller can push evaluated TRS
    // onto it; a static matrix node ignores position/rotation/scaling writes.
    // Animation-free files keep the byte-identical static-matrix node.
    let node: SceneNode;
    if (animated) {
        const { t, q, s } = fbxMatDecompose(local);
        node = createSceneNode(name, t[0], t[1], t[2], q[0], q[1], q[2], q[3], s[0], s[1], s[2]);
    } else {
        node = createSceneNodeFromMatrix(name, local);
    }

    const myIndex = modelNodes.length;
    modelNodes.push({ model, node, parentIndex });
    modelIdToIndex.set(model.id, myIndex);

    // Bridge rule: world = mat4Multiply(parentWorld, childLocal).
    const nodeWorld = mat4Multiply(parentWorld, local);
    // Full Lite-space world = rootFlip · nodeWorld (rootFlip is left-multiplied at
    // the very top of the hierarchy, so this matches root → [axis] → node order).
    worldMap.set(model.id, mat4Multiply(rootFlip, nodeWorld));

    if (model.geometry) {
        const meshes = buildFbxMeshes(engine, model, nodeWorld, materialMap);
        for (const mesh of meshes) {
            node.children.push(mesh);
        }
        // Record the built meshes for the optional, lazy morph-target pass.
        morphRecords.push({ meshes, geometry: model.geometry, model });
    }

    for (const child of model.children) {
        node.children.push(buildModelNode(engine, child, nodeWorld, materialMap, worldMap, rootFlip, morphRecords, animated, modelNodes, modelIdToIndex, myIndex));
    }

    return node;
}

/**
 * Load an FBX file (binary or ASCII) and return an {@link AssetContainer}.
 * Pass the result to `addToScene()`, which registers meshes and wires parent
 * links by recursing the returned node tree.
 */
export async function loadFbx(engine: EngineContext, url: string): Promise<AssetContainer> {
    const buffer = await fetch(url).then((r) => r.arrayBuffer());
    const bytes = new Uint8Array(buffer);
    const doc = isBinaryFbx(bytes) ? parseBinaryFBX(buffer) : parseAsciiFBX(new TextDecoder().decode(bytes));
    const fbxScene = interpretFBX(doc);

    // Texture resolution context: the FBX directory plus its `<name>.fbm/`
    // embedded-media folder (FBX SDK extracts embedded images there, so external
    // sidecars are found even when the stored path points outside the project).
    const slash = url.lastIndexOf("/");
    const baseUrl = url.substring(0, slash + 1);
    const fileName = url.substring(slash + 1);
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.substring(0, dot) : fileName;
    const fbmDir = stem ? `${baseUrl}${stem}.fbm/` : undefined;

    // Build every material (colors + textures) up front so mesh building stays
    // synchronous, mirroring the `.babylon` loader's texturePromises pattern.
    const { materials: materialMap, diagnostics } = await buildFbxMaterials(engine, fbxScene.materials, baseUrl, fbmDir);
    for (const message of diagnostics) {
        console.warn(`[loadFbx] ${message}`);
    }

    // Axis/unit conversion: when the file isn't already Babylon's default Y-up
    // frame at unit scale, an extra node applies the basis change + unit scale to
    // the whole hierarchy. Seeding the AABB recursion with it keeps baked bounds
    // in the rendered world space (the root flip stays excluded, as before).
    const axisMatrix = computeFbxAxisConversionMatrix(fbxScene);
    const startWorld = axisMatrix ?? mat4Identity();

    // The synthetic `__root__` node applies the RH→LH flip via scale `[-1, 1, 1]`
    // — a pure diag(-1, 1, 1, 1) matrix. We fold it back into each node's world
    // matrix in `worldMap` so cameras/lights land in the same Lite world space the
    // meshes render in (their AABB `nodeWorld` deliberately excludes it).
    const rootFlip = mat4Identity();
    (rootFlip as unknown as Mat4Storage)[0] = -1;

    const worldMap = new Map<number, Mat4>();
    const morphRecords: FbxMorphRecord[] = [];
    // Detect animation up front so every model node is built writeable (TRS) when
    // animated; the animation builder itself is dynamic-imported only when needed.
    const animated = hasFbxAnimation(fbxScene._objectMap);
    const modelNodes: FbxAnimatedModel[] = [];
    const modelIdToIndex = new Map<number, number>();
    const rootNodes = fbxScene.rootModels.map((m) =>
        buildModelNode(engine, m, startWorld, materialMap, worldMap, rootFlip, morphRecords, animated, modelNodes, modelIdToIndex, -1)
    );

    // Synthetic root (like BJS __root__) applies the RH→LH conversion via scale.
    const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
    if (axisMatrix) {
        // Parent the models under a dedicated axis-conversion node, itself the
        // single child of __root__, so the basis change is a pure additional
        // transform and never double-flips handedness.
        const axisNode = createSceneNodeFromMatrix("__fbx_axis_conversion__", axisMatrix);
        axisNode.children.push(...rootNodes);
        root.children.push(axisNode);
    } else {
        root.children.push(...rootNodes);
    }

    const container: AssetContainer = { entities: [root] };

    // Morph targets (FBX blend shapes) are DYNAMIC-imported only when the file
    // declares a BlendShape deformer, so a morph-free FBX pays zero bytes for the
    // extractor + GPU morph factory. The build assigns `mesh.morphTargets` to every
    // mesh built from a geometry that carries a blend shape, and returns the per-mesh
    // morph-animation handoff the animation builder (Phase 7c) consumes. Types are
    // referenced via `typeof import(...)` (a type-only construct that emits no static
    // import edge), so the dynamic module is still loaded only when needed.
    let morphAnimBindings: Awaited<ReturnType<(typeof import("./fbx-morph-build.js"))["applyFbxMorphTargets"]>> = [];
    if (hasFbxBlendShapes(fbxScene._objectMap)) {
        const morphBuild = await import("./fbx-morph-build.js");
        const morphDiagnostics: string[] = [];
        morphAnimBindings = await morphBuild.applyFbxMorphTargets(engine, fbxScene._objectMap, morphRecords, morphDiagnostics);
    }

    // Skeletons (FBX skin deformers) are DYNAMIC-imported only when the file
    // declares a Skin/Cluster deformer, so a skin-free FBX pays zero bytes for the
    // skin/rig interpreter passes + GPU skeleton factory. The build assigns
    // `mesh.skeleton` to every mesh built from a skinned geometry and returns the
    // per-mesh binding handoff the animation builder (Phase 7b) consumes. The same
    // per-geometry records collected for the morph pass are reused here.
    let skeletonBindings: Awaited<ReturnType<(typeof import("./fbx-skeleton-build.js"))["applyFbxSkeletons"]>> = [];
    if (hasFbxSkins(fbxScene._objectMap)) {
        const skeletonBuild = await import("./fbx-skeleton-build.js");
        const skeletonDiagnostics: string[] = [];
        skeletonBindings = await skeletonBuild.applyFbxSkeletons(engine, fbxScene._objectMap, morphRecords, skeletonDiagnostics);
        if (skeletonBindings.length) {
            container._fbxSkeletonBindings = skeletonBindings;
        }
    }

    // Cameras + lights are DYNAMIC-imported so a camera/light-free FBX pays zero
    // bytes for them. The camera goes on `container.camera` (addToScene applies it
    // as scene.camera when the scene has none); lights are top-level entities
    // (siblings of __root__) because their world transform is already baked in —
    // parenting them under the flip would double-apply it.
    if (fbxScene.cameras.length) {
        const cameraBuild = await import("./fbx-camera-build.js");
        const cam = fbxScene.cameras[0]!;
        container.camera = cameraBuild.buildFbxCamera(cam, worldMap.get(cam.modelId) ?? mat4Identity());
    }
    if (fbxScene.lights.length) {
        const lightBuild = await import("./fbx-light-build.js");
        for (const light of fbxScene.lights) {
            container.entities.push(lightBuild.buildFbxLight(light, worldMap.get(light.modelId) ?? mat4Identity()));
        }
    }

    // Node / skeletal / morph animation is DYNAMIC-imported only when the file
    // declares animation curves, so a static FBX pays zero bytes for the extractor +
    // build step. The models were already built as writeable TRS nodes above (when
    // `animated`), so the controller can push evaluated TRS straight onto them; the
    // skeleton + morph handoffs drive the bone texture / weights buffer per frame.
    if (animated) {
        const animBuild = await import("./fbx-animation-build.js");
        const groups = animBuild.buildFbxAnimationGroups(fbxScene._objectMap, modelNodes, modelIdToIndex, skeletonBindings, morphAnimBindings);
        if (groups.length) {
            container.animationGroups = groups;
        }
    }

    return container;
}
