/**
 * One-off generator for the billboard sprite atlas used by scenes 34-36.
 *
 * Produces a deterministic 192×64 RGBA PNG with three 64×64 cells:
 *   0: glow disc       — radial white→transparent gradient (scene 34)
 *   1: tree silhouette — dark green triangle + brown trunk (scene 35)
 *   2: flag/banner     — solid colored rect with a horizontal stripe (scene 36)
 *
 * Output: lab/public/sprites/billboards/atlas.png
 *
 * Generated once and committed. Both the BJS reference and Lite scene paths
 * fetch the same URL so the atlas bytes are bit-exact identical — no
 * canvas2D float-rounding noise leaks into the parity diff.
 *
 * Usage: pnpm tsx scripts/build-billboard-atlas.ts
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../lab/public/sprites/billboards/atlas.png");

const CELL = 64;
const COLS = 3;
const ROWS = 1;
const W = CELL * COLS; // 192
const H = CELL * ROWS; // 64

const png = new PNG({ width: W, height: H });

function setPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || x >= W || y < 0 || y >= H) {
        return;
    }
    const i = (y * W + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
}

function fillRect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            setPx(x, y, r, g, b, a);
        }
    }
}

// All pixels start transparent.
fillRect(0, 0, W, H, 0, 0, 0, 0);

// Helper: write a pixel into a cell using top-down "as displayed" coordinates,
// then flip Y on output. The Lite billboard renderable samples the atlas with
// the source-PNG-Y-up convention (V=0 → corner.y=0 → world bottom-up direction),
// so authoring content with a flip-on-write keeps the rendered sprite upright.
// (Anchored sprite layers don't have this flip — they're a separate convention.)
function setPxFlipped(x: number, y: number, r: number, g: number, b: number, a: number): void {
    setPx(x, H - 1 - y, r, g, b, a);
}
function fillRectFlipped(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            setPxFlipped(x, y, r, g, b, a);
        }
    }
}

// ── Cell 0 — glow disc ───────────────────────────────────────────────
{
    const ox = 0;
    const cx = ox + CELL / 2;
    const cy = H / 2;
    const radius = CELL / 2 - 1;
    for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
            const dx = x + ox - cx;
            const dy = y - cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            const t = Math.max(0, 1 - d / radius);
            // Smooth falloff (t^2) for a soft glow. Symmetric, so flip is a no-op.
            const a = Math.round(255 * t * t);
            if (a > 0) {
                setPxFlipped(x + ox, y, 255, 245, 210, a);
            }
        }
    }
}

// ── Cell 1 — tree silhouette ─────────────────────────────────────────
{
    const ox = CELL;
    // Dark green canopy as a single isoceles triangle (apex up in the
    // displayed sprite).
    const apexX = ox + CELL / 2;
    const apexY = 6;
    const baseY = 50;
    const baseHalfW = 24;
    for (let y = apexY; y < baseY; y++) {
        const t = (y - apexY) / (baseY - apexY);
        const halfW = Math.round(t * baseHalfW);
        for (let x = apexX - halfW; x <= apexX + halfW; x++) {
            setPxFlipped(x, y, 30, 95, 45, 255);
        }
    }
    // Brown trunk rectangle below the canopy.
    fillRectFlipped(ox + CELL / 2 - 4, baseY, ox + CELL / 2 + 4, 62, 110, 70, 35, 255);
}

// ── Cell 2 — flag / banner ───────────────────────────────────────────
{
    const ox = CELL * 2;
    // Filled colored rect with a 1-px transparent border for clean edges.
    const x0 = ox + 6;
    const x1 = ox + CELL - 6;
    const y0 = 8;
    const y1 = CELL - 8;
    fillRectFlipped(x0, y0, x1, y1, 200, 60, 60, 255);
    // Off-white horizontal stripe across the middle third.
    const sy0 = y0 + Math.round(((y1 - y0) * 2) / 5);
    const sy1 = y0 + Math.round(((y1 - y0) * 3) / 5);
    fillRectFlipped(x0, sy0, x1, sy1, 245, 240, 220, 255);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, PNG.sync.write(png));
console.log(`Wrote ${OUT} (${W}×${H})`);
