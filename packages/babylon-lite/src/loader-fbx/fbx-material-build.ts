/**
 * FBX material building — maps {@link FBXMaterialData} to {@link StandardMaterialProps}.
 *
 * Colors are mapped synchronously (the allocation-light fast path used by
 * texture-less materials), then every connected texture is resolved
 * concurrently and assigned to the matching Standard-material slot. The result
 * is a map keyed by FBX material id; `load-fbx.ts` awaits it before building
 * meshes so the renderer never sees a half-populated material.
 *
 * Texture-slot mapping mirrors BJS `fbxFileLoader._createMaterial`. Colour textures
 * are decoded in GAMMA space (srgb:false) to match Babylon.js StandardMaterial, which
 * samples diffuse/emissive/ambient/specular textures without an sRGB→linear conversion
 * (same convention as Lite's .babylon loader). Verified against the FBX visual-parity
 * goldens (m06 checker red): srgb:true over-darkened saturated colours.
 *  - `DiffuseColor`  → `diffuseTexture` (+ `diffuseColor` forced white so the
 *    texture is not tinted), gamma.
 *  - `EmissiveColor` → `emissiveTexture`, gamma.
 *  - `AmbientColor`  → `ambientTexture`, gamma.
 *  - `SpecularColor` → `specularTexture`, gamma.
 *  - `ReflectionColor`/`ReflectionFactor` → `reflectionTexture`, gamma.
 *  - `NormalMap`/`Bump`/`BumpFactor`/… → `bumpTexture`, linear.
 *  - `TransparentColor`/`TransparencyFactor` → `opacityTexture`, linear.
 *
 * `uvScaling` maps to `material.uvScale`; a texture on a non-zero UV set index
 * sets the slot's `*CoordIndex = 1`. Non-trivial UV translation/rotation is not
 * representable on Standard materials (no uOffset/uAng) and is reported as a
 * diagnostic instead of being silently dropped.
 */

import type { EngineContext } from "../engine/engine.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";

import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { enableStandardUvOffset } from "../material/standard/enable-standard-mesh-features.js";

import type { FBXMaterialData } from "./interpreter/materials.js";
import { resolveFbxTexture } from "./fbx-texture.js";

/** Texture-slot descriptor: where an FBX material property lands on a Standard material. */
interface FbxTexSlot {
    /** Destination `Texture2D` field on {@link StandardMaterialProps}. */
    readonly dst: string;
    /** Decode the image as sRGB (color) vs linear (normal/data). */
    readonly srgb: boolean;
    /** Optional `*CoordIndex` field set to 1 when the texture uses a secondary UV set. */
    readonly coordIndex?: string;
    /** Force `diffuseColor` white so the diffuse texture is not tinted. */
    readonly whiteDiffuse?: boolean;
}

/** Resolve an FBX texture `propertyName` to a Standard-material slot, or null if unmapped. */
function resolveSlot(propertyName: string): FbxTexSlot | null {
    switch (propertyName) {
        case "DiffuseColor":
        case "Diffuse":
            return { dst: "diffuseTexture", srgb: false, coordIndex: "diffuseCoordIndex", whiteDiffuse: true };
        case "EmissiveColor":
        case "Emissive":
            return { dst: "emissiveTexture", srgb: false };
        case "AmbientColor":
        case "Ambient":
            return { dst: "ambientTexture", srgb: false, coordIndex: "ambientCoordIndex" };
        case "SpecularColor":
        case "Specular":
            return { dst: "specularTexture", srgb: false, coordIndex: "specularCoordIndex" };
        case "ReflectionColor":
        case "ReflectionFactor":
            return { dst: "reflectionTexture", srgb: false };
        case "NormalMap":
        case "NormalMapTexture":
        case "normalCamera":
        case "Bump":
        case "BumpFactor":
            return { dst: "bumpTexture", srgb: false };
        case "TransparentColor":
        case "TransparencyFactor":
            return { dst: "opacityTexture", srgb: false };
        default:
            return null;
    }
}

/**
 * Map an FBX material's scalar/color properties to Standard-material props.
 * Mirrors BJS `_createMaterial` colour rules (Lambert → no specular term,
 * factors fold into their colours, opacity ← `opacity` else `1 − transparency`).
 */
