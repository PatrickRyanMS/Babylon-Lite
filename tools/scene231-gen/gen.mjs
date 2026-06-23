// Generates scene231-standard-features.glb — a single skinned + morphed + vertex-colored,
// UV-mapped tube that exercises all four new Standard-material features in one mesh:
//   - SKELETON: 2 bones; the upper bone is posed (rotated ~40° about Z) so the tube bends.
//   - MORPH:    one target (radial bulge ~sin(v*PI)); default weight 1.0 so it is applied on load.
//   - VERTEX COLOR: COLOR_0 RGBA gradient (red at base -> blue at tip).
//   - UV:       cylindrical TEXCOORD_0 so the scene's Standard material can apply a uvOffset.
//
// The scene (scene231.ts) loads this, assigns Standard materials, calls the enableStandard* opt-ins,
// and renders. No Babylon reference exists (new Lite feature) -> the scene self-generates the golden.
//
// Run: node gen.mjs   (writes ../../lab/public/test-assets/scene231-standard-features.glb)
// Requires @gltf-transform/core (installed locally in this scratch dir).

import { Document, NodeIO } from "@gltf-transform/core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const R = 0.4; // tube radius
const H = 2.5; // tube height
const NSEG = 20; // segments around
const NY = 16; // segments along height
const BONE1_Y = 1.25; // mid bone bind height
const BONE1_DEG = 40; // posed bend of the upper bone (degrees about Z)

const positions = [];
const normals = [];
const uvs = [];
const colors = []; // RGBA
const joints = []; // VEC4 uint
const weights = []; // VEC4 float
const morphDeltas = []; // VEC3 position deltas
const indices = [];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ── Side surface: (NSEG+1) x (NY+1) grid (seam column duplicated for clean UVs) ──
for (let j = 0; j <= NY; j++) {
    const v = j / NY;
    const y = v * H;
    // bone1 weight ramps from 0 (below 0.6) to 1 (above 1.9)
    const w1 = clamp01((y - 0.6) / 1.3);
    const w0 = 1 - w1;
    // vertex color: red base -> blue tip
    const cr = lerp(1.0, 0.2, v);
    const cg = 0.25;
    const cb = lerp(0.2, 1.0, v);
    const bulge = Math.sin(v * Math.PI) * 0.35; // morph radial push, max at mid
    for (let i = 0; i <= NSEG; i++) {
        const a = (i / NSEG) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        positions.push(R * cx, y, R * cz);
        normals.push(cx, 0, cz);
        uvs.push(i / NSEG, v);
        colors.push(cr, cg, cb, 1.0);
        joints.push(0, 1, 0, 0);
        weights.push(w0, w1, 0, 0);
        morphDeltas.push(bulge * cx, 0, bulge * cz);
    }
}
const ringStride = NSEG + 1;
for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NSEG; i++) {
        const a = j * ringStride + i;
        const b = a + 1;
        const c = a + ringStride;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
    }
}

// ── Caps (bottom + top): center vertex + triangle fan ──
function addCap(yLevel, ny, normalY, vColor, flip) {
    const centerIdx = positions.length / 3;
    const w1 = clamp01((yLevel - 0.6) / 1.3);
    positions.push(0, yLevel, 0);
    normals.push(0, normalY, 0);
    uvs.push(0.5, 0.5);
    colors.push(vColor[0], vColor[1], vColor[2], 1.0);
    joints.push(0, 1, 0, 0);
    weights.push(1 - w1, w1, 0, 0);
    morphDeltas.push(0, 0, 0);
    const ringStart = ny * ringStride;
    for (let i = 0; i < NSEG; i++) {
        const r0 = ringStart + i;
        const r1 = ringStart + i + 1;
        if (flip) {
            indices.push(centerIdx, r1, r0);
        } else {
            indices.push(centerIdx, r0, r1);
        }
    }
}
addCap(0, 0, -1, [1.0, 0.25, 0.2], false); // bottom
addCap(H, NY, 1, [0.2, 0.25, 1.0], true); // top

// ── Build glTF ──
const doc = new Document();
const buffer = doc.createBuffer();

const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);

const posAcc = acc("VEC3", new Float32Array(positions));
const normAcc = acc("VEC3", new Float32Array(normals));
const uvAcc = acc("VEC2", new Float32Array(uvs));
const colAcc = acc("VEC4", new Float32Array(colors));
const jntAcc = acc("VEC4", new Uint8Array(joints));
const wgtAcc = acc("VEC4", new Float32Array(weights));
const morphAcc = acc("VEC3", new Float32Array(morphDeltas));
const idxAcc = doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer);

const morphTarget = doc.createPrimitiveTarget().setAttribute("POSITION", morphAcc);

const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", posAcc)
    .setAttribute("NORMAL", normAcc)
    .setAttribute("TEXCOORD_0", uvAcc)
    .setAttribute("COLOR_0", colAcc)
    .setAttribute("JOINTS_0", jntAcc)
    .setAttribute("WEIGHTS_0", wgtAcc)
    .setIndices(idxAcc)
    .addTarget(morphTarget);

const material = doc.createMaterial("standard-features-mat").setBaseColorFactor([0.8, 0.8, 0.8, 1]).setRoughnessFactor(1).setMetallicFactor(0);
prim.setMaterial(material);

const mesh = doc.createMesh("standardFeaturesTube").addPrimitive(prim).setWeights([1.0]);

// ── Skeleton: bone0 (root) -> bone1 (mid, posed) ──
const bone0 = doc.createNode("bone0").setTranslation([0, 0, 0]);
const r = (BONE1_DEG * Math.PI) / 180;
// Quaternion for rotation about Z by r:
const qz = [0, 0, Math.sin(r / 2), Math.cos(r / 2)];
const bone1 = doc.createNode("bone1").setTranslation([0, BONE1_Y, 0]).setRotation(qz);
bone0.addChild(bone1);

// Inverse bind matrices (column-major): bone0 = identity; bone1 = translate(0,-BONE1_Y,0)
// prettier-ignore
const ibm = new Float32Array([
    1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1,
    1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, -BONE1_Y, 0, 1,
]);
const ibmAcc = acc("MAT4", ibm);
const skin = doc.createSkin("rig").addJoint(bone0).addJoint(bone1).setSkeleton(bone0).setInverseBindMatrices(ibmAcc);

const meshNode = doc.createNode("standardFeaturesMesh").setMesh(mesh).setSkin(skin);

doc.createScene("scene").addChild(bone0).addChild(meshNode);

const glb = await new NodeIO().writeBinary(doc);
const outPath = resolve(__dirname, "../../lab/public/test-assets/scene231-standard-features.glb");
writeFileSync(outPath, Buffer.from(glb));
console.log(`Wrote ${outPath} (${glb.byteLength} bytes)`);
console.log(`verts=${positions.length / 3} tris=${indices.length / 3}`);
