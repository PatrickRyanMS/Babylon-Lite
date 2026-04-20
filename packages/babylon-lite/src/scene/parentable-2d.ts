/** 2D parenting interfaces — parallel to `parentable.ts` but for Mat3 affine.
 *
 *  Used by Sprite2D handles to express scene-graph hierarchy in screen space.
 *  Zero entity imports, zero runtime code. */

import type { Mat3 } from "../math/mat3.js";

export interface IWorldMatrix2DProvider {
    readonly worldMatrix2D: Mat3;
    readonly worldMatrix2DVersion: number;
}

export interface IParentable2D {
    parent: IWorldMatrix2DProvider | null;
}
