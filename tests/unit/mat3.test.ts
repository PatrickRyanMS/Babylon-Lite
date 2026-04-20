import { describe, it, expect } from "vitest";
import { mat3Compose, mat3Identity, mat3Invert, mat3Multiply, mat3MultiplyInto, mat3TransformPoint } from "../../packages/babylon-lite/src/math/mat3";

describe("mat3", () => {
    it("identity", () => {
        const m = mat3Identity();
        expect(m[0]).toBe(1);
        expect(m[4]).toBe(1);
        expect(m[8]).toBe(1);
        expect(m[1]).toBe(0);
        expect(m[3]).toBe(0);
        const [x, y] = mat3TransformPoint(m, 5, -3);
        expect(x).toBe(5);
        expect(y).toBe(-3);
    });

    it("compose: translation only is recoverable", () => {
        const m = mat3Compose(7, -4, 0, 1, 1);
        expect(m[6]).toBe(7);
        expect(m[7]).toBe(-4);
        const [x, y] = mat3TransformPoint(m, 0, 0);
        expect(x).toBe(7);
        expect(y).toBe(-4);
    });

    it("compose: rotation pi/2 then translate", () => {
        const m = mat3Compose(10, 20, Math.PI / 2, 1, 1);
        const [x, y] = mat3TransformPoint(m, 1, 0);
        // rotate (1,0) by pi/2 → (0,1), then translate +(10,20) → (10, 21).
        expect(x).toBeCloseTo(10);
        expect(y).toBeCloseTo(21);
    });

    it("compose: scale", () => {
        const m = mat3Compose(0, 0, 0, 2, 3);
        const [x, y] = mat3TransformPoint(m, 4, 5);
        expect(x).toBe(8);
        expect(y).toBe(15);
    });

    it("multiply: parent * child applies child first", () => {
        const child = mat3Compose(1, 2, 0, 1, 1); // translate (1,2)
        const parent = mat3Compose(10, 20, 0, 1, 1); // translate (10,20)
        const world = mat3Multiply(parent, child);
        const [x, y] = mat3TransformPoint(world, 0, 0);
        expect(x).toBe(11);
        expect(y).toBe(22);
    });

    it("multiplyInto matches multiply", () => {
        const a = mat3Compose(1, 2, Math.PI / 4, 1, 2);
        const b = mat3Compose(3, 4, Math.PI / 3, 0.5, 0.5);
        const expected = mat3Multiply(a, b);
        const out = new Float32Array(9);
        mat3MultiplyInto(out, a, b);
        for (let i = 0; i < 9; i++) {
            expect(out[i]).toBeCloseTo(expected[i]!);
        }
    });

    it("invert: round-trip is identity", () => {
        const m = mat3Compose(7, -4, 0.7, 2, 0.5);
        const inv = mat3Invert(m);
        expect(inv).not.toBeNull();
        const id = mat3Multiply(m, inv!);
        expect(id[0]).toBeCloseTo(1);
        expect(id[4]).toBeCloseTo(1);
        expect(id[8]).toBeCloseTo(1);
        expect(id[1]).toBeCloseTo(0);
        expect(id[3]).toBeCloseTo(0);
    });

    it("invert: singular returns null", () => {
        // Zero scale → singular linear part.
        const m = mat3Compose(0, 0, 0, 0, 0);
        expect(mat3Invert(m)).toBeNull();
    });
});
