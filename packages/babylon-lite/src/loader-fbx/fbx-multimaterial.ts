/**
 * FBX multi-material submesh grouping (PURE, no engine/GPU dependency).
 *
 * Lite has no MultiMaterial type. Mirroring the `.babylon` loader, a geometry
 * with per-triangle material assignments is rendered as ONE mesh per material
 * range: all sub-meshes share the same vertex buffers, but each draws a
 * contiguous slice of a REORDERED index buffer.
 *
 * {@link groupTrianglesByMaterial} ports the grouping done by the Babylon.js FBX
 * loader's `_applyMultiMaterial`: it buckets triangles by their material index,
 * then emits the index buffer with same-material triangles laid out
 * contiguously, plus the `{materialIndex, start, count}` ranges that index into
 * that reordered buffer. The three indices of every triangle stay together and
 * in their original order, so winding is preserved.
 */

import { U32 } from "../engine/typed-arrays.js";

/** A contiguous run of indices in the reordered buffer that share one material. */
export interface FbxMaterialRange {
    /** Index into the model's material list for this run. */
    materialIndex: number;
    /** Offset of the first index of the run in the reordered buffer (multiple of 3). */
    start: number;
    /** Number of indices in the run (multiple of 3). */
    count: number;
}

/** Result of grouping a triangle index buffer by per-triangle material index. */
export interface FbxGroupedTriangles {
    /** Triangle indices, reordered so same-material triangles are contiguous. */
    reordered: Uint32Array;
    /** Contiguous material runs covering the whole reordered buffer. */
    ranges: FbxMaterialRange[];
}

/**
 * Group an FBX triangle index buffer into per-material contiguous ranges.
 *
 * @param indices - Triangle indices `[a,b,c, a,b,c, …]` into the vertex arrays.
 * @param materialIndices - Per-triangle material index (`length === indices.length / 3`),
 *   or `null` when the geometry has a single material. When `null` or all-same a
 *   single range over the original index buffer is returned (no reordering).
 */
export function groupTrianglesByMaterial(indices: Uint32Array, materialIndices: Int32Array | null): FbxGroupedTriangles {
    const triCount = (indices.length / 3) | 0;

    // No per-triangle material data → single range over the original buffer.
    if (!materialIndices || materialIndices.length === 0) {
        return { reordered: indices, ranges: [{ materialIndex: 0, start: 0, count: indices.length }] };
    }

    // All triangles share one material → single range, no reorder needed.
    const first = materialIndices[0]!;
    let allSame = true;
    for (let t = 1; t < triCount; t++) {
        if ((materialIndices[t] ?? first) !== first) {
            allSame = false;
            break;
        }
    }
    if (allSame) {
        return { reordered: indices, ranges: [{ materialIndex: first, start: 0, count: indices.length }] };
    }

    // Bucket triangles by material index, preserving their original order within
    // each bucket. Emit buckets in ascending material-index order so the layout
    // is deterministic and `materialIndex` maps straight to the material list.
    const buckets = new Map<number, number[]>();
    for (let t = 0; t < triCount; t++) {
        const mi = materialIndices[t] ?? 0;
        let list = buckets.get(mi);
        if (!list) {
            list = [];
            buckets.set(mi, list);
        }
        list.push(t);
    }

    const materialKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

    const reordered = new U32(indices.length);
    const ranges: FbxMaterialRange[] = [];
    let write = 0;
    for (const mi of materialKeys) {
        const tris = buckets.get(mi)!;
        const start = write;
        for (const t of tris) {
            const base = t * 3;
            reordered[write] = indices[base]!;
            reordered[write + 1] = indices[base + 1]!;
            reordered[write + 2] = indices[base + 2]!;
            write += 3;
        }
        ranges.push({ materialIndex: mi, start, count: write - start });
    }

    return { reordered, ranges };
}
