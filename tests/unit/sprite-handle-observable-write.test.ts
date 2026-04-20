import { describe, it, expect } from "vitest";
import { createGridSpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import { addSprite2D } from "../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { addAnchoredSprite } from "../../packages/babylon-lite/src/sprite/sprite-anchored-handle";
import { addBillboardSprite } from "../../packages/babylon-lite/src/sprite/sprite-billboard-handle";
import { createSprite2DLayer, SPRITE_2D_STRIDE } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import { createAnchoredSpriteLayer, SPRITE_ANCHORED_STRIDE } from "../../packages/babylon-lite/src/sprite/sprite-anchored";
import { _createBillboardSystem, SPRITE_BILLBOARD_STRIDE } from "../../packages/babylon-lite/src/sprite/sprite-billboard-shared";

function makeAtlas(): ReturnType<typeof createGridSpriteAtlas> {
    const tex: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 64, height: 64 };
    return createGridSpriteAtlas(tex, { cellWidthPx: 16, cellHeightPx: 16 });
}

describe("Sprite2D handle observable writes", () => {
    it("position.x writes slot float and marks only that slot dirty", () => {
        const layer = createSprite2DLayer(makeAtlas(), { capacity: 4 });
        addSprite2D(layer, { positionPx: [0, 0] });
        const h = addSprite2D(layer, { positionPx: [10, 20] });
        // Reset dirty range tracking by reading current state.
        const slot = 1 * SPRITE_2D_STRIDE;
        h.position.x = 99;
        expect(layer._storage.data[slot + 0]).toBe(99);
        expect(layer._storage.dirtyMin).toBeLessThanOrEqual(1);
        expect(layer._storage.dirtyMax).toBeGreaterThanOrEqual(2);
    });
});

describe("Anchored handle observable writes", () => {
    it("position.z writes slot float", () => {
        const layer = createAnchoredSpriteLayer(makeAtlas(), { capacity: 4 });
        const h = addAnchoredSprite(layer, { position: [1, 2, 3] });
        const slot = 0 * SPRITE_ANCHORED_STRIDE;
        h.position.z = -7;
        expect(layer._storage.data[slot + 2]).toBe(-7);
        expect(layer._storage.dirtyMin).toBeLessThanOrEqual(0);
        expect(layer._storage.dirtyMax).toBeGreaterThanOrEqual(1);
    });

    it("color.w writes slot float", () => {
        const layer = createAnchoredSpriteLayer(makeAtlas(), { capacity: 4 });
        const h = addAnchoredSprite(layer, { position: [0, 0, 0], color: [1, 1, 1, 1] });
        h.color.w = 0.25;
        expect(layer._storage.data[19]).toBe(0.25);
    });
});

describe("Billboard handle observable writes", () => {
    it("position.x writes slot float", () => {
        const sys = _createBillboardSystem(makeAtlas(), "facing", null, { capacity: 4 });
        const h = addBillboardSprite(sys, { position: [0, 0, 0], sizeWorld: [1, 1] });
        const slot = 0 * SPRITE_BILLBOARD_STRIDE;
        h.position.x = 42;
        expect(sys._storage.data[slot + 0]).toBe(42);
        expect(sys._storage.dirtyMin).toBeLessThanOrEqual(0);
        expect(sys._storage.dirtyMax).toBeGreaterThanOrEqual(1);
    });

    it("sizeWorld writes width/height", () => {
        const sys = _createBillboardSystem(makeAtlas(), "facing", null, { capacity: 4 });
        const h = addBillboardSprite(sys, { position: [0, 0, 0], sizeWorld: [1, 1] });
        h.sizeWorld.x = 2.5;
        expect(sys._storage.data[6]).toBe(2.5);
    });
});
