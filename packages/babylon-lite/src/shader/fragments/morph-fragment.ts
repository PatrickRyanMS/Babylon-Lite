/**
 * Morph Target Fragment (shared)
 *
 * Vertex-stage morph target animation: texture-based morph deltas applied
 * before skinning. Material-agnostic — used by both the PBR and Standard
 * material composers. Only bundled when a scene uses morph targets.
 */

import type { BindingDecl, ShaderFragment } from "../fragment-types.js";

// WebGPU shader stage constants
const STAGE_VERTEX = 0x1;

const MORPH_PRE_SKINNING = `var morphedPos = position;
var morphedNorm = normal;
let mCol = i32(vertexIndex % morph.texWidth);
let mRowInBand = i32(vertexIndex / morph.texWidth);
for (var i = 0u; i < morph.count; i = i + 1u) {
  let w = morph.weights[i];
  let posBase = i32(i * 2u) * i32(morph.rowsPerBand);
  let normBase = i32(i * 2u + 1u) * i32(morph.rowsPerBand);
  morphedPos = morphedPos + w * textureLoad(morphTargets, vec2<i32>(mCol, posBase + mRowInBand), 0).xyz;
  morphedNorm = morphedNorm + w * textureLoad(morphTargets, vec2<i32>(mCol, normBase + mRowInBand), 0).xyz;
}`;

/**
 * Create a morph target fragment.
 * The morph extension modifies position/normal variables before the world
 * transform, using morphedPos/morphedNorm in place of position/normal.
 *
 * `bindingStyle` controls only WHERE the morph texture + weights UBO land in
 * group 1 — the WGSL/struct/builtins/VR are identical:
 *   - `"vertex"` (default): declared as `_vertexBindings`, placed by the composer
 *     immediately after the mesh UBO and before base bindings. Used by PBR.
 *   - `"afterBase"`: declared as `_bindings` (mesh group, vertex visibility), placed
 *     by the composer AFTER base bindings where the Standard trailing ext-bind loop
 *     runs — so morph can be wired as a plain StdExt with no bespoke bind code.
 */
export function createMorphFragment(opts?: { bindingStyle?: "vertex" | "afterBase" }): ShaderFragment {
    const morphBindings: BindingDecl[] = [
        { _name: "morphTargets", _type: { _kind: "texture", _textureType: "texture_2d<f32>", _sampleType: "unfilterable-float" }, _visibility: STAGE_VERTEX },
        { _name: "morph", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_VERTEX },
    ];
    return {
        _id: "morph",

        _vertexBuiltins: [{ _name: "vertexIndex", _builtin: "vertex_index", _type: "u32" }],

        _vertexHelperFunctions: `struct morphUniforms {\nweights: vec4<f32>,\ncount: u32,\ntexWidth: u32,\nrowsPerBand: u32,\n_p0: u32,\n}`,

        ...(opts?.bindingStyle === "afterBase" ? { _bindings: morphBindings } : { _vertexBindings: morphBindings }),

        _vertexSlots: {
            VR: MORPH_PRE_SKINNING,
        },
    };
}
