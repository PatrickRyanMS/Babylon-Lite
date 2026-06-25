// Scene 231 — Standard Material Features (skeleton / morph / vertex color / UV offset)
//
// New Lite feature work (no Babylon.js reference). Loads a generated glb whose single tube mesh
// carries skinning (posed bone bend), a morph target (default weight 1.0 bulge), vertex colors, and
// UVs, then renders it with Lite STANDARD materials — exercising the new Standard-material feature
// dispatch (enableStandard*). Self-generates its own ground-truth golden (see the parity spec).
//
// Default: interactive (ArcRotate + mouse). `?capture=1`: deterministic 600×400 fixed-camera render
// for the golden (mirrors scene230).
//
// All four features render through the glb→Standard path: the glTF loader sets the skeleton, morph
// targets, and a float32x4 (RGBA) color buffer material-agnostically; the shared `_computeMeshFeatures`
// surfaces them to whichever material family the mesh uses, and the net-neutral Standard feature
// dispatch (enableStandard*) consumes them. Vertex color now aligns because the Standard vcolor StdExt
// was unified to the engine-wide float32x4 RGBA layout (see docs/lite/scene231-standard-features.md).

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createDirectionalLight,
    loadGltf,
    loadTexture2D,
    getContainerMeshes,
    createStandardMaterial,
    attachControl,
    registerScene,
    enableStandardSkeleton,
    enableStandardMorph,
    enableStandardVertexColor,
    enableStandardUvOffset,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const ASSET_URL = "/test-assets/scene231-standard-features.glb";
// Local grid texture (committed alongside the glb) so the Standard material's uvOffset is visually
// obvious and the golden has zero network dependency.
const TEXTURE_URL = "/test-assets/scene231-grid.png";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(window.location.search);
    const capture = params.has("capture");

    if (capture) {
        canvas.width = 600;
        canvas.height = 400;
        canvas.style.width = "600px";
        canvas.style.height = "400px";
    }

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.12, g: 0.12, b: 0.14, a: 1.0 };

    // Opt the Standard material into the deform/vertex features this asset uses. These are
    // net-neutral when never called; here the scene is the "loader" driving the Standard path.
    enableStandardSkeleton();
    enableStandardMorph();
    enableStandardVertexColor();
    enableStandardUvOffset();

    const container = await loadGltf(engine, ASSET_URL);
    const diffuse = await loadTexture2D(engine, TEXTURE_URL);

    // Replace each loaded mesh's (PBR) material with a Standard material carrying a diffuse texture
    // + a non-zero UV offset, so the render goes through the Standard feature dispatch. This MUST
    // happen BEFORE addToScene: addToScene buckets each mesh under its material's group builder at
    // add time (mesh.material._buildGroup), so swapping to Standard first is what routes the mesh
    // through the Standard path. (A swap after the initial build would instead drain per-frame.)
    for (const mesh of getContainerMeshes(container)) {
        const mat = createStandardMaterial();
        mat.diffuseTexture = diffuse;
        mat.uvOffset = [0.25, 0.1];
        mat.backFaceCulling = false; // tube + caps: show both sides
        mesh.material = mat;
    }

    addToScene(scene, container);

    const cam = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.2, 6, { x: 0, y: 1.1, z: 0 });
    scene.camera = cam;
    if (!capture) {
        attachControl(cam as ArcRotateCamera, canvas, scene);
    }

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
    addToScene(scene, createDirectionalLight([-0.5, -1, -0.5], 0.9));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
