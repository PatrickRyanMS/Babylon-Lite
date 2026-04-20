/**
 * pickBillboardSprite — sprite picker for billboard systems in a 3D scene.
 *
 * Implementation note: this is a **CPU projection-and-rectangle test**. It
 * walks every visible + pickable sprite, builds the same world-space basis
 * that the variant's vertex shader builds (Facing / YawLocked / AxisLocked),
 * forms the four world-space corners, projects each corner through the
 * camera viewProjection, and runs a 2D point-in-quad test on the cursor.
 *
 * The signature is `Promise<…>` to match the spec — billboard pickers were
 * specified to be async because the long-term plan is to integrate with the
 * GPU ID-pass picker. That path is **not yet wired for sprites**; the GPU
 * picker only enumerates meshes today (see `picking/gpu-picker.ts`). We use
 * the CPU fallback here and keep the async shape so the GPU upgrade is a
 * drop-in replacement when picking infrastructure adds sprite support.
 *
 * TODO(GPU picking): When the engine-wide picking pipeline gains sprite
 * support, replace the CPU walk below with a GPU ID-pass query that reuses
 * the variant's WGSL (so the picked silhouette matches the rendered
 * silhouette, including alpha-cutout discard).
 */

import type { SceneContext } from "../../scene/scene.js";
import type { BillboardSpriteSystem } from "../sprite-billboard-shared.js";
import { SPRITE_BILLBOARD_STRIDE } from "../sprite-billboard-shared.js";
import { getViewProjectionMatrix } from "../../camera/camera.js";

export interface SpritePickInfo {
    layerOrSystem: BillboardSpriteSystem;
    spriteIndex: number;
    uv: [number, number];
    screenPx: [number, number];
    worldPosition?: [number, number, number];
}

type Vec3 = [number, number, number];

function projectToPx(vp: Float32Array, x: number, y: number, z: number, w: number, h: number): { x: number; y: number; w: number } | null {
    const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
    const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
    const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
    if (cw <= 0) {
        return null;
    }
    return { x: ((cx / cw) * 0.5 + 0.5) * w, y: (1 - (cy / cw) * 0.5 - 0.5) * h, w: cw };
}

function pointInQuad(px: number, py: number, q0: { x: number; y: number }, q1: { x: number; y: number }, q2: { x: number; y: number }, q3: { x: number; y: number }): boolean {
    // Two-triangle test (q0,q1,q2) and (q0,q2,q3). Sign-based barycentric.
    const sign = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
    function inTri(t0: { x: number; y: number }, t1: { x: number; y: number }, t2: { x: number; y: number }): boolean {
        const d1 = sign(px, py, t0.x, t0.y, t1.x, t1.y);
        const d2 = sign(px, py, t1.x, t1.y, t2.x, t2.y);
        const d3 = sign(px, py, t2.x, t2.y, t0.x, t0.y);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(hasNeg && hasPos);
    }
    return inTri(q0, q1, q2) || inTri(q0, q2, q3);
}

function basisFor(system: BillboardSpriteSystem, worldPos: Vec3, camRight: Vec3, camUp: Vec3, camPos: Vec3): { right: Vec3; up: Vec3 } {
    if (system._variant === "facing") {
        return { right: camRight, up: camUp };
    }
    const toCam: Vec3 = [camPos[0] - worldPos[0], camPos[1] - worldPos[1], camPos[2] - worldPos[2]];
    const len = Math.hypot(toCam[0], toCam[1], toCam[2]) || 1;
    toCam[0] /= len;
    toCam[1] /= len;
    toCam[2] /= len;

    if (system._variant === "yaw") {
        const up: Vec3 = [0, 1, 0];
        let rx = up[1] * toCam[2] - up[2] * toCam[1];
        let ry = up[2] * toCam[0] - up[0] * toCam[2];
        let rz = up[0] * toCam[1] - up[1] * toCam[0];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-4) {
            return { right: [1, 0, 0], up };
        }
        rx /= rl;
        ry /= rl;
        rz /= rl;
        return { right: [rx, ry, rz], up };
    }

    // Axis-locked.
    const a = system._lockAxis ?? [0, 1, 0];
    const dotAT = a[0] * toCam[0] + a[1] * toCam[1] + a[2] * toCam[2];
    let fx = toCam[0] - a[0] * dotAT;
    let fy = toCam[1] - a[1] * dotAT;
    let fz = toCam[2] - a[2] * dotAT;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-4) {
        // Degenerate fallback (matches WGSL).
        fx = Math.abs(a[0]) < 0.9 ? 0 : 1;
        fy = 0;
        fz = Math.abs(a[0]) < 0.9 ? 1 : 0;
    } else {
        fx /= fl;
        fy /= fl;
        fz /= fl;
    }
    let rx = a[1] * fz - a[2] * fy;
    let ry = a[2] * fx - a[0] * fz;
    let rz = a[0] * fy - a[1] * fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    return { right: [rx, ry, rz], up: [a[0], a[1], a[2]] };
}

