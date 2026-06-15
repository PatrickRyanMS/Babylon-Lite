/**
 * FBX axis + unit conversion (PURE, no engine/GPU dependency).
 *
 * FBX files declare their coordinate frame via the global settings `upAxis`,
 * `frontAxis`, `coordAxis` (0=X, 1=Y, 2=Z) each with a sign, plus a scene
 * `unitScaleFactor`. {@link computeFbxAxisConversionMatrix} ports the Babylon.js
 * FBX loader's `_computeFBXAxisConversionMatrix`: it builds the basis-change
 * matrix that rewrites geometry from the file's frame into Babylon's canonical
 * frame (up = +Y, front = +Z, coord/right = +X), then folds in the uniform unit
 * scale.
 *
 * The matrix is a pure basis permutation (signed). For the right-handed axis
 * systems FBX exporters emit (Y-up, Z-up Max/Maya) its determinant is +1, so it
 * does NOT change handedness — the loader's `__root__` scale `[-1, 1, 1]` remains
 * the sole RH→LH flip and is never doubled.
 *
 * Convention: the returned `Mat4` is column-major flat (`m[col * 4 + row]`),
 * identical to the `fbx-mat4` helpers. Applied as `v' = M · v` it maps the
 * file's up vector to `+Y`, its front vector to `+Z`, and its coord vector to
 * `+X`. For the default Y-up frame with unit scale 1 the matrix would be the
 * identity, so this function returns `null` in that case (no conversion node).
 */

import type { Mat4 } from "../math/types.js";

/** The seven FBX global-settings fields needed to build the conversion matrix. */
export interface FbxAxisSettings {
    upAxis: number;
    upAxisSign: number;
    frontAxis: number;
    frontAxisSign: number;
    coordAxis: number;
    coordAxisSign: number;
    unitScaleFactor: number;
}

/** True when the settings describe FBX's default frame (Y-up, +Z front, +X coord) and unit scale. */
function isDefaultFrame(s: FbxAxisSettings): boolean {
    return s.upAxis === 1 && s.upAxisSign === 1 && s.frontAxis === 2 && s.frontAxisSign === 1 && s.coordAxis === 0 && s.coordAxisSign === 1 && s.unitScaleFactor === 1;
}

/**
 * Build the FBX axis + unit conversion matrix, or `null` when no conversion is
 * needed (default Y-up frame with unit scale 1).
 *
 * The linear 3×3 part places the file's coord/up/front basis vectors as the
 * matrix ROWS so that `M · (coord) = +X`, `M · (up) = +Y`, `M · (front) = +Z`,
 * then multiplies every entry by `unitScaleFactor` for the uniform unit scale.
 */
export function computeFbxAxisConversionMatrix(scene: FbxAxisSettings): Mat4 | null {
    if (isDefaultFrame(scene)) {
        return null;
    }

    const s = scene.unitScaleFactor;
    const m = new Float64Array(16);

    // Column-major flat storage: m[col * 4 + row] = M[row][col].
    //   row 0 = coord vector  → target +X
    //   row 1 = up vector     → target +Y
    //   row 2 = front vector  → target +Z
    m[scene.coordAxis * 4 + 0] = scene.coordAxisSign * s;
    m[scene.upAxis * 4 + 1] = scene.upAxisSign * s;
    m[scene.frontAxis * 4 + 2] = scene.frontAxisSign * s;
    m[15] = 1;

    return m as unknown as Mat4;
}
