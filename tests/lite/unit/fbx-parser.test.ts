import { describe, it, expect } from "vitest";
import { deflateSync } from "zlib";
import { parseBinaryFBX } from "../../../packages/babylon-lite/src/loader-fbx/parsers/fbx-binary-parser.js";
import { parseAsciiFBX } from "../../../packages/babylon-lite/src/loader-fbx/parsers/fbx-ascii-parser.js";
import { inflateZlib } from "../../../packages/babylon-lite/src/loader-fbx/parsers/zlib-inflate.js";
import { findChildByName, findChildrenByName, findDocumentNode } from "../../../packages/babylon-lite/src/loader-fbx/types/fbx-types.js";
import type { FBXNode } from "../../../packages/babylon-lite/src/loader-fbx/types/fbx-types.js";
import { FBX_MODEL_FILES, fbxAssetsAvailable, readFbxModel } from "../fbx-assets";

const BINARY_MAGIC = "Kaydara FBX Binary";

/** Copy bytes into a standalone ArrayBuffer that exactly matches the file bytes. */
function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
}

function isBinaryFbx(buf: Uint8Array): boolean {
    return Buffer.from(buf.subarray(0, BINARY_MAGIC.length)).toString("latin1").startsWith(BINARY_MAGIC);
}

/** Walk the document depth-first, collecting every node with the given name. */
function collectNodes(nodes: readonly FBXNode[], name: string, out: FBXNode[] = []): FBXNode[] {
    for (const node of nodes) {
        if (node.name === name) {
            out.push(node);
        }
        collectNodes(node.children, name, out);
    }
    return out;
}

// Skip ONLY when there is neither a local Assets checkout NOR network (explicit OFFLINE=1);
// otherwise the models come from the local checkout or the Babylon CDN.
const SKIP_REAL = !fbxAssetsAvailable && process.env.OFFLINE === "1";

describe.skipIf(SKIP_REAL)("fbx parser — real models (local checkout or Babylon CDN)", () => {
    for (const name of FBX_MODEL_FILES) {
        it(`parses ${name} into a non-empty document`, async () => {
            const bytes = await readFbxModel(name);
            // The shipped m01–m16 corpus is binary FBX; ASCII routing is covered by the hand-built test below.
            expect(isBinaryFbx(bytes)).toBe(true);
            const doc = parseBinaryFBX(toArrayBuffer(bytes));

            expect(doc.version).toBeGreaterThanOrEqual(7000);
            expect(doc.nodes.length).toBeGreaterThan(0);

            const topLevel = new Set(doc.nodes.map((n) => n.name));
            const hasCoreSection = topLevel.has("Objects") || topLevel.has("Definitions") || topLevel.has("FBXHeaderExtension");
            expect(hasCoreSection).toBe(true);
        });
    }

    it("decompresses zlib-encoded geometry arrays from a real model (exercises inflate end-to-end)", async () => {
        // m03/m04 are the largest meshes in the corpus and store their geometry arrays zlib-encoded.
        // If the deflate decoder were broken, parsing would throw (adler32 / length mismatch) before we get here.
        let checkedVertices = false;
        for (const name of ["m03_normals.fbx", "m04_material_properties.fbx"]) {
            const doc = parseBinaryFBX(toArrayBuffer(await readFbxModel(name)));

            const geometries = collectNodes(doc.nodes, "Geometry");
            expect(geometries.length).toBeGreaterThan(0);

            for (const geom of geometries) {
                const vertices = findChildByName(geom, "Vertices");
                if (!vertices || vertices.properties.length === 0) {
                    continue;
                }
                const value = vertices.properties[0]!.value;
                expect(ArrayBuffer.isView(value)).toBe(true);
                const verts = value as Float64Array | Float32Array;
                // A valid vertex array is a non-empty, xyz-triplet list of finite floats.
                expect(verts.length).toBeGreaterThan(0);
                expect(verts.length % 3).toBe(0);
                expect(Number.isFinite(verts[0]!)).toBe(true);

                const indices = findChildByName(geom, "PolygonVertexIndex");
                if (indices && indices.properties.length > 0) {
                    const idx = indices.properties[0]!.value as Int32Array;
                    expect(ArrayBuffer.isView(idx)).toBe(true);
                    expect(idx.length).toBeGreaterThan(0);
                }
                checkedVertices = true;
            }
        }
        expect(checkedVertices).toBe(true);
    });
});

describe("zlib-inflate — deterministic round-trip", () => {
    it("inflates a zlib stream produced by Node's deflate (literals + back-references)", () => {
        let text = "";
        for (let i = 0; i < 64; i++) {
            text += "The quick brown fox jumps over the lazy dog. ";
        }
        const original = new TextEncoder().encode(text);
        const compressed = deflateSync(Buffer.from(original)); // zlib-wrapped deflate
        // The compressed stream must actually be smaller (so back-references are exercised).
        expect(compressed.byteLength).toBeLessThan(original.byteLength);

        const inflated = inflateZlib(new Uint8Array(compressed), original.byteLength);
        expect(inflated.byteLength).toBe(original.byteLength);
        expect(Buffer.from(inflated).equals(Buffer.from(original))).toBe(true);
    });

    it("rejects a stream whose declared length does not match", () => {
        const compressed = deflateSync(Buffer.from(new Uint8Array([1, 2, 3, 4])));
        expect(() => inflateZlib(new Uint8Array(compressed), 3)).toThrow();
    });
});

describe("fbx ascii parser — hand-built document", () => {
    const ASCII_FBX = [
        "; FBX 7.4.0 project file",
        "; ----------------------------------------------------",
        "",
        "FBXHeaderExtension:  {",
        "    FBXHeaderVersion: 1003",
        "    FBXVersion: 7400",
        '    Creator: "Babylon Lite Test"',
        "}",
        "Definitions:  {",
        "    Version: 100",
        "    Count: 1",
        "}",
        "Objects:  {",
        '    Geometry: 140724, "Geometry::Cube", "Mesh" {',
        "        Vertices: *9 {",
        "            a: 0,0,0,1,0,0,0,1,0",
        "        }",
        "        PolygonVertexIndex: *3 {",
        "            a: 0,1,2",
        "        }",
        "    }",
        "}",
    ].join("\n");

    it("parses a minimal ASCII FBX header, version and nested nodes", () => {
        const doc = parseAsciiFBX(ASCII_FBX);
        expect(doc.version).toBe(7400);

        const header = findDocumentNode(doc, "FBXHeaderExtension");
        expect(header).toBeDefined();
        const creator = findChildByName(header!, "Creator");
        expect(creator?.properties[0]?.value).toBe("Babylon Lite Test");

        const objects = findDocumentNode(doc, "Objects");
        expect(objects).toBeDefined();
        const geometries = findChildrenByName(objects!, "Geometry");
        expect(geometries.length).toBe(1);

        const vertices = findChildByName(geometries[0]!, "Vertices");
        expect(vertices).toBeDefined();
        const value = vertices!.properties[0]!.value as Float64Array;
        expect(value).toBeInstanceOf(Float64Array);
        expect(Array.from(value)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    });
});
