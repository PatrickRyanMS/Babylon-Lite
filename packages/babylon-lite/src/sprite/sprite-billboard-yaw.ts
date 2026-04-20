/**
 * Cylindrical (yaw-locked) billboard — sprites rotate only around world Y.
 *
 * Common for trees, NPCs, and chest/banner-style markers that should remain
 * upright as the camera circles. Quad basis is computed in WGSL from
 * `cameraPosition` (packed in `Sprite3DSceneUBO`) and the world-Y axis.
 */

import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { BillboardSpriteSystem, BillboardSpriteSystemOptions } from "./sprite-billboard-shared.js";
import { _createBillboardSystem } from "./sprite-billboard-shared.js";

/** Cylindrical billboard: rotates only around world Y. */
export function createYawLockedBillboardSystem(atlas: SpriteAtlas, opts: BillboardSpriteSystemOptions = {}): BillboardSpriteSystem {
    const system = _createBillboardSystem(atlas, "yaw", null, opts);
    system._deferredBuild = async (scene): Promise<void> => {
        const mod = await import("./sprite-billboard-yaw-renderable.js");
        await mod.buildYawLockedBillboardRenderable(system, scene);
    };
    return system;
}
