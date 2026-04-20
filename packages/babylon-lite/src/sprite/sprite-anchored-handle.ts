/** AnchoredSpriteHandle — observable, parentable handle for an anchored sprite.
 *
 *  Parallel to `Mesh` for sprites: each handle owns its own `WorldMatrixAccessors`
 *  so it can participate in the 3D scene graph (`IParentable` + `IWorldMatrixProvider`).
 *
 *  Pay-for-use: the handle module is a separate file, dynamic-imported only by
 *  callers that use `addAnchoredSprite` (handle API). Apps that only call
 *  `addAnchoredSpriteIndex` never load this code. */

import type { Mat4 } from "../math/types.js";
import { mat4Identity, mat4Translation } from "../math/mat4.js";
import { ObservableVec2 } from "../math/observable-vec2.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableVec4 } from "../math/observable-vec4.js";
import type { IParentable, IWorldMatrixProvider } from "../scene/parentable.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import { resolveSpriteFrame, type SpriteFrameRef } from "./shared/sprite-atlas.js";
import { markDirty } from "./shared/sprite-gpu.js";
import { walkParentedAnchoredHandles } from "./sprite-anchored-handle-walk.js";
import {
    SPRITE_ANCHORED_STRIDE,
    addAnchoredSpriteIndex,
    removeAnchoredSpriteIndex,
    setAnchoredSpriteFrameIndex,
    updateAnchoredSpriteIndex,
    _removeAnchoredHandleId,
    type AnchoredSpriteInit,
    type AnchoredSpriteLayer,
    type IParentedAnchoredHandle,
} from "./sprite-anchored.js";

export interface AnchoredSpriteHandle extends IParentable, IWorldMatrixProvider, IParentedAnchoredHandle {
    readonly id: number;
    readonly _layer: AnchoredSpriteLayer;
    /** World position (also the local position when parent is null). */
    readonly position: ObservableVec3;
    readonly offsetPx: ObservableVec2;
    readonly sizePx: ObservableVec2;
    readonly pivot: ObservableVec2;
    readonly color: ObservableVec4;
    rotation: number;
    depthBias: number;
    frame: number;
    visible: boolean;
    pickable: boolean;
}