/**
 * Pick the topmost billboard sprite under the given canvas pixel.
 * Returns null when no sprite covers the cursor or the scene has no camera.
 */
export async function pickBillboardSprite(scene: SceneContext, xPx: number, yPx: number): Promise<SpritePickInfo | null> {
    const cam = scene.camera;
    if (!cam) {
        return null;
    }
    const canvas = scene.engine.canvas;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) {
        return null;
    }
    const aspect = w / h;
    const vp = getViewProjectionMatrix(cam, aspect) as unknown as Float32Array;

    const wm = cam.worldMatrix;
    const camRight: Vec3 = [wm[0]!, wm[1]!, wm[2]!];
    const camUp: Vec3 = [wm[4]!, wm[5]!, wm[6]!];
    const camPos: Vec3 = [wm[12]!, wm[13]!, wm[14]!];

    const reg = (scene as unknown as { _billboardSystems?: BillboardSpriteSystem[] })._billboardSystems;
    if (!reg || reg.length === 0) {
        return null;
    }
    // Walk systems in descending order, then reverse insertion within each.
    const systems = reg.slice().sort((a, b) => b.order - a.order);

    let best: { info: SpritePickInfo; distance: number } | null = null;

    for (const system of systems) {
        if (!system.visible || system._storage.count === 0) {
            continue;
        }
        const data = system._storage.data;
        for (let i = system._storage.count - 1; i >= 0; i--) {
            const meta = system._meta[i]!;
            if (!meta.visible || !meta.pickable) {
                continue;
            }
            const off = i * SPRITE_BILLBOARD_STRIDE;
            const wx = data[off + 0]!;
            const wy = data[off + 1]!;
            const wz = data[off + 2]!;
            const sw = meta.sizeWorld[0];
            const sh = meta.sizeWorld[1];
            if (sw <= 0 || sh <= 0) {
                continue;
            }
            const basis = basisFor(system, [wx, wy, wz], camRight, camUp, camPos);
            const sin = Math.sin(meta.rotation);
            const cos = Math.cos(meta.rotation);
            const px = meta.pivot[0];
            const py = meta.pivot[1];

            // Build the four world-space corners (matches WGSL: local = (corner - pivot) * sizeWorld then rotate2).
            const projCorners: { x: number; y: number; w: number }[] = [];
            const cornerUVs: [number, number][] = [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
            ];
            let allBehind = true;
            for (const c of cornerUVs) {
                const lx = (c[0] - px) * sw;
                const ly = (c[1] - py) * sh;
                const rx = lx * cos - ly * sin;
                const ry = lx * sin + ly * cos;
                const wxC = wx + basis.right[0] * rx + basis.up[0] * ry;
                const wyC = wy + basis.right[1] * rx + basis.up[1] * ry;
                const wzC = wz + basis.right[2] * rx + basis.up[2] * ry;
                const proj = projectToPx(vp, wxC, wyC, wzC, w, h);
                if (!proj) {
                    projCorners.length = 0;
                    break;
                }
                projCorners.push(proj);
                allBehind = false;
            }
            if (allBehind || projCorners.length !== 4) {
                continue;
            }
            if (!pointInQuad(xPx, yPx, projCorners[0]!, projCorners[1]!, projCorners[2]!, projCorners[3]!)) {
                continue;
            }
            // Keep the closest hit (smallest clip.w is closest for typical projections).
            const distance = projCorners[0]!.w;
            if (!best || distance < best.distance) {
                best = {
                    info: {
                        layerOrSystem: system,
                        spriteIndex: i,
                        uv: [0.5, 0.5],
                        screenPx: [xPx, yPx],
                        worldPosition: [wx, wy, wz],
                    },
                    distance,
                };
            }
        }
    }
    return best ? best.info : null;
}
