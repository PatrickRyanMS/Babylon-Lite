/**
 * Refresh the scene230 FBX parity goldens from Babylon.js's committed FBX
 * visualization reference images, and update the provenance manifest.
 *
 *   pnpm sync:fbx-goldens                 # from the sibling ../Babylon.js checkout
 *   pnpm sync:fbx-goldens -- --ref master # from raw.githubusercontent.com @ master
 *   BJS_REF_IMAGES_DIR=/path pnpm sync:fbx-goldens
 *
 * This is the deliberate, reviewed "refresh" action (see GUIDANCE.md §2c — goldens
 * are immutable ground truth, regenerated only on explicit request). After syncing,
 * re-run `pnpm test:parity` to confirm Lite still matches the (possibly new) baseline.
 * Nothing is committed automatically.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    GOLDEN_MAP,
    MANIFEST_PATH,
    BJS_REPO,
    BJS_SOURCE_DIR,
    RAW_URL_BASE,
    DEFAULT_DRIFT_THRESHOLD_MAD,
    liteGoldenPath,
    resolveBabylonSource,
    sha256,
    type GoldenEntry,
    type GoldenManifest,
} from "./fbx-goldens-lib";

function parseRef(argv: string[]): string | undefined {
    const i = argv.indexOf("--ref");
    return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const ref = parseRef(process.argv.slice(2));
    const source = resolveBabylonSource({ ref });
    console.log(`Syncing ${GOLDEN_MAP.length} FBX goldens from ${source.describe}`);

    const goldens: GoldenEntry[] = [];
    let written = 0;
    let unchanged = 0;
    for (const [model, src] of GOLDEN_MAP) {
        const bytes = await source.get(src);
        const dest = liteGoldenPath(model);
        const hash = sha256(bytes);
        const prior = existsSync(dest) ? sha256(readFileSync(dest)) : null;
        if (prior === hash) {
            unchanged++;
        } else {
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, bytes);
            written++;
            console.log(`  updated  ${model.padEnd(22)} <- ${src} (${prior ? "changed" : "new"})`);
        }
        goldens.push({ model, source: src, sha256: hash });
    }

    const manifest: GoldenManifest = {
        $comment:
            "Provenance for the scene230 FBX parity goldens. Each babylon-ref-golden.png is an EXACT copy of Babylon.js's committed FBX visualization reference image. " +
            "Refresh with `pnpm sync:fbx-goldens`; detect upstream drift with `pnpm check:fbx-goldens`. Do not hand-edit.",
        babylonRepo: BJS_REPO,
        babylonSourceDir: BJS_SOURCE_DIR,
        rawUrlBase: RAW_URL_BASE,
        syncedFromRef: source.ref,
        syncedFromCommit: source.commit,
        syncedAt: new Date().toISOString(),
        driftThresholdMad: DEFAULT_DRIFT_THRESHOLD_MAD,
        goldens,
    };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4) + "\n");

    console.log(`\n${written} golden(s) written, ${unchanged} unchanged.`);
    console.log(`Manifest updated: ${MANIFEST_PATH}`);
    console.log(`  babylon ref:    ${source.ref || "(unknown)"}${source.commit ? `  commit ${source.commit.slice(0, 10)}` : ""}`);
    if (written > 0) {
        console.log("\nGoldens changed — re-run `pnpm test:parity` to verify Lite still matches the new baseline.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
