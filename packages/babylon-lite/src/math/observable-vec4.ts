/** ObservableVec4 — a 4-component vector (e.g. RGBA) with setters that notify
 *  on change. Same pattern as `ObservableVec3` / `ObservableVec2`. */

export class ObservableVec4 {
    private _x: number;
    private _y: number;
    private _z: number;
    private _w: number;
    private readonly _onDirty: () => void;

    constructor(x: number, y: number, z: number, w: number, onDirty: () => void) {
        this._x = x;
        this._y = y;
        this._z = z;
        this._w = w;
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
    get z(): number {
        return this._z;
    }
    set z(v: number) {
        if (this._z !== v) {
            this._z = v;
            this._onDirty();
        }
    }
    get w(): number {
        return this._w;
    }
    set w(v: number) {
        if (this._w !== v) {
            this._w = v;
            this._onDirty();
        }
    }

    set(x: number, y: number, z: number, w: number): void {
        this._x = x;
        this._y = y;
        this._z = z;
        this._w = w;
        this._onDirty();
    }
}
