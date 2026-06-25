import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

/**
 * Scene 231 — Standard Material Features visual parity (Lite-native, self-generated golden).
 *
 * Loads a generated glb whose single tube mesh carries skinning (a posed bone bend), a morph
 * target (default weight 1.0 bulge), float32x4 RGBA vertex colors, and UVs, then renders it with
 * Lite STANDARD materials (diffuse grid texture + non-zero uvOffset) — exercising the net-neutral
 * Standard feature dispatch (enableStandardSkeleton/Morph/VertexColor/UvOffset).
 *
 * This is new Lite feature work: there is NO Babylon.js reference to diff against, so the scene
 * generates its OWN ground-truth golden (the same convention as captureGolden's skip-if-exists).
 * The committed golden lives at reference/lite/scene231-standard-features/babylon-ref-golden.png;
 * the test diffs future renders against it to catch regressions, so MAD should stay ~0. Regenerate
 * with RECAPTURE_GOLDEN=true.
 */

const sceneConfig = getSceneConfig(231);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene231-standard-features");

test.skip(!!sceneConfig.skipParity, "Scene 231 skipped via skipParity in scene-config.json");

test("Scene 231 - Standard material features matches the committed Lite golden", async ({ page }, testInfo) => {
    const goldenRef = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

    await page.goto(`/scene231.html?capture=1`);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(200);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });
    await page.locator("canvas").screenshot({ path: screenshotPath });

    // Lite-native ground truth: create the golden on first run (or when RECAPTURE_GOLDEN is set),
    // then diff every subsequent render against the committed image.
    if (!fs.existsSync(goldenRef) || process.env.RECAPTURE_GOLDEN) {
        fs.copyFileSync(screenshotPath, goldenRef);
    }

    const full = compareImages(screenshotPath, goldenRef);
    await attachCompareArtifacts(testInfo, screenshotPath, goldenRef, REFERENCE_DIR);

    const pctChanged = (100 * (full.totalPixels - full.within5)) / full.totalPixels;
    console.log(`Scene 231: MAD=${full.mad.toFixed(3)} %chg>5=${pctChanged.toFixed(2)}% maxDiff=${full.maxDiff} (<= ${sceneConfig.maxMad})`);

    expect(full.mad, `Scene 231 MAD should be <= ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
