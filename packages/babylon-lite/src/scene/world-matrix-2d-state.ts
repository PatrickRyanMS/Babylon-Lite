/** Lazy world-Mat3 computation — parallel to `world-matrix-state.ts`.
 *
 *  Each entity provides only `getLocalMatrix(): Mat3`. This module handles
 *  version tracking, parent-chain validation, and caching. Zero entity imports. */

import type { Mat3 } from "../math/mat3.js";
import { mat3MultiplyInto } from "../math/mat3.js";
import type { IWorldMatrix2DProvider } from "./parentable-2d.js";

export interface WorldMatrix2DAccessors {
    getWorldMatrix2D(): Mat3;
    getWorldMatrix2DVersion(): number;
    markLocalDirty(): void;
    parent: IWorldMatrix2DProvider | null;
}

export function createWorldMatrix2DState(getLocalMatrix: () => Mat3): WorldMatrix2DAccessors {
    let _localVersion = 0;
    let _worldVersion = 0;
    let _lastLocalVersion = -1;
    let _lastParentVersion = -1;
    let _cachedWorld: Mat3 | null = null;
    const _ownedWorld = new Float32Array(9) as Mat3;
    let _parent: IWorldMatrix2DProvider | null = null;

    return {
        get parent(): IWorldMatrix2DProvider | null {
            return _parent;
        },
        set parent(p: IWorldMatrix2DProvider | null) {
            if (p !== _parent) {
                _parent = p;
                _cachedWorld = null;
            }
        },

        markLocalDirty(): void {
            _localVersion++;
            _worldVersion++;
            _cachedWorld = null;
        },

        getWorldMatrix2D(): Mat3 {
            if (_cachedWorld !== null && _localVersion === _lastLocalVersion) {
                if (_parent === null) {
                    return _cachedWorld;
                }
                void _parent.worldMatrix2D;
                if (_parent.worldMatrix2DVersion === _lastParentVersion) {
                    return _cachedWorld;
                }
            }

            const local = getLocalMatrix();
            if (_parent !== null) {
                const pw = _parent.worldMatrix2D;
                mat3MultiplyInto(_ownedWorld, pw, local);
                _cachedWorld = _ownedWorld;
            } else {
                _cachedWorld = local;
            }

            _lastLocalVersion = _localVersion;
            _lastParentVersion = _parent?.worldMatrix2DVersion ?? -1;
            _worldVersion++;
            return _cachedWorld;
        },

        getWorldMatrix2DVersion(): number {
            return _worldVersion;
        },
    };
}
