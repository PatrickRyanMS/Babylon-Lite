import { test, expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import * as path from "path";
import { attachCompareArtifacts, captureGolden, compareImages, generateDiffMap, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(73);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene73-wheel-nme-viewport");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const BUNDLE_VS_SOURCE_MAX_MAD = 0.01;

test.skip(!!sceneConfig.skipParity, "Scene 73 skipped via skipParity in scene-config.json");
test.setTimeout(180_000);

async function captureScene73(page: Page, url: string, screenshotPath: string): Promise<string> {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 60_000 });
    await page.waitForTimeout(500);

    await page.locator("canvas").screenshot({ path: screenshotPath });
    return screenshotPath;
}

async function expectScene73MatchesReference(page: Page, testInfo: TestInfo, url: string, actualName: string) {
    const screenshotPath = await captureScene73(page, url, path.join(REFERENCE_DIR, actualName));

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
}

test("Scene 73 — CarbonFiberWheel PBR vs NME viewports matches Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 73, timeout: 60_000, settleMs: 1500 });

    await expectScene73MatchesReference(page, testInfo, "/scene73.html", "test-actual.png");
});

test("Scene 73 — bundled CarbonFiberWheel PBR vs NME viewports matches source output", async ({ page }, testInfo) => {
    const sourcePath = await captureScene73(page, "/scene73.html", testInfo.outputPath("source.png"));
    const bundlePath = await captureScene73(page, "/bundle-scene73.html", testInfo.outputPath("bundled.png"));

    const full = compareImages(bundlePath, sourcePath);
    const diffPath = testInfo.outputPath("diff-map.png");
    generateDiffMap(bundlePath, sourcePath, diffPath);
    await testInfo.attach("bundle", { path: bundlePath, contentType: "image/png" });
    await testInfo.attach("source", { path: sourcePath, contentType: "image/png" });
    await testInfo.attach("diff-map", { path: diffPath, contentType: "image/png" });
    console.log(`Bundle-vs-source MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Bundled output MAD should be ≤ ${BUNDLE_VS_SOURCE_MAX_MAD} vs source output`).toBeLessThanOrEqual(BUNDLE_VS_SOURCE_MAX_MAD);
});
