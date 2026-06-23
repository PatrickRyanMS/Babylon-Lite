/**
 * FBX tangent generation — PURE math, no engine/GPU.
 *
 * Faithful 1:1 port of Babylon.js's FBX `generateTangents` and its helpers
 * (`packages/dev/loaders/src/FBX/fbxFileLoader.ts`: `generateTangents`,
 * `accumulateTangentContribution`, `buildTangentGroupKey`,
 * `computeTangentHandedness`, `computeCornerAngle`, `normalizeVector`,
 * `quantizeTangentKey`, `buildFallbackTangent`). Used only when an FBX geometry
 * carries NO authored `LayerElementTangent` but has source normals + UVs — exactly
 * the condition under which Babylon generates tangents (fbxFileLoader.ts:799-808).
 *
 * Algorithm (Lengyel): per triangle, compute the UV-gradient tangent/bitangent,
 * accumulate per corner weighted by the corner angle into groups keyed by
 * control-point/normal/uv/handedness/material, then per output vertex
 * Gram-Schmidt-orthogonalize the tangent against the normal and emit a vec4
 * `[tx,ty,tz,handedness]` where `handedness = sign(dot(cross(N,T),B)) * scale`.
 *
 * The output layout (vec4 with handedness in `w`) matches the engine's
 * `VERTEX_TANGENT` convention, identical to the PBR/glTF tangent path.
 */

interface TangentGroup {
    tx: number;
    ty: number;
    tz: number;
    bx: number;
    by: number;
    bz: number;
}

/**
 * Generate per-vertex tangents (vec4, handedness in `w`) from positions, normals,
 * UVs and triangle indices. Faithful port of Babylon's FBX `generateTangents`.
 *
 * @param positions - Flat positions `[x,y,z, …]` (one per output vertex).
 * @param normals - Flat unit normals `[x,y,z, …]` (one per output vertex).
 * @param uvs - Flat UVs `[u,v, …]` (one per output vertex).
 * @param indices - Triangle indices into the vertex arrays.
 * @param normalMapTangentHandednessScale - `+1` (y-up, default) or `-1` (y-down).
 * @param controlPointIndices - Output-vertex → control-point map (groups split tangents by it), or null.
 * @param materialIndices - Per-triangle material index (groups split by it), or null.
 */
export function generateFbxTangents(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    uvs: ArrayLike<number>,
    indices: ArrayLike<number>,
    normalMapTangentHandednessScale: 1 | -1 = 1,
    controlPointIndices: ArrayLike<number> | null = null,
    materialIndices: ArrayLike<number> | null = null
): Float32Array {
    const vertexCount = positions.length / 3;
    const groups = new Map<string, TangentGroup>();
    const vertexGroupKeys = new Array<string | null>(vertexCount).fill(null);

    for (let i = 0; i + 2 < indices.length; i += 3) {
        const materialIndex = materialIndices ? materialIndices[i / 3]! : 0;
        const i1 = indices[i]!;
        const i2 = indices[i + 1]!;
        const i3 = indices[i + 2]!;

        const p1 = i1 * 3;
        const p2 = i2 * 3;
        const p3 = i3 * 3;
        const uv1 = i1 * 2;
        const uv2 = i2 * 2;
        const uv3 = i3 * 2;

        const x1 = positions[p2]! - positions[p1]!;
        const x2 = positions[p3]! - positions[p1]!;
        const y1 = positions[p2 + 1]! - positions[p1 + 1]!;
        const y2 = positions[p3 + 1]! - positions[p1 + 1]!;
        const z1 = positions[p2 + 2]! - positions[p1 + 2]!;
        const z2 = positions[p3 + 2]! - positions[p1 + 2]!;

        const s1 = uvs[uv2]! - uvs[uv1]!;
        const s2 = uvs[uv3]! - uvs[uv1]!;
        const t1 = uvs[uv2 + 1]! - uvs[uv1 + 1]!;
        const t2 = uvs[uv3 + 1]! - uvs[uv1 + 1]!;
        const denominator = s1 * t2 - s2 * t1;
        if (Math.abs(denominator) < 1e-8) {
            continue;
        }

        const r = 1 / denominator;
        const sx = (t2 * x1 - t1 * x2) * r;
        const sy = (t2 * y1 - t1 * y2) * r;
        const sz = (t2 * z1 - t1 * z2) * r;
        const bx = (s1 * x2 - s2 * x1) * r;
        const by = (s1 * y2 - s2 * y1) * r;
        const bz = (s1 * z2 - s2 * z1) * r;

        accumulateTangentContribution(i1, i2, i3, sx, sy, sz, bx, by, bz, positions, normals, uvs, controlPointIndices, materialIndex, groups, vertexGroupKeys);
        accumulateTangentContribution(i2, i3, i1, sx, sy, sz, bx, by, bz, positions, normals, uvs, controlPointIndices, materialIndex, groups, vertexGroupKeys);
        accumulateTangentContribution(i3, i1, i2, sx, sy, sz, bx, by, bz, positions, normals, uvs, controlPointIndices, materialIndex, groups, vertexGroupKeys);
    }

    const tangents = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
        const no = i * 3;
        const to = i * 4;
        const [nx, ny, nz] = normalizeVector(normals[no]!, normals[no + 1]!, normals[no + 2]!);
        const groupKey = vertexGroupKeys[i];
        const group = groupKey ? groups.get(groupKey) : undefined;
        const tx = group?.tx ?? 0;
        const ty = group?.ty ?? 0;
        const tz = group?.tz ?? 0;
        const normalDotTangent = nx * tx + ny * ty + nz * tz;

        let ox = tx - nx * normalDotTangent;
        let oy = ty - ny * normalDotTangent;
        let oz = tz - nz * normalDotTangent;
        const tangentLength = Math.hypot(ox, oy, oz);
        if (tangentLength > 1e-8) {
            ox /= tangentLength;
            oy /= tangentLength;
            oz /= tangentLength;
        } else {
            [ox, oy, oz] = buildFallbackTangent(nx, ny, nz);
        }

        const bx = group?.bx ?? 0;
        const by = group?.by ?? 0;
        const bz = group?.bz ?? 0;
        const cx = ny * oz - nz * oy;
        const cy = nz * ox - nx * oz;
        const cz = nx * oy - ny * ox;
        const bitangentLength = Math.hypot(bx, by, bz);
        const handedness = bitangentLength > 1e-8 && cx * bx + cy * by + cz * bz < 0 ? -1 : 1;

        tangents[to] = ox;
        tangents[to + 1] = oy;
        tangents[to + 2] = oz;
        tangents[to + 3] = handedness * normalMapTangentHandednessScale;
    }

    return tangents;
}

