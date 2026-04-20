/** Set a sprite handle's parent while preserving its current world position.
 *
 *  Parallel to `setParent` for meshes, but specialized for sprite handles:
 *  computes the current world position, sets the parent, and adjusts the
 *  handle's local position so its world position is unchanged.
 *
 *  Sprite handles do not have a 3D rotation/scale (rotation is 2D-around-pivot,
 *  scale is 2D in screen space), so only translation is preserved here. */

import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4Invert } from "../math/mat4.js";

interface SpriteWorldHandle {
    readonly position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: import("../math/types.js").Mat4;
}

export function setParentSprite(handle: SpriteWorldHandle, parent: IWorldMatrixProvider | null): void {
    // 1. Snapshot current world position from the handle's world matrix.
    const w = handle.worldMatrix;
    const wx = w[12]!;
    const wy = w[13]!;
    const wz = w[14]!;

    // 2. Set parent.
    handle.parent = parent;

    if (parent === null) {
        handle.position.set(wx, wy, wz);
        return;
    }

    // 3. Compute new local position = inverse(parentWorld) * worldPos.
    const inv = mat4Invert(parent.worldMatrix);
    if (!inv) {
        handle.position.set(wx, wy, wz);
        return;
    }
    const lx = inv[0]! * wx + inv[4]! * wy + inv[8]! * wz + inv[12]!;
    const ly = inv[1]! * wx + inv[5]! * wy + inv[9]! * wz + inv[13]!;
    const lz = inv[2]! * wx + inv[6]! * wy + inv[10]! * wz + inv[14]!;
    handle.position.set(lx, ly, lz);
}
