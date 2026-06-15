/** Standard Vertex-Color Fragment — multiplies baseColor by the per-vertex RGB
 *  color (tight float32x3, stride 12) before lighting, matching BJS StandardMaterial. */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_VERTEX_COLOR } from "../standard-flags.js";

export function createStdVertexColorFragment(): ShaderFragment {
    return {
        _id: "std-vcolor",
        _vertexAttributes: [{ _name: "color", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 }],
        _varyings: [{ _name: "vColor", _type: "vec3<f32>" }],
        _vertexSlots: { VB: `out.vColor = color;` },
        // Backtick (not double-quote) so the bundle's WGSL identifier mangler rewrites
        // `baseColor` here to match the mangled declaration in the standard template.
        _fragmentSlots: { AT: `\nbaseColor = baseColor * input.vColor;` },
    };
}

/** Registry extension gated on `HAS_VERTEX_COLOR`. Vertex color is an attribute, not a
 *  UBO/texture, so there is no group-1 binding — the `_bind`/`_textures` hooks are omitted
 *  and the shared StdExt bind/texture loops skip it. */
export const stdVertexColorExt: StdExt = {
    _id: "std-vcolor",
    _phase: "mesh",
    _feature: HAS_VERTEX_COLOR,
    _frag: () => createStdVertexColorFragment(),
};
