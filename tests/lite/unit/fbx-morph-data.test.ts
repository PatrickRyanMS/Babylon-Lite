import { describe, expect, it } from "vitest";

import { expandFbxMorphTarget, buildFbxMorphTargets, calculateBlendShapeInfluences, FBX_MAX_MORPH_TARGETS } from "../../../packages/babylon-lite/src/loader-fbx/fbx-morph-data.js";
import { computeFBXGeometricDeltaMatrix } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/transform.js";
import type { FBXShapeData, FBXBlendShapeChannelData, FBXBlendShapeData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/blend-shapes.js";

/** Minimal sparse Shape from raw arrays. */
function makeShape(opts: { indices: number[]; vertices: number[]; normals?: number[] | null }): FBXShapeData {
    return {
        indices: new Uint32Array(opts.indices),
        vertices: new Float64Array(opts.vertices),
        normals: opts.normals ? new Float64Array(opts.normals) : null,
    };
}

/** Minimal channel with a single shape, default weight 100% / no FullWeights. */
function makeChannel(id: number, shape: FBXShapeData, deformPercent = 100): FBXBlendShapeChannelData {
    return { name: `ch${id}`, id, deformPercent, shapes: [shape], fullWeights: null, diagnostics: [] };
}

function makeBlendShape(channels: FBXBlendShapeChannelData[]): FBXBlendShapeData {
    return { id: 999, geometryId: 1, channels };
}

describe("fbx-morph-data — expandFbxMorphTarget sparse → dense mapping", () => {
    it("writes each shape delta to the output vertices whose control point matches (zero elsewhere)", () => {
        // Output vertices map to control points: 0→10, 1→20, 2→10, 3→30.
        const controlPointIndices = new Uint32Array([10, 20, 10, 30]);
        // Sparse deltas for control points 10 and 30 (20 is unaffected).
        const shape = makeShape({ indices: [10, 30], vertices: [1, 2, 3, 4, 5, 6] });

        const out = expandFbxMorphTarget(shape, controlPointIndices, 4, null, null);

        expect(out.positions).toBeInstanceOf(Float32Array);
        expect(out.positions.length).toBe(12);
        // cp10 delta lands on output vertices 0 and 2; cp30 on vertex 3; vertex 1 (cp20) stays zero.
        expect(Array.from(out.positions)).toEqual([1, 2, 3, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
        expect(out.normals).toBeNull();
    });

    it("leaves the whole target zero when no control point is affected", () => {
        const controlPointIndices = new Uint32Array([0, 1, 2]);
        const shape = makeShape({ indices: [7], vertices: [9, 9, 9] }); // cp 7 never referenced
        const out = expandFbxMorphTarget(shape, controlPointIndices, 3, null, null);
        expect(Array.from(out.positions)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });
});

describe("fbx-morph-data — geometric delta transform applied to position deltas", () => {
    it("rotates the delta vector by the geometric delta matrix (90° about Y)", () => {
        // 90° about Y maps the +X delta to −Z (column-major direction transform).
        const deltaMatrix = computeFBXGeometricDeltaMatrix([0, 90, 0], [1, 1, 1]);
        const controlPointIndices = new Uint32Array([5]);
        const shape = makeShape({ indices: [5], vertices: [1, 0, 0] });

        const out = expandFbxMorphTarget(shape, controlPointIndices, 1, deltaMatrix, null);

        expect(out.positions[0]!).toBeCloseTo(0, 5);
        expect(out.positions[1]!).toBeCloseTo(0, 5);
        expect(out.positions[2]!).toBeCloseTo(-1, 5);
    });

    it("scales the delta vector by the geometric delta matrix (pure scale)", () => {
        const deltaMatrix = computeFBXGeometricDeltaMatrix([0, 0, 0], [2, 3, 4]);
        const controlPointIndices = new Uint32Array([0]);
        const shape = makeShape({ indices: [0], vertices: [1, 1, 1] });

        const out = expandFbxMorphTarget(shape, controlPointIndices, 1, deltaMatrix, null);

        expect(out.positions[0]!).toBeCloseTo(2, 5);
        expect(out.positions[1]!).toBeCloseTo(3, 5);
        expect(out.positions[2]!).toBeCloseTo(4, 5);
    });

    it("expands normal deltas verbatim when no normal matrix is given", () => {
        const controlPointIndices = new Uint32Array([0, 1]);
        const shape = makeShape({ indices: [1], vertices: [0, 0, 0.5], normals: [0, 0, 2] });

        const out = expandFbxMorphTarget(shape, controlPointIndices, 2, null, null);

        expect(out.normals).toBeInstanceOf(Float32Array);
        // Output vertex 0 (cp0) unaffected → zero; vertex 1 (cp1) gets the verbatim delta.
        expect(Array.from(out.normals!)).toEqual([0, 0, 0, 0, 0, 2]);
    });

    it("normalizes the transformed normal delta when a normal matrix is given", () => {
        // Identity normal matrix (no rotation/scale): transform is a no-op, then the
        // delta is normalized to unit length to match the BJS port.
        const normalMatrix = computeFBXGeometricDeltaMatrix([0, 0, 0], [1, 1, 1]);
        const controlPointIndices = new Uint32Array([0]);
        const shape = makeShape({ indices: [0], vertices: [0, 0, 0], normals: [3, 0, 0] });

        const out = expandFbxMorphTarget(shape, controlPointIndices, 1, null, normalMatrix);

        expect(out.normals![0]!).toBeCloseTo(1, 5);
        expect(out.normals![1]!).toBeCloseTo(0, 5);
        expect(out.normals![2]!).toBeCloseTo(0, 5);
    });
});

describe("fbx-morph-data — buildFbxMorphTargets channel cap", () => {
    const controlPointIndices = new Uint32Array([0]);
    const shapeFor = (cp: number) => makeShape({ indices: [cp], vertices: [cp, 0, 0] });

    it("builds one target per channel with the channel's initial influence as the weight", () => {
        const bs = makeBlendShape([makeChannel(1, shapeFor(0), 100), makeChannel(2, shapeFor(0), 50)]);
        const built = buildFbxMorphTargets(bs, controlPointIndices, 1, null, null);

        expect(built.truncated).toBe(false);
        expect(built.targets.length).toBe(2);
        expect(built.weights[0]!).toBeCloseTo(1, 5); // 100% → influence 1
        expect(built.weights[1]!).toBeCloseTo(0.5, 5); // 50% → influence 0.5
    });

    it("truncates to the first 4 targets and flags truncation when >4 channels exist", () => {
        const channels = [];
        for (let i = 0; i < 6; i++) {
            channels.push(makeChannel(i, shapeFor(0)));
        }
        const built = buildFbxMorphTargets(makeBlendShape(channels), controlPointIndices, 1, null, null);

        expect(built.targets.length).toBe(FBX_MAX_MORPH_TARGETS);
        expect(built.weights.length).toBe(FBX_MAX_MORPH_TARGETS);
        expect(built.truncated).toBe(true);
    });

    it("does not flag truncation for exactly 4 channels", () => {
        const channels = [makeChannel(0, shapeFor(0)), makeChannel(1, shapeFor(0)), makeChannel(2, shapeFor(0)), makeChannel(3, shapeFor(0))];
        const built = buildFbxMorphTargets(makeBlendShape(channels), controlPointIndices, 1, null, null);
        expect(built.targets.length).toBe(4);
        expect(built.truncated).toBe(false);
    });
});

describe("fbx-morph-data — calculateBlendShapeInfluences (FBX crossfade)", () => {
    it("maps DeformPercent against the default 0-100 range for a single shape", () => {
        expect(calculateBlendShapeInfluences(50, null, 1)).toEqual([0.5]);
        expect(calculateBlendShapeInfluences(100, null, 1)).toEqual([1]);
        expect(calculateBlendShapeInfluences(200, null, 1)).toEqual([1]); // clamped
    });

    it("crossfades between in-between shapes using FullWeights", () => {
        // FullWeights [0,50,100]; DeformPercent 25 sits halfway between shape 0 and 1.
        const influences = calculateBlendShapeInfluences(25, [0, 50, 100], 3);
        expect(influences[0]!).toBeCloseTo(0.5, 5);
        expect(influences[1]!).toBeCloseTo(0.5, 5);
        expect(influences[2]!).toBeCloseTo(0, 5);
    });

    it("returns the last shape fully when DeformPercent is at the top of the range", () => {
        const influences = calculateBlendShapeInfluences(100, [0, 50, 100], 3);
        expect(influences[2]!).toBeCloseTo(1, 5);
    });
});
