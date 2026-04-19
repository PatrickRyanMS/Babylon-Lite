/**
 * Refraction Fragment — KHR_materials_transmission + _volume + _ior.
 *
 * V1: env-only refraction. Samples the IBL specular cube along the refracted
 * view direction (Snell), modulated by Beer-Lambert absorption using volume
 * attenuation color + distance. No opaque-scene RTT is needed — a full-fidelity
 * scene-behind-the-glass sample is a follow-up extension.
 *
 * Maps BJS SubSurfaceConfiguration.refraction with useOpaqueSceneTexture=false.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SubSurfaceProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR2_HAS_REFRACTION, PBR2_HAS_VOLUME } from "../pbr-flags.js";

// AI: applied inside the IBL-modification slot, after subsurface had its chance.
// Reuses iblTexture + iblSampler (already bound for IBL).
// `color` at this point contains the pre-refraction shaded output. Mix the refraction
// contribution in by `transmissionFactor` and modulate by Beer-Lambert absorption
// when KHR_materials_volume is present.
function makeRefractionMod(hasVolume: boolean): string {
    // Beer-Lambert: exp(-sigma_a * d) where sigma_a = -log(color) / dist.
    // BJS formulation: absorption = exp(ln(attenuationColor) * thickness / attenuationDistance)
    // We pre-bake ln(attenuationColor)/attenuationDistance into volumeParams.rgb on the CPU side.
    const absorption = hasVolume ? `let absorption = exp(material.volumeParams.rgb * material.refractionParams.z);` : `let absorption = vec3<f32>(1.0);`;

    return `{
let etaRatio = 1.0 / max(material.refractionParams.y, 1.001);
let refrDir_raw = refract(-V, N, etaRatio);
let refrDir = rotateY(refrDir_raw, scene.envRotationY);
let refrMaxLod = f32(textureNumLevels(iblTexture) - 1);
let refrLod = clamp(roughness * refrMaxLod, 0.0, refrMaxLod);
let refrSample = textureSampleLevel(iblTexture, iblSampler, refrDir, refrLod).rgb * material.environmentIntensity;
${absorption}
let refractionColor = refrSample * absorption;
let transmission = material.refractionParams.x;
color = mix(color, refractionColor, transmission);
}`;
}

/**
 * Create a refraction fragment.
 * @param hasVolume Whether KHR_materials_volume data is present (Beer-Lambert absorption).
 */
export function createRefractionFragment(hasVolume: boolean): ShaderFragment {
    const uboFields: { name: string; type: "vec4<f32>" }[] = [{ name: "refractionParams", type: "vec4<f32>" as const }];
    if (hasVolume) {
        uboFields.push({ name: "volumeParams", type: "vec4<f32>" as const });
    }
    return {
        id: "refraction",
        // Must come after IBL so `color` already contains the shaded output; also requires
        // the env cube binding + rotateY helper provided by IBL.
        dependencies: ["ibl"],
        uboFields,
        fragmentSlots: { AI: makeRefractionMod(hasVolume) },
    };
}

/** Write refraction UBO data. */
function writeRefractionUBO(data: Float32Array, mat: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const ss = mat.subsurface as SubSurfaceProps | undefined;
    const refr = ss?.refraction;
    if (!refr) {
        return;
    }
    const off = offsets.get("refractionParams");
    if (off === undefined) {
        return;
    }
    const o = off / 4;
    data[o] = refr.intensity ?? 0;
    data[o + 1] = refr.indexOfRefraction ?? 1.5;
    // Thickness (distance light travels through medium). Use the thickness max; falls back to 1.
    const thick = ss!.thickness;
    data[o + 2] = thick?.max ?? 1.0;
    data[o + 3] = refr.useThicknessAsDepth ? 1.0 : 0.0;

    // Volume (Beer-Lambert) — pre-bake ln(tint)/attenuationDistance so the fragment can do exp(x * thickness).
    const vOff = offsets.get("volumeParams");
    if (vOff !== undefined) {
        const vo = vOff / 4;
        const tint = ss!.tint?.color ?? [1, 1, 1];
        const dist = Math.max(ss!.tint?.atDistance ?? 1, 0.0001);
        // log(0) is -Infinity; clamp tiny values to avoid NaN.
        data[vo] = Math.log(Math.max(tint[0]!, 1e-6)) / dist;
        data[vo + 1] = Math.log(Math.max(tint[1]!, 1e-6)) / dist;
        data[vo + 2] = Math.log(Math.max(tint[2]!, 1e-6)) / dist;
        data[vo + 3] = 0;
    }
}

export const refractionExt: PbrExt = {
    id: "refraction",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        const ss = m.subsurface as SubSurfaceProps | undefined;
        const refr = ss?.refraction;
        if (!refr || (refr.intensity ?? 0) <= 0) {
            return { f: 0, f2: 0 };
        }
        let f2 = PBR2_HAS_REFRACTION;
        if (ss!.tint?.atDistance !== undefined) {
            f2 |= PBR2_HAS_VOLUME;
        }
        return { f: 0, f2 };
    },
    frag(ctx) {
        if (!(ctx.features2 & PBR2_HAS_REFRACTION)) {
            return null;
        }
        return createRefractionFragment((ctx.features2 & PBR2_HAS_VOLUME) !== 0);
    },
    writeUbo(data, mat, offsets) {
        if (offsets.has("refractionParams")) {
            writeRefractionUBO(data, mat as PbrMaterialProps, offsets);
        }
    },
};
