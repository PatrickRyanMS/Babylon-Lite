/** Standard Specular Texture Fragment — replaces specular color with texture sample. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";

const STAGE_FRAGMENT = 0x2;

export function createStdSpecularFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vUV2" : "input.vUV";
    return {
        id: "std-specular",
        bindings: [
            { name: "specularTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "specularSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            AT: `specularColor = textureSample(specularTex, specularSampler, ${uv}).rgb;`,
        },
    };
}
