import { test, expect } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

/**
 * Scene 230 — FBX loader visual parity.
 *
 * Renders each of the Babylon.js FBX loader's reference models in Lite (via the FBX
 * loader port) using the EXACT Babylon.js FBX visualization rig (lab/lite/src/lite/
 * scene230.ts, mirroring babylon-fbx render.mjs + viewConfig.mjs: 600×400, clear
 * (0.16,0.16,0.18), hemi 0.85 + directional 0.9, single-sided, per-model orbit +
 * radius*1.15, m15 through the FBX camera, animations seeked then framed) and MAD-diffs
 * each against the committed Babylon.js golden in
 * reference/lite/scene230-fbx-loader/<model>/babylon-ref-golden.png.
 *
 * Goldens are the committed Babylon.js renders (no BJS oracle is opened at runtime —
 * same convention as the animated scenes). Babylon Lite targets pixel parity with
 * Babylon, so with the identical rig most models land < 1.2 MAD (0-255 scale). The base
 * threshold comes from scene-config (getSceneConfig(230).maxMad); a few models with
 * documented engine gaps carry a per-model override below.
 */

const sceneConfig = getSceneConfig(230);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene230-fbx-loader");

test.skip(!!sceneConfig.skipParity, "Scene 230 skipped via skipParity in scene-config.json");

/** Per-model MAD ceilings that exceed the scene's base maxMad, with the reason.
 *  Everything not listed uses sceneConfig.maxMad. */
const MAD_OVERRIDES: Record<string, { maxMad: number; reason: string }> = {
    // Minor lighting/framing residual on the compact cube vs the WebGL golden.
    m01_cube_phong: { maxMad: 6, reason: "lighting/framing residual" },
    // Morph (m10/m13) and skinning (m09/m12) vertex deformation are both active in Standard;
    // each lands a small residual vs the WebGL golden (anti-aliasing/lighting on deformed edges).
    m09_skinning: { maxMad: 0.5, reason: "skinning deformation active; minor residual vs WebGL golden" },
    m10_morph: { maxMad: 1.0, reason: "morph deformation active; minor residual vs WebGL golden" },
    m12_skeletal_anim: { maxMad: 0.5, reason: "skinning deformation active; minor residual vs WebGL golden" },
    m13_morph_anim: { maxMad: 1.2, reason: "morph deformation active; minor residual vs WebGL golden" },
};

const MODELS = [
    "m01_cube_phong",
    "m02_geo_ngons",
    "m03_normals",
    "m04_material_properties",
    "m05_textures",
    "m06_uv_transform",
    "m07_multimaterial",
    "m08_transforms",
    "m09_skinning",
    "m10_morph",
    "m11_node_anim",
    "m12_skeletal_anim",
    "m13_morph_anim",
    "m14_multiclip",
    "m15_camera_lights",
    "m16_axis_yup",
    "m16_axis_zup",
    "m16_units_254",
];

test.describe("Scene 230 - FBX loader matches Babylon.js reference renders", () => {
    for (const model of MODELS) {
        test(model, async ({ page }, testInfo) => {
            const modelDir = path.join(REFERENCE_DIR, model);
            const goldenRef = path.join(modelDir, "babylon-ref-golden.png");

            await page.goto(`/scene230.html?model=${model}&capture=1`);
            await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
            const err = await page.evaluate(() => (window as unknown as { __parityError?: string }).__parityError);
            expect(err, `${model} render error: ${err}`).toBeFalsy();
            await page.waitForTimeout(200);

            const screenshotPath = path.join(modelDir, "test-actual.png");
            await page.locator("canvas").screenshot({ path: screenshotPath });

            const full = compareImages(screenshotPath, goldenRef);
            await attachCompareArtifacts(testInfo, screenshotPath, goldenRef, modelDir);

            const override = MAD_OVERRIDES[model];
            const maxMad = override?.maxMad ?? sceneConfig.maxMad;
            const pctChanged = (100 * (full.totalPixels - full.within5)) / full.totalPixels;
            console.log(
                `Scene 230 ${model}: MAD=${full.mad.toFixed(3)} %chg>5=${pctChanged.toFixed(2)}% maxDiff=${full.maxDiff} (<= ${maxMad}${override ? ` — ${override.reason}` : ""})`
            );

            expect(full.mad, `${model} MAD should be <= ${maxMad}`).toBeLessThanOrEqual(maxMad);
        });
    }
});
