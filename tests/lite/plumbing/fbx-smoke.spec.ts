import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

/** Models exercised for the basic "loads + renders non-blank" contract. */
const NONBLANK_MODELS = [
    "m01_cube_phong",
    "m03_normals",
    "m08_transforms",
    "m16_axis_yup",
    "m16_axis_zup",
    "m16_units_254",
    "m05_textures",
    "m06_uv_transform",
    "m04_material_properties",
];

/** Models whose canvas is also written to `_tmp_fbx_caps/` for visual eyeballing. */
const CAPTURE_MODELS = new Set(["m07_multimaterial", "m15_camera_lights", "m16_axis_yup", "m16_axis_zup", "m05_textures", "m06_uv_transform", "m10_morph"]);

/** Explicit camera orbit (radians) for models the default front-on camera can't
 *  frame well: the flat texture cards face +Z (away from the default −Z camera).
 *  A shared 3/4 view (from the +Z/−X corner, slightly elevated) brings their
 *  textured content into frame so both the non-blank assertion and the eyeball
 *  captures are meaningful. The morph plane is a flat XZ ground plane (normal +Y),
 *  so it needs a top-down tilt (small beta) to present its surface. */
const VIEW_OVERRIDES: Record<string, { alpha: number; beta: number }> = {
    m05_textures: { alpha: 2.094, beta: 1.047 },
    m06_uv_transform: { alpha: 2.094, beta: 1.047 },
    m10_morph: { alpha: 0.785, beta: 0.6 },
    m13_morph_anim: { alpha: 0.785, beta: 0.6 },
};

/** Temp capture directory at the repo root (left in place for the orchestrator). */
const CAP_DIR = resolve(__dirname, "../../../_tmp_fbx_caps");

