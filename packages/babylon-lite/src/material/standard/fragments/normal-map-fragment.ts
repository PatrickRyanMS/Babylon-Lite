/**
 * Normal Map Fragment (Standard material) — cotangent fallback variant.
 *
 * This module holds the screen-space **cotangent frame** bump fragment (used when the mesh has
 * no tangent attribute — exactly like Babylon's StandardMaterial fallback) plus `bumpStdExt`,
 * the always-on bump extension dynamic-imported whenever a material has a bump texture.
 *
 * The **explicit-tangent TBN** variant (`HAS_NORMAL_TANGENT`, Babylon FBX parity) lives in its
 * own chunk (`std-normal-tangent-fragment.ts`) and self-installs its factory via
 * `_installNormalTangentFrag`, so non-tangent bump scenes (glTF/.babylon) never bundle it.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { Mesh } from "../../../mesh/mesh.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_BUMP_TEXTURE, HAS_NORMAL_TANGENT } from "../standard-flags.js";
import { WGSL_PERTURB_NORMAL } from "../../../shader/wgsl-helpers.js";

const STAGE_FRAGMENT = 0x2;

/** The bump texture + sampler bindings — identical for both normal-map variants. */
export const BUMP_BINDINGS = [
    { _name: "bT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
    { _name: "bS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
] as const;

/**
 * Create the screen-space cotangent-frame bump fragment (no tangent attribute).
 * Used as the fallback when the mesh has no tangents.
 */
export function createNormalMapFragment(): ShaderFragment {
    return {
        _id: "normal-map",

        _bindings: BUMP_BINDINGS.map((b) => ({ ...b })),

        _helperFunctions: WGSL_PERTURB_NORMAL,

        _fragmentSlots: {
            AC: `normalW = perturbNormal(input.vn, input.vp, input.vu, mat.bs);`,
        },
    };
}

// Explicit-tangent TBN factory, injected by std-normal-tangent-fragment.ts (its own chunk).
// Stays null on non-tangent bump scenes, so `_frag` only ever calls the cotangent path there.
let _tangentFrag: ((features: number) => ShaderFragment) | null = null;
/** @internal Install the explicit-tangent normal-map fragment factory. Called on import of
 *  std-normal-tangent-fragment.ts (loaded only when an FBX-tangent bump mesh is present). */
export function _installNormalTangentFrag(frag: (features: number) => ShaderFragment): void {
    _tangentFrag = frag;
}

export const bumpStdExt: StdExt = {
    _id: "normal-map",
    _phase: "mesh",
    _feature: HAS_BUMP_TEXTURE,
    // Use the explicit-tangent TBN when the mesh carries tangents (HAS_NORMAL_TANGENT) AND that
    // variant's chunk has been loaded; else the cotangent fallback. Both share bT/bS + _bind below.
    _frag: (features: number) => (features & HAS_NORMAL_TANGENT && _tangentFrag ? _tangentFrag(features) : createNormalMapFragment()),
    _bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const tex = mat.bumpTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    // The explicit-tangent variant adds a `tangent` vertex attribute; bind its buffer here in the
    // canonical sorted order (matches the composer's vertex layout). Skipped when the mesh has no
    // tangent buffer (the cotangent variant declares no tangent attribute).
    _bindVertexBuffers(mesh: Mesh, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number): number {
        const g = mesh._gpu;
        if (g.tangentBuffer) {
            pass.setVertexBuffer(slot++, g.tangentBuffer, g._vbLayout?._t?._offset);
        }
        return slot;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.bumpTexture) {
            out.push(mat.bumpTexture);
        }
    },
};
