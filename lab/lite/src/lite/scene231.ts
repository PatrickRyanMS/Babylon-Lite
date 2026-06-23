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
// NOTE: vertex color currently misaligns through the glb path — the glTF loader emits a tight
// float32x4 (RGBA) color buffer but the Standard vcolor StdExt (ported for FBX) expects float32x3
// (RGB). See docs/lite/scene231-standard-features.md ("vertex-color stride mismatch"). Skeleton,
// morph, and UV offset work; vcolor needs the unification fix before it renders correctly.

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
// Grid texture so the Standard material's uvOffset is visually obvious.
const TEXTURE_URL = "https://playground.babylonjs.com/textures/grid.png";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(window.location.search);
    const capture = params.has("capture");

    if (capture) {
        canvas.width = 600;
        canvas.height = 400;
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
    addToScene(scene, container);

    const diffuse = await loadTexture2D(engine, TEXTURE_URL);

    // Replace each loaded mesh's (PBR) material with a Standard material carrying a diffuse texture
    // + a non-zero UV offset, so the render goes through the Standard feature dispatch.
    for (const mesh of getContainerMeshes(container)) {
        const mat = createStandardMaterial();
        mat.diffuseTexture = diffuse;
        mat.uvOffset = [0.25, 0.1];
        mat.backFaceCulling = false; // tube + caps: show both sides
        mesh.material = mat;
    }

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
