import type { Mat4 } from "../../math/types.js";

/**
 * Self-contained 4x4 matrix helper that replicates Babylon.js `Matrix` flat
 * semantics exactly, so the FBX transform math can be ported line-for-line.
 *
 * BJS `Matrix` uses row-major storage with row-vector math, while Lite `Mat4`
 * uses column-major storage with column-vector math. For the SAME transform the
 * two flat 16-element layouts are IDENTICAL (the two transpose conventions
 * cancel): translation lives at flat indices 12,13,14 in both, the rotation
 * builders below match `Matrix.RotationX/Y/Z`, and `fbxMatMultiply` is the
 * BJS row-major product (left operand applied first). Therefore every value
 * produced here is directly usable as a Lite column-major `Mat4` with NO
 * transpose and NO multiply-order reversal.
 *
 * The helper operates on `Float64Array(16)` for precision and is fully
 * self-contained: it imports only the `Mat4` type and never touches Lite's
 * `mat4Multiply`, `mat4Invert`, or the compose kernels.
 */

/** Identity matrix (flat diagonal 1 at indices 0,5,10,15). */
export function fbxMatIdentity(): Mat4 {
    const m = new Float64Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m as unknown as Mat4;
}

/** Translation matrix; tx,ty,tz at flat indices 12,13,14 (matches `Matrix.Translation`). */
export function fbxMatTranslation(x: number, y: number, z: number): Mat4 {
    const m = new Float64Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m as unknown as Mat4;
}

/** Scaling matrix; diagonal at flat indices 0,5,10 = x,y,z (matches `Matrix.Scaling`). */
export function fbxMatScaling(x: number, y: number, z: number): Mat4 {
    const m = new Float64Array(16);
    m[0] = x;
    m[5] = y;
    m[10] = z;
    m[15] = 1;
    return m as unknown as Mat4;
}

/** Rotation about X. Flat = [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1] (matches `Matrix.RotationX`). */
export function fbxMatRotationX(theta: number): Mat4 {
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    const m = new Float64Array(16);
    m[0] = 1;
    m[5] = c;
    m[6] = s;
    m[9] = -s;
    m[10] = c;
    m[15] = 1;
    return m as unknown as Mat4;
}

/** Rotation about Y. Flat = [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1] (matches `Matrix.RotationY`). */
export function fbxMatRotationY(theta: number): Mat4 {
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    const m = new Float64Array(16);
    m[0] = c;
    m[2] = -s;
    m[5] = 1;
    m[8] = s;
    m[10] = c;
    m[15] = 1;
    return m as unknown as Mat4;
}

/** Rotation about Z. Flat = [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1] (matches `Matrix.RotationZ`). */
export function fbxMatRotationZ(theta: number): Mat4 {
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    const m = new Float64Array(16);
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
    m[10] = 1;
    m[15] = 1;
    return m as unknown as Mat4;
}

/**
 * Row-major product: out[i*4+j] = sum_k a[i*4+k] * b[k*4+j].
 * This is BJS `a.multiply(b)` semantics: `a` is applied first, then `b`.
 * Do NOT confuse with Lite's `mat4Multiply` (column-major, b applied first).
 */
export function fbxMatMultiply(a: Mat4, b: Mat4): Mat4 {
    const am = a as unknown as Float64Array;
    const bm = b as unknown as Float64Array;
    const out = new Float64Array(16);
    for (let i = 0; i < 4; i++) {
        const a0 = am[i * 4]!;
        const a1 = am[i * 4 + 1]!;
        const a2 = am[i * 4 + 2]!;
        const a3 = am[i * 4 + 3]!;
        out[i * 4] = a0 * bm[0]! + a1 * bm[4]! + a2 * bm[8]! + a3 * bm[12]!;
        out[i * 4 + 1] = a0 * bm[1]! + a1 * bm[5]! + a2 * bm[9]! + a3 * bm[13]!;
        out[i * 4 + 2] = a0 * bm[2]! + a1 * bm[6]! + a2 * bm[10]! + a3 * bm[14]!;
        out[i * 4 + 3] = a0 * bm[3]! + a1 * bm[7]! + a2 * bm[11]! + a3 * bm[15]!;
    }
    return out as unknown as Mat4;
}

