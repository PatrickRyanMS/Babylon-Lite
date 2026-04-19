/**
 * Axis-locked billboard renderable — dynamic-imported by `createAxisLockedBillboardSystem`.
 *
 * The system UBO `AxisLockedBillboardSystemUBO` (32 B) replaces the per-layer
 * `SpriteLayerUBO`. Both expose `.opacity` at offset 0; the axis vector lives
 * at offset 16 (matches the WGSL `vec3<f32>` 16-byte alignment).
 *
 * Layout (32 B):
 *   offset 0   opacity:     f32
 *   offset 4   alphaCutoff: f32   (reserved for future runtime cutoff; baked into WGSL today)
 *   offset 8   _pad:        f32   (alignment slack — vec3 starts at 16)
 *   offset 12  _pad:        f32
 *   offset 16  lockAxis.x:  f32
 *   offset 20  lockAxis.y:  f32
 *   offset 24  lockAxis.z:  f32
 *   offset 28  _pad:        f32
 *
 * NOTE: WGSL `vec3<f32>` requires 16-byte alignment, so `lockAxis` is placed
 * at offset 16 (not 12). The WGSL struct definition lays it out with implicit
 * padding to match.
 */

import type { SceneContext } from "../scene/scene.js";
import type { BillboardSpriteSystem } from "./sprite-billboard-shared.js";
import { buildBillboardRenderable } from "./shared/sprite-billboard-renderable.js";
import { composeAxisLockedBillboard } from "./sprite-billboard-axis-shader.js";

// vec3 alignment forces the struct to 32 B even though we only need ~28.
const AXIS_LOCKED_SYSTEM_UBO_BYTES = 32;

export async function buildAxisLockedBillboardRenderable(system: BillboardSpriteSystem, scene: SceneContext): Promise<void> {
    const composed = composeAxisLockedBillboard({ blendMode: system.blendMode, alphaCutoff: system.alphaCutoff });
    const axis = system._lockAxis ?? [0, 1, 0];
    await buildBillboardRenderable(system, scene, {
        cacheKey: "axis",
        label: "sprite-billboard-axis",
        vertexWGSL: composed.vertexWGSL,
        fragmentWGSL: composed.fragmentWGSL,
        systemUboBytes: AXIS_LOCKED_SYSTEM_UBO_BYTES,
        writeSystemUbo: (scratch): void => {
            scratch[0] = system.opacity;
            scratch[1] = system.alphaCutoff;
            // scratch[2..3] = pad
            scratch[4] = axis[0];
            scratch[5] = axis[1];
            scratch[6] = axis[2];
            // scratch[7] = pad
        },
    });
}
