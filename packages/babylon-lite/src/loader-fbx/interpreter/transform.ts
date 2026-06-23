import type { Mat4 } from "../../math/types.js";
import { fbxMatIdentity, fbxMatInvert, fbxMatMultiply, fbxMatRotationX, fbxMatRotationY, fbxMatRotationZ, fbxMatScaling, fbxMatTranslation } from "./fbx-mat4.js";

/**
 * FBX transform math, ported line-for-line from the Babylon.js FBX loader.
 *
 * Every matrix here is built with the `fbx-mat4` helpers, which replicate BJS
 * `Matrix` flat semantics exactly. Because a BJS row-major matrix and a Lite
 * column-major `Mat4` share identical 16-element flat storage for the same
 * transform, the `Mat4` returned by these functions is directly a valid Lite
 * column-major matrix — no transpose, no multiply-order reversal. Each BJS
 * `X.multiply(Y)` becomes `fbxMatMultiply(X, Y)` (X applied first).
 */

/** A 3-component FBX vector `[x, y, z]` (translation, rotation in degrees, scale, etc.). */
export type FBXVector3 = [number, number, number];

/** The full set of FBX node transform components used to build a local matrix. */
export interface FBXTransformComponents {
    translation: FBXVector3;
    rotation: FBXVector3;
    scale: FBXVector3;
    preRotation: FBXVector3;
    postRotation: FBXVector3;
    rotationPivot: FBXVector3;
    scalingPivot: FBXVector3;
    rotationOffset: FBXVector3;
    scalingOffset: FBXVector3;
    rotationOrder: number;
    inheritType?: number;
}

/** Euler rotation (radians) composed in fixed XYZ order. */
export function eulerToMatrixXYZ(rx: number, ry: number, rz: number): Mat4 {
    const mx = fbxMatRotationX(rx);
    const my = fbxMatRotationY(ry);
    const mz = fbxMatRotationZ(rz);
    return fbxMatMultiply(fbxMatMultiply(mx, my), mz);
}

/** Euler rotation (radians) composed according to the FBX rotation order (0..5). */
export function eulerToMatrix(rx: number, ry: number, rz: number, order: number): Mat4 {
    const mx = fbxMatRotationX(rx);
    const my = fbxMatRotationY(ry);
    const mz = fbxMatRotationZ(rz);

    switch (order) {
        case 0:
            return fbxMatMultiply(fbxMatMultiply(mx, my), mz); // XYZ
        case 1:
            return fbxMatMultiply(fbxMatMultiply(mx, mz), my); // XZY
        case 2:
            return fbxMatMultiply(fbxMatMultiply(my, mz), mx); // YZX
        case 3:
            return fbxMatMultiply(fbxMatMultiply(my, mx), mz); // YXZ
        case 4:
            return fbxMatMultiply(fbxMatMultiply(mz, mx), my); // ZXY
        case 5:
            return fbxMatMultiply(fbxMatMultiply(mz, my), mx); // ZYX
        default:
            return fbxMatMultiply(fbxMatMultiply(mx, my), mz); // fallback to XYZ
    }
}

/** Geometric transform matrix (translation in units, rotation in degrees, scale). */
export function computeFBXGeometricMatrix(translation: FBXVector3, rotation: FBXVector3, scale: FBXVector3): Mat4 {
    const translationM = fbxMatTranslation(translation[0], translation[1], translation[2]);
    return fbxMatMultiply(computeFBXGeometricDeltaMatrix(rotation, scale), translationM);
}

/** Rotation/scale portion of the geometric transform (rotation in degrees). */
export function computeFBXGeometricDeltaMatrix(rotation: FBXVector3, scale: FBXVector3): Mat4 {
    const d2r = Math.PI / 180;
    const scaleM = fbxMatScaling(scale[0], scale[1], scale[2]);
    const rotationM = eulerToMatrixXYZ(rotation[0] * d2r, rotation[1] * d2r, rotation[2] * d2r);
    return fbxMatMultiply(scaleM, rotationM);
}

