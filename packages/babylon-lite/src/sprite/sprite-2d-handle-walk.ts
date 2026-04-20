/**
 * Per-frame walker for parented Sprite2DHandle instances.
 *
 * Extracted from `sprite-2d-renderable.ts` so the renderable's static import
 * graph stays free of handle/walker code. The handle module statically imports
 * this walker and assigns it to `layer._parentedHandlesWalker` on first
 * parenting; the renderable invokes it via the function-pointer hook only
 * when the layer actually has parented handles.
 *
 * Index-only scenes never reach this module.
 *
 * Reads world Mat3 from each handle, decomposes translation/rotation/scale,
 * writes pos / scaled-size / pivot / sin-cos into the slot.
 */

import { SPRITE_2D_STRIDE, type Sprite2DLayer } from "./sprite-2d.js";
import { markDirty } from "./shared/sprite-gpu.js";

export function walkParentedSprite2DHandles(layer: Sprite2DLayer): void {
    const parented = layer._parentedHandles;
    if (parented === null || parented.size === 0 || layer._idToIndex === null) {
        return;
    }
    const map = layer._idToIndex;
    const d = layer._storage.data;
    let minIdx = Infinity;
    let maxIdx = -1;
    for (const h of parented) {
        const i = map.get(h.id);
        if (i === undefined) {
            continue;
        }
        const m = h.worldMatrix2D;
        // Mat3 column-major: m[0..2] = col0, m[3..5] = col1, m[6..8] = col2.
        const c0x = m[0]!,
            c0y = m[1]!;
        const c1x = m[3]!,
            c1y = m[4]!;
        const tx = m[6]!,
            ty = m[7]!;
        const sx = Math.sqrt(c0x * c0x + c0y * c0y);
        const sy = Math.sqrt(c1x * c1x + c1y * c1y);
        const rot = sx > 1e-6 ? Math.atan2(c0y, c0x) : 0;
        const sin = Math.sin(rot);
        const cos = Math.cos(rot);
        const off = i * SPRITE_2D_STRIDE;
        d[off + 0] = tx;
        d[off + 1] = ty;
        const visW = h._localVisible ? h._localSizePx[0] * sx : 0;
        const visH = h._localVisible ? h._localSizePx[1] * sy : 0;
        d[off + 2] = visW;
        d[off + 3] = visH;
        d[off + 4] = h._localPivot[0];
        d[off + 5] = h._localPivot[1];
        d[off + 6] = sin;
        d[off + 7] = cos;
        if (i < minIdx) {
            minIdx = i;
        }
        if (i > maxIdx) {
            maxIdx = i;
        }
    }
    if (maxIdx >= 0) {
        markDirty(layer._storage, minIdx, maxIdx + 1);
    }
}
