/**
 * Shared helpers for the FBX parity-golden provenance + drift tooling.
 *
 * The scene230 FBX parity goldens (reference/lite/scene230-fbx-loader/<model>/
 * babylon-ref-golden.png) are EXACT copies of Babylon.js's own committed FBX
 * visualization reference images
 * (packages/tools/tests/test/visualization/ReferenceImages/fbx-*.png).
 *
 *   - `pnpm sync:fbx-goldens`  copies the Babylon images into the repo and records
 *                             their provenance (Babylon ref/commit + per-file hash).
 *   - `pnpm check:fbx-goldens` re-diffs our pinned copies against Babylon's current
 *                             reference images so we are told when upstream changes.
 *
 * Babylon images are resolved from (in priority order):
 *   1. `--ref <gitref>` / env `BJS_REF`  → fetched from raw.githubusercontent.com.
 *   2. env `BJS_REF_IMAGES_DIR`          → an explicit local directory.
 *   3. the sibling `../Babylon.js` checkout (default for local dev).
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..");

/** Lite golden directory (one subdir per model, each holding babylon-ref-golden.png). */
export const LITE_GOLDEN_DIR = join(REPO_ROOT, "reference", "lite", "scene230-fbx-loader");
/** Committed provenance manifest. */
export const MANIFEST_PATH = join(LITE_GOLDEN_DIR, "golden-sources.json");

export const BJS_REPO = "BabylonJS/Babylon.js";
export const BJS_SOURCE_DIR = "packages/tools/tests/test/visualization/ReferenceImages";
export const RAW_URL_BASE = "https://raw.githubusercontent.com";
/** Default sibling Babylon.js checkout, relative to this repo root. */
export const SIBLING_BJS_DIR = resolve(REPO_ROOT, "..", "Babylon.js");

/** Canonical model→Babylon-source mapping (the 18 FBX visualization references). */
export const GOLDEN_MAP: ReadonlyArray<readonly [model: string, source: string]> = [
    ["m01_cube_phong", "fbx-m01-cube-phong.png"],
    ["m02_geo_ngons", "fbx-m02-ngons.png"],
    ["m03_normals", "fbx-m03-normals.png"],
    ["m04_material_properties", "fbx-m04-materials.png"],
    ["m05_textures", "fbx-m05-textures.png"],
    ["m06_uv_transform", "fbx-m06-uv-transform.png"],
    ["m07_multimaterial", "fbx-m07-multimaterial.png"],
    ["m08_transforms", "fbx-m08-transforms.png"],
    ["m09_skinning", "fbx-m09-skinning.png"],
    ["m10_morph", "fbx-m10-morph.png"],
    ["m11_node_anim", "fbx-m11-node-anim.png"],
    ["m12_skeletal_anim", "fbx-m12-skeletal-anim.png"],
    ["m13_morph_anim", "fbx-m13-morph-anim.png"],
    ["m14_multiclip", "fbx-m14-multiclip.png"],
    ["m15_camera_lights", "fbx-m15-camera-lights.png"],
    ["m16_axis_yup", "fbx-m16-axis-yup.png"],
    ["m16_axis_zup", "fbx-m16-axis-zup.png"],
    ["m16_units_254", "fbx-m16-units.png"],
];

export interface GoldenEntry {
    model: string;
    source: string;
    sha256: string;
}

export interface GoldenManifest {
    $comment: string;
    babylonRepo: string;
    babylonSourceDir: string;
    rawUrlBase: string;
    /** Human-readable `git describe` of the Babylon checkout the goldens were synced from. */
    syncedFromRef: string;
    /** Full Babylon commit SHA the goldens were synced from. */
    syncedFromCommit: string;
    syncedAt: string;
    /** Max per-image MAD (0-255) tolerated before the drift gate fails. */
    driftThresholdMad: number;
    goldens: GoldenEntry[];
}

export const DEFAULT_DRIFT_THRESHOLD_MAD = 1.0;

export function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
}

/** The path to a model's committed Lite golden PNG. */
export function liteGoldenPath(model: string): string {
    return join(LITE_GOLDEN_DIR, model, "babylon-ref-golden.png");
}

/** Mean absolute per-channel difference (0-255) between two PNG buffers, or
 *  `null` when the dimensions differ (which is itself a drift signal). */
export function comparePngMad(a: Buffer, b: Buffer): { mad: number | null; dims: string } {
    const pa = PNG.sync.read(a);
    const pb = PNG.sync.read(b);
    if (pa.width !== pb.width || pa.height !== pb.height) {
        return { mad: null, dims: `${pa.width}x${pa.height} vs ${pb.width}x${pb.height}` };
    }
    let sum = 0;
    for (let i = 0; i < pa.data.length; i++) {
        sum += Math.abs(pa.data[i]! - pb.data[i]!);
    }
    return { mad: sum / pa.data.length, dims: `${pa.width}x${pa.height}` };
}

export interface BabylonSource {
    /** Human description of where the images come from (for logging). */
    describe: string;
    /** `git describe`-style ref, when known (sibling/local checkout). */
    ref: string;
    /** Full commit SHA, when known. */
    commit: string;
    /** Resolve one source image (e.g. `fbx-m02-ngons.png`) to its bytes. */
    get(source: string): Promise<Buffer>;
}

export interface ResolveOpts {
    /** Git ref to fetch from raw.githubusercontent.com (overrides local sources). */
    ref?: string;
}

/** Resolve where to read Babylon's reference images from. */
export function resolveBabylonSource(opts: ResolveOpts = {}): BabylonSource {
    const ref = opts.ref ?? process.env.BJS_REF;
    if (ref) {
        const base = `${RAW_URL_BASE}/${BJS_REPO}/${ref}/${BJS_SOURCE_DIR}`;
        return {
            describe: `${BJS_REPO}@${ref} (raw.githubusercontent.com)`,
            ref,
            commit: "",
            async get(source: string): Promise<Buffer> {
                const url = `${base}/${source}`;
                const res = await fetch(url);
                if (!res.ok) {
                    throw new Error(`fetch ${url} -> HTTP ${res.status}`);
                }
                return Buffer.from(await res.arrayBuffer());
            },
        };
    }

    const localDir = process.env.BJS_REF_IMAGES_DIR ? resolve(process.env.BJS_REF_IMAGES_DIR) : join(SIBLING_BJS_DIR, BJS_SOURCE_DIR);
    if (!existsSync(localDir)) {
        throw new Error(
            `Babylon reference images not found at ${localDir}.\n` +
                `Provide one of: --ref <gitref> (fetch from GitHub), env BJS_REF_IMAGES_DIR=<dir>, or a sibling ../Babylon.js checkout.`
        );
    }
    let ref2 = "(local)";
    let commit = "";
    const siblingRoot = process.env.BJS_REF_IMAGES_DIR ? "" : SIBLING_BJS_DIR;
    if (siblingRoot && existsSync(join(siblingRoot, ".git"))) {
        try {
            commit = execFileSync("git", ["-C", siblingRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
            ref2 = execFileSync("git", ["-C", siblingRoot, "describe", "--tags", "--always"], { encoding: "utf8" }).trim();
        } catch {
            /* not a git checkout / git unavailable — provenance stays unknown */
        }
    }
    return {
        describe: localDir,
        ref: ref2,
        commit,
        get(source: string): Promise<Buffer> {
            return Promise.resolve(readFileSync(join(localDir, source)));
        },
    };
}

export function readManifest(): GoldenManifest {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as GoldenManifest;
}
