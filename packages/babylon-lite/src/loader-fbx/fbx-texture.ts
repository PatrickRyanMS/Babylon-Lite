/**
 * FBX texture resolution — turns an {@link FBXTextureRef} into a {@link Texture2D}.
 *
 * Two sources are supported:
 *  - **Embedded.** A connected `Video` node carries the raw image bytes
 *    (`embeddedData`). The bytes are wrapped in a `Blob`, exposed through a
 *    temporary `blob:` object URL, decoded by {@link loadTexture2D}, and the URL
 *    is revoked once the upload resolves.
 *  - **External.** The texture lives next to the FBX file. Candidate URLs are
 *    derived from `relativeFileName`/`fileName` (preserving a local relative
 *    path, the `<name>.fbm/` embedded-media folder, and a bare-basename
 *    fallback), each tried with the original plus a small set of alternate
 *    image extensions until one decodes.
 *
 * Returns `null` (rather than throwing) when no candidate decodes, so a single
 * missing texture never aborts the whole model load.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { loadTexture2D } from "../texture/texture-2d.js";

import type { FBXTextureRef } from "./interpreter/materials.js";

/** Options controlling how an FBX texture reference is decoded. */
export interface ResolveFbxTextureOptions {
    /** Decode into an sRGB format (color textures) vs linear (normal/data). */
    srgb: boolean;
    /** Upload-time V flip. Default true (BJS Y-up raster convention). */
    invertY?: boolean;
    /** Optional `<name>.fbm/` embedded-media directory for external sidecars. */
    fbmDir?: string;
}

/** Image extensions tried when the referenced file fails to decode (BJS parity). */
const ALT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"] as const;

/** Last path segment of a (forward-slash-normalized) path. */
function baseName(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/** A path is "local" if it can be appended to the FBX directory without escaping
 *  it: not absolute, not a Windows drive path, and not a parent-relative path. */
function looksLocal(path: string): boolean {
    return path.length > 0 && !path.startsWith("/") && !path.startsWith("..") && !/^[a-zA-Z]:/.test(path);
}

/** Build the ordered list of external candidate URLs for a texture reference. */
function buildExternalCandidates(texRef: FBXTextureRef, baseUrl: string, fbmDir: string | undefined): string[] {
    const rel = texRef.relativeFileName ? texRef.relativeFileName.replace(/\\/g, "/") : "";
    const file = texRef.fileName ? texRef.fileName.replace(/\\/g, "/") : "";
    const relBase = baseName(rel);
    const fileBase = baseName(file);

    const primary: string[] = [];
    const push = (url: string): void => {
        if (url && !primary.includes(url)) {
            primary.push(url);
        }
    };

    // Preserve a local relative path under the FBX directory.
    if (looksLocal(rel)) {
        push(baseUrl + rel);
    }
    // Embedded-media sidecar folder (FBX SDK extracts embedded images here).
    if (fbmDir) {
        push(fbmDir + relBase);
        push(fbmDir + fileBase);
    }
    // Bare basename directly under the FBX directory.
    push(baseUrl + relBase);
    push(baseUrl + fileBase);

    // Expand each candidate with alternate image extensions.
    const candidates: string[] = [];
    const pushAlt = (url: string): void => {
        if (url && !candidates.includes(url)) {
            candidates.push(url);
        }
    };
    for (const url of primary) {
        pushAlt(url);
        const slash = url.lastIndexOf("/");
        const dot = url.lastIndexOf(".");
        if (dot > slash) {
            const stem = url.slice(0, dot);
            for (const ext of ALT_EXTENSIONS) {
                pushAlt(`${stem}.${ext}`);
            }
        }
    }
    return candidates;
}

/**
 * Resolve an FBX texture reference to a {@link Texture2D}, or `null` if it cannot
 * be loaded from any source.
 *
 * @param engine - Engine context (GPU device).
 * @param texRef - Texture reference extracted from the FBX material.
 * @param baseUrl - Directory of the FBX file (trailing slash included).
 * @param opts - Decode options (sRGB, invertY, `.fbm` sidecar folder).
 */
export async function resolveFbxTexture(engine: EngineContext, texRef: FBXTextureRef, baseUrl: string, opts: ResolveFbxTextureOptions): Promise<Texture2D | null> {
    const srgb = opts.srgb;
    const invertY = opts.invertY ?? true;

    // Embedded image bytes: wrap in a transient blob URL, decode, then revoke.
    if (texRef.embeddedData && texRef.embeddedData.length > 0) {
        const blobUrl = URL.createObjectURL(new Blob([texRef.embeddedData as BlobPart]));
        try {
            return await loadTexture2D(engine, blobUrl, { srgb, invertY });
        } catch {
            return null;
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    // External: try each candidate until one decodes.
    for (const url of buildExternalCandidates(texRef, baseUrl, opts.fbmDir)) {
        try {
            return await loadTexture2D(engine, url, { srgb, invertY });
        } catch {
            // Try the next candidate.
        }
    }
    return null;
}