export function addAnchoredSprite(layer: AnchoredSpriteLayer, init: AnchoredSpriteInit): AnchoredSpriteHandle {
    // Lazy-init the handle ID infrastructure on first use.
    if (layer._idToIndex === null) {
        layer._idToIndex = new Map();
        layer._indexToId = new Uint32Array(layer._storage.capacity);
    }
    const idx = addAnchoredSpriteIndex(layer, init);
    // Grow indexToId if storage grew during add.
    if (layer._indexToId!.length < layer._storage.capacity) {
        const grown = new Uint32Array(layer._storage.capacity);
        grown.set(layer._indexToId!);
        layer._indexToId = grown;
    }
    const id = layer._nextHandleId++;
    layer._idToIndex.set(id, idx);
    layer._indexToId![idx] = id;

    let _rotation = init.rotation ?? 0;
    let _depthBias = init.depthBias ?? 0;
    let _frame = resolveSpriteFrame(layer.atlas, init.frame ?? 0);
    let _visible = init.visible !== false;
    let _pickable = init.pickable !== false;

    // Each observable triggers _writeBack which resolves the (possibly moved) index.
    const writePosition = (): void => {
        const i = layer._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_ANCHORED_STRIDE;
        const d = layer._storage.data;
        d[off + 0] = handle.position.x;
        d[off + 1] = handle.position.y;
        d[off + 2] = handle.position.z;
        markDirty(layer._storage, i, i + 1);
        layer._sortVersion++;
        wm.markLocalDirty();
    };
    const writeOffsetPx = (): void => {
        const i = layer._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_ANCHORED_STRIDE;
        const d = layer._storage.data;
        d[off + 4] = handle.offsetPx.x;
        d[off + 5] = handle.offsetPx.y;
        markDirty(layer._storage, i, i + 1);
    };
    const writeSizePx = (): void => {
        const i = layer._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_ANCHORED_STRIDE;
        const d = layer._storage.data;
        d[off + 6] = _visible ? handle.sizePx.x : 0;
        d[off + 7] = _visible ? handle.sizePx.y : 0;
        markDirty(layer._storage, i, i + 1);
    };
    const writePivot = (): void => {
        const i = layer._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_ANCHORED_STRIDE;
        const d = layer._storage.data;
        d[off + 8] = handle.pivot.x;
        d[off + 9] = handle.pivot.y;
        markDirty(layer._storage, i, i + 1);
    };
    const writeColor = (): void => {
        const i = layer._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_ANCHORED_STRIDE;
        const d = layer._storage.data;
        d[off + 16] = handle.color.x;
        d[off + 17] = handle.color.y;
        d[off + 18] = handle.color.z;
        d[off + 19] = handle.color.w;
        markDirty(layer._storage, i, i + 1);
    };

    // Local matrix is just translation (rotation is 2D-around-pivot in the slot,
    // not a 3D rotation). Sprite scale is not part of the world transform.
    const wm = createWorldMatrixState((): Mat4 => {
        const p = handle.position;
        if (p.x === 0 && p.y === 0 && p.z === 0) {
            return mat4Identity();
        }
        return mat4Translation(p.x, p.y, p.z);
    });

    const sizeInit = init.sizePx ?? layer.atlas.frames[_frame]!.sourceSizePx;
    const pivotInit = init.pivot ?? layer.atlas.frames[_frame]!.pivot;
    const offsetInit = init.offsetPx ?? [0, 0];
    const colorInit = init.color ?? [1, 1, 1, 1];

    const handle: AnchoredSpriteHandle = {
        id,
        _layer: layer,
        position: new ObservableVec3(init.position[0], init.position[1], init.position[2], writePosition),
        offsetPx: new ObservableVec2(offsetInit[0]!, offsetInit[1]!, writeOffsetPx),
        sizePx: new ObservableVec2(sizeInit[0]!, sizeInit[1]!, writeSizePx),
        pivot: new ObservableVec2(pivotInit[0]!, pivotInit[1]!, writePivot),
        color: new ObservableVec4(colorInit[0]!, colorInit[1]!, colorInit[2]!, colorInit[3]!, writeColor),
        get rotation(): number {
            return _rotation;
        },
        set rotation(v: number) {
            _rotation = v;
            const i = layer._idToIndex!.get(handle.id);
            if (i !== undefined) {
                updateAnchoredSpriteIndex(layer, i, { rotation: v });
            }
        },
        get depthBias(): number {
            return _depthBias;
        },
        set depthBias(v: number) {
            _depthBias = v;
            const i = layer._idToIndex!.get(handle.id);
            if (i !== undefined) {
                const off = i * SPRITE_ANCHORED_STRIDE;
                layer._storage.data[off + 3] = v;
                markDirty(layer._storage, i, i + 1);
            }
        },
        get frame(): number {
            return _frame;
        },
        set frame(v: SpriteFrameRef) {
            const fi = resolveSpriteFrame(layer.atlas, v);
            _frame = fi;
            const i = layer._idToIndex!.get(handle.id);
            if (i !== undefined) {
                setAnchoredSpriteFrameIndex(layer, i, fi);
            }
        },
        get visible(): boolean {
            return _visible;
        },
        set visible(v: boolean) {
            _visible = v;
            writeSizePx();
        },
        get pickable(): boolean {
            return _pickable;
        },
        set pickable(v: boolean) {
            _pickable = v;
            const i = layer._idToIndex!.get(handle.id);
            if (i !== undefined) {
                const off = i * SPRITE_ANCHORED_STRIDE;
                layer._storage.data[off + 22] = v ? 1 : 0;
                markDirty(layer._storage, i, i + 1);
            }
        },
        get parent(): IWorldMatrixProvider | null {
            return wm.parent;
        },
        set parent(p: IWorldMatrixProvider | null) {
            const wasNull = wm.parent === null;
            wm.parent = p;
            wm.markLocalDirty();
            // Manage parented-set membership.
            if (wasNull && p !== null) {
                if (layer._parentedHandles === null) {
                    layer._parentedHandles = new Set();
                    layer._parentedHandlesWalker = walkParentedAnchoredHandles;
                }
                layer._parentedHandles.add(handle);
            } else if (!wasNull && p === null) {
                layer._parentedHandles?.delete(handle);
            }
        },
        get worldMatrix(): Mat4 {
            return wm.getWorldMatrix();
        },
        get worldMatrixVersion(): number {
            return wm.getWorldMatrixVersion();
        },
    };
    return handle;
}

export function removeAnchoredSprite(handle: AnchoredSpriteHandle): void {
    const layer = handle._layer;
    const i = layer._idToIndex?.get(handle.id);
    if (i === undefined) {
        return;
    }
    // Remove from parented-set if present.
    layer._parentedHandles?.delete(handle);
    // Clear our slot's mapping FIRST, then perform swap-remove (which patches
    // the moved-into slot's mapping via _onAnchoredIndexMoved).
    _removeAnchoredHandleId(layer, i);
    removeAnchoredSpriteIndex(layer, i);
}
