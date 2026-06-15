/** Scene 226 — FBX Loader (visual-parity render).
 *
 *  Reproduces the Babylon.js FBX visualization rig (babylon-fbx render.mjs +
 *  viewConfig.mjs) so a Lite render can be MAD-diffed against the committed
 *  Babylon.js reference PNGs (`reference/lite/scene226-fbx-loader/<model>/`).
 *  Rendered by `tests/lite/parity/scenes/scene226-fbx-loader.spec.ts`.
 *
 *  Deterministic, fixed 600×400, exact light rig + per-model orbit/seek. NO inspector
 *  or UI chrome (that lives in the interactive fbx-test page).
 *
 *  Query: `?model=<name>` (default `m01_cube_phong`). Sets `canvas.dataset.ready='true'`
 *  on success/failure so the parity harness can always observe the outcome.
 */

import { createEngine, createSceneContext, addToScene, createDefaultCamera, createHemisphericLight, createDirectionalLight, registerScene, startEngine, goToFrame, loadFbx } from "babylon-lite";

const PI = Math.PI;

interface View {
    alpha?: number;
    beta?: number;
    seek?: number;
    useFbxCamera?: boolean;
}

// Mirrors babylon-fbx/tools/fbx-test-generator/viewConfig.mjs exactly.
const VIEW_CONFIG: Record<string, View> = {
    m01_cube_phong: { alpha: -PI / 4, beta: PI / 3 },
    m02_geo_ngons: { alpha: PI / 2, beta: PI / 2 },
    m03_normals: { alpha: -PI / 2.3, beta: PI / 2.4 },
    m04_material_properties: { alpha: -PI / 2, beta: PI / 2.2 },
    m05_textures: { alpha: PI / 2, beta: PI / 2 },
    m06_uv_transform: { alpha: PI / 2, beta: PI / 2 },
    m07_multimaterial: { alpha: -PI / 3.2, beta: PI / 3 },
    m08_transforms: { alpha: -PI / 2.3, beta: PI / 2.3 },
    m09_skinning: { alpha: -PI / 2, beta: PI / 2 },
    m10_morph: { alpha: -PI / 3, beta: PI / 3.4 },
    m11_node_anim: { alpha: -PI / 2.4, beta: PI / 2.3, seek: 40 / 60 },
    m12_skeletal_anim: { alpha: -PI / 2, beta: PI / 2 },
    m13_morph_anim: { alpha: -PI / 3, beta: PI / 3.4 },
    m14_multiclip: { alpha: -PI / 3, beta: PI / 3 },
    m15_camera_lights: { useFbxCamera: true },
    m16_axis_yup: { alpha: -PI / 4, beta: PI / 3 },
    m16_axis_zup: { alpha: -PI / 4, beta: PI / 3 },
    m16_units_254: { alpha: -PI / 4, beta: PI / 3 },
};

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const win = window as unknown as { __parityError?: string };

interface FrameMesh {
    _cpuPositions?: Float32Array;
    worldMatrix: ArrayLike<number>;
    visible?: boolean;
}

/** Frame the POSED content from live world bounds (matches render.mjs, which frames
 *  AFTER seeking the animation). Lite's createDefaultCamera frames from baked rest-pose
 *  bounds, so for animated models we recompute the live AABB here. radius = diag*1.5
 *  then *1.15 (the BJS harness zoom-out), alpha/beta from the preset. */
function frameLive(scene: { meshes: FrameMesh[] }, cam: { alpha: number; beta: number; radius: number; target: { set(x: number, y: number, z: number): void } }, view: View): void {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (const m of scene.meshes) {
        const p = m._cpuPositions;
        const w = m.worldMatrix;
        if (!p || !w || m.visible === false) {
            continue;
        }
        for (let i = 0; i < p.length; i += 3) {
            const x = p[i]!,
                y = p[i + 1]!,
                z = p[i + 2]!;
            const wx = w[0]! * x + w[4]! * y + w[8]! * z + w[12]!;
            const wy = w[1]! * x + w[5]! * y + w[9]! * z + w[13]!;
            const wz = w[2]! * x + w[6]! * y + w[10]! * z + w[14]!;
            if (wx < minX) {
                minX = wx;
            }
            if (wy < minY) {
                minY = wy;
            }
            if (wz < minZ) {
                minZ = wz;
            }
            if (wx > maxX) {
                maxX = wx;
            }
            if (wy > maxY) {
                maxY = wy;
            }
            if (wz > maxZ) {
                maxZ = wz;
            }
        }
    }
    if (!isFinite(minX)) {
        return;
    }
    const sx = maxX - minX,
        sy = maxY - minY,
        sz = maxZ - minZ;
    cam.target.set(minX + sx * 0.5, minY + sy * 0.5, minZ + sz * 0.5);
    cam.radius = Math.sqrt(sx * sx + sy * sy + sz * sz) * 1.5 * 1.15;
    if (view.alpha !== undefined) {
        cam.alpha = view.alpha;
    }
    if (view.beta !== undefined) {
        cam.beta = view.beta;
    }
}

async function run(): Promise<void> {
    const model = new URLSearchParams(window.location.search).get("model") ?? "m01_cube_phong";
    const view: View = VIEW_CONFIG[model] ?? { alpha: -PI / 4, beta: PI / 3 };
    try {
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        // BJS harness clear color.
        scene.clearColor = { r: 0.16, g: 0.16, b: 0.18, a: 1 };

        const container = await loadFbx(engine, `/fbx/${model}.fbx`);
        addToScene(scene, container);

        // Neutral rig — added only when the FBX brought no lights of its own (matches
        // render.mjs, which adds the rig only when scene.lights.length === 0; e.g. m15
        // keeps its authored lights). Hemi 0.85 / directional 0.9 per render.mjs.
        if (scene.lights.length === 0) {
            const hemi = createHemisphericLight([0.3, 1.0, 0.25], 0.85);
            hemi.groundColor = [0.25, 0.25, 0.3];
            addToScene(scene, hemi);
            addToScene(scene, createDirectionalLight([-0.6, -1.0, -0.8], 0.9));
        }

        const useFbxCam = !!(view.useFbxCamera && container.camera);
        const cam = useFbxCam ? null : (createDefaultCamera(scene) as unknown as { alpha: number; beta: number; radius: number; target: { set(x: number, y: number, z: number): void } });

        // Pin animations to a deterministic fraction of the clip (BJS default 0.5),
        // BEFORE framing — so the camera frames the posed pose (render.mjs order).
        const seek = view.seek ?? 0.5;
        for (const g of scene.animationGroups) {
            goToFrame(g, seek * (g.duration ?? 0) * (g.frameRate ?? 60), engine);
        }

        await registerScene(scene);

        // Frame the posed content from live world bounds (skip for the FBX camera).
        if (cam) {
            frameLive(scene as unknown as { meshes: FrameMesh[] }, cam, view);
        }

        await startEngine(engine);
        canvas.dataset.ready = "true";
    } catch (e) {
        win.__parityError = e instanceof Error ? (e.stack ?? e.message) : String(e);
        canvas.dataset.ready = "true";
    }
}

void run();
