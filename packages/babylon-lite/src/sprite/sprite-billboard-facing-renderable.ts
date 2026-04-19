/**
 * Facing billboard renderable — dynamic-imported by `createFacingBillboardSystem`.
 */

import type { SceneContext } from "../scene/scene.js";
import type { BillboardSpriteSystem } from "./sprite-billboard-shared.js";
import { buildBillboardRenderable } from "./shared/sprite-billboard-renderable.js";
import { composeFacingBillboard } from "./sprite-billboard-facing-shader.js";

const SPRITE_LAYER_UBO_BYTES = 32;

export async function buildFacingBillboardRenderable(system: BillboardSpriteSystem, scene: SceneContext): Promise<void> {
    const composed = composeFacingBillboard({ blendMode: system.blendMode, alphaCutoff: system.alphaCutoff });
    await buildBillboardRenderable(system, scene, {
        cacheKey: "facing",
        label: "sprite-billboard-facing",
        vertexWGSL: composed.vertexWGSL,
        fragmentWGSL: composed.fragmentWGSL,
        systemUboBytes: SPRITE_LAYER_UBO_BYTES,
        writeSystemUbo: (scratch): void => {
            scratch[0] = system.opacity;
        },
    });
}
