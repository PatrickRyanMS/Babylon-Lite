/**
 * FBX light builder (dynamic-imported by `load-fbx.ts` only when the file
 * actually declares lights, so a light-free FBX pays zero bytes for it).
 *
 * Ports the relevant slice of the Babylon.js FBX loader's `_createLight`: the
 * light node's WORLD matrix (already in Lite space — i.e. with the `__root__`
 * `[-1, 1, 1]` flip and any axis-conversion node folded in) places the light.
 * An FBX light aims along its local **-Z** axis, so the direction is the
 * normalized vector from the world-space origin to the local `(0, 0, -1)` point
 * pushed through that world matrix. Intensity arrives already divided by 100 and
 * colour is the raw FBX RGB triple.
 */

import type { Mat4 } from "../math/types.js";
import type { LightBase } from "../light/types.js";
import type { FBXLightData } from "./interpreter/fbx-interpreter.js";

import { createPointLight } from "../light/point-light.js";
import { createDirectionalLight } from "../light/directional-light.js";
import { createSpotLight } from "../light/spot-light.js";

/** Apply a Lite column-major `Mat4` to a point: `v' = M · v`.
 *   x' = m[0]x + m[4]y + m[8]z + m[12]
 *   y' = m[1]x + m[5]y + m[9]z + m[13]
 *   z' = m[2]x + m[6]y + m[10]z + m[14]
 */
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const f = m as unknown as ArrayLike<number>;
    return [f[0]! * x + f[4]! * y + f[8]! * z + f[12]!, f[1]! * x + f[5]! * y + f[9]! * z + f[13]!, f[2]! * x + f[6]! * y + f[10]! * z + f[14]!];
}

/** Resolved Lite light parameters derived from an FBX light. */
export interface FbxLightParams {
    /** FBX light type: 0=Point, 1=Directional, 2=Spot. */
    type: number;
    /** World-space light position. */
    position: [number, number, number];
    /** Normalized world-space aim direction (local -Z). */
    direction: [number, number, number];
    /** Full cone angle in radians (spot lights). */
    coneAngle: number;
    /** Intensity multiplier (already /100 by the interpreter). */
    intensity: number;
    /** Diffuse colour `[r, g, b]`. */
    color: [number, number, number];
}

/**
 * PURE mapping helper: FBX light data + its Lite-space world matrix → the
 * parameters needed to construct a Lite light. No engine/GPU/scene dependency,
 * so it is directly unit-testable with synthetic world matrices.
 */
export function fbxLightToParams(light: FBXLightData, worldMat: Mat4): FbxLightParams {
    const position = transformPoint(worldMat, 0, 0, 0);
    const forward = transformPoint(worldMat, 0, 0, -1);
    let dx = forward[0] - position[0];
    let dy = forward[1] - position[1];
    let dz = forward[2] - position[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    return {
        type: light.lightType,
        position,
        direction: [dx, dy, dz],
        coneAngle: (light.coneAngle * Math.PI) / 180,
        intensity: light.intensity,
        color: [light.color[0], light.color[1], light.color[2]],
    };
}

/**
 * Build a Lite light from FBX light data + its Lite-space world matrix. Maps the
 * FBX light type to the matching Lite factory (0→point, 1→directional, 2→spot,
 * anything else→point) and sets the light's diffuse colour from the FBX colour.
 */
export function buildFbxLight(light: FBXLightData, worldMat: Mat4): LightBase {
    const p = fbxLightToParams(light, worldMat);
    if (p.type === 1) {
        const dir = createDirectionalLight(p.direction, p.intensity);
        dir.diffuse = p.color;
        return dir;
    }
    if (p.type === 2) {
        const spot = createSpotLight(p.position, p.direction, p.coneAngle, 2, p.intensity);
        spot.diffuse = p.color;
        return spot;
    }
    const point = createPointLight(p.position, p.intensity);
    point.diffuse = p.color;
    return point;
}
