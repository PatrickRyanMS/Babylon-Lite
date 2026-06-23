import { describe, expect, it } from "vitest";

import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import { mat4Multiply } from "../../../packages/babylon-lite/src/math/mat4-multiply.js";
import {
    fbxMatIdentity,
    fbxMatInvert,
    fbxMatMultiply,
    fbxMatRotationX,
    fbxMatRotationY,
    fbxMatRotationZ,
    fbxMatScaling,
    fbxMatTranslation,
} from "../../../packages/babylon-lite/src/loader-fbx/interpreter/fbx-mat4.js";
import {
    computeFBXGeometricDeltaMatrix,
    computeFBXGeometricMatrix,
    computeFBXGeometricNormalMatrix,
    computeFBXLocalMatrix,
    eulerToMatrix,
    eulerToMatrixXYZ,
    type FBXTransformComponents,
    type FBXVector3,
} from "../../../packages/babylon-lite/src/loader-fbx/interpreter/transform.js";

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// Convention pin: apply a Lite column-major Mat4 to a point.
//   x' = m[0]x + m[4]y + m[8]z + m[12]
//   y' = m[1]x + m[5]y + m[9]z + m[13]
//   z' = m[2]x + m[6]y + m[10]z + m[14]
// This is the COLUMN-MAJOR application that Lite uses (v' = M . v). The flat
// storage of a ported BJS matrix IS a valid Lite column-major matrix, so this
// is the single source of truth for "what the matrix does to a vector".
// ---------------------------------------------------------------------------
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const f = m as unknown as ArrayLike<number>;
    return [f[0]! * x + f[4]! * y + f[8]! * z + f[12]!, f[1]! * x + f[5]! * y + f[9]! * z + f[13]!, f[2]! * x + f[6]! * y + f[10]! * z + f[14]!];
}

function flat(m: Mat4): number[] {
    return Array.from(m as unknown as ArrayLike<number>);
}

// ---------------------------------------------------------------------------
// INDEPENDENT reference math: plain nested-array matrices in standard
// column-vector convention. ref[i][j] is row i, col j; applied as out = ref . v.
// refMul(A, B) is the standard product A . B (B applied first to a vector).
// These intentionally do NOT use fbx-mat4 so they form an independent oracle.
// ---------------------------------------------------------------------------
type RefMat = number[][];

function refIdentity(): RefMat {
    return [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];
}

function refMul(a: RefMat, b: RefMat): RefMat {
    const out: RefMat = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ];
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let s = 0;
            for (let k = 0; k < 4; k++) {
                s += a[i]![k]! * b[k]![j]!;
            }
            out[i]![j] = s;
        }
    }
    return out;
}

function refApply(m: RefMat, x: number, y: number, z: number): [number, number, number] {
    return [
        m[0]![0]! * x + m[0]![1]! * y + m[0]![2]! * z + m[0]![3]!,
        m[1]![0]! * x + m[1]![1]! * y + m[1]![2]! * z + m[1]![3]!,
        m[2]![0]! * x + m[2]![1]! * y + m[2]![2]! * z + m[2]![3]!,
    ];
}

function refTranslation(x: number, y: number, z: number): RefMat {
    const m = refIdentity();
    m[0]![3] = x;
    m[1]![3] = y;
    m[2]![3] = z;
    return m;
}

function refScaling(x: number, y: number, z: number): RefMat {
    const m = refIdentity();
    m[0]![0] = x;
    m[1]![1] = y;
    m[2]![2] = z;
    return m;
}

// Standard right-handed column-vector rotation matrices (v' = R . v).
function refRotX(a: number): RefMat {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        [1, 0, 0, 0],
        [0, c, -s, 0],
        [0, s, c, 0],
        [0, 0, 0, 1],
    ];
}

function refRotY(a: number): RefMat {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        [c, 0, s, 0],
        [0, 1, 0, 0],
        [-s, 0, c, 0],
        [0, 0, 0, 1],
    ];
}

function refRotZ(a: number): RefMat {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        [c, -s, 0, 0],
        [s, c, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];
}

function refRotForAxis(axis: string, angle: number): RefMat {
    if (axis === "X") {
        return refRotX(angle);
    }
    if (axis === "Y") {
        return refRotY(angle);
    }
    return refRotZ(angle);
}

