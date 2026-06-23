import { describe, expect, it } from "vitest";

import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import type { FBXCameraData, FBXLightData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/fbx-interpreter.js";
import { fbxCameraToParams, buildFbxCamera } from "../../../packages/babylon-lite/src/loader-fbx/fbx-camera-build.js";
import { fbxLightToParams, buildFbxLight } from "../../../packages/babylon-lite/src/loader-fbx/fbx-light-build.js";

/** Build a column-major Mat4 from 16 raw values (`m[col * 4 + row]`). */
function mat(values: number[]): Mat4 {
    return Float64Array.from(values) as unknown as Mat4;
}

/** Identity Mat4. */
const IDENTITY = mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A 90° rotation about Z (x→y, y→−x) plus translation [5, 6, 7], column-major. */
const ROT_Z_90_T = mat([
    0,
    1,
    0,
    0, // column 0
    -1,
    0,
    0,
    0, // column 1
    0,
    0,
    1,
    0, // column 2
    5,
    6,
    7,
    1, // column 3 (translation)
]);

/** Uniform scale 2 plus translation [1, 2, 3], column-major. */
const SCALE2_T = mat([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);

function makeCamera(over: Partial<FBXCameraData> = {}): FBXCameraData {
    return {
        modelId: 1,
        name: "Cam",
        fieldOfView: 50,
        nearPlane: 0.1,
        farPlane: 1000,
        aspectRatio: 0,
        projectionType: "perspective",
        unknownProperties: [],
        diagnostics: [],
        ...over,
    };
}

function makeLight(over: Partial<FBXLightData> = {}): FBXLightData {
    return {
        modelId: 1,
        name: "Light",
        lightType: 0,
        color: [1, 1, 1],
        intensity: 1,
        coneAngle: 45,
        decayType: 2,
        unknownProperties: [],
        diagnostics: [],
        ...over,
    };
}

function expectVec(actual: [number, number, number], expected: [number, number, number]): void {
    expect(actual[0]).toBeCloseTo(expected[0], 9);
    expect(actual[1]).toBeCloseTo(expected[1], 9);
    expect(actual[2]).toBeCloseTo(expected[2], 9);
}

describe("fbxCameraToParams", () => {
    it("identity world: position at origin, target along +X, fov deg→rad, near/far passthrough", () => {
        const p = fbxCameraToParams(makeCamera({ fieldOfView: 90, nearPlane: 0.25, farPlane: 500 }), IDENTITY);
        expectVec(p.position, [0, 0, 0]);
        expectVec(p.target, [1, 0, 0]); // FBX camera looks along local +X
        expect(p.fov).toBeCloseTo(Math.PI / 2, 9);
        expect(p.nearPlane).toBe(0.25);
        expect(p.farPlane).toBe(500);
    });

    it("translate+rotate world: position is the translation, target is local +X transformed", () => {
        const p = fbxCameraToParams(makeCamera({ fieldOfView: 50 }), ROT_Z_90_T);
        expectVec(p.position, [5, 6, 7]);
        // local +X (1,0,0) rotated by +90° about Z → (0,1,0), plus translation.
        expectVec(p.target, [5, 7, 7]);
        expect(p.fov).toBeCloseTo((50 * Math.PI) / 180, 9);
    });
});

describe("buildFbxCamera", () => {
    it("constructs a FreeCamera positioned + oriented from the world matrix", () => {
        const cam = buildFbxCamera(makeCamera({ fieldOfView: 60, nearPlane: 0.3, farPlane: 750 }), ROT_Z_90_T);
        expect(cam.position.x).toBeCloseTo(5, 9);
        expect(cam.position.y).toBeCloseTo(6, 9);
        expect(cam.position.z).toBeCloseTo(7, 9);
        expect(cam.target.x).toBeCloseTo(5, 9);
        expect(cam.target.y).toBeCloseTo(7, 9);
        expect(cam.target.z).toBeCloseTo(7, 9);
        expect(cam.fov).toBeCloseTo((60 * Math.PI) / 180, 9);
        expect(cam.nearPlane).toBe(0.3);
        expect(cam.farPlane).toBe(750);
    });
});

describe("fbxLightToParams", () => {
    it("identity world: position at origin, direction along −Z, coneAngle deg→rad, color/intensity passthrough", () => {
        const p = fbxLightToParams(makeLight({ lightType: 2, coneAngle: 30, intensity: 2.5, color: [0.25, 1, 0.3] }), IDENTITY);
        expect(p.type).toBe(2);
        expectVec(p.position, [0, 0, 0]);
        expectVec(p.direction, [0, 0, -1]); // FBX light aims along local −Z
        expect(p.coneAngle).toBeCloseTo((30 * Math.PI) / 180, 9);
        expect(p.intensity).toBe(2.5);
        expectVec(p.color, [0.25, 1, 0.3]);
    });

    it("translate+rotate world: position is the translation, direction is rotated −Z", () => {
        const p = fbxLightToParams(makeLight(), ROT_Z_90_T);
        expectVec(p.position, [5, 6, 7]);
        // local −Z is unaffected by a Z-axis rotation → still (0,0,-1) after subtracting position.
        expectVec(p.direction, [0, 0, -1]);
    });

    it("normalizes the direction even when the world matrix carries scale", () => {
        const p = fbxLightToParams(makeLight(), SCALE2_T);
        const len = Math.hypot(p.direction[0], p.direction[1], p.direction[2]);
        expect(len).toBeCloseTo(1, 9);
        expectVec(p.direction, [0, 0, -1]);
    });

    it("passes the light type through verbatim", () => {
        expect(fbxLightToParams(makeLight({ lightType: 0 }), IDENTITY).type).toBe(0);
        expect(fbxLightToParams(makeLight({ lightType: 1 }), IDENTITY).type).toBe(1);
        expect(fbxLightToParams(makeLight({ lightType: 2 }), IDENTITY).type).toBe(2);
    });
});

describe("buildFbxLight", () => {
    it("routes type 0 → point light with diffuse color set", () => {
        const light = buildFbxLight(makeLight({ lightType: 0, color: [1, 0.2, 0.2], intensity: 1.1 }), IDENTITY);
        expect(light.lightType).toBe("point");
        expect((light as unknown as { diffuse: number[] }).diffuse).toEqual([1, 0.2, 0.2]);
        expect((light as unknown as { intensity: number }).intensity).toBe(1.1);
    });

    it("routes type 1 → directional light with diffuse color set", () => {
        const light = buildFbxLight(makeLight({ lightType: 1, color: [0.3, 0.45, 1] }), IDENTITY);
        expect(light.lightType).toBe("directional");
        expect((light as unknown as { diffuse: number[] }).diffuse).toEqual([0.3, 0.45, 1]);
    });

    it("routes type 2 → spot light with diffuse color + cone angle set", () => {
        const light = buildFbxLight(makeLight({ lightType: 2, color: [0.25, 1, 0.3], coneAngle: 40 }), IDENTITY);
        expect(light.lightType).toBe("spot");
        expect((light as unknown as { diffuse: number[] }).diffuse).toEqual([0.25, 1, 0.3]);
        expect((light as unknown as { angle: number }).angle).toBeCloseTo((40 * Math.PI) / 180, 9);
    });

    it("falls back to a point light for an unknown type", () => {
        const light = buildFbxLight(makeLight({ lightType: 99 }), IDENTITY);
        expect(light.lightType).toBe("point");
    });
});
