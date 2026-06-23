/**
 * Explicit-tangent TBN normal-map fragment (Standard material) — faithful to Babylon's
 * StandardMaterial: the bitangent is built in OBJECT space (`cross(N,T)*tangent.w`) then
 * transformed by the world matrix, so Lite's RH→LH mirror root (negative determinant) is handled
 * with no green-channel flip. Used when a normal-mapped mesh carries a tangent buffer (e.g. the FBX
 * loader's authored/generated tangents).
 *
 * Lives in its own dynamically-imported chunk so non-tangent bump scenes (glTF/.babylon, which
 * fall back to the cotangent frame) never bundle it. On import it self-installs its factory into
 * `bumpStdExt` via `_installNormalTangentFrag`; the group builder imports this module only when a
 * bump mesh in the group also has a tangent buffer.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { HAS_MORPH_TARGETS, HAS_NORMAL_TANGENT } from "../standard-flags.js";
import { BUMP_BINDINGS, _installNormalTangentFrag } from "./normal-map-fragment.js";
import { _installStdExtFeature } from "../standard-renderable.js";

/**
 * Create the explicit-tangent TBN bump fragment. Declares the `tangent` vec4 vertex attribute and
 * the `worldTangent`/`worldBitangent` varyings, computes them in the VB vertex slot (after the VW
 * finalWorld assignment), and builds the world-space TBN in the fragment.
 *
 * @param features - Active feature bits; used to pick the morphed vs raw local normal.
 */
export function createStdNormalTangentFragment(features: number): ShaderFragment {
    // Use the same local normal the template uses for `out.vn` so the TBN's 3rd column is
    // consistent with the lit normal (morphedNorm when morph is active, else the raw attribute).
    const normVar = features & HAS_MORPH_TARGETS ? "morphedNorm" : "normal";
    return {
        _id: "normal-map",

        _vertexAttributes: [{ _name: "tangent", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 }],
        _varyings: [
            { _name: "worldTangent", _type: "vec3<f32>" },
            { _name: "worldBitangent", _type: "vec3<f32>" },
        ],

        _bindings: BUMP_BINDINGS.map((b) => ({ ...b })),

        // Object-space bitangent (cross(N,T)*w) THEN transform by finalWorld — matches Babylon
        // bumpVertex.fx + Lite PBR. Do NOT recompute the bitangent in world space (the RH→LH
        // mirror root has det<0 and would re-flip the green/V response).
        _vertexSlots: {
            VB: `let T_local_tbn = normalize(tangent.xyz);
let N_local_tbn = normalize(${normVar});
let B_local_tbn = cross(N_local_tbn, T_local_tbn) * tangent.w;
out.worldTangent = (finalWorld * vec4<f32>(T_local_tbn, 0.0)).xyz;
out.worldBitangent = (finalWorld * vec4<f32>(B_local_tbn, 0.0)).xyz;`,
        },

        _fragmentSlots: {
            AC: `let _nmSample = textureSample(bT, bS, input.vu).rgb * 2.0 - 1.0;
normalW = normalize(mat3x3<f32>(input.worldTangent, input.worldBitangent, normalize(input.vn)) * vec3<f32>(_nmSample.xy * mat.bs, _nmSample.z));`,
        },
    };
}

// Self-install: bumpStdExt's `_frag` invokes this factory for HAS_NORMAL_TANGENT draws once this
// chunk has loaded. The group builder dynamic-imports this module before composing.
_installNormalTangentFrag(createStdNormalTangentFragment);
// Also wire the tangent feature bit so the renderable's HAS_NORMAL_TANGENT feature-OR branch is
// active here and folds out of bundles that never enable it. See standard-renderable._stdExtBits.
_installStdExtFeature(HAS_NORMAL_TANGENT);
