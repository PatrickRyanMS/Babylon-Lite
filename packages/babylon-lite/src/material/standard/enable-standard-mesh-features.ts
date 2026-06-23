/**
 * Opt-in enablers for the Standard material's deform/vertex mesh features (vertex color, morph,
 * skeleton, normal-map tangent). Each registers a dispatcher into the Standard group-builder's
 * module-local `_stdMeshExtDispatch` registry so the group-builder dynamically loads the matching
 * fragment chunk when a mesh in the group has the feature.
 *
 * This is the **net-neutral fold seam** (same pattern as `enableMaterialStencil`): a scene that
 * never calls one of these never imports this module, so the group-builder's dispatch registry and
 * the per-feature shader chunks fold completely out of the bundle. The FBX loader is the caller —
 * it invokes the matching `enableStandard*()` when it builds a mesh that uses the feature, so only
 * FBX (or other opt-in) scenes pay for them; plain Standard scenes stay byte-identical to upstream.
 *
 * Each enabler is idempotent (registers its dispatcher at most once per session).
 */

import type { Mesh } from "../../mesh/mesh.js";
import { _registerStdMeshExtDispatch } from "./standard-group-builder.js";
import { _installStandardUvOffset } from "./standard-pipeline.js";

let _vColorEnabled = false;
/** Enable Standard per-vertex color (RGB). Called by loaders that build vertex-colored meshes. */
export function enableStandardVertexColor(): void {
    if (_vColorEnabled) {
        return;
    }
    _vColorEnabled = true;
    _registerStdMeshExtDispatch([(m: Mesh) => !!m._gpu?.colorBuffer, () => import("./fragments/std-vertex-color-fragment.js"), "stdVertexColorExt"]);
}

let _morphEnabled = false;
/** Enable Standard morph-target deformation. Called by loaders that build morph-target meshes. */
export function enableStandardMorph(): void {
    if (_morphEnabled) {
        return;
    }
    _morphEnabled = true;
    _registerStdMeshExtDispatch([(m: Mesh) => !!m.morphTargets, () => import("./fragments/std-morph-fragment.js"), "stdMorphExt"]);
}

let _skeletonEnabled = false;
/** Enable Standard skeletal skinning. Called by loaders that build skinned meshes. */
export function enableStandardSkeleton(): void {
    if (_skeletonEnabled) {
        return;
    }
    _skeletonEnabled = true;
    _registerStdMeshExtDispatch([(m: Mesh) => !!m.skeleton, () => import("./fragments/std-skeleton-fragment.js"), "stdSkeletonExt"]);
}

let _normalTangentEnabled = false;
/** Enable the explicit-tangent TBN normal-map variant (Babylon FBX parity). Called by loaders that
 *  build bump-mapped meshes carrying authored/generated tangents. The chunk self-installs its
 *  fragment factory into `bumpStdExt`, so the dispatcher registers no StdExt (`key` is null). */
export function enableStandardNormalTangent(): void {
    if (_normalTangentEnabled) {
        return;
    }
    _normalTangentEnabled = true;
    _registerStdMeshExtDispatch([
        (m: Mesh) => !!m._gpu?.tangentBuffer && !!(m.material as { bumpTexture?: unknown }).bumpTexture,
        () => import("./fragments/std-normal-tangent-fragment.js"),
        null,
    ]);
}

let _uvOffsetEnabled = false;
/** Enable Standard UV offset (`material.uvOffset`). Called by loaders that set a non-zero UV
 *  translation (the FBX loader, from `uvTranslation`). Without this, the pipeline's UV-offset reads
 *  fold to a constant 0 so non-offset scenes stay byte-identical. */
export function enableStandardUvOffset(): void {
    if (_uvOffsetEnabled) {
        return;
    }
    _uvOffsetEnabled = true;
    _installStandardUvOffset();
}
