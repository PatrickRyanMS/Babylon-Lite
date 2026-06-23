/**
 * FBX test models are NOT vendored in this repo (they are owned by the Babylon **Assets**
 * repo and served from the CDN). Tests resolve them via, in order:
 *   1. a local checkout — `FBX_ASSETS_DIR` env, else the sibling `<repo>/../Assets/meshes/fbx`
 *   2. the Babylon CDN — `https://assets.babylonjs.com/meshes/fbx`
 *
 * Only the universally-available m01–m16 loader-test set is used (plus m05's external
 * sidecar texture); all of it lives under `loaderTests/` in both the local checkout and
 * the CDN. Browser tests proxy `/fbx/*` through the lab dev server (lab/vite.config.ts)
 * using the same local→CDN fallback, so they need neither a local checkout nor CORS.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/** Local FBX models root (sibling Assets checkout). May not exist. */
export const FBX_ASSETS_ROOT = process.env.FBX_ASSETS_DIR ? resolve(process.env.FBX_ASSETS_DIR) : resolve(__dirname, "../../../Assets/meshes/fbx");

/** Babylon CDN base for the FBX models (fallback when there is no local checkout). */
export const FBX_CDN_BASE = "https://assets.babylonjs.com/meshes/fbx";

/** True when a local Assets checkout is present (else the CDN is used). */
export const fbxAssetsAvailable = existsSync(FBX_ASSETS_ROOT);

/** The m01–m16 loader-test models (all under `loaderTests/`). */
export const FBX_MODEL_FILES = [
    "m01_cube_phong.fbx",
    "m02_geo_ngons.fbx",
    "m03_normals.fbx",
    "m04_material_properties.fbx",
    "m05_textures.fbx",
    "m06_uv_transform.fbx",
    "m07_multimaterial.fbx",
    "m08_transforms.fbx",
    "m09_skinning.fbx",
    "m10_morph.fbx",
    "m11_node_anim.fbx",
    "m12_skeletal_anim.fbx",
    "m13_morph_anim.fbx",
    "m14_multiclip.fbx",
    "m15_camera_lights.fbx",
    "m16_axis_yup.fbx",
    "m16_axis_zup.fbx",
    "m16_units_254.fbx",
];

/** Resolve a single FBX asset to a LOCAL path (under `loaderTests/`). The returned path
 *  may not exist — callers should fall back to {@link readFbxModel}. */
export function resolveFbxAsset(name: string): string {
    return resolve(FBX_ASSETS_ROOT, "loaderTests", name);
}

/** Read an FBX model's bytes: local checkout if present, else the Babylon CDN. */
export async function readFbxModel(name: string): Promise<Uint8Array> {
    const local = resolveFbxAsset(name);
    if (existsSync(local)) {
        return new Uint8Array(readFileSync(local));
    }
    const res = await fetch(`${FBX_CDN_BASE}/loaderTests/${name}`);
    if (!res.ok) {
        throw new Error(`FBX model "${name}" not found locally or on CDN (HTTP ${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
}
