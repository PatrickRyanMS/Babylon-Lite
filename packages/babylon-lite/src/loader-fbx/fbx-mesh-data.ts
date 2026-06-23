/**
 * FBX geometry → GPU-ready typed arrays (PURE, no engine/GPU dependency).
 *
 * Converts an interpreter {@link FBXGeometryData} plus a model's geometric
 * transform (translation / rotation-in-degrees / scale) into tight `Float32`
 * vertex arrays the renderer can upload directly.
 *
 * The geometric transform is FBX's per-geometry offset that affects ONLY the
 * mesh vertices (never the node's children), so it is baked into the vertex
 * data here rather than carried on the scene node. Positions are transformed by
 * `computeFBXGeometricMatrix` and normals by `computeFBXGeometricNormalMatrix`
 * (then re-normalized). When the geometric transform is identity the data is a
 * straight F64→F32 copy with no per-vertex math.
 *
 * Positions and normals stay in their original right-handed space — the loader's
 * synthetic `__root__` node applies the RH→LH flip for the whole hierarchy.
 */

import { F32 } from "../engine/typed-arrays.js";
import { computeFBXGeometricMatrix, computeFBXGeometricNormalMatrix } from "./interpreter/transform.js";
import type { FBXVector3 } from "./interpreter/transform.js";
import type { FBXGeometryData } from "./interpreter/geometry.js";
import { generateFbxTangents } from "./fbx-tangents.js";

/** Tight, GPU-ready vertex/index arrays for a single FBX mesh. */
export interface FbxMeshGpuData {
    /** Vertex positions `[x,y,z, …]` (geometric transform baked in). */
    positions: Float32Array;
    /** Per-vertex unit normals `[x,y,z, …]`. Always present (derived when the
     *  source geometry has none) so the renderer's lit pipeline has data. */
    normals: Float32Array;
    /** Per-vertex UVs `[u,v, …]`, or null when the geometry has no UV set. */
    uvs: Float32Array | null;
    /** Per-vertex colors `[r,g,b, …]` (tight RGB; alpha dropped to match the
     *  engine's float32x3 vertex-color convention), or null when absent. */
    colors: Float32Array | null;
    /** Per-vertex tangents `[x,y,z,w, …]` (w = handedness), or null when the
     *  geometry has neither authored tangents nor (source normals + UVs) to
     *  generate them from. Used for explicit-tangent normal mapping (Babylon parity). */
    tangents: Float32Array | null;
    /** Triangle indices into the vertex arrays. */
    indices: Uint32Array;
}

/** True when the geometric transform is the identity (no per-vertex bake needed). */
function isIdentityGeometric(t: FBXVector3, r: FBXVector3, s: FBXVector3): boolean {
    return t[0] === 0 && t[1] === 0 && t[2] === 0 && r[0] === 0 && r[1] === 0 && r[2] === 0 && s[0] === 1 && s[1] === 1 && s[2] === 1;
}

/** Derive smooth per-vertex normals from positions + triangle indices.
 *  Used only as a fallback when the FBX geometry carries no normals. */
function deriveNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new F32(positions.length);
    for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i]! * 3;
        const ib = indices[i + 1]! * 3;
        const ic = indices[i + 2]! * 3;
        const ax = positions[ia]!,
            ay = positions[ia + 1]!,
            az = positions[ia + 2]!;
        const bx = positions[ib]!,
            by = positions[ib + 1]!,
            bz = positions[ib + 2]!;
        const cx = positions[ic]!,
            cy = positions[ic + 1]!,
            cz = positions[ic + 2]!;
        const e1x = bx - ax,
            e1y = by - ay,
            e1z = bz - az;
        const e2x = cx - ax,
            e2y = cy - ay,
            e2z = cz - az;
        // Face normal = e1 × e2 (area-weighted: not normalized before accumulation).
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        normals[ia] = normals[ia]! + nx;
        normals[ia + 1] = normals[ia + 1]! + ny;
        normals[ia + 2] = normals[ia + 2]! + nz;
        normals[ib] = normals[ib]! + nx;
        normals[ib + 1] = normals[ib + 1]! + ny;
        normals[ib + 2] = normals[ib + 2]! + nz;
        normals[ic] = normals[ic]! + nx;
        normals[ic + 1] = normals[ic + 1]! + ny;
        normals[ic + 2] = normals[ic + 2]! + nz;
    }
    for (let i = 0; i < normals.length; i += 3) {
        const x = normals[i]!,
            y = normals[i + 1]!,
            z = normals[i + 2]!;
        const len = Math.hypot(x, y, z);
        if (len > 1e-8) {
            normals[i] = x / len;
            normals[i + 1] = y / len;
            normals[i + 2] = z / len;
        } else {
            // Degenerate vertex — pick an arbitrary unit normal so the buffer is valid.
            normals[i] = 0;
            normals[i + 1] = 0;
            normals[i + 2] = 1;
        }
    }
    return normals;
}

/**
 * Build tight Float32 GPU arrays for one FBX mesh.
 *
 * @param geom - Interpreted geometry (positions/normals/uvs are F64, expanded per output vertex).
 * @param geomT - Geometric translation (units).
 * @param geomR - Geometric rotation (degrees).
 * @param geomS - Geometric scale.
 */
