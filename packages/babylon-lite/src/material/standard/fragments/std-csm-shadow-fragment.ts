/**
 * Standard CSM Shadow Fragment — Per-Light Cascaded Shadow Support
 *
 * Thin wrapper around the shared csm-shadow-fragment-core for Standard
 * materials. Only bundled when a scene uses a CSM-shadow-receiving Standard mesh.
 *
 * The camera view-space z used for cascade selection is computed inline from the
 * world-position varying (input.vp) instead of the old input.vf.z. The two are
 * mathematically identical (vf was just the view-space position derived from the
 * same world position), so cascade selection is pixel-identical. This mirrors the
 * PBR CSM path and removes the dependency on the vf varying, which is now emitted
 * only when the scene has fog.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createCsmShadowFragment } from "../../../shader/fragments/csm-shadow-fragment-core.js";

export type { CsmShadowLightSlot } from "../../../shader/fragments/csm-shadow-fragment-core.js";
import type { CsmShadowLightSlot } from "../../../shader/fragments/csm-shadow-fragment-core.js";

/**
 * Create a per-light CSM shadow fragment for Standard materials.
 * The shadow factor for each light is stored in `shadowFactors[lightIndex]`.
 */
export function createStdCsmShadowFragment(shadowLights: CsmShadowLightSlot[]): ShaderFragment {
    return createCsmShadowFragment("std-csm-shadow", shadowLights, {
        worldPosExpr: "input.vp",
        viewZExpr: "(scene.view * vec4<f32>(input.vp, 1.0)).z",
    });
}
