import { describe, expect, it } from "vitest";

import { groupTrianglesByMaterial } from "../../../packages/babylon-lite/src/loader-fbx/fbx-multimaterial.js";

/** Build a tidy triangle index buffer for `triCount` triangles where triangle
 *  `t` owns the three consecutive indices `[3t, 3t+1, 3t+2]`. This makes the
 *  original owning triangle of any output triple trivially recoverable. */
function tidyIndices(triCount: number): Uint32Array {
    const out = new Uint32Array(triCount * 3);
    for (let i = 0; i < out.length; i++) {
        out[i] = i;
    }
    return out;
}

/** Recover the original triangle index of an output triple, asserting the three
 *  indices stayed together AND in their original order (winding preserved). */
function tripleToOriginalTri(reordered: Uint32Array, offset: number): number {
    const a = reordered[offset]!;
    const b = reordered[offset + 1]!;
    const c = reordered[offset + 2]!;
    expect(a % 3).toBe(0); // first index of a tidy triangle is a multiple of 3
    expect(b).toBe(a + 1); // consecutive + ordered ⇒ winding intact
    expect(c).toBe(a + 2);
    return a / 3;
}

describe("groupTrianglesByMaterial — null / single material", () => {
    it("returns a single range over the original buffer when materialIndices is null", () => {
        const indices = tidyIndices(4);
        const { reordered, ranges } = groupTrianglesByMaterial(indices, null);
        expect(reordered).toBe(indices); // no copy / no reorder
        expect(ranges).toEqual([{ materialIndex: 0, start: 0, count: 12 }]);
    });

    it("returns a single range when every triangle shares one material index", () => {
        const indices = tidyIndices(3);
        const mats = new Int32Array([2, 2, 2]);
        const { reordered, ranges } = groupTrianglesByMaterial(indices, mats);
        expect(reordered).toBe(indices);
        expect(ranges).toEqual([{ materialIndex: 2, start: 0, count: 9 }]);
    });

    it("treats an empty materialIndices array as single-material", () => {
        const indices = tidyIndices(2);
        const { reordered, ranges } = groupTrianglesByMaterial(indices, new Int32Array(0));
        expect(reordered).toBe(indices);
        expect(ranges).toEqual([{ materialIndex: 0, start: 0, count: 6 }]);
    });
});

describe("groupTrianglesByMaterial — multi material grouping", () => {
    // Material indices [0,1,0,2,1] over 5 triangles → 3 groups.
    const indices = tidyIndices(5);
    const mats = new Int32Array([0, 1, 0, 2, 1]);

    it("groups same-material triangles contiguously with covering ranges", () => {
        const { reordered, ranges } = groupTrianglesByMaterial(indices, mats);

        // Ranges sorted by material index, contiguous, covering the whole buffer.
        expect(ranges.map((r) => r.materialIndex)).toEqual([0, 1, 2]);
        expect(ranges[0]).toEqual({ materialIndex: 0, start: 0, count: 6 }); // tris 0,2
        expect(ranges[1]).toEqual({ materialIndex: 1, start: 6, count: 6 }); // tris 1,4
        expect(ranges[2]).toEqual({ materialIndex: 2, start: 12, count: 3 }); // tri 3

        // Contiguity + full coverage of the reordered buffer.
        let cursor = 0;
        for (const r of ranges) {
            expect(r.start).toBe(cursor);
            cursor += r.count;
        }
        expect(cursor).toBe(indices.length);
        expect(reordered.length).toBe(indices.length);
    });

    it("keeps every triangle intact (winding) and assigns it to the correct material", () => {
        const { reordered, ranges } = groupTrianglesByMaterial(indices, mats);

        const seen: number[] = [];
        for (const r of ranges) {
            for (let off = r.start; off < r.start + r.count; off += 3) {
                const tri = tripleToOriginalTri(reordered, off);
                // The triangle's original material must equal this range's material.
                expect(mats[tri]).toBe(r.materialIndex);
                seen.push(tri);
            }
        }

        // Every original triangle appears exactly once across all ranges.
        expect(seen.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    it("preserves original within-group order of triangles", () => {
        const { reordered, ranges } = groupTrianglesByMaterial(indices, mats);
        // Material 0 owns triangles 0 then 2 (original order).
        expect(tripleToOriginalTri(reordered, ranges[0]!.start)).toBe(0);
        expect(tripleToOriginalTri(reordered, ranges[0]!.start + 3)).toBe(2);
        // Material 1 owns triangles 1 then 4.
        expect(tripleToOriginalTri(reordered, ranges[1]!.start)).toBe(1);
        expect(tripleToOriginalTri(reordered, ranges[1]!.start + 3)).toBe(4);
    });
});