/**
 * Decompose a column-major affine `Mat4` into translation, rotation quaternion
 * (x, y, z, w) and scale. The inverse of Lite's `mat4Compose`, so a round-trip
 * `mat4Compose(decompose(M)) === M` for any shear-free TRS matrix — which every
 * `computeFBXLocalMatrix` result is (its upper-left 3×3 is `R·diag(s)`, i.e. the
 * columns are the scaled rotation axes).
 *
 * Scale magnitudes are the column lengths; a negative 3×3 determinant (an odd
 * number of mirrored axes) flips the X scale so the recovered rotation stays a
 * proper rotation (det = +1) and the quaternion extraction is valid. The
 * quaternion uses the same basis as `mat4ComposeInto`/`mat4FromQuat`, so the
 * animation system reproduces the exact pose when it recomposes.
 */
export function fbxMatDecompose(m: Mat4): { t: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] } {
    const e = m as unknown as ArrayLike<number>;

    // Column lengths = scale magnitudes (columns are the scaled rotation axes).
    let sx = Math.hypot(e[0]!, e[1]!, e[2]!);
    const sy = Math.hypot(e[4]!, e[5]!, e[6]!);
    const sz = Math.hypot(e[8]!, e[9]!, e[10]!);

    // 3×3 determinant: negative ⇒ a reflection is folded in; flip one scale axis
    // so the recovered rotation matrix is proper (det +1).
    const det = e[0]! * (e[5]! * e[10]! - e[6]! * e[9]!) - e[4]! * (e[1]! * e[10]! - e[2]! * e[9]!) + e[8]! * (e[1]! * e[6]! - e[2]! * e[5]!);
    if (det < 0) {
        sx = -sx;
    }

    const t: [number, number, number] = [e[12]!, e[13]!, e[14]!];

    if (sx === 0 || sy === 0 || sz === 0) {
        return { t, q: [0, 0, 0, 1], s: [sx, sy, sz] };
    }

    const ix = 1 / sx;
    const iy = 1 / sy;
    const iz = 1 / sz;
    // Rotation matrix columns (column-major), normalized. rRC = row R, col C.
    const r00 = e[0]! * ix;
    const r10 = e[1]! * ix;
    const r20 = e[2]! * ix;
    const r01 = e[4]! * iy;
    const r11 = e[5]! * iy;
    const r21 = e[6]! * iy;
    const r02 = e[8]! * iz;
    const r12 = e[9]! * iz;
    const r22 = e[10]! * iz;

    const trace = r00 + r11 + r22;
    let qx: number;
    let qy: number;
    let qz: number;
    let qw: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2; // 4·qw
        qw = 0.25 * s;
        qx = (r21 - r12) / s;
        qy = (r02 - r20) / s;
        qz = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1 + r00 - r11 - r22) * 2; // 4·qx
        qw = (r21 - r12) / s;
        qx = 0.25 * s;
        qy = (r01 + r10) / s;
        qz = (r02 + r20) / s;
    } else if (r11 > r22) {
        const s = Math.sqrt(1 + r11 - r00 - r22) * 2; // 4·qy
        qw = (r02 - r20) / s;
        qx = (r01 + r10) / s;
        qy = 0.25 * s;
        qz = (r12 + r21) / s;
    } else {
        const s = Math.sqrt(1 + r22 - r00 - r11) * 2; // 4·qz
        qw = (r10 - r01) / s;
        qx = (r02 + r20) / s;
        qy = (r12 + r21) / s;
        qz = 0.25 * s;
    }

    return { t, q: [qx, qy, qz, qw], s: [sx, sy, sz] };
}

/**
 * Full 4x4 inverse (general affine / non-orthogonal), via the transpose of the
 * cofactor matrix divided by the determinant. Returns identity when singular.
 * Replicates `Matrix.invertToRef` / `InvertMatrixToArray` flat output exactly.
 */
