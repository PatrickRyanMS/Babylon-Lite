/**
 * Drift gate for the scene226 FBX parity goldens.
 *
 * Re-diffs our pinned goldens (reference/lite/scene226-fbx-loader/<model>/
 * babylon-ref-golden.png) against Babylon.js's current committed FBX visualization
 * reference images, so we are explicitly told when Babylon's golden-path renders
 * change upstream (otherwise a one-time copy could silently go stale and Lite could
 * "pass" parity against an outdated baseline).
 *
 *   pnpm check:fbx-goldens                  # vs the sibling ../Babylon.js checkout
 *   pnpm check:fbx-goldens -- --ref master  # vs raw.githubusercontent.com @ master
 *   BJS_REF_IMAGES_DIR=/path pnpm check:fbx-goldens
 *
 * This is NOT part of the deterministic parity run (which pins the local goldens).
 * It is a separate freshness check meant for a schedule (e.g. weekly CI) and for
 * whenever the pinned Babylon ref is bumped. Exits non-zero on any drift, dimension
 * mismatch, missing file, or local-integrity failure.
 *
 * Two independent signals are reported per model:
 *   - integrity : local golden's sha256 vs the manifest (did our copy get edited?)
 *   - drift     : local golden vs Babylon's current image  (did upstream change?)
 */
import { existsSync, readFileSync } from "node:fs";
import { comparePngMad, liteGoldenPath, readManifest, resolveBabylonSource, sha256 } from "./fbx-goldens-lib";

function parseRef(argv: string[]): string | undefined {
    const i = argv.indexOf("--ref");
    return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const manifest = readManifest();
    const threshold = manifest.driftThresholdMad;
    const ref = parseRef(process.argv.slice(2));
    const source = resolveBabylonSource({ ref });

    console.log(`Checking ${manifest.goldens.length} FBX goldens for drift`);
    console.log(`  pinned at:  ${manifest.syncedFromRef || "(unknown)"}${manifest.syncedFromCommit ? `  commit ${manifest.syncedFromCommit.slice(0, 10)}` : ""}`);
    console.log(`  comparing:  ${source.describe}${source.commit ? `  commit ${source.commit.slice(0, 10)}` : ""}`);
    console.log(`  threshold:  MAD <= ${threshold} (0-255)\n`);

    const problems: string[] = [];
    let worst = 0;

    for (const { model, source: src, sha256: recorded } of manifest.goldens) {
        const localPath = liteGoldenPath(model);
        if (!existsSync(localPath)) {
            console.log(`  ${model.padEnd(22)} MISSING local golden`);
            problems.push(`${model}: local golden missing (${localPath})`);
            continue;
        }
        const localBytes = readFileSync(localPath);

        // Integrity: did our committed copy change vs what the manifest recorded?
        const localHash = sha256(localBytes);
        const integrityOk = localHash === recorded;

        // Drift: does our copy still match Babylon's current reference image?
        let upstreamBytes: Buffer;
        try {
            upstreamBytes = await source.get(src);
        } catch (e) {
            console.log(`  ${model.padEnd(22)} ERROR fetching ${src}: ${(e as Error).message}`);
            problems.push(`${model}: could not read Babylon source ${src}`);
            continue;
        }
        const { mad, dims } = comparePngMad(localBytes, upstreamBytes);

        let status: string;
        if (mad === null) {
            status = `DIM MISMATCH ${dims}`;
            problems.push(`${model}: dimension mismatch (${dims})`);
        } else {
            worst = Math.max(worst, mad);
            const drift = mad > threshold;
            if (drift) {
                problems.push(`${model}: upstream drift MAD=${mad.toFixed(3)} > ${threshold}`);
            }
            if (!integrityOk) {
                problems.push(`${model}: local golden edited (sha256 != manifest)`);
            }
            status = `MAD=${mad.toFixed(3)} ${drift ? "DRIFTED" : "ok"}${integrityOk ? "" : "  [LOCAL EDITED]"}`;
        }
        console.log(`  ${model.padEnd(22)} ${status}`);
    }

    console.log(`\nworst drift MAD = ${worst.toFixed(3)} (threshold ${threshold})`);

    if (problems.length > 0) {
        console.error(`\n✖ ${problems.length} golden issue(s):`);
        for (const p of problems) {
            console.error(`  - ${p}`);
        }
        console.error(
            "\nBabylon's FBX reference renders appear to have changed (or a local golden was edited).\n" +
                "Review the differences, then run `pnpm sync:fbx-goldens` to re-pin the goldens and\n" +
                "re-run `pnpm test:parity` to confirm Babylon Lite still matches the new baseline."
        );
        process.exit(1);
    }

    console.log("\n✓ All FBX goldens are current with Babylon and intact.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
