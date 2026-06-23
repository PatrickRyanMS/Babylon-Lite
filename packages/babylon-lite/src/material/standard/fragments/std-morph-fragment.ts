/** Standard Morph-Target Extension — vertex-stage morph deformation wired as a plain
 *  StdExt. Reuses the shared, material-agnostic morph fragment (the same WGSL/struct/VR
 *  used by PBR) with `bindingStyle: "afterBase"` so the morph texture + weights UBO land
 *  AFTER the base bindings, where the shared StdExt bind loop already runs. No bespoke
 *  factory or bind-restructure — gated on the mesh-driven HAS_MORPH_TARGETS feature bit. */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createMorphFragment } from "../../../shader/fragments/morph-fragment.js";
import type { Mesh } from "../../../mesh/mesh.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_MORPH_TARGETS } from "../standard-flags.js";
import { _installStdExtFeature } from "../std-feature-hooks.js";

/** Registry extension gated on `HAS_MORPH_TARGETS`. The morph texture + weights UBO are
 *  vertex-only mesh-driven resources, so `_bind` pulls them off the mesh (not the material)
 *  and pushes them in the same order the composer declares them. No `_textures` — morph
 *  resources are owned by the mesh's morph manager, not the GPU texture pool. */
export const stdMorphExt: StdExt = {
    _id: "morph",
    _phase: "mesh",
    _feature: HAS_MORPH_TARGETS,
    _frag: (): ShaderFragment => createMorphFragment({ bindingStyle: "afterBase" }),
    _bind(_mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number, mesh?: Mesh): number {
        const mt = mesh!.morphTargets!;
        entries.push({ binding: b++, resource: mt.texture.createView() }, { binding: b++, resource: { buffer: mt.weightsBuffer } });
        return b;
    },
};

// Loading this chunk wires the morph feature bit into the bundle (folds the renderable's feature-OR
// branch in scenes that never enable morph targets). See standard-renderable._stdExtBits.
_installStdExtFeature(HAS_MORPH_TARGETS);