export function fbxMatInvert(m: Mat4): Mat4 {
    const src = m as unknown as Float64Array;
    const m00 = src[0]!;
    const m01 = src[1]!;
    const m02 = src[2]!;
    const m03 = src[3]!;
    const m10 = src[4]!;
    const m11 = src[5]!;
    const m12 = src[6]!;
    const m13 = src[7]!;
    const m20 = src[8]!;
    const m21 = src[9]!;
    const m22 = src[10]!;
    const m23 = src[11]!;
    const m30 = src[12]!;
    const m31 = src[13]!;
    const m32 = src[14]!;
    const m33 = src[15]!;

    const det_22_33 = m22 * m33 - m32 * m23;
    const det_21_33 = m21 * m33 - m31 * m23;
    const det_21_32 = m21 * m32 - m31 * m22;
    const det_20_33 = m20 * m33 - m30 * m23;
    const det_20_32 = m20 * m32 - m22 * m30;
    const det_20_31 = m20 * m31 - m30 * m21;

    const cofact_00 = +(m11 * det_22_33 - m12 * det_21_33 + m13 * det_21_32);
    const cofact_01 = -(m10 * det_22_33 - m12 * det_20_33 + m13 * det_20_32);
    const cofact_02 = +(m10 * det_21_33 - m11 * det_20_33 + m13 * det_20_31);
    const cofact_03 = -(m10 * det_21_32 - m11 * det_20_32 + m12 * det_20_31);

    const det = m00 * cofact_00 + m01 * cofact_01 + m02 * cofact_02 + m03 * cofact_03;

    if (det === 0) {
        return fbxMatIdentity();
    }

    const detInv = 1 / det;
    const det_12_33 = m12 * m33 - m32 * m13;
    const det_11_33 = m11 * m33 - m31 * m13;
    const det_11_32 = m11 * m32 - m31 * m12;
    const det_10_33 = m10 * m33 - m30 * m13;
    const det_10_32 = m10 * m32 - m30 * m12;
    const det_10_31 = m10 * m31 - m30 * m11;
    const det_12_23 = m12 * m23 - m22 * m13;
    const det_11_23 = m11 * m23 - m21 * m13;
    const det_11_22 = m11 * m22 - m21 * m12;
    const det_10_23 = m10 * m23 - m20 * m13;
    const det_10_22 = m10 * m22 - m20 * m12;
    const det_10_21 = m10 * m21 - m20 * m11;

    const cofact_10 = -(m01 * det_22_33 - m02 * det_21_33 + m03 * det_21_32);
    const cofact_11 = +(m00 * det_22_33 - m02 * det_20_33 + m03 * det_20_32);
    const cofact_12 = -(m00 * det_21_33 - m01 * det_20_33 + m03 * det_20_31);
    const cofact_13 = +(m00 * det_21_32 - m01 * det_20_32 + m02 * det_20_31);

    const cofact_20 = +(m01 * det_12_33 - m02 * det_11_33 + m03 * det_11_32);
    const cofact_21 = -(m00 * det_12_33 - m02 * det_10_33 + m03 * det_10_32);
    const cofact_22 = +(m00 * det_11_33 - m01 * det_10_33 + m03 * det_10_31);
    const cofact_23 = -(m00 * det_11_32 - m01 * det_10_32 + m02 * det_10_31);

    const cofact_30 = -(m01 * det_12_23 - m02 * det_11_23 + m03 * det_11_22);
    const cofact_31 = +(m00 * det_12_23 - m02 * det_10_23 + m03 * det_10_22);
    const cofact_32 = -(m00 * det_11_23 - m01 * det_10_23 + m03 * det_10_21);
    const cofact_33 = +(m00 * det_11_22 - m01 * det_10_22 + m02 * det_10_21);

    const out = new Float64Array(16);
    out[0] = cofact_00 * detInv;
    out[1] = cofact_10 * detInv;
    out[2] = cofact_20 * detInv;
    out[3] = cofact_30 * detInv;
    out[4] = cofact_01 * detInv;
    out[5] = cofact_11 * detInv;
    out[6] = cofact_21 * detInv;
    out[7] = cofact_31 * detInv;
    out[8] = cofact_02 * detInv;
    out[9] = cofact_12 * detInv;
    out[10] = cofact_22 * detInv;
    out[11] = cofact_32 * detInv;
    out[12] = cofact_03 * detInv;
    out[13] = cofact_13 * detInv;
    out[14] = cofact_23 * detInv;
    out[15] = cofact_33 * detInv;
    return out as unknown as Mat4;
}
