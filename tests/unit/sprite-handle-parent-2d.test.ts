import { describe, it, expect } from "vitest";
import { createGridSpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import { addSprite2D } from "../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { walkParentedSprite2DHandles } from "../../packages/babylon-lite/src/sprite/sprite-2d-handle-walk";
import { createSprite2DLayer, SPRITE_2D_STRIDE } from "../../packages/babylon-lite/src/sprite/sprite-2d";

function makeAtlas(): ReturnType<typeof createGridSpriteAtlas> {
    const tex: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 64, height: 64 };
    return createGridSpriteAtlas(tex, { cellWidthPx: 16, cellHeightPx: 16 });
}

describe("Sprite2D handle parented to another Sprite2D handle", () => {
    it("rotating the parent rotates and translates the child slot", () => {
        const layer = createSprite2DLayer(makeAtlas(), { capacity: 4 });
        const parent = addSprite2D(layer, { positionPx: [100, 200], sizePx: [10, 10] });
        const child = addSprite2D(layer, { positionPx: [50, 0], sizePx: [10, 10] });
        child.parent = parent;

        // Rotate parent 90°; child local-(50,0) should rotate around parent
        // origin into world (100, 250) via Mat3 (column-major) compose.
        // parent compose: rotation pi/2, translate (100,200), scale 1.
        // child world = parent * child_local = (100 + (-1)*0, 200 + 1*50) = (100, 250).
        parent.rotation = Math.PI / 2;

        walkParentedSprite2DHandles(layer);

        const slot = 1 * SPRITE_2D_STRIDE;
        expect(layer._storage.data[slot + 0]).toBeCloseTo(100, 4);
        expect(layer._storage.data[slot + 1]).toBeCloseTo(250, 4);

        // Child's slot also reflects rotation: sin/cos = sin(pi/2), cos(pi/2).
        // Child has no local rotation, so world rotation = parent rotation.
        const sin = layer._storage.data[slot + 6]!;
        const cos = layer._storage.data[slot + 7]!;
        expect(sin).toBeCloseTo(1, 4);
        expect(cos).toBeCloseTo(0, 4);
    });

    it("scaling the parent scales the child's packed size", () => {
        const layer = createSprite2DLayer(makeAtlas(), { capacity: 4 });
        const parent = addSprite2D(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        const child = addSprite2D(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        child.parent = parent;

        parent.scale.x = 2;
        parent.scale.y = 3;

        walkParentedSprite2DHandles(layer);

        const slot = 1 * SPRITE_2D_STRIDE;
        // Packed size = local_size * world_scale extracted from parent matrix.
        expect(layer._storage.data[slot + 2]).toBeCloseTo(20, 4);
        expect(layer._storage.data[slot + 3]).toBeCloseTo(30, 4);
    });
});
