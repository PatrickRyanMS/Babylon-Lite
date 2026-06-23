import { describe, expect, it } from "vitest";

import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import { computeFbxAxisConversionMatrix, type FbxAxisSettings } from "../../../packages/babylon-lite/src/loader-fbx/fbx-axis.js";

/** Apply a Lite column-major Mat4 to a point: v' = M · v.
 *   x' = m[0]x + m[4]y + m[8]z + m[12]
 *   y' = m[1]x + m[5]y + m[9]z + m[13]
 *   z' = m[2]x + m[6]y + m[10]z + m[14]
 *  (Same convention pin used by fbx-transform.test.ts.) */
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const f = m as unknown as ArrayLike<number>;
    return [f[0]! * x + f[4]! * y + f[8]! * z + f[12]!, f[1]! * x + f[5]! * y + f[9]! * z + f[13]!, f[2]! * x + f[6]! * y + f[10]! * z + f[14]!];
}

function expectPoint(actual: [number, number, number], expected: [number, number, number]): void {
    expect(actual[0]).toBeCloseTo(expected[0], 9);
    expect(actual[1]).toBeCloseTo(expected[1], 9);
    expect(actual[2]).toBeCloseTo(expected[2], 9);
}

/** FBX default frame: up=+Y, front=+Z, coord=+X, unit scale 1. */
const DEFAULT: FbxAxisSettings = {
    upAxis: 1,
    upAxisSign: 1,
    frontAxis: 2,
    frontAxisSign: 1,
    coordAxis: 0,
    coordAxisSign: 1,
    unitScaleFactor: 1,
};

describe("computeFbxAxisConversionMatrix — default frame", () => {
    it("returns null for the default Y-up frame at unit scale", () => {
        expect(computeFbxAxisConversionMatrix(DEFAULT)).toBeNull();
    });

    it("returns null even when each default field is restated", () => {
        expect(computeFbxAxisConversionMatrix({ ...DEFAULT })).toBeNull();
    });
});

describe("computeFbxAxisConversionMatrix — Z-up → Y-up", () => {
    // Z-up Max/Maya style: up=+Z, front=-Y, coord=+X.
    const ZUP: FbxAxisSettings = {
        upAxis: 2,
        upAxisSign: 1,
        frontAxis: 1,
        frontAxisSign: -1,
        coordAxis: 0,
        coordAxisSign: 1,
        unitScaleFactor: 1,
    };

    it("is non-null and maps the file up vector (+Z) to Babylon up (+Y)", () => {
        const m = computeFbxAxisConversionMatrix(ZUP);
        expect(m).not.toBeNull();
        expectPoint(transformPoint(m!, 0, 0, 1), [0, 1, 0]);
    });

    it("maps coord (+X) → +X and front (-Y) → +Z", () => {
        const m = computeFbxAxisConversionMatrix(ZUP)!;
        expectPoint(transformPoint(m, 1, 0, 0), [1, 0, 0]); // coord stays X
        expectPoint(transformPoint(m, 0, -1, 0), [0, 0, 1]); // front (-Y) → +Z
    });

    it("preserves handedness (determinant of the linear 3×3 part is +1)", () => {
        const f = computeFbxAxisConversionMatrix(ZUP)! as unknown as ArrayLike<number>;
        // Column-major linear part.
        const a = f[0]!,
            b = f[4]!,
            c = f[8]!;
        const d = f[1]!,
            e = f[5]!,
            g = f[9]!;
        const h = f[2]!,
            i = f[6]!,
            j = f[10]!;
        const det = a * (e * j - g * i) - b * (d * j - g * h) + c * (d * i - e * h);
        expect(det).toBeCloseTo(1, 9);
    });
});

describe("computeFbxAxisConversionMatrix — unit scale", () => {
    it("scales by unitScaleFactor when the frame is otherwise default", () => {
        const m = computeFbxAxisConversionMatrix({ ...DEFAULT, unitScaleFactor: 2.54 });
        expect(m).not.toBeNull();
        // Default axes → pure uniform scale of 2.54.
        expectPoint(transformPoint(m!, 1, 0, 0), [2.54, 0, 0]);
        expectPoint(transformPoint(m!, 0, 1, 0), [0, 2.54, 0]);
        expectPoint(transformPoint(m!, 0, 0, 1), [0, 0, 2.54]);
        expectPoint(transformPoint(m!, 2, -3, 4), [2 * 2.54, -3 * 2.54, 4 * 2.54]);
    });

    it("folds the unit scale into a Z-up conversion", () => {
        const m = computeFbxAxisConversionMatrix({
            upAxis: 2,
            upAxisSign: 1,
            frontAxis: 1,
            frontAxisSign: -1,
            coordAxis: 0,
            coordAxisSign: 1,
            unitScaleFactor: 2.54,
        })!;
        // +Z up, scaled.
        expectPoint(transformPoint(m, 0, 0, 1), [0, 2.54, 0]);
    });
});