/** Luminance (Rec. 601) of an RGB triple. */
function luma(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Non-blank metric: fraction of pixels whose COLOR (per-channel L1 distance)
 *  differs from the top-left corner background by more than `delta`, plus the
 *  luminance stddev. Color distance (not luminance alone) is used for the
 *  differing fraction so a strongly-tinted-but-similar-luma surface — e.g. a dark
 *  red face over a dark blue background — still registers as non-blank. */
function nonBlankMetric(png: PNG, delta = 32): { differingFraction: number; stddev: number } {
    const { width, height, data } = png;
    const bgR = data[0]!;
    const bgG = data[1]!;
    const bgB = data[2]!;
    let differing = 0;
    let sum = 0;
    let sumSq = 0;
    const count = width * height;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const colorDist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (colorDist > delta) {
            differing++;
        }
        const l = luma(r, g, b);
        sum += l;
        sumSq += l * l;
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    return { differingFraction: differing / count, stddev: Math.sqrt(variance) };
}

interface FbxResult {
    error: string | null;
    meshCount: number;
    cameraCount: number;
    lightCount: number;
    morphTargetCount: number;
    animationGroupCount: number;
    animationDurationSec: number;
    skeletonBoneCount: number;
    diagnostics: string[];
}

/** Load the FBX smoke page for `model`, returning its state + the canvas screenshot. */
async function loadModel(page: import("@playwright/test").Page, model: string): Promise<{ result: FbxResult; png: PNG }> {
    const view = VIEW_OVERRIDES[model];
    const query = view ? `?model=${model}&alpha=${view.alpha}&beta=${view.beta}` : `?model=${model}`;
    await page.goto(`/fbx-test.html${query}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    const result = await page.evaluate(() => (window as unknown as { __fbx: FbxResult }).__fbx);
    const buf = await page.locator("canvas").screenshot();

    if (CAPTURE_MODELS.has(model)) {
        mkdirSync(CAP_DIR, { recursive: true });
        writeFileSync(resolve(CAP_DIR, `${model}.png`), buf);
    }

    return { result, png: PNG.sync.read(buf) };
}

/** Load the FBX page for `model` frozen at `seekTime` seconds, returning its
 *  state plus the raw screenshot buffer (so the caller can persist it). */
async function loadModelAtTime(page: import("@playwright/test").Page, model: string, seekTime: number): Promise<{ result: FbxResult; buf: Buffer }> {
    const view = VIEW_OVERRIDES[model];
    let query = `?model=${model}&seekTime=${seekTime}`;
    if (view) {
        query += `&alpha=${view.alpha}&beta=${view.beta}`;
    }
    await page.goto(`/fbx-test.html${query}`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    const result = await page.evaluate(() => (window as unknown as { __fbx: FbxResult }).__fbx);
    const buf = await page.locator("canvas").screenshot();
    return { result, buf };
}

/** Fraction of pixels whose per-channel L1 color distance exceeds `delta`
 *  between two equally-sized screenshots. */
function pixelDiffFraction(a: PNG, b: PNG, delta = 32): number {
    const len = Math.min(a.data.length, b.data.length);
    const count = len / 4;
    let differing = 0;
    for (let i = 0; i < len; i += 4) {
        const dist = Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
        if (dist > delta) {
            differing++;
        }
    }
    return differing / count;
}

test.describe("FBX core static-mesh smoke", () => {
    for (const model of NONBLANK_MODELS) {
        test(`${model} loads and renders a non-blank image`, async ({ page }) => {
            const { result, png } = await loadModel(page, model);

            expect(result.error, `${model} reported an error: ${result.error}`).toBeFalsy();
            expect(result.meshCount, `${model} produced no meshes`).toBeGreaterThanOrEqual(1);

            const { differingFraction, stddev } = nonBlankMetric(png);
            console.log(`[fbx-smoke] ${model}: meshCount=${result.meshCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`);

            const nonBlank = differingFraction > 0.01 || stddev > 4;
            expect(nonBlank, `${model} rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
        });
    }

    test("m07_multimaterial splits into >= 2 sub-meshes and renders non-blank", async ({ page }) => {
        const { result, png } = await loadModel(page, "m07_multimaterial");

        expect(result.error, `m07_multimaterial reported an error: ${result.error}`).toBeFalsy();
        // Multi-material geometry must produce one mesh per material range.
        expect(result.meshCount, `m07_multimaterial did not split (meshCount=${result.meshCount})`).toBeGreaterThanOrEqual(2);

        const { differingFraction, stddev } = nonBlankMetric(png);
        console.log(`[fbx-smoke] m07_multimaterial: meshCount=${result.meshCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`);

        const nonBlank = differingFraction > 0.01 || stddev > 4;
        expect(nonBlank, `m07_multimaterial rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
    });

    test("m15_camera_lights applies the FBX camera + lights and renders non-blank", async ({ page }) => {
        const { result, png } = await loadModel(page, "m15_camera_lights");

        expect(result.error, `m15_camera_lights reported an error: ${result.error}`).toBeFalsy();
        // The FBX declares its own camera + lights, so the demo must NOT fall back
        // to the default rig: cameraCount/lightCount come straight from the file.
        expect(result.cameraCount, `m15_camera_lights produced no FBX camera`).toBeGreaterThanOrEqual(1);
        expect(result.lightCount, `m15_camera_lights produced no FBX lights`).toBeGreaterThanOrEqual(1);

        const { differingFraction, stddev } = nonBlankMetric(png);
        console.log(
            `[fbx-smoke] m15_camera_lights: meshCount=${result.meshCount} cameraCount=${result.cameraCount} lightCount=${result.lightCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`
        );

        const nonBlank = differingFraction > 0.01 || stddev > 4;
        expect(nonBlank, `m15_camera_lights rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
    });

    test("m09_skinning loads a skin deformer, builds a skeleton, and renders non-blank", async ({ page }) => {
        const { result, png } = await loadModel(page, "m09_skinning");

        expect(result.error, `m09_skinning reported an error: ${result.error}`).toBeFalsy();
        expect(result.meshCount, `m09_skinning produced no meshes`).toBeGreaterThanOrEqual(1);
        // The FBX declares a skin deformer, so a skeleton with at least one bone
        // must be built and assigned. (Visual skinning is wired in a later phase,
        // so the mesh renders at its REST/bind pose — undeformed but present.)
        expect(result.skeletonBoneCount, `m09_skinning built no skeleton bones`).toBeGreaterThan(0);

        const { differingFraction, stddev } = nonBlankMetric(png);
        console.log(
            `[fbx-smoke] m09_skinning: meshCount=${result.meshCount} skeletonBoneCount=${result.skeletonBoneCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`
        );

        const nonBlank = differingFraction > 0.01 || stddev > 4;
        expect(nonBlank, `m09_skinning rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
    });

    test("m10_morph loads blend shapes, assigns morph targets, and renders non-blank", async ({ page }) => {
        const { result, png } = await loadModel(page, "m10_morph");

        expect(result.error, `m10_morph reported an error: ${result.error}`).toBeFalsy();
        expect(result.meshCount, `m10_morph produced no meshes`).toBeGreaterThanOrEqual(1);
        // The FBX declares blend shapes, so at least one morph target must be built.
        expect(result.morphTargetCount, `m10_morph produced no morph targets`).toBeGreaterThanOrEqual(1);

        const { differingFraction, stddev } = nonBlankMetric(png);
        console.log(
            `[fbx-smoke] m10_morph: meshCount=${result.meshCount} morphTargetCount=${result.morphTargetCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`
        );

        const nonBlank = differingFraction > 0.01 || stddev > 4;
        expect(nonBlank, `m10_morph rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
    });

    test("m11_node_anim builds an animation group and the node moves between t0 and a mid time", async ({ page }) => {
        // m11 declares one AnimationStack ("Take 001", 0–2s) driving three root
        // models — constant-interp translation, linear 0→360° rotation, and cubic
        // scale. Capture the rest frame (t=0) and the mid frame (t=1s, where the
        // rotation is at 180° and the scale at its peak) and require a visible
        // pixel delta: that proves the node-TRS animation actually renders.
        const cap0 = await loadModelAtTime(page, "m11_node_anim", 0);
        const cap1 = await loadModelAtTime(page, "m11_node_anim", 1);

        expect(cap0.result.error, `m11_node_anim reported an error at t0: ${cap0.result.error}`).toBeFalsy();
        expect(cap1.result.error, `m11_node_anim reported an error at t1: ${cap1.result.error}`).toBeFalsy();
        expect(cap0.result.animationGroupCount, `m11_node_anim built no animation groups`).toBeGreaterThanOrEqual(1);

        mkdirSync(CAP_DIR, { recursive: true });
        writeFileSync(resolve(CAP_DIR, "m11_node_anim_t0.png"), cap0.buf);
        writeFileSync(resolve(CAP_DIR, "m11_node_anim_t1.png"), cap1.buf);

        const png0 = PNG.sync.read(cap0.buf);
        const png1 = PNG.sync.read(cap1.buf);

        // Both frames must render the models (non-blank).
        const m0 = nonBlankMetric(png0);
        const m1 = nonBlankMetric(png1);
        expect(m0.differingFraction > 0.01 || m0.stddev > 4, `m11_node_anim rendered blank at t0`).toBe(true);
        expect(m1.differingFraction > 0.01 || m1.stddev > 4, `m11_node_anim rendered blank at t1`).toBe(true);

        const diff = pixelDiffFraction(png0, png1);
        console.log(`[fbx-smoke] m11_node_anim: animationGroupCount=${cap0.result.animationGroupCount} t0-vs-t1 diff=${(diff * 100).toFixed(2)}%`);

        // The node animation must move enough geometry to change > 1% of pixels.
        expect(diff, `m11_node_anim did not visibly move between t0 and t1 (diff=${(diff * 100).toFixed(2)}%)`).toBeGreaterThan(0.01);
    });

    test("m12_skeletal_anim builds a bone skeleton + bone-driving animation group and renders non-blank", async ({ page }) => {
        // m12 declares a skin deformer AND animation curves that drive its bones.
        // Visual skinning deformation needs a Standard-pipeline skeleton change that
        // is currently shelved (ceiling-blocked), so the mesh renders at its bind
        // pose here. Contract for this clean-tree smoke: the loader builds the bone
        // skeleton + bone-driving AnimationGroup, and both the rest frame and the
        // seeked frame render (non-blank) without error. (The deformation itself is
        // validated separately with the shelved engine patch applied.)
        const cap0 = await loadModelAtTime(page, "m12_skeletal_anim", 0);
        const midTime = Math.max(0.25, (cap0.result.animationDurationSec || 2) * 0.5);
        const capMid = await loadModelAtTime(page, "m12_skeletal_anim", midTime);

        expect(cap0.result.error, `m12_skeletal_anim reported an error at rest: ${cap0.result.error}`).toBeFalsy();
        expect(capMid.result.error, `m12_skeletal_anim reported an error when seeked: ${capMid.result.error}`).toBeFalsy();
        expect(cap0.result.meshCount, `m12_skeletal_anim produced no meshes`).toBeGreaterThanOrEqual(1);
        expect(cap0.result.skeletonBoneCount, `m12_skeletal_anim built no skeleton bones`).toBeGreaterThan(0);
        expect(cap0.result.animationGroupCount, `m12_skeletal_anim built no animation groups`).toBeGreaterThanOrEqual(1);

        // Persist rest + seeked frames for eyeballing the deformation.
        mkdirSync(CAP_DIR, { recursive: true });
        writeFileSync(resolve(CAP_DIR, "m12_rest.png"), cap0.buf);
        writeFileSync(resolve(CAP_DIR, "m12_skeletal_anim.png"), capMid.buf);

        const png0 = PNG.sync.read(cap0.buf);
        const pngMid = PNG.sync.read(capMid.buf);

        // Both frames must render the mesh (non-blank).
        const m0 = nonBlankMetric(png0);
        const mMid = nonBlankMetric(pngMid);
        expect(m0.differingFraction > 0.01 || m0.stddev > 4, `m12_skeletal_anim rendered blank at rest`).toBe(true);
        expect(mMid.differingFraction > 0.01 || mMid.stddev > 4, `m12_skeletal_anim rendered blank when seeked`).toBe(true);

        const diff = pixelDiffFraction(png0, pngMid);
        console.log(
            `[fbx-smoke] m12_skeletal_anim: skeletonBoneCount=${cap0.result.skeletonBoneCount} animationGroupCount=${cap0.result.animationGroupCount} durationSec=${cap0.result.animationDurationSec} midTime=${midTime.toFixed(3)} rest-vs-mid diff=${(diff * 100).toFixed(2)}%`
        );

        // NOTE: visual deformation (diff > 0) requires the shelved Standard-pipeline
        // skeleton engine patch; on the clean tree the skinned mesh renders at bind
        // pose, so `diff` is ~0 here. We only assert the machinery + non-blank above.
        void diff;
    });

    test("m13_morph_anim builds an animation group over morph targets and renders non-blank", async ({ page }) => {
        // m13 declares blend shapes AND a DeformPercent curve that animates their
        // weights. Visual morph deformation needs a later engine change, so the
        // mesh renders at its base pose here — the contract is that the loader
        // builds the morph targets AND the PATH_WEIGHTS AnimationGroup machinery
        // without erroring, and the mesh is present (non-blank).
        const { result, png } = await loadModel(page, "m13_morph_anim");

        expect(result.error, `m13_morph_anim reported an error: ${result.error}`).toBeFalsy();
        expect(result.meshCount, `m13_morph_anim produced no meshes`).toBeGreaterThanOrEqual(1);
        expect(result.morphTargetCount, `m13_morph_anim produced no morph targets`).toBeGreaterThanOrEqual(1);
        expect(result.animationGroupCount, `m13_morph_anim built no animation groups`).toBeGreaterThanOrEqual(1);

        const { differingFraction, stddev } = nonBlankMetric(png);
        console.log(
            `[fbx-smoke] m13_morph_anim: meshCount=${result.meshCount} morphTargetCount=${result.morphTargetCount} animationGroupCount=${result.animationGroupCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`
        );

        const nonBlank = differingFraction > 0.01 || stddev > 4;
        expect(nonBlank, `m13_morph_anim rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
    });

    test("m14_multiclip exposes one AnimationGroup per animation stack (>= 2) and renders non-blank", async ({ page }) => {
        // m14 declares multiple AnimationStacks, each of which must become its own
        // AnimationGroup (multi-clip). Assert >= 2 groups and a present (non-blank) scene.
        const { result, png } = await loadModel(page, "m14_multiclip");

        expect(result.error, `m14_multiclip reported an error: ${result.error}`).toBeFalsy();
        expect(result.meshCount, `m14_multiclip produced no meshes`).toBeGreaterThanOrEqual(1);
        expect(result.animationGroupCount, `m14_multiclip did not emit one group per stack (animationGroupCount=${result.animationGroupCount})`).toBeGreaterThanOrEqual(2);

        const { differingFraction, stddev } = nonBlankMetric(png);
        console.log(
            `[fbx-smoke] m14_multiclip: meshCount=${result.meshCount} animationGroupCount=${result.animationGroupCount} differingFraction=${(differingFraction * 100).toFixed(2)}% stddev=${stddev.toFixed(2)}`
        );

        const nonBlank = differingFraction > 0.01 || stddev > 4;
        expect(nonBlank, `m14_multiclip rendered blank (differingFraction=${differingFraction.toFixed(4)}, stddev=${stddev.toFixed(2)})`).toBe(true);
    });
});
