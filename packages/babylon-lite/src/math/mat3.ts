/** Mat3 — 3×3 column-major matrix used for 2D affine transforms.
 *
 *  Index layout (column-major):
 *    [0] [3] [6]
 *    [1] [4] [7]
 *    [2] [5] [8]
 *
 *  For 2D affine: rows 0–1 are the linear part (rotation × scale), and the
 *  last column (indices 6, 7) is the translation. Index 8 is always 1.
 *
 *  Matches the style of `mat4.ts` but smaller: small standalone utility,
 *  zero module-level allocations, no caches. */

export type Mat3 = Float32Array & { readonly __m3: unique symbol };

export function mat3Identity(): Mat3 {
    const m = new Float32Array(9) as Mat3;
    m[0] = 1;
    m[4] = 1;
    m[8] = 1;
    return m;
}

/** Compose a 2D affine matrix from translation, rotation (radians), and scale. */
export function mat3Compose(tx: number, ty: number, rotation: number, sx: number, sy: number): Mat3 {
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const m = new Float32Array(9) as Mat3;
    m[0] = c * sx;
    m[1] = s * sx;
    m[2] = 0;
    m[3] = -s * sy;
    m[4] = c * sy;
    m[5] = 0;
    m[6] = tx;
    m[7] = ty;
    m[8] = 1;
    return m;
}

/** Multiply: out = a * b. */
export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
    const out = new Float32Array(9) as Mat3;
    mat3MultiplyInto(out, a, b);
    return out;
}

/** Multiply into pre-allocated out. */
export function mat3MultiplyInto(out: Mat3 | Float32Array, a: Mat3 | Float32Array, b: Mat3 | Float32Array): void {
    const a00 = a[0]!,
        a01 = a[1]!,
        a02 = a[2]!;
    const a10 = a[3]!,
        a11 = a[4]!,
        a12 = a[5]!;
    const a20 = a[6]!,
        a21 = a[7]!,
        a22 = a[8]!;
    const b00 = b[0]!,
        b01 = b[1]!,
        b02 = b[2]!;
    const b10 = b[3]!,
        b11 = b[4]!,
        b12 = b[5]!;
    const b20 = b[6]!,
        b21 = b[7]!,
        b22 = b[8]!;
    out[0] = a00 * b00 + a10 * b01 + a20 * b02;
    out[1] = a01 * b00 + a11 * b01 + a21 * b02;
    out[2] = a02 * b00 + a12 * b01 + a22 * b02;
    out[3] = a00 * b10 + a10 * b11 + a20 * b12;
    out[4] = a01 * b10 + a11 * b11 + a21 * b12;
    out[5] = a02 * b10 + a12 * b11 + a22 * b12;
    out[6] = a00 * b20 + a10 * b21 + a20 * b22;
    out[7] = a01 * b20 + a11 * b21 + a21 * b22;
    out[8] = a02 * b20 + a12 * b21 + a22 * b22;
}

/** Compute inverse of a Mat3. Returns null if singular. */
export function mat3Invert(m: Mat3): Mat3 | null {
    const a = m[0]!,
        b = m[1]!,
        c = m[2]!;
    const d = m[3]!,
        e = m[4]!,
        f = m[5]!;
    const g = m[6]!,
        h = m[7]!,
        i = m[8]!;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    let det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-10) {
        return null;
    }
    det = 1 / det;
    const out = new Float32Array(9) as Mat3;
    out[0] = A * det;
    out[1] = -(b * i - c * h) * det;
    out[2] = (b * f - c * e) * det;
    out[3] = B * det;
    out[4] = (a * i - c * g) * det;
    out[5] = -(a * f - c * d) * det;
    out[6] = C * det;
    out[7] = -(a * h - b * g) * det;
    out[8] = (a * e - b * d) * det;
    return out;
}

/** Transform a 2D point by the matrix (assumes affine, w = 1). */
export function mat3TransformPoint(m: Mat3, x: number, y: number): [number, number] {
    return [m[0]! * x + m[3]! * y + m[6]!, m[1]! * x + m[4]! * y + m[7]!];
}
