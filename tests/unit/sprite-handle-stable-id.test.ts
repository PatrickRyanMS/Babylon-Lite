import { describe, it, expect } from "vitest";
import { createGridSpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import { addSprite2D, removeSprite2D } from "../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { addAnchoredSprite, removeAnchoredSprite } from "../../packages/babylon-lite/src/sprite/sprite-anchored-handle";
import { addBillboardSprite, removeBillboardSprite } from "../../packages/babylon-lite/src/sprite/sprite-billboard-handle";
import { createSprite2DLayer } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import { createAnchoredSpriteLayer } from "../../packages/babylon-lite/src/sprite/sprite-anchored";
import { _createBillboardSystem } from "../../packages/babylon-lite/src/sprite/sprite-billboard-shared";

function makeAtlas(): ReturnType<typeof createGridSpriteAtlas> {
    const tex: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 64, height: 64 };
    return createGridSpriteAtlas(tex, { cellWidthPx: 16, cellHeightPx: 16 });
}

describe("Sprite2D handle stable id", () => {
    it("survives swap-remove of a middle handle", () => {
        const layer = createSprite2DLayer(makeAtlas(), { capacity: 4 });
        const a = addSprite2D(layer, { positionPx: [10, 10] });
        const b = addSprite2D(layer, { positionPx: [20, 20] });
        const c = addSprite2D(layer, { positionPx: [30, 30] });
        expect(layer._idToIndex!.get(a.id)).toBe(0);
        expect(layer._idToIndex!.get(b.id)).toBe(1);
        expect(layer._idToIndex!.get(c.id)).toBe(2);

        removeSprite2D(b);

        // a unchanged, c moved into b's slot.
        expect(layer._idToIndex!.has(b.id)).toBe(false);
        expect(layer._idToIndex!.get(a.id)).toBe(0);
        expect(layer._idToIndex!.get(c.id)).toBe(1);
        expect(layer._indexToId![0]).toBe(a.id);
        expect(layer._indexToId![1]).toBe(c.id);
    });
});

describe("Anchored handle stable id", () => {
    it("survives swap-remove of a middle handle", () => {
        const layer = createAnchoredSpriteLayer(makeAtlas(), { capacity: 4 });
        const a = addAnchoredSprite(layer, { position: [1, 0, 0] });
        const b = addAnchoredSprite(layer, { position: [2, 0, 0] });
        const c = addAnchoredSprite(layer, { position: [3, 0, 0] });

        removeAnchoredSprite(b);

        expect(layer._idToIndex!.has(b.id)).toBe(false);
        expect(layer._idToIndex!.get(a.id)).toBe(0);
        expect(layer._idToIndex!.get(c.id)).toBe(1);
        expect(layer._indexToId![0]).toBe(a.id);
        expect(layer._indexToId![1]).toBe(c.id);
    });
});

describe("Billboard handle stable id", () => {
    it("survives swap-remove of a middle handle", () => {
        const sys = _createBillboardSystem(makeAtlas(), "facing", null, { capacity: 4 });
        const a = addBillboardSprite(sys, { position: [1, 0, 0], sizeWorld: [1, 1] });
        const b = addBillboardSprite(sys, { position: [2, 0, 0], sizeWorld: [1, 1] });
        const c = addBillboardSprite(sys, { position: [3, 0, 0], sizeWorld: [1, 1] });

        removeBillboardSprite(b);

        expect(sys._idToIndex!.has(b.id)).toBe(false);
        expect(sys._idToIndex!.get(a.id)).toBe(0);
        expect(sys._idToIndex!.get(c.id)).toBe(1);
        expect(sys._indexToId![0]).toBe(a.id);
        expect(sys._indexToId![1]).toBe(c.id);
    });
});
