/**
 * Per-frame walker for parented BillboardSpriteHandle instances.
 *
 * Extracted from `sprite-billboard-renderable.ts` so the renderable's static
 * import graph stays free of handle/walker code. The handle module statically
 * imports this walker and assigns it to `system._parentedHandlesWalker` on
 * first parenting; the renderable then invokes it via the function-pointer
 * hook only when the system actually has parented handles.
 *
 * Index-only scenes never reach this module (handle module is the only
 * importer, and it is only loaded by scenes that call `addBillboardSprite`).
 */

import { SPRITE_BILLBOARD_STRIDE, type BillboardSpriteSystem } from "../sprite-billboard-shared.js";
import { markDirty } from "./sprite-gpu.js";

export function walkParentedBillboardHandles(system: BillboardSpriteSystem): void {
    const parented = system._parentedHandles;
    if (parented === null || parented.size === 0 || system._idToIndex === null) {
        return;
    }
    const map = system._idToIndex;
    const d = system._storage.data;
    let minIdx = Infinity;
    let maxIdx = -1;
    for (const h of parented) {
        const i = map.get(h.id);
        if (i === undefined) {
            continue;
        }
        const wm = h.worldMatrix;
        const off = i * SPRITE_BILLBOARD_STRIDE;
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
        markDirty(system._storage, minIdx, maxIdx + 1);
        system._sortVersion++;
    }
}