function mapFbxMaterialColors(fbxMat: FBXMaterialData): StandardMaterialProps {
    const std = createStandardMaterial();
    const p = fbxMat.properties;

    if (p.diffuseColor) {
        const f = p.diffuseFactor ?? 1;
        std.diffuseColor = [p.diffuseColor[0] * f, p.diffuseColor[1] * f, p.diffuseColor[2] * f];
    }

    if (fbxMat.type === "Phong") {
        if (p.specularColor) {
            const f = p.specularFactor ?? 1;
            std.specularColor = [p.specularColor[0] * f, p.specularColor[1] * f, p.specularColor[2] * f];
        }
        if (p.shininess !== undefined) {
            std.specularPower = p.shininess;
        }
    } else {
        // Lambert shading model has no specular term.
        std.specularColor = [0, 0, 0];
    }

    if (p.emissiveColor) {
        const f = p.emissiveFactor ?? 1;
        std.emissiveColor = [p.emissiveColor[0] * f, p.emissiveColor[1] * f, p.emissiveColor[2] * f];
    }

    if (p.ambientColor) {
        std.ambientColor = [p.ambientColor[0], p.ambientColor[1], p.ambientColor[2]];
    }

    if (p.opacity !== undefined) {
        std.alpha = p.opacity;
    } else if (p.transparencyFactor !== undefined) {
        std.alpha = 1 - p.transparencyFactor;
    }

    return std;
}

/** Result of building all materials for an FBX document. */
export interface FbxMaterialBuildResult {
    /** Built Standard materials keyed by FBX material id. */
    materials: Map<number, StandardMaterialProps>;
    /** Recoverable diagnostics (unmapped textures, dropped UV transforms, load failures). */
    diagnostics: string[];
}

/**
 * Build Standard materials for every FBX material, loading all connected
 * textures concurrently. Returns once every texture promise has settled.
 *
 * @param engine - Engine context (GPU device).
 * @param materials - Deduped scene-level FBX materials.
 * @param baseUrl - Directory of the FBX file (trailing slash included).
 * @param fbmDir - `<name>.fbm/` embedded-media directory for external sidecars.
 */
export async function buildFbxMaterials(
    engine: EngineContext,
    materials: readonly FBXMaterialData[],
    baseUrl: string,
    fbmDir: string | undefined
): Promise<FbxMaterialBuildResult> {
    const map = new Map<number, StandardMaterialProps>();
    const diagnostics: string[] = [];
    const seenDiag = new Set<string>();
    const addDiag = (message: string): void => {
        if (!seenDiag.has(message)) {
            seenDiag.add(message);
            diagnostics.push(message);
        }
    };

    const texturePromises: Promise<void>[] = [];

    for (const fbxMat of materials) {
        if (map.has(fbxMat.id)) {
            continue;
        }
        const std = mapFbxMaterialColors(fbxMat);
        const record = std as unknown as Record<string, unknown>;

        for (const texRef of fbxMat.textures) {
            const slot = resolveSlot(texRef.propertyName);
            if (!slot) {
                addDiag(`FBX texture property '${texRef.propertyName}' on material '${fbxMat.name}' is not mapped to a Standard-material slot.`);
                continue;
            }

            // uvScaling → material.uvScale (last writer wins across this material's textures).
            if (texRef.uvScaling && (texRef.uvScaling[0] !== 1 || texRef.uvScaling[1] !== 1)) {
                std.uvScale = [texRef.uvScaling[0], texRef.uvScaling[1]];
            }
            // uvTranslation → material.uvOffset (BJS Texture.uOffset/vOffset; last writer wins).
            if (texRef.uvTranslation && (texRef.uvTranslation[0] !== 0 || texRef.uvTranslation[1] !== 0)) {
                std.uvOffset = [texRef.uvTranslation[0], texRef.uvTranslation[1]];
                // Opt the Standard pipeline into UV offset so its reads stop folding to 0 (net-neutral
                // for scenes — like every non-FBX Standard scene — that never set a UV offset).
                enableStandardUvOffset();
            }
            // Rotation is not yet applied (Standard UV transform is scale + offset only).
            if (texRef.uvRotation) {
                addDiag(`FBX UV rotation ${texRef.uvRotation}° on material '${fbxMat.name}' is not supported (only uvScale + uvOffset are applied).`);
            }
            // Texture on a secondary UV set → use UV2 for slots that support it.
            if (slot.coordIndex && texRef.uvSetIndex !== undefined && texRef.uvSetIndex > 0) {
                record[slot.coordIndex] = 1;
            }
            // A diffuse texture must not be tinted by the diffuse colour.
            if (slot.whiteDiffuse) {
                std.diffuseColor = [1, 1, 1];
            }

            const label = texRef.relativeFileName || texRef.fileName || texRef.propertyName;
            texturePromises.push(
                resolveFbxTexture(engine, texRef, baseUrl, { srgb: slot.srgb, fbmDir }).then((tex) => {
                    if (tex) {
                        record[slot.dst] = tex;
                    } else {
                        addDiag(`Failed to load FBX texture '${label}' for material '${fbxMat.name}'.`);
                    }
                })
            );
        }

        map.set(fbxMat.id, std);
    }

    await Promise.all(texturePromises);
    return { materials: map, diagnostics };
}
