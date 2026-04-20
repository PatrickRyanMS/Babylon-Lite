/**
 * Shared WGSL helpers for billboard sprite shader composers.
 *
 * Tiny TS string consts concatenated into each variant's vertex / fragment
 * WGSL. Mirrors the convention used by the larger PBR/Background composers
 * (see `shader/wgsl-helpers.ts`). No `?raw` imports — sprite shaders are too
 * small + parameterised to benefit from separate `.wgsl` files.
 */

import type { SpriteBlendMode } from "./sprite-atlas.js";

/** VSIn struct — identical for all three billboard variants. */
export const BILLBOARD_VS_IN_WGSL = /* wgsl */ `
struct VSIn {
    @builtin(vertex_index) vid: u32,
    @location(0) worldPos: vec3<f32>,
    @location(1) reserved0: f32,
    @location(2) reserved1: vec2<f32>,
    @location(3) sizeWorld: vec2<f32>,
    @location(4) pivot: vec2<f32>,
    @location(5) sinCos: vec2<f32>,
    @location(6) uvRect: vec4<f32>,
    @location(7) color: vec4<f32>,
    @location(8) flagsAndPad: vec4<f32>,
};

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

fn rotate2(p: vec2<f32>, sinCos: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(p.x * sinCos.y - p.y * sinCos.x, p.x * sinCos.x + p.y * sinCos.y);
}

fn cornerOf(vid: u32) -> vec2<f32> {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
    );
    return corners[vid];
}

fn cornerUV(corner: vec2<f32>, rect: vec4<f32>, flipX: f32, flipY: f32) -> vec2<f32> {
    var u = mix(rect.x, rect.z, corner.x);
    var v = mix(rect.y, rect.w, corner.y);
    if (flipX > 0.5) { u = rect.x + rect.z - u; }
    if (flipY > 0.5) { v = rect.y + rect.w - v; }
    return vec2<f32>(u, v);
}
`;

/** Build the shared sprite fragment WGSL. `layerStructWGSL` lets the
 *  axis-locked variant swap `SpriteLayerUBO` for `AxisLockedBillboardSystemUBO`
 *  without the fragment-side `c.a *= layer.opacity;` line changing — both
 *  expose `.opacity` at offset 0. */
export function buildBillboardFragmentWGSL(blendMode: SpriteBlendMode, alphaCutoff: number, layerStructWGSL: string): string {
    const cutoff = blendMode === "cutout" ? `if (c.a < ${alphaCutoff.toFixed(6)}) { discard; }` : "";
    const returnStmt = blendMode === "multiply" ? "return vec4<f32>(c.rgb * c.a, c.a);" : "return c;";
    return /* wgsl */ `
${layerStructWGSL}
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSamp: sampler;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUniforms;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    var c = textureSample(atlasTex, atlasSamp, in.uv) * in.color;
    c.a = c.a * layer.opacity;
    ${cutoff}
    ${returnStmt}
}
`;
}

/** Layer UBO struct used by Facing + YawLocked variants (32 B alignment). */
export const SPRITE_LAYER_UBO_WGSL = /* wgsl */ `
struct SpriteLayerUniforms {
    opacity: f32,
    _pad: vec3<f32>,
};
`;

/** System UBO struct used by AxisLocked variant. Aliased as
 *  `SpriteLayerUniforms` so the shared fragment shader binds identically. */
export const AXIS_LOCKED_SYSTEM_UBO_WGSL = /* wgsl */ `
struct SpriteLayerUniforms {
    opacity: f32,
    alphaCutoff: f32,
    lockAxis: vec3<f32>,
    _pad: f32,
};
`;
