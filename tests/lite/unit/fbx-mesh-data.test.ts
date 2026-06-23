import { describe, expect, it } from "vitest";

import { buildFbxMeshData } from "../../../packages/babylon-lite/src/loader-fbx/fbx-mesh-data.js";
import type { FBXGeometryData } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/geometry.js";
import type { FBXVector3 } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/transform.js";

const ID_T: FBXVector3 = [0, 0, 0];
const ID_R: FBXVector3 = [0, 0, 0];
const ID_S: FBXVector3 = [1, 1, 1];

/** Build a minimal FBXGeometryData from raw arrays (the loader-relevant fields). */
function makeGeometry(opts: { positions: number[]; indices: number[]; normals?: number[] | null; uvs?: number[] | null; colors?: number[] | null }): FBXGeometryData {
    return {
        id: 1,
        name: "test-geo",
        positions: new Float64Array(opts.positions),
        indices: new Uint32Array(opts.indices),
        normals: opts.normals ? new Float64Array(opts.normals) : null,
        uvs: opts.uvs ? new Float64Array(opts.uvs) : null,
        uvSets: [],
        colors: opts.colors ? new Float32Array(opts.colors) : null,
        tangents: null,
        binormals: null,
        controlPointIndices: null,
        materialIndices: null,
        diagnostics: [],
    };
}

describe("fbx-mesh-data — identity geometric transform (F64 → F32 pass-through)", () => {
    it("copies positions / normals / uvs / colors / indices and converts to Float32", () => {
        const geom = makeGeometry({
            positions: [1.5, -2.25, 3.125, -4, 5, -6],
            indices: [0, 1, 0],
            normals: [0, 0, 1, 1, 0, 0],
            uvs: [0.25, 0.75, 0.5, 0.5],
            colors: [1, 0, 0, 1, 0, 1, 0, 1],
        });

        const out = buildFbxMeshData(geom, ID_T, ID_R, ID_S);

        expect(out.positions).toBeInstanceOf(Float32Array);
        expect(out.normals).toBeInstanceOf(Float32Array);
        expect(out.uvs).toBeInstanceOf(Float32Array);
        expect(out.colors).toBeInstanceOf(Float32Array);
        expect(out.indices).toBeInstanceOf(Uint32Array);

        // Exact (these values are representable in f32).
        expect(Array.from(out.positions)).toEqual([1.5, -2.25, 3.125, -4, 5, -6]);
        expect(Array.from(out.normals!)).toEqual([0, 0, 1, 1, 0, 0]);
        expect(Array.from(out.uvs!)).toEqual([0.25, 0.75, 0.5, 0.5]);
        // Vertex colors are kept as RGBA with alpha forced to 1.0 (engine float32x4 layout):
        // RGBA(1,0,0,1) + RGBA(0,1,0,1) → RGBA(1,0,0,1) + RGBA(0,1,0,1).
        expect(Array.from(out.colors!)).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
        expect(Array.from(out.indices)).toEqual([0, 1, 0]);
    });

    it("returns null uvs / colors when the geometry has none", () => {
        const geom = makeGeometry({ positions: [0, 0, 0, 1, 1, 1, 2, 2, 2], indices: [0, 1, 2], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0] });
        const out = buildFbxMeshData(geom, ID_T, ID_R, ID_S);
        expect(out.uvs).toBeNull();
        expect(out.colors).toBeNull();
    });
});

describe("fbx-mesh-data — geometric transform baked into vertices", () => {
    it("pure scale scales positions and inverse-scales (then renormalizes) normals", () => {
        const geom = makeGeometry({
            positions: [1, 1, 1, 2, 0, 0],
            indices: [0, 1, 0],
            normals: [1, 0, 0, 1, 1, 1],
        });

        const out = buildFbxMeshData(geom, ID_T, ID_R, [2, 3, 4]);

        // Positions scaled component-wise.
        expect(out.positions[0]).toBeCloseTo(2, 5);
        expect(out.positions[1]).toBeCloseTo(3, 5);
        expect(out.positions[2]).toBeCloseTo(4, 5);
        expect(out.positions[3]).toBeCloseTo(4, 5);
        expect(out.positions[4]).toBeCloseTo(0, 5);
        expect(out.positions[5]).toBeCloseTo(0, 5);

        // Normal [1,0,0] under inverse-scale [1/2,1/3,1/4] stays [1,0,0] after renormalize.
        expect(out.normals![0]).toBeCloseTo(1, 5);
        expect(out.normals![1]).toBeCloseTo(0, 5);
        expect(out.normals![2]).toBeCloseTo(0, 5);

        // Normal [1,1,1] → inverse-scale → [0.5, 1/3, 0.25] → normalized.
        const ex = 0.5,
            ey = 1 / 3,
            ez = 0.25;
        const len = Math.hypot(ex, ey, ez);
        expect(out.normals![3]).toBeCloseTo(ex / len, 5);
        expect(out.normals![4]).toBeCloseTo(ey / len, 5);
        expect(out.normals![5]).toBeCloseTo(ez / len, 5);
        // Output normals are unit length.
        expect(Math.hypot(out.normals![3]!, out.normals![4]!, out.normals![5]!)).toBeCloseTo(1, 5);
    });

    it("pure translation offsets positions and leaves normals unchanged", () => {
        const geom = makeGeometry({
            positions: [0, 0, 0, 1, 2, 3],
            indices: [0, 1, 0],
            normals: [0, 0, 1, 0, 0, 1],
        });

        const out = buildFbxMeshData(geom, [5, -3, 2], ID_R, ID_S);

        expect(Array.from(out.positions)).toEqual([5, -3, 2, 6, -1, 5]);
        // Translation has no effect on normals (a pure direction transform).
        expect(out.normals![0]).toBeCloseTo(0, 5);
        expect(out.normals![1]).toBeCloseTo(0, 5);
        expect(out.normals![2]).toBeCloseTo(1, 5);
    });
});

describe("fbx-mesh-data — derived normals when geometry has none", () => {
    it("produces unit normals perpendicular to a flat triangle", () => {
        // Triangle in the z=0 plane wound CCW about +z.
        const geom = makeGeometry({
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            normals: null,
        });

        const out = buildFbxMeshData(geom, ID_T, ID_R, ID_S);
        expect(out.normals).toBeInstanceOf(Float32Array);
        expect(out.normals!.length).toBe(9);

        for (let i = 0; i < 9; i += 3) {
            const x = out.normals![i]!,
                y = out.normals![i + 1]!,
                z = out.normals![i + 2]!;
            // Unit length.
            expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
            // Perpendicular to the triangle plane (±z).
            expect(Math.abs(x)).toBeCloseTo(0, 5);
            expect(Math.abs(y)).toBeCloseTo(0, 5);
            expect(Math.abs(z)).toBeCloseTo(1, 5);
        }
    });
});
