/**
 * Yaw-locked billboard renderable — dynamic-imported by `createYawLockedBillboardSystem`.
 */

import type { SceneContext } from "../scene/scene.js";
import type { BillboardSpriteSystem } from "./sprite-billboard-shared.js";
import { buildBillboardRenderable } from "./shared/sprite-billboard-renderable.js";
import { composeYawLockedBillboard } from "./sprite-billboard-yaw-shader.js";

const SPRITE_LAYER_UBO_BYTES = 32;

export async function buildYawLockedBillboardRenderable(system: BillboardSpriteSystem, scene: SceneContext): Promise<void> {
    const composed = composeYawLockedBillboard({ blendMode: system.blendMode, alphaCutoff: system.alphaCutoff });
    await buildBillboardRenderable(system, scene, {
        cacheKey: "yaw",
        label: "sprite-billboard-yaw",
        vertexWGSL: composed.vertexWGSL,
        fragmentWGSL: composed.fragmentWGSL,
        systemUboBytes: SPRITE_LAYER_UBO_BYTES,
        writeSystemUbo: (scratch): void => {
            scratch[0] = system.opacity;
        },
    });
}