// Compose Euler rotations in the documented order string. The FIRST letter is
// applied FIRST to the vector, so the math product pre-multiplies each new
// axis: e.g. "XYZ" => Rz . Ry . Rx (rotate X, then Y, then Z).
function refEuler(rxRad: number, ryRad: number, rzRad: number, order: string): RefMat {
    const angles: Record<string, number> = { X: rxRad, Y: ryRad, Z: rzRad };
    let result = refIdentity();
    for (const axis of order) {
        result = refMul(refRotForAxis(axis, angles[axis]!), result);
    }
    return result;
}

function refTranspose3(m: RefMat): RefMat {
    const out = refIdentity();
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            out[i]![j] = m[j]![i]!;
        }
    }
    return out;
}

const ORDER_NAMES = ["XYZ", "XZY", "YZX", "YXZ", "ZXY", "ZYX"];

const TEST_POINTS: Array<[number, number, number]> = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 2, 3],
    [-2, 0.5, 4],
    [7, -3, -1.5],
];

function expectPointClose(actual: [number, number, number], expected: [number, number, number], eps: number): void {
    expect(actual[0]).toBeCloseTo(expected[0], eps);
    expect(actual[1]).toBeCloseTo(expected[1], eps);
    expect(actual[2]).toBeCloseTo(expected[2], eps);
}

// 3x3 determinant of the linear part of a column-major Mat4.
function det3(m: Mat4): number {
    const f = m as unknown as ArrayLike<number>;
    const a = f[0]!;
    const b = f[4]!;
    const c = f[8]!;
    const d = f[1]!;
    const e = f[5]!;
    const g = f[9]!;
    const h = f[2]!;
    const i = f[6]!;
    const j = f[10]!;
    return a * (e * j - g * i) - b * (d * j - g * h) + c * (d * i - e * h);
}