export function buildFbxMeshData(geom: FBXGeometryData, geomT: FBXVector3, geomR: FBXVector3, geomS: FBXVector3): FbxMeshGpuData {
    const src = geom.positions;
    const positions = new F32(src.length);
    let normals: Float32Array;

    if (isIdentityGeometric(geomT, geomR, geomS)) {
        positions.set(src); // F64 → F32
        if (geom.normals) {
            normals = new F32(geom.normals.length);
            normals.set(geom.normals); // F64 → F32 (already unit-length from the interpreter)
        } else {
            normals = deriveNormals(positions, geom.indices);
        }
    } else {
        const gm = computeFBXGeometricMatrix(geomT, geomR, geomS);
        const m0 = gm[0]!,
            m1 = gm[1]!,
            m2 = gm[2]!,
            m4 = gm[4]!,
            m5 = gm[5]!,
            m6 = gm[6]!,
            m8 = gm[8]!,
            m9 = gm[9]!,
            m10 = gm[10]!,
            m12 = gm[12]!,
            m13 = gm[13]!,
            m14 = gm[14]!;
        for (let i = 0; i < src.length; i += 3) {
            const x = src[i]!,
                y = src[i + 1]!,
                z = src[i + 2]!;
            positions[i] = m0 * x + m4 * y + m8 * z + m12;
            positions[i + 1] = m1 * x + m5 * y + m9 * z + m13;
            positions[i + 2] = m2 * x + m6 * y + m10 * z + m14;
        }

        if (geom.normals) {
            const nm = computeFBXGeometricNormalMatrix(geomR, geomS);
            const n0 = nm[0]!,
                n1 = nm[1]!,
                n2 = nm[2]!,
                n4 = nm[4]!,
                n5 = nm[5]!,
                n6 = nm[6]!,
                n8 = nm[8]!,
                n9 = nm[9]!,
                n10 = nm[10]!;
            const sn = geom.normals;
            normals = new F32(sn.length);
            for (let i = 0; i < sn.length; i += 3) {
                const x = sn[i]!,
                    y = sn[i + 1]!,
                    z = sn[i + 2]!;
                let nx = n0 * x + n4 * y + n8 * z;
                let ny = n1 * x + n5 * y + n9 * z;
                let nz = n2 * x + n6 * y + n10 * z;
                const len = Math.hypot(nx, ny, nz);
                if (len > 1e-8) {
                    const inv = 1 / len;
                    nx *= inv;
                    ny *= inv;
                    nz *= inv;
                }
                normals[i] = nx;
                normals[i + 1] = ny;
                normals[i + 2] = nz;
            }
        } else {
            normals = deriveNormals(positions, geom.indices);
        }
    }

    const uvs = geom.uvs ? new F32(geom.uvs.length) : null;
    if (uvs && geom.uvs) {
        uvs.set(geom.uvs); // F64 → F32
    }

    // Colors are F32 RGBA from the interpreter — repack to tight RGB (drop the
    // alpha component) to match the engine's float32x3 vertex-color convention
    // (BJS forces vertex alpha to 1.0 and treats colors as RGB-only).
    let colors: Float32Array | null = null;
    if (geom.colors) {
        const vcount = (geom.colors.length / 4) | 0;
        colors = new F32(vcount * 3);
        for (let v = 0; v < vcount; v++) {
            colors[v * 3] = geom.colors[v * 4]!;
            colors[v * 3 + 1] = geom.colors[v * 4 + 1]!;
            colors[v * 3 + 2] = geom.colors[v * 4 + 2]!;
        }
    }

    // Indices are already Uint32 triangle indices.
    const indices = geom.indices.slice();

    // Tangents (vec4 [x,y,z,handedness]) — faithful to Babylon's FBX loader
    // (fbxFileLoader.ts:784-809): use the authored LayerElementTangent when present,
    // transformed by the geometric-normal matrix like the normals; otherwise GENERATE
    // them from source normals + UVs (Babylon only generates when SOURCE normals existed,
    // not derived). The y-up default handedness scale is +1. Tangents stay in the same
    // RH space as positions/normals — the `__root__` node applies the RH→LH flip, and
    // the explicit-tangent material path computes the bitangent in object space then
    // transforms it, so the mirror is handled consistently.
    let tangents: Float32Array | null = null;
    const geomBaked = !isIdentityGeometric(geomT, geomR, geomS);
    if (geom.tangents) {
        const src4 = geom.tangents;
        tangents = new F32(src4.length);
        if (geomBaked) {
            const nm = computeFBXGeometricNormalMatrix(geomR, geomS);
            const n0 = nm[0]!,
                n1 = nm[1]!,
                n2 = nm[2]!,
                n4 = nm[4]!,
                n5 = nm[5]!,
                n6 = nm[6]!,
                n8 = nm[8]!,
                n9 = nm[9]!,
                n10 = nm[10]!;
            for (let i = 0; i < src4.length; i += 4) {
                const x = src4[i]!,
                    y = src4[i + 1]!,
                    z = src4[i + 2]!;
                let tx = n0 * x + n4 * y + n8 * z;
                let ty = n1 * x + n5 * y + n9 * z;
                let tz = n2 * x + n6 * y + n10 * z;
                const len = Math.hypot(tx, ty, tz);
                if (len > 1e-8) {
                    const inv = 1 / len;
                    tx *= inv;
                    ty *= inv;
                    tz *= inv;
                }
                tangents[i] = tx;
                tangents[i + 1] = ty;
                tangents[i + 2] = tz;
                tangents[i + 3] = src4[i + 3]!; // handedness unchanged
            }
        } else {
            tangents.set(src4); // F64 → F32
        }
    } else if (geom.normals && uvs) {
        // Generate from the geometric-baked positions/normals + UVs (handedness scale +1, y-up default).
        tangents = generateFbxTangents(positions, normals, uvs, indices, 1, geom.controlPointIndices, geom.materialIndices);
    }

    return { positions, normals, uvs, colors, tangents, indices };
}
