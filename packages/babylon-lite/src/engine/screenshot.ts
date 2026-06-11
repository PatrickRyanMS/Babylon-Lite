import type { EngineContext } from "./engine.js";
import { BU } from "./gpu-flags.js";

/**
 * A captured frame, read back from the canvas swapchain.
 *
 * `data` is tightly-packed RGBA8 (4 bytes/pixel), row-major, top row first — the same
 * layout `ImageData` expects, so it can be handed straight to a 2D canvas:
 *
 * ```ts
 * const shot = await captureScreenshot(engine);
 * const cv = new OffscreenCanvas(shot.width, shot.height);
 * cv.getContext("2d")!.putImageData(new ImageData(shot.data, shot.width, shot.height), 0, 0);
 * const url = await cv.convertToBlob({ type: "image/jpeg", quality: 0.85 });
 * ```
 *
 * Alpha is forced to 255 (fully opaque): the swapchain is presented opaque, so its alpha
 * channel is not meaningful for a saved image. Colours are the final, presented 8-bit
 * values (BGRA swizzled to RGBA when the preferred canvas format is BGRA).
 */
export interface Screenshot {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

/** @internal A single readback in flight: the buffer the frame's copy lands in, plus the
 *  dimensions/padding needed to unpack it, and the requests waiting on this frame. */
interface PendingReadback {
    buffer: GPUBuffer;
    width: number;
    height: number;
    bytesPerRow: number;
    bgra: boolean;
    reqs: ReadonlyArray<{ resolve: (s: Screenshot) => void; reject: (e: unknown) => void }>;
}

/** copyTextureToBuffer requires the per-row stride to be a multiple of 256 bytes. */
function alignBytesPerRow(width: number): number {
    return Math.ceil((width * 4) / 256) * 256;
}

/**
 * Capture the current canvas backbuffer (the final presented frame — post-processing and
 * all — with NO HTML/DOM overlay, since those are never drawn into the canvas).
 *
 * The read is scheduled on the next rendered frame: the copy is recorded into that frame's
 * command encoder (so it reads a valid, just-rendered swapchain texture), then the staging
 * buffer is mapped after submit and the pixels are unpacked. Requires a running render loop
 * (`startEngine`); the returned promise resolves once the readback completes.
 *
 * Multiple calls queued before the next frame share a single GPU copy and all resolve with
 * the same image.
 */
export function captureScreenshot(engine: EngineContext): Promise<Screenshot> {
    return new Promise<Screenshot>((resolve, reject) => {
        (engine._captureQueue ??= []).push({ resolve, reject });
    });
}

/** @internal Called from `renderFrame` after the contexts have recorded (so the swapchain
 *  texture holds this frame) and before the encoder is finished. Records one copy of the
 *  current swapchain texture into a fresh MAP_READ staging buffer and returns the pending
 *  readback, or null when nothing is queued. */
export function _serviceCaptureQueue(engine: EngineContext, encoder: GPUCommandEncoder): PendingReadback | null {
    const queue = engine._captureQueue;
    if (!queue || queue.length === 0) {
        return null;
    }
    engine._captureQueue = undefined;

    const tex = engine.scRT._colorTexture;
    if (!tex) {
        const err = new Error("captureScreenshot: no swapchain texture available");
        for (const r of queue) {
            r.reject(err);
        }
        return null;
    }
    const width = engine.scRT._width;
    const height = engine.scRT._height;
    const bytesPerRow = alignBytesPerRow(width);
    const buffer = engine._device.createBuffer({
        label: "screenshot-readback",
        size: bytesPerRow * height,
        usage: BU.COPY_DST | BU.MAP_READ,
    });
    encoder.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
    return { buffer, width, height, bytesPerRow, bgra: engine.format.startsWith("bgra"), reqs: queue };
}

/** @internal Called from `renderFrame` after the frame's commands are submitted. Maps the
 *  staging buffer, unpacks it into tightly-packed opaque RGBA8, and resolves the waiting
 *  requests. Fire-and-forget: the map is async and resolves the promises later. */
export async function _finishCapture(pend: PendingReadback): Promise<void> {
    const { buffer, width, height, bytesPerRow, bgra, reqs } = pend;
    try {
        await buffer.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(buffer.getMappedRange());
        const out = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            const srcRow = y * bytesPerRow;
            const dstRow = y * width * 4;
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 4;
                const d = dstRow + x * 4;
                if (bgra) {
                    out[d] = src[s + 2]!;
                    out[d + 1] = src[s + 1]!;
                    out[d + 2] = src[s]!;
                } else {
                    out[d] = src[s]!;
                    out[d + 1] = src[s + 1]!;
                    out[d + 2] = src[s + 2]!;
                }
                out[d + 3] = 255;
            }
        }
        buffer.unmap();
        buffer.destroy();
        const shot: Screenshot = { width, height, data: out };
        for (const r of reqs) {
            r.resolve(shot);
        }
    } catch (e) {
        try {
            buffer.destroy();
        } catch {
            /* already destroyed */
        }
        for (const r of reqs) {
            r.reject(e);
        }
    }
}
