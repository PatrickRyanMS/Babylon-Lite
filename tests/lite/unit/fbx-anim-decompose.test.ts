import { describe, expect, it } from "vitest";

import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import { mat4Compose } from "../../../packages/babylon-lite/src/math/mat4-compose.js";
import { fbxMatDecompose } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/fbx-mat4.js";

const SQRT1_2 = Math.SQRT1_2; // ≈ 0.70710678…

/** Per-element matrix closeness assertion. */
function expectMatClose(a: Mat4, b: Mat4, eps = 1e-5): void {
    const fa = a as unknown as ArrayLike<number>;
    const fb = b as unknown as ArrayLike<number>;
    for (let i = 0; i < 16; i++) {
        expect(Math.abs(fa[i]! - fb[i]!), `element ${i}: ${fa[i]} vs ${fb[i]}`).toBeLessThanOrEqual(eps);
    }
}

/** Normalize a quaternion to a canonical sign (w >= 0) for comparison. */
function canonicalQuat(q: [number, number, number, number]): [number, number, number, number] {
    return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

describe("fbxMatDecompose", () => {
    it("decomposes the identity matrix", () => {
        const m = mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        const { t, q, s } = fbxMatDecompose(m);
        expect(t).toEqual([0, 0, 0]);
        expect(canonicalQuat(q)).toEqual([0, 0, 0, 1]);
        expect(s[0]).toBeCloseTo(1, 6);
        expect(s[1]).toBeCloseTo(1, 6);
        expect(s[2]).toBeCloseTo(1, 6);
    });

    it("recovers a known 90° rotation about Z as a quaternion", () => {
        // 90° about +Z → quaternion (0, 0, sin45, cos45).
        const m = mat4Compose(0, 0, 0, 0, 0, SQRT1_2, SQRT1_2, 1, 1, 1);
        const { q } = fbxMatDecompose(m);
        const c = canonicalQuat(q);
        expect(c[0]).toBeCloseTo(0, 6);
        expect(c[1]).toBeCloseTo(0, 6);
        expect(c[2]).toBeCloseTo(SQRT1_2, 6);
        expect(c[3]).toBeCloseTo(SQRT1_2, 6);
    });

    it("round-trips translation + rotation + positive non-uniform scale", () => {
        // A non-trivial rotation quaternion (normalized) + non-uniform scale.
        const qx = 0.1;
        const qy = -0.3;
        const qz = 0.2;
        const qw = Math.sqrt(1 - qx * qx - qy * qy - qz * qz);
        const m = mat4Compose(5, -2, 3, qx, qy, qz, qw, 2, 0.5, 1.5);

        const { t, q, s } = fbxMatDecompose(m);
        // Translation is exact.
        expect(t[0]).toBeCloseTo(5, 5);
        expect(t[1]).toBeCloseTo(-2, 5);
        expect(t[2]).toBeCloseTo(3, 5);
        // Scale magnitudes recovered.
        expect(s[0]).toBeCloseTo(2, 5);
        expect(s[1]).toBeCloseTo(0.5, 5);
        expect(s[2]).toBeCloseTo(1.5, 5);
        // Quaternion recovered (up to sign).
        const c = canonicalQuat(q);
        expect(c[0]).toBeCloseTo(qx, 5);
        expect(c[1]).toBeCloseTo(qy, 5);
        expect(c[2]).toBeCloseTo(qz, 5);
        expect(c[3]).toBeCloseTo(qw, 5);

        // Full matrix round-trip via recompose.
        const m2 = mat4Compose(t[0], t[1], t[2], q[0], q[1], q[2], q[3], s[0], s[1], s[2]);
        expectMatClose(m, m2);
    });

    it("round-trips a matrix with a negative scale (reflection) at the matrix level", () => {
        // A mirrored basis: decompose folds the reflection into one scale axis and
        // keeps a proper rotation, but recompose must still reproduce the matrix.
        const qx = 0.0;
        const qy = 0.4;
        const qz = 0.0;
        const qw = Math.sqrt(1 - qy * qy);
        const m = mat4Compose(1, 2, -1, qx, qy, qz, qw, -2, 1, 1);

        const { t, q, s } = fbxMatDecompose(m);
        const m2 = mat4Compose(t[0], t[1], t[2], q[0], q[1], q[2], q[3], s[0], s[1], s[2]);
        expectMatClose(m, m2);
    });
});