describe("fbx transform — convention pin (rotation point mappings)", () => {
    it("RotationZ(pi/2) maps (1,0,0) -> (0,1,0)", () => {
        expectPointClose(transformPoint(fbxMatRotationZ(Math.PI / 2), 1, 0, 0), [0, 1, 0], 9);
    });

    it("RotationX(pi/2) maps (0,1,0) -> (0,0,1)", () => {
        expectPointClose(transformPoint(fbxMatRotationX(Math.PI / 2), 0, 1, 0), [0, 0, 1], 9);
    });

    it("RotationY(pi/2) maps (0,0,1) -> (1,0,0)", () => {
        expectPointClose(transformPoint(fbxMatRotationY(Math.PI / 2), 0, 0, 1), [1, 0, 0], 9);
    });

    it("exact BJS flat layouts for RotationX/Y/Z", () => {
        // RotationX flat = [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]
        const ax = Math.PI / 5;
        const cx = Math.cos(ax);
        const sx = Math.sin(ax);
        expect(flat(fbxMatRotationX(ax))).toEqual([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
        // RotationY flat = [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]
        expect(flat(fbxMatRotationY(ax))).toEqual([cx, 0, -sx, 0, 0, 1, 0, 0, sx, 0, cx, 0, 0, 0, 0, 1]);
        // RotationZ flat = [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]
        expect(flat(fbxMatRotationZ(ax))).toEqual([cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });
});

describe("fbx transform — eulerToMatrix orders 0..5 vs independent reference", () => {
    const rx = 30 * D2R;
    const ry = 40 * D2R;
    const rz = 50 * D2R;

    for (let order = 0; order < 6; order++) {
        it(`order ${order} (${ORDER_NAMES[order]}) matches nested-array reference`, () => {
            const m = eulerToMatrix(rx, ry, rz, order);
            const ref = refEuler(rx, ry, rz, ORDER_NAMES[order]!);
            for (const p of TEST_POINTS) {
                expectPointClose(transformPoint(m, p[0], p[1], p[2]), refApply(ref, p[0], p[1], p[2]), 6);
            }
        });
    }

    it("order actually matters (XYZ differs from ZYX)", () => {
        const xyz = eulerToMatrix(rx, ry, rz, 0);
        const zyx = eulerToMatrix(rx, ry, rz, 5);
        const p: [number, number, number] = [1, 2, 3];
        const a = transformPoint(xyz, p[0], p[1], p[2]);
        const b = transformPoint(zyx, p[0], p[1], p[2]);
        const diff = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        expect(diff).toBeGreaterThan(1e-3);
    });

    it("eulerToMatrixXYZ equals eulerToMatrix order 0", () => {
        const a = eulerToMatrixXYZ(rx, ry, rz);
        const b = eulerToMatrix(rx, ry, rz, 0);
        expect(flat(a)).toEqual(flat(b));
    });
});

describe("fbx transform — computeFBXLocalMatrix fast path (S.R.T)", () => {
    it("zero pivots/offsets/postRotation equals manual S * (lclRot * preRot) * T", () => {
        const components: FBXTransformComponents = {
            translation: [5, -3, 2],
            rotation: [25, 15, -40],
            scale: [2, 0.5, 3],
            preRotation: [10, -20, 5],
            postRotation: [0, 0, 0],
            rotationPivot: [0, 0, 0],
            scalingPivot: [0, 0, 0],
            rotationOffset: [0, 0, 0],
            scalingOffset: [0, 0, 0],
            rotationOrder: 0,
        };

        const m = computeFBXLocalMatrix(components);

        // Independent reference: T . preRot . lclRot . S (column-vector math).
        const refS = refScaling(components.scale[0], components.scale[1], components.scale[2]);
        const refLcl = refEuler(components.rotation[0] * D2R, components.rotation[1] * D2R, components.rotation[2] * D2R, ORDER_NAMES[components.rotationOrder]!);
        const refPre = refEuler(components.preRotation[0] * D2R, components.preRotation[1] * D2R, components.preRotation[2] * D2R, "XYZ");
        const refT = refTranslation(components.translation[0], components.translation[1], components.translation[2]);
        const ref = refMul(refMul(refMul(refT, refPre), refLcl), refS);

        for (const p of TEST_POINTS) {
            expectPointClose(transformPoint(m, p[0], p[1], p[2]), refApply(ref, p[0], p[1], p[2]), 6);
        }
    });
});

describe("fbx transform — computeFBXLocalMatrix compound (full path)", () => {
    it("non-zero pivots/offsets/pre+post rotation/non-uniform scale/non-XYZ order vs independent reference", () => {
        const components: FBXTransformComponents = {
            translation: [12, -4, 7],
            rotation: [35, -25, 55],
            scale: [2, 3, 0.5],
            preRotation: [10, 20, -15],
            postRotation: [-30, 12, 8],
            rotationPivot: [1, -2, 3],
            scalingPivot: [-1.5, 0.5, 2],
            rotationOffset: [0.5, 1.5, -1],
            scalingOffset: [2, -0.5, 1],
            rotationOrder: 3, // YXZ — non-XYZ
        };

        const m = computeFBXLocalMatrix(components);

        // Independent reference reproduces the BJS multiply chain. Each
        // X.multiply(Y) is row-major (X applied first); the equivalent
        // column-vector product reverses the whole chain:
        //   result = T . Roff . Rp . Rpre . R . RpostInv . RpInv . Soff . Sp . S . SpInv
        const refT = refTranslation(components.translation[0], components.translation[1], components.translation[2]);
        const refRoff = refTranslation(components.rotationOffset[0], components.rotationOffset[1], components.rotationOffset[2]);
        const refRp = refTranslation(components.rotationPivot[0], components.rotationPivot[1], components.rotationPivot[2]);
        const refRpInv = refTranslation(-components.rotationPivot[0], -components.rotationPivot[1], -components.rotationPivot[2]);
        const refSoff = refTranslation(components.scalingOffset[0], components.scalingOffset[1], components.scalingOffset[2]);
        const refSp = refTranslation(components.scalingPivot[0], components.scalingPivot[1], components.scalingPivot[2]);
        const refSpInv = refTranslation(-components.scalingPivot[0], -components.scalingPivot[1], -components.scalingPivot[2]);
        const refRpre = refEuler(components.preRotation[0] * D2R, components.preRotation[1] * D2R, components.preRotation[2] * D2R, "XYZ");
        const refR = refEuler(components.rotation[0] * D2R, components.rotation[1] * D2R, components.rotation[2] * D2R, ORDER_NAMES[components.rotationOrder]!);
        const refPost = refEuler(components.postRotation[0] * D2R, components.postRotation[1] * D2R, components.postRotation[2] * D2R, "XYZ");
        const refRpostInv = refTranspose3(refPost); // inverse of an orthonormal rotation
        const refS = refScaling(components.scale[0], components.scale[1], components.scale[2]);

        let ref = refT;
        ref = refMul(ref, refRoff);
        ref = refMul(ref, refRp);
        ref = refMul(ref, refRpre);
        ref = refMul(ref, refR);
        ref = refMul(ref, refRpostInv);
        ref = refMul(ref, refRpInv);
        ref = refMul(ref, refSoff);
        ref = refMul(ref, refSp);
        ref = refMul(ref, refS);
        ref = refMul(ref, refSpInv);

        const probes: Array<[number, number, number]> = [
            [1, 2, 3],
            [-4, 5, -6],
            [0.25, -0.75, 2.5],
        ];
        for (const p of probes) {
            expectPointClose(transformPoint(m, p[0], p[1], p[2]), refApply(ref, p[0], p[1], p[2]), 6);
        }
    });
});

describe("fbx transform — fbxMatInvert", () => {
    it("M * inverse(M) = identity for a non-orthogonal affine M", () => {
        // Non-uniform scale + rotation + translation (non-orthogonal linear part).
        const S = fbxMatScaling(2, 0.5, 3);
        const R = eulerToMatrix(20 * D2R, -35 * D2R, 50 * D2R, 2);
        const T = fbxMatTranslation(7, -2, 4);
        const M = fbxMatMultiply(fbxMatMultiply(S, R), T);

        const prod = fbxMatMultiply(M, fbxMatInvert(M));
        const id = flat(fbxMatIdentity());
        const got = flat(prod);
        for (let i = 0; i < 16; i++) {
            expect(got[i]!).toBeCloseTo(id[i]!, 6);
        }
    });
});

describe("fbx transform — bridge to Lite mat4Multiply", () => {
    it("fbxMatMultiply(child, parent) == mat4Multiply(parent, child)", () => {
        const child = fbxMatMultiply(fbxMatMultiply(fbxMatScaling(1.5, 2.0, 0.75), eulerToMatrix(15 * D2R, 40 * D2R, -25 * D2R, 0)), fbxMatTranslation(3, -1, 2));
        const parent = fbxMatMultiply(fbxMatMultiply(fbxMatScaling(0.5, 1.25, 2.0), eulerToMatrix(-30 * D2R, 10 * D2R, 55 * D2R, 4)), fbxMatTranslation(-2, 5, 1));

        const left = flat(fbxMatMultiply(child, parent));
        const right = flat(mat4Multiply(parent, child));
        for (let i = 0; i < 16; i++) {
            expect(left[i]!).toBeCloseTo(right[i]!, 4);
        }
    });
});

describe("fbx transform — geometric matrices", () => {
    it("identity inputs -> identity", () => {
        const id: FBXVector3 = [0, 0, 0];
        const unit: FBXVector3 = [1, 1, 1];
        expect(flat(computeFBXGeometricMatrix(id, id, unit))).toEqual(flat(fbxMatIdentity()));
        expect(flat(computeFBXGeometricDeltaMatrix(id, unit))).toEqual(flat(fbxMatIdentity()));
        expect(flat(computeFBXGeometricNormalMatrix(id, unit))).toEqual(flat(fbxMatIdentity()));
    });

    it("pure scale -> diagonal delta matrix", () => {
        const delta = flat(computeFBXGeometricDeltaMatrix([0, 0, 0], [2, 3, 4]));
        expect(delta).toEqual([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
    });

    it("normal matrix = inverse-scale * rotation", () => {
        const rotation: FBXVector3 = [22, -17, 41];
        const scale: FBXVector3 = [2, 4, 0.5];
        const normal = computeFBXGeometricNormalMatrix(rotation, scale);
        const expected = fbxMatMultiply(fbxMatScaling(1 / scale[0], 1 / scale[1], 1 / scale[2]), eulerToMatrixXYZ(rotation[0] * D2R, rotation[1] * D2R, rotation[2] * D2R));
        const a = flat(normal);
        const b = flat(expected);
        for (let i = 0; i < 16; i++) {
            expect(a[i]!).toBeCloseTo(b[i]!, 9);
        }
        // Pure-scale normal matrix has reciprocal scales on the diagonal.
        const pure = flat(computeFBXGeometricNormalMatrix([0, 0, 0], [2, 4, 8]));
        expect(pure[0]!).toBeCloseTo(0.5, 9);
        expect(pure[5]!).toBeCloseTo(0.25, 9);
        expect(pure[10]!).toBeCloseTo(0.125, 9);
    });
});

describe("fbx transform — negative scale determinant", () => {
    it("a single negative scale axis yields a negative determinant", () => {
        const S = fbxMatScaling(2, 3, -1);
        const R = eulerToMatrix(15 * D2R, 25 * D2R, -10 * D2R, 0);
        const T = fbxMatTranslation(1, 2, 3);
        const M = fbxMatMultiply(fbxMatMultiply(S, R), T);
        expect(det3(M)).toBeLessThan(0);

        // Sanity: positive (even) scale keeps a positive determinant.
        const Spos = fbxMatScaling(2, 3, 1);
        const Mpos = fbxMatMultiply(fbxMatMultiply(Spos, R), T);
        expect(det3(Mpos)).toBeGreaterThan(0);
    });
});