/** Normal matrix for the geometric transform (inverse-scale * rotation, rotation in degrees). */
export function computeFBXGeometricNormalMatrix(rotation: FBXVector3, scale: FBXVector3): Mat4 {
    const d2r = Math.PI / 180;
    const inverseScaleM = fbxMatScaling(scale[0] === 0 ? 0 : 1 / scale[0], scale[1] === 0 ? 0 : 1 / scale[1], scale[2] === 0 ? 0 : 1 / scale[2]);
    const rotationM = eulerToMatrixXYZ(rotation[0] * d2r, rotation[1] * d2r, rotation[2] * d2r);
    return fbxMatMultiply(inverseScaleM, rotationM);
}

/** Build the full FBX local transform matrix from its components (rotations in degrees). */
export function computeFBXLocalMatrix(components: FBXTransformComponents): Mat4 {
    const { translation, rotation, scale, preRotation, postRotation, rotationPivot, scalingPivot, rotationOffset, scalingOffset, rotationOrder } = components;
    const d2r = Math.PI / 180;

    const hasPivots = rotationPivot[0] !== 0 || rotationPivot[1] !== 0 || rotationPivot[2] !== 0 || scalingPivot[0] !== 0 || scalingPivot[1] !== 0 || scalingPivot[2] !== 0;
    const hasOffsets = rotationOffset[0] !== 0 || rotationOffset[1] !== 0 || rotationOffset[2] !== 0 || scalingOffset[0] !== 0 || scalingOffset[1] !== 0 || scalingOffset[2] !== 0;
    const hasPostRot = postRotation[0] !== 0 || postRotation[1] !== 0 || postRotation[2] !== 0;

    if (!hasPivots && !hasOffsets && !hasPostRot) {
        const preRotM = eulerToMatrixXYZ(preRotation[0] * d2r, preRotation[1] * d2r, preRotation[2] * d2r);
        const lclRotM = eulerToMatrix(rotation[0] * d2r, rotation[1] * d2r, rotation[2] * d2r, rotationOrder);
        const translationM = fbxMatTranslation(translation[0], translation[1], translation[2]);
        const rotationM = fbxMatMultiply(lclRotM, preRotM);
        const scaleM = fbxMatScaling(scale[0], scale[1], scale[2]);
        return fbxMatMultiply(fbxMatMultiply(scaleM, rotationM), translationM);
    }

    const T = fbxMatTranslation(translation[0], translation[1], translation[2]);
    const Roff = fbxMatTranslation(rotationOffset[0], rotationOffset[1], rotationOffset[2]);
    const Rp = fbxMatTranslation(rotationPivot[0], rotationPivot[1], rotationPivot[2]);
    const RpInv = fbxMatTranslation(-rotationPivot[0], -rotationPivot[1], -rotationPivot[2]);
    const Soff = fbxMatTranslation(scalingOffset[0], scalingOffset[1], scalingOffset[2]);
    const Sp = fbxMatTranslation(scalingPivot[0], scalingPivot[1], scalingPivot[2]);
    const SpInv = fbxMatTranslation(-scalingPivot[0], -scalingPivot[1], -scalingPivot[2]);

    const Rpre = eulerToMatrixXYZ(preRotation[0] * d2r, preRotation[1] * d2r, preRotation[2] * d2r);
    const R = eulerToMatrix(rotation[0] * d2r, rotation[1] * d2r, rotation[2] * d2r, rotationOrder);
    const S = fbxMatScaling(scale[0], scale[1], scale[2]);

    let RpostInv: Mat4;
    if (hasPostRot) {
        const Rpost = eulerToMatrixXYZ(postRotation[0] * d2r, postRotation[1] * d2r, postRotation[2] * d2r);
        RpostInv = fbxMatInvert(Rpost);
    } else {
        RpostInv = fbxMatIdentity();
    }

    let result = SpInv;
    result = fbxMatMultiply(result, S);
    result = fbxMatMultiply(result, Sp);
    result = fbxMatMultiply(result, Soff);
    result = fbxMatMultiply(result, RpInv);
    result = fbxMatMultiply(result, RpostInv);
    result = fbxMatMultiply(result, R);
    result = fbxMatMultiply(result, Rpre);
    result = fbxMatMultiply(result, Rp);
    result = fbxMatMultiply(result, Roff);
    result = fbxMatMultiply(result, T);
    return result;
}
