/**
 * Axis-locked billboard — sprites locked to an arbitrary normalized world axis.
 *
 * Quad basis: the locked axis is `up`, and `right` is built from the
 * camera-projected direction perpendicular to that axis. Passing `[0,1,0]` is
 * functionally equivalent to the yaw-locked variant, but each variant has its
 * own pipeline + UBO so there is no per-frame branch.
 *
 * The axis lives in this system's `AxisLockedBillboardSystemUBO` — it is
 * **not** per-sprite — and replaces the per-layer `SpriteLayerUBO` at
 * `@group(1) @binding(2)`. Both UBOs expose `.opacity` at offset 0 so the
 * shared fragment shader pattern still applies.
 */

import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { BillboardSpriteSystem, BillboardSpriteSystemOptions } from "./sprite-billboard-shared.js";
import { _createBillboardSystem } from "./sprite-billboard-shared.js";

function normalize(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-12) {
        return [0, 1, 0];
    }
    return [v[0] / len, v[1] / len, v[2] / len];
}

/** Arbitrary axis-locked billboard. Axis is normalized at creation time. */
export function createAxisLockedBillboardSystem(atlas: SpriteAtlas, axis: [number, number, number], opts: BillboardSpriteSystemOptions = {}): BillboardSpriteSystem {
    const normalized = normalize(axis);
    const system = _createBillboardSystem(atlas, "axis", normalized, opts);
    system._deferredBuild = async (scene): Promise<void> => {
        const mod = await import("./sprite-billboard-axis-renderable.js");
        await mod.buildAxisLockedBillboardRenderable(system, scene);
    };
    return system;
}
