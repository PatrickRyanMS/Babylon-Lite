/** BillboardSpriteHandle — observable, parentable handle for a billboard sprite.
 *  Same shape as `AnchoredSpriteHandle` but uses `sizeWorld` (no offsetPx, no depthBias). */

import type { Mat4 } from "../math/types.js";
import { mat4Identity, mat4Translation } from "../math/mat4.js";
import { ObservableVec2 } from "../math/observable-vec2.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableVec4 } from "../math/observable-vec4.js";
import type { IParentable, IWorldMatrixProvider } from "../scene/parentable.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import { resolveSpriteFrame, type SpriteFrameRef } from "./shared/sprite-atlas.js";
import { markDirty } from "./shared/sprite-gpu.js";
import { walkParentedBillboardHandles } from "./shared/sprite-billboard-handle-walk.js";
import {
    SPRITE_BILLBOARD_STRIDE,
    addBillboardSpriteIndex,
    removeBillboardSpriteIndex,
    setBillboardSpriteFrameIndex,
    updateBillboardSpriteIndex,
    _removeBillboardHandleId,
    type BillboardSpriteInit,
    type BillboardSpriteSystem,
    type IParentedBillboardHandle,
} from "./sprite-billboard-shared.js";

export interface BillboardSpriteHandle extends IParentable, IWorldMatrixProvider, IParentedBillboardHandle {
    readonly id: number;
    readonly _layer: BillboardSpriteSystem;
    readonly position: ObservableVec3;
    readonly sizeWorld: ObservableVec2;
    readonly pivot: ObservableVec2;
    readonly color: ObservableVec4;
    rotation: number;
    frame: number;
    visible: boolean;
    pickable: boolean;
}

export function addBillboardSprite(system: BillboardSpriteSystem, init: BillboardSpriteInit): BillboardSpriteHandle {
    if (system._idToIndex === null) {
        system._idToIndex = new Map();
        system._indexToId = new Uint32Array(system._storage.capacity);
    }
    const idx = addBillboardSpriteIndex(system, init);
    if (system._indexToId!.length < system._storage.capacity) {
        const grown = new Uint32Array(system._storage.capacity);
        grown.set(system._indexToId!);
        system._indexToId = grown;
    }
    const id = system._nextHandleId++;
    system._idToIndex.set(id, idx);
    system._indexToId![idx] = id;

    let _rotation = init.rotation ?? 0;
    let _frame = resolveSpriteFrame(system.atlas, init.frame ?? 0);
    let _visible = init.visible !== false;
    let _pickable = init.pickable !== false;

    const writePosition = (): void => {
        const i = system._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_BILLBOARD_STRIDE;
        const d = system._storage.data;
        d[off + 0] = handle.position.x;
        d[off + 1] = handle.position.y;
        d[off + 2] = handle.position.z;
        markDirty(system._storage, i, i + 1);
        system._sortVersion++;
        wm.markLocalDirty();
    };
    const writeSizeWorld = (): void => {
        const i = system._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_BILLBOARD_STRIDE;
        const d = system._storage.data;
        d[off + 6] = _visible ? handle.sizeWorld.x : 0;
        d[off + 7] = _visible ? handle.sizeWorld.y : 0;
        markDirty(system._storage, i, i + 1);
    };
    const writePivot = (): void => {
        const i = system._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_BILLBOARD_STRIDE;
        const d = system._storage.data;
        d[off + 8] = handle.pivot.x;
        d[off + 9] = handle.pivot.y;
        markDirty(system._storage, i, i + 1);
    };
    const writeColor = (): void => {
        const i = system._idToIndex!.get(handle.id);
        if (i === undefined) {
            return;
        }
        const off = i * SPRITE_BILLBOARD_STRIDE;
        const d = system._storage.data;
        d[off + 16] = handle.color.x;
        d[off + 17] = handle.color.y;
        d[off + 18] = handle.color.z;
        d[off + 19] = handle.color.w;
        markDirty(system._storage, i, i + 1);
    };

    const wm = createWorldMatrixState((): Mat4 => {
        const p = handle.position;
        if (p.x === 0 && p.y === 0 && p.z === 0) {
            return mat4Identity();
        }
        return mat4Translation(p.x, p.y, p.z);
    });

    const sizeInit = init.sizeWorld;
    const pivotInit = init.pivot ?? system.atlas.frames[_frame]!.pivot;
    const colorInit = init.color ?? [1, 1, 1, 1];

    const handle: BillboardSpriteHandle = {
        id,
        _layer: system,
        position: new ObservableVec3(init.position[0], init.position[1], init.position[2], writePosition),
        sizeWorld: new ObservableVec2(sizeInit[0], sizeInit[1], writeSizeWorld),
        pivot: new ObservableVec2(pivotInit[0]!, pivotInit[1]!, writePivot),
        color: new ObservableVec4(colorInit[0]!, colorInit[1]!, colorInit[2]!, colorInit[3]!, writeColor),
        get rotation(): number {
            return _rotation;
        },
        set rotation(v: number) {
            _rotation = v;
            const i = system._idToIndex!.get(handle.id);
            if (i !== undefined) {
                updateBillboardSpriteIndex(system, i, { rotation: v });
            }
        },
        get frame(): number {
            return _frame;
        },
        set frame(v: SpriteFrameRef) {
            const fi = resolveSpriteFrame(system.atlas, v);
            _frame = fi;
            const i = system._idToIndex!.get(handle.id);
            if (i !== undefined) {
                setBillboardSpriteFrameIndex(system, i, fi);
            }
        },
        get visible(): boolean {
            return _visible;
        },
        set visible(v: boolean) {
            _visible = v;
            writeSizeWorld();
        },
        get pickable(): boolean {
            return _pickable;
        },
        set pickable(v: boolean) {
            _pickable = v;
            const i = system._idToIndex!.get(handle.id);
            if (i !== undefined) {
                const off = i * SPRITE_BILLBOARD_STRIDE;
                system._storage.data[off + 22] = v ? 1 : 0;
                markDirty(system._storage, i, i + 1);
            }
        },
        get parent(): IWorldMatrixProvider | null {
            return wm.parent;
        },
        set parent(p: IWorldMatrixProvider | null) {
            const wasNull = wm.parent === null;
            wm.parent = p;
            wm.markLocalDirty();
            if (wasNull && p !== null) {
                if (system._parentedHandles === null) {
                    system._parentedHandles = new Set();
                    system._parentedHandlesWalker = walkParentedBillboardHandles;
                }
                system._parentedHandles.add(handle);
            } else if (!wasNull && p === null) {
                system._parentedHandles?.delete(handle);
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

export function removeBillboardSprite(handle: BillboardSpriteHandle): void {
    const system = handle._layer;
    const i = system._idToIndex?.get(handle.id);
    if (i === undefined) {
        return;
    }
    system._parentedHandles?.delete(handle);
    _removeBillboardHandleId(system, i);
    removeBillboardSpriteIndex(system, i);
}
