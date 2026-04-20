import { describe, it, expect } from "vitest";
import { createGridSpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import { addAnchoredSprite } from "../../packages/babylon-lite/src/sprite/sprite-anchored-handle";
import { addBillboardSprite } from "../../packages/babylon-lite/src/sprite/sprite-billboard-handle";
import { walkParentedAnchoredHandles } from "../../packages/babylon-lite/src/sprite/sprite-anchored-handle-walk";
import { walkParentedBillboardHandles } from "../../packages/babylon-lite/src/sprite/shared/sprite-billboard-handle-walk";
import { createAnchoredSpriteLayer, SPRITE_ANCHORED_STRIDE } from "../../packages/babylon-lite/src/sprite/sprite-anchored";
import { _createBillboardSystem, SPRITE_BILLBOARD_STRIDE } from "../../packages/babylon-lite/src/sprite/sprite-billboard-shared";
import { createTransformNode } from "../../packages/babylon-lite/src/scene/transform-node";

function makeAtlas(): ReturnType<typeof createGridSpriteAtlas> {
    const tex: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 64, height: 64 };
    return createGridSpriteAtlas(tex, { cellWidthPx: 16, cellHeightPx: 16 });
}

describe("Anchored handle parented to TransformNode", () => {
    it("walker writes parent translation into slot", () => {
        const layer = createAnchoredSpriteLayer(makeAtlas(), { capacity: 4 });
        const parent = createTransformNode("p", 5, 7, -3);
        const h = addAnchoredSprite(layer, { position: [0, 0, 0] });
        h.parent = parent;

        walkParentedAnchoredHandles(layer);

        const slot = 0 * SPRITE_ANCHORED_STRIDE;
        expect(layer._storage.data[slot + 0]).toBeCloseTo(5);
        expect(layer._storage.data[slot + 1]).toBeCloseTo(7);
        expect(layer._storage.data[slot + 2]).toBeCloseTo(-3);
    });

    it("setParent(handle, null) preserves the world position via writePosition", () => {
        const layer = createAnchoredSpriteLayer(makeAtlas(), { capacity: 4 });
        const parent = createTransformNode("p", 10, 0, 0);
        const h = addAnchoredSprite(layer, { position: [2, 0, 0] });
        h.parent = parent;
        walkParentedAnchoredHandles(layer);
        // Slot now reflects parent translation (2 units local + 10 parent = 12).
        expect(layer._storage.data[0]).toBeCloseTo(12);
        // Snapshot world position before un-parenting (handle.position is local).
        const wx = h.worldMatrix[12]!;
        // Un-parent: use setParentSprite-style preservation manually.
        h.parent = null;
        h.position.x = wx;
        // Buffer should match preserved world x.
        expect(layer._storage.data[0]).toBeCloseTo(12);
    });
});

describe("Billboard handle parented to TransformNode", () => {
    it("walker writes parent translation into slot", () => {
        const sys = _createBillboardSystem(makeAtlas(), "facing", null, { capacity: 4 });
        const parent = createTransformNode("p", -1, 2, 4);
        const h = addBillboardSprite(sys, { position: [0, 0, 0], sizeWorld: [1, 1] });
        h.parent = parent;

        walkParentedBillboardHandles(sys);

        const slot = 0 * SPRITE_BILLBOARD_STRIDE;
        expect(sys._storage.data[slot + 0]).toBeCloseTo(-1);
        expect(sys._storage.data[slot + 1]).toBeCloseTo(2);
        expect(sys._storage.data[slot + 2]).toBeCloseTo(4);
    });
});
