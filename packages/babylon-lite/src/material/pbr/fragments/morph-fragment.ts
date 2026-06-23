/**
 * Morph Target Fragment (PBR ext wrapper)
 *
 * Re-exports the shared, material-agnostic morph fragment and wraps it in a
 * PBR extension (`PbrExt`) so the PBR composer can detect/bind morph targets.
 * The shared `createMorphFragment` lives in `shader/fragments/morph-fragment.ts`
 * and is reused by the Standard material side without pulling in this wrapper.
 */

import { createMorphFragment } from "../../../shader/fragments/morph-fragment.js";

export { createMorphFragment };

import type { PbrExt } from "../pbr-flags.js";
import { MSH_HAS_MORPH_TARGETS } from "../../mesh-features.js";

export const pbrExt: PbrExt = {
    id: "morph",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx._meshFeatures & MSH_HAS_MORPH_TARGETS)) {
            return null;
        }
        return createMorphFragment();
    },
    bind(ctx, entries, b) {
        const mesh = ctx._mesh;
        if (!(ctx._meshFeatures & MSH_HAS_MORPH_TARGETS) || !mesh?.morphTargets) {
            return b;
        }
        entries.push({ binding: b++, resource: mesh.morphTargets.texture.createView() });
        // Weights UBO is pushed separately by the pipeline (needs engine-side buffer handle).
        // Caller supplies weightsBuffer on mesh.morphTargets.
        if (mesh.morphTargets.weightsBuffer) {
            entries.push({ binding: b++, resource: { buffer: mesh.morphTargets.weightsBuffer } });
        }
        return b;
    },
};
