import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { StandardMaterialProps } from "./standard-material.js";

// ─── Feature Flags ──────────────────────────────────────────────────

export const HAS_DIFFUSE_TEXTURE = 1 << 0;
export const HAS_EMISSIVE_TEXTURE = 1 << 1;
export const HAS_BUMP_TEXTURE = 1 << 2;
export const HAS_SPECULAR_TEXTURE = 1 << 3;
export const HAS_AMBIENT_TEXTURE = 1 << 4;
export const HAS_LIGHTMAP_TEXTURE = 1 << 5;
export const HAS_OPACITY_TEXTURE = 1 << 6;
export const LIGHTMAP_USES_UV2 = 1 << 7;
export const AMBIENT_USES_UV2 = 1 << 8;
export const DOUBLE_SIDED = 1 << 9;
export const DIFFUSE_USES_UV2 = 1 << 10;
export const SPECULAR_USES_UV2 = 1 << 11;
export const OPACITY_FROM_RGB = 1 << 12;
export const HAS_REFLECTION_TEXTURE = 1 << 13;
export const DISABLE_LIGHTING = 1 << 14;
export const MATERIAL_ALPHA_BLEND = 1 << 16;
export const HAS_CUBE_REFLECTION = 1 << 17;
export const NO_COLOR_OUTPUT = 1 << 18;
export const HAS_DEPTH_EMISSIVE_TEXTURE = 1 << 19;
export const ESM_SHADOW_OUTPUT = 1 << 20;
export const GEOMETRY_OUTPUT = 1 << 21;
/** Lightmap is used as a baked shadowmap: multiplies the final color instead of adding. */
export const LIGHTMAP_SHADOWMAP = 1 << 15;
/** Lightmap UVs are V-flipped (BJS Texture.uAng === π → uv'=(u, 1-v)). */
export const LIGHTMAP_FLIP_V = 1 << 22;
/** Mesh has per-vertex RGB colors. Driven off the mesh's color buffer (not a material
 *  property), OR'd into the local feature bitmask for non-shadow colored meshes so the
 *  shared StdExt loop composes the vertex-color fragment and keys the pipeline correctly. */
export const HAS_VERTEX_COLOR = 1 << 23;
/** Mesh has morph targets. Driven off the mesh (not a material property), OR'd into the
 *  local feature bitmask for non-shadow morphed meshes so the shared StdExt loop composes
 *  the vertex-stage morph fragment and keys the pipeline correctly. */
export const HAS_MORPH_TARGETS = 1 << 24;
/** Scene has fog. Driven off `scene.fog` (not a material property), OR'd into the local
 *  feature bitmask for non-shadow color meshes so the template emits the fog varying, helper,
 *  and blend block — and keys the pipeline cache so fog/non-fog variants stay distinct. The
 *  fog WGSL is dynamic-imported from `std-fog-wgsl.ts` only when the scene has fog, so non-fog
 *  Standard scenes bundle zero fog bytes (mirrors the PBR fog gate). */
export const SCENE_HAS_FOG = 1 << 25;
/** Mesh has a skeleton (skeletal/skinning vertex deformation). Driven off the mesh (not a
 *  material property), OR'd into the local feature bitmask for non-shadow skinned meshes so the
 *  shared StdExt loop composes the vertex-stage skeleton fragment and keys the pipeline correctly.
 *  The bone texture binds via the trailing ext-bind loop and joints/weights via `_bindVertexBuffers`. */
export const HAS_SKELETON = 1 << 26;
/** Mesh skeleton uses 8-bone (joints1/weights1) skinning. OR'd alongside HAS_SKELETON. */
export const HAS_SKELETON_8 = 1 << 27;
/** Mesh has per-vertex tangents AND a bump/normal texture: render the normal map via the
 *  explicit-tangent TBN (Babylon FBX parity) instead of the screen-space cotangent frame.
 *  OR'd into the local feature bitmask for non-shadow bump meshes that carry a tangent buffer;
 *  the bump StdExt picks the explicit-tangent fragment when this bit is set, else the cotangent
 *  fallback. The tangent vertex buffer binds via `_bindVertexBuffers`. */
export const HAS_NORMAL_TANGENT = 1 << 28;

// ─── Standard Material Extension Registry ───────────────────────────

/** Bind-ordering phase for StdExt textures (alphabetical by id within phase, matching composer). */
export type StdExtPhase = "mesh";

/** Unified extension for Standard material. Each fragment module exports one.
 *  Fragments register via `_registerStdExt(ext)` at dynamic-import sites. */
export interface StdExt {
    /** @internal */
    readonly _id: string;
    /** @internal */
    readonly _phase: StdExtPhase;
    /** @internal Feature bit this ext gates on. */
    readonly _feature: number;
    /** @internal */
    _frag(features: number, shadowLights?: ShadowLightSlotLite[]): ShaderFragment;
    /** @internal Push group-1 bind entries starting at binding `b`; return new b.
     *  The optional `mesh` arg is supplied by the color/geometry bind-group builders for
     *  exts that bind mesh-driven resources (e.g. morph texture + weights); texture exts
     *  ignore it. */
    _bind?(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number, mesh?: Mesh): number;
    /** @internal Bind draw-time vertex buffers for this ext starting at `slot`; return the next slot.
     *  Called from the Standard draw closure (after base attrs/uv/uv2, before thin instances) in the
     *  same canonical sorted order the composer lays out fragment vertex attributes, so the bound
     *  buffer slots line up with the pipeline's vertex-buffer layout. Exts without draw-time vertex
     *  buffers (the common case) omit this hook and the loop skips them. */
    _bindVertexBuffers?(mesh: Mesh, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number): number;
    /** @internal Enumerate textures for acquire/release. */
    _textures?(mat: StandardMaterialProps, out: Texture2D[]): void;
}

export interface ShadowLightSlotLite {
    lightIndex: number;
    shadowType: "esm" | "pcf";
}

// Lazy-init: avoids a module-level `new Map()` that defeats tree-shaking for
// consumers importing flags/registry symbols without using extensions.
// See GUIDANCE.md §4 ("Zero module-level side effects").
let _stdExts: Map<string, StdExt> | null = null;
let _stdExtsSorted: readonly StdExt[] | null = null;

export function _registerStdExt(ext: StdExt): void {
    (_stdExts ??= new Map()).set(ext._id, ext);
    _stdExtsSorted = null;
}

export function _getStdExts(): ReadonlyMap<string, StdExt> {
    return (_stdExts ??= new Map());
}

export function _getStdExtsSorted(): readonly StdExt[] {
    if (!_stdExtsSorted) {
        const map = _stdExts;
        _stdExtsSorted = map ? Array.from(map.values()).sort((a, b) => a._id.localeCompare(b._id)) : [];
    }
    return _stdExtsSorted;
}

/** Derived: mesh needs UV attribute (any texture present). */
export const NEEDS_UV = HAS_DIFFUSE_TEXTURE | HAS_EMISSIVE_TEXTURE | HAS_BUMP_TEXTURE | HAS_SPECULAR_TEXTURE | HAS_AMBIENT_TEXTURE | HAS_LIGHTMAP_TEXTURE | HAS_OPACITY_TEXTURE;

/** Derived: mesh needs UV2 attribute. */
export const NEEDS_UV2 = LIGHTMAP_USES_UV2 | AMBIENT_USES_UV2 | DIFFUSE_USES_UV2 | SPECULAR_USES_UV2;
