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
import { _tangentFrag } from "../std-feature-hooks.js";

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

// The explicit-tangent TBN factory + its install hook live in std-feature-hooks.ts (a named-imported
// internal module) — NOT here — because this chunk is namespace-imported (`mod.bumpStdExt`), so any
// export here would be retained and `_tangentFrag` could never be proven null. Keeping the state +
// setter out of this chunk lets non-tangent bump scenes fold the tangent path away entirely.

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
    // canonical sorted order (matches the composer's vertex layout). Gated on `_tangentFrag` so the
    // body folds out of non-tangent bump scenes (where the tangent chunk never loaded); skipped at
    // runtime when the mesh has no tangent buffer (the cotangent variant declares no tangent attr).
    _bindVertexBuffers(mesh: Mesh, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number): number {
        if (_tangentFrag) {
            const g = mesh._gpu;
            if (g.tangentBuffer) {
                pass.setVertexBuffer(slot++, g.tangentBuffer, g._vbLayout?._t?._offset);
            }
        }
        return slot;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.bumpTexture) {
            out.push(mat.bumpTexture);
        }
    },
};
