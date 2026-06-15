import { describe, expect, it } from "vitest";

import type { FBXCurveData, FBXKeyframe } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/animation.js";
import { sampleFBXCurveAtTime, isFrameBakedSampledCurve } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/animation.js";

function curve(keys: FBXKeyframe[], isSampled = false): FBXCurveData {
    return { channel: "d|X", keys, isSampled };
}

describe("sampleFBXCurveAtTime", () => {
    it("returns null for an empty / missing curve", () => {
        expect(sampleFBXCurveAtTime(undefined, 0)).toBeNull();
        expect(sampleFBXCurveAtTime(curve([]), 0)).toBeNull();
    });

    it("clamps before the first and after the last key", () => {
        const c = curve([
            { time: 1, value: 10, interpolation: "linear" },
            { time: 2, value: 20, interpolation: "linear" },
        ]);
        expect(sampleFBXCurveAtTime(c, 0)).toBe(10);
        expect(sampleFBXCurveAtTime(c, 5)).toBe(20);
    });

    it("interpolates linearly between keys", () => {
        const c = curve([
            { time: 0, value: 0, interpolation: "linear" },
            { time: 1, value: 10, interpolation: "linear" },
        ]);
        expect(sampleFBXCurveAtTime(c, 0.5)).toBeCloseTo(5, 6);
        expect(sampleFBXCurveAtTime(c, 0.25)).toBeCloseTo(2.5, 6);
    });

    it("holds the current value for constant (standard) interpolation", () => {
        const c = curve([
            { time: 0, value: 0, interpolation: "constant", constantMode: "standard" },
            { time: 1, value: 10, interpolation: "linear" },
        ]);
        expect(sampleFBXCurveAtTime(c, 0.5)).toBe(0);
        expect(sampleFBXCurveAtTime(c, 0.999)).toBe(0);
    });

    it("jumps to the next value for constant (next) interpolation", () => {
        const c = curve([
            { time: 0, value: 0, interpolation: "constant", constantMode: "next" },
            { time: 1, value: 10, interpolation: "linear" },
        ]);
        expect(sampleFBXCurveAtTime(c, 0.5)).toBe(10);
    });

    it("evaluates a cubic Hermite segment using its tangents", () => {
        // Symmetric S-curve segment: zero end slopes ⇒ midpoint is the average.
        const c = curve([
            { time: 0, value: 0, interpolation: "cubic", rightSlope: 0, nextLeftSlope: 0 },
            { time: 1, value: 10, interpolation: "cubic", rightSlope: 0, nextLeftSlope: 0 },
        ]);
        expect(sampleFBXCurveAtTime(c, 0.5)).toBeCloseTo(5, 6);
        // Flat tangents pull the quarter point below the linear value (2.5).
        expect(sampleFBXCurveAtTime(c, 0.25)).toBeLessThan(2.5);
    });

    it("treats a sampled cubic curve as linear", () => {
        const c = curve(
            [
                { time: 0, value: 0, interpolation: "cubic", rightSlope: 5, nextLeftSlope: 5 },
                { time: 1, value: 10, interpolation: "cubic", rightSlope: 5, nextLeftSlope: 5 },
            ],
            true
        );
        // isSampled short-circuits the cubic evaluation to a plain lerp.
        expect(sampleFBXCurveAtTime(c, 0.5)).toBeCloseTo(5, 6);
    });
});

describe("isFrameBakedSampledCurve", () => {
    it("returns false for too few keys", () => {
        const keys: FBXKeyframe[] = [];
        for (let i = 0; i < 4; i++) {
            keys.push({ time: i / 30, value: i, interpolation: "linear" });
        }
        expect(isFrameBakedSampledCurve(keys)).toBe(false);
    });

    it("detects a uniform 30 fps linear bake", () => {
        const keys: FBXKeyframe[] = [];
        for (let i = 0; i < 16; i++) {
            keys.push({ time: i / 30, value: Math.sin(i), interpolation: "linear" });
        }
        expect(isFrameBakedSampledCurve(keys)).toBe(true);
    });

    it("rejects non-uniform key spacing", () => {
        const times = [0, 0.01, 0.2, 0.21, 0.5, 0.55, 0.9, 1.4, 1.41];
        const keys: FBXKeyframe[] = times.map((t, i) => ({ time: t, value: i, interpolation: "linear" }));
        expect(isFrameBakedSampledCurve(keys)).toBe(false);
    });
});