function accumulateTangentContribution(
    vertexIndex: number,
    nextIndex: number,
    prevIndex: number,
    tx: number,
    ty: number,
    tz: number,
    bx: number,
    by: number,
    bz: number,
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    uvs: ArrayLike<number>,
    controlPointIndices: ArrayLike<number> | null,
    materialIndex: number,
    groups: Map<string, TangentGroup>,
    vertexGroupKeys: Array<string | null>
): void {
    const weight = computeCornerAngle(positions, vertexIndex, nextIndex, prevIndex);
    if (weight <= 1e-8) {
        return;
    }

    const key = buildTangentGroupKey(vertexIndex, tx, ty, tz, bx, by, bz, positions, normals, uvs, controlPointIndices, materialIndex);
    let group = groups.get(key);
    if (!group) {
        group = { tx: 0, ty: 0, tz: 0, bx: 0, by: 0, bz: 0 };
        groups.set(key, group);
    }

    group.tx += tx * weight;
    group.ty += ty * weight;
    group.tz += tz * weight;
    group.bx += bx * weight;
    group.by += by * weight;
    group.bz += bz * weight;
    vertexGroupKeys[vertexIndex] ??= key;
}

function buildTangentGroupKey(
    vertexIndex: number,
    tx: number,
    ty: number,
    tz: number,
    bx: number,
    by: number,
    bz: number,
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    uvs: ArrayLike<number>,
    controlPointIndices: ArrayLike<number> | null,
    materialIndex: number
): string {
    const po = vertexIndex * 3;
    const no = vertexIndex * 3;
    const uo = vertexIndex * 2;
    const [nx, ny, nz] = normalizeVector(normals[no]!, normals[no + 1]!, normals[no + 2]!);
    const handedness = computeTangentHandedness(nx, ny, nz, tx, ty, tz, bx, by, bz);
    const positionKey = controlPointIndices
        ? `cp:${controlPointIndices[vertexIndex]}`
        : `p:${quantizeTangentKey(positions[po]!)},${quantizeTangentKey(positions[po + 1]!)},${quantizeTangentKey(positions[po + 2]!)}`;
    return [
        positionKey,
        quantizeTangentKey(nx),
        quantizeTangentKey(ny),
        quantizeTangentKey(nz),
        quantizeTangentKey(uvs[uo]!),
        quantizeTangentKey(uvs[uo + 1]!),
        handedness,
        materialIndex,
    ].join("|");
}

function computeTangentHandedness(nx: number, ny: number, nz: number, tx: number, ty: number, tz: number, bx: number, by: number, bz: number): 1 | -1 {
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    return cx * bx + cy * by + cz * bz < 0 ? -1 : 1;
}

function computeCornerAngle(positions: ArrayLike<number>, vertexIndex: number, nextIndex: number, prevIndex: number): number {
    const vo = vertexIndex * 3;
    const no = nextIndex * 3;
    const po = prevIndex * 3;
    const ax = positions[no]! - positions[vo]!;
    const ay = positions[no + 1]! - positions[vo + 1]!;
    const az = positions[no + 2]! - positions[vo + 2]!;
    const bx = positions[po]! - positions[vo]!;
    const by = positions[po + 1]! - positions[vo + 1]!;
    const bz = positions[po + 2]! - positions[vo + 2]!;
    const aLength = Math.hypot(ax, ay, az);
    const bLength = Math.hypot(bx, by, bz);
    if (aLength <= 1e-8 || bLength <= 1e-8) {
        return 0;
    }
    const dot = (ax * bx + ay * by + az * bz) / (aLength * bLength);
    return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function normalizeVector(x: number, y: number, z: number): [number, number, number] {
    const length = Math.hypot(x, y, z);
    return length > 1e-8 ? [x / length, y / length, z / length] : [0, 0, 1];
}

function quantizeTangentKey(value: number): number {
    const quantized = Math.round(value * 1e6);
    return Object.is(quantized, -0) ? 0 : quantized;
}

function buildFallbackTangent(nx: number, ny: number, nz: number): [number, number, number] {
    const ax = Math.abs(nx) < 0.9 ? 1 : 0;
    const ay = ax === 1 ? 0 : 1;
    const dot = nx * ax + ny * ay;
    let tx = ax - nx * dot;
    let ty = ay - ny * dot;
    let tz = -nz * dot;
    const length = Math.hypot(tx, ty, tz);
    if (length <= 1e-8) {
        return [1, 0, 0];
    }
    tx /= length;
    ty /= length;
    tz /= length;
    return [tx, ty, tz];
}
