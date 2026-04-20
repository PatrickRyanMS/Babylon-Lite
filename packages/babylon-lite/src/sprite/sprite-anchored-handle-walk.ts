/**
 * Per-frame walker for parented AnchoredSpriteHandle instances.
 *
 * Extracted from `sprite-anchored-renderable.ts` so the renderable's static
 * import graph stays free of handle/walker code. The handle module statically
 * imports this walker and assigns it to `layer._parentedHandlesWalker` on
 * first parenting; the renderable invokes it via the function-pointer hook
 * only when the layer actually has parented handles.
 *
 * Index-only scenes never reach this module.
 */

import { SPRITE_ANCHORED_STRIDE, type AnchoredSpriteLayer } from "./sprite-anchored.js";
import { markDirty } from "./shared/sprite-gpu.js";

export function walkParentedAnchoredHandles(layer: AnchoredSpriteLayer): void {
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
        const wm = h.worldMatrix;
        const off = i * SPRITE_ANCHORED_STRIDE;
        d[off + 0] = wm[12]!;
        d[off + 1] = wm[13]!;
        d[off + 2] = wm[14]!;
        if (i < minIdx) {
            minIdx = i;
        }
        if (i > maxIdx) {
            maxIdx = i;
        }
    }
    if (maxIdx >= 0) {
        markDirty(layer._storage, minIdx, maxIdx + 1);
        layer._sortVersion++;
    }
}
