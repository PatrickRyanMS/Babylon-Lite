/** ObservableVec2 — a 2-component vector with setters that notify on change.
 *  Used by sprite handles for position / sizePx / pivot / scale so the render
 *  system can detect changes via a per-handle dirty callback.
 *  Same pattern as `ObservableVec3` — V8 inlines trivial getters/setters. */

export class ObservableVec2 {
    private _x: number;
    private _y: number;
    private readonly _onDirty: () => void;

    constructor(x: number, y: number, onDirty: () => void) {
        this._x = x;
        this._y = y;
        this._onDirty = onDirty;
    }

    get x(): number {
        return this._x;
    }
    set x(v: number) {
        if (this._x !== v) {
            this._x = v;
            this._onDirty();
        }
    }

    get y(): number {
        return this._y;
    }
    set y(v: number) {
        if (this._y !== v) {
            this._y = v;
            this._onDirty();
        }
    }

    /** Bulk set — one dirty notification instead of two. */
    set(x: number, y: number): void {
        this._x = x;
        this._y = y;
        this._onDirty();
    }

    copyFrom(v: { x: number; y: number }): void {
        this._x = v.x;
        this._y = v.y;
        this._onDirty();
    }
}
