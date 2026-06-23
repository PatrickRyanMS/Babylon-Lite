/**
 * FBX camera builder (dynamic-imported by `load-fbx.ts` only when the file
 * actually declares a camera, so a camera-free FBX pays zero bytes for it).
 *
 * Ports the relevant slice of the Babylon.js FBX loader's `_createCamera`: the
 * camera node's WORLD matrix (already in Lite space — i.e. with the `__root__`
 * `[-1, 1, 1]` flip and any axis-conversion node folded in) places the camera.
 * An FBX camera looks along its local **+X** axis, so the look-at target is the
 * local `(1, 0, 0)` point pushed through that world matrix. Field of view comes
 * across in degrees and is converted to radians for the Lite `FreeCamera`.
 */

import type { Mat4 } from "../math/types.js";
import type { FreeCamera } from "../camera/free-camera.js";
import type { FBXCameraData } from "./interpreter/fbx-interpreter.js";

import { createFreeCamera } from "../camera/free-camera.js";

/** Apply a Lite column-major `Mat4` to a point: `v' = M · v`.
 *   x' = m[0]x + m[4]y + m[8]z + m[12]
 *   y' = m[1]x + m[5]y + m[9]z + m[13]
 *   z' = m[2]x + m[6]y + m[10]z + m[14]
 */
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const f = m as unknown as ArrayLike<number>;
    return [f[0]! * x + f[4]! * y + f[8]! * z + f[12]!, f[1]! * x + f[5]! * y + f[9]! * z + f[13]!, f[2]! * x + f[6]! * y + f[10]! * z + f[14]!];
}

/** Resolved Lite `FreeCamera` parameters derived from an FBX camera. */
export interface FbxCameraParams {
    /** World-space camera position. */
    position: [number, number, number];
    /** World-space look-at target (local +X pushed through the world matrix). */
    target: [number, number, number];
    /** Field of view in radians. */
    fov: number;
    /** Near clip plane. */
    nearPlane: number;
    /** Far clip plane. */
    farPlane: number;
}

/**
 * PURE mapping helper: FBX camera data + its Lite-space world matrix → the
 * parameters needed to construct a Lite {@link FreeCamera}. No engine/GPU/scene
 * dependency, so it is directly unit-testable with synthetic world matrices.
 */
export function fbxCameraToParams(cam: FBXCameraData, worldMat: Mat4): FbxCameraParams {
    return {
        position: transformPoint(worldMat, 0, 0, 0),
        target: transformPoint(worldMat, 1, 0, 0),
        fov: (cam.fieldOfView * Math.PI) / 180,
        nearPlane: cam.nearPlane,
        farPlane: cam.farPlane,
    };
}

/**
 * Build a Lite {@link FreeCamera} from FBX camera data + its Lite-space world
 * matrix. Orthographic FBX cameras are downgraded to a perspective `FreeCamera`
 * (Lite's free camera has no orthographic mode) with a diagnostic — the
 * geometry still frames, just under a perspective projection.
 */
export function buildFbxCamera(cam: FBXCameraData, worldMat: Mat4): FreeCamera {
    const p = fbxCameraToParams(cam, worldMat);
    if (cam.projectionType === "orthographic") {
        console.warn(`[loadFbx] camera "${cam.name}" is orthographic; Lite FreeCamera has no ortho mode — created as perspective.`);
    }
    const camera = createFreeCamera({ x: p.position[0], y: p.position[1], z: p.position[2] }, { x: p.target[0], y: p.target[1], z: p.target[2] });
    camera.fov = p.fov;
    camera.nearPlane = p.nearPlane;
    camera.farPlane = p.farPlane;
    return camera;
}
