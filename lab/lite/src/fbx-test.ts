/** FBX loader smoke scene — loads an FBX model via the core static-mesh path
 *  and renders it with a hemispheric light + auto-framed default camera.
 *
 *  Query string: `?model=<name>` (default `m01_cube_phong`). The FBX file is
 *  fetched from `/fbx/<name>.fbx` (served from `lab/public/fbx/`).
 *
 *  Exposes `window.__fbx = { ready, error, meshCount, cameraCount, lightCount,
 *  morphTargetCount, skeletonBoneCount, diagnostics }` and sets `canvas.dataset.ready = 'true'` on BOTH success and
 *  failure so tests can always observe the outcome. When the FBX supplies its own
 *  camera/lights they are used as-is; otherwise a default camera + hemispheric
 *  fill light are added so the model still frames and renders non-blank. */

import {
    createEngine,
    createSceneContext,
    addToScene,
    createDefaultCamera,
    attachControl,
    createHemisphericLight,
    registerScene,
    startEngine,
    setMorphTargetWeights,
    goToFrame,
    loadFbx,
} from "babylon-lite";

interface FbxTestState {
    ready: boolean;
    error: string | null;
    meshCount: number;
    cameraCount: number;
    lightCount: number;
    morphTargetCount: number;
    animationGroupCount: number;
    animationDurationSec: number;
    skeletonBoneCount: number;
    diagnostics: string[];
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const state: FbxTestState = {
    ready: false,
    error: null,
    meshCount: 0,
    cameraCount: 0,
    lightCount: 0,
    morphTargetCount: 0,
    animationGroupCount: 0,
    animationDurationSec: 0,
    skeletonBoneCount: 0,
    diagnostics: [],
};
(window as unknown as { __fbx: FbxTestState }).__fbx = state;

// Capture FBX loader diagnostics (emitted via console.warn) so the inspector can
// surface them. Installed before any loadFbx call.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
    state.diagnostics.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    _origWarn(...args);
};

// ─── Lightweight inspector ──────────────────────────────────────────────────
// Lite has no built-in debug layer, so this is a minimal scene inspector for the
// FBX demo: per-mesh geometry/material/deformer stats, world bounds, live camera
// readout, and toggles for facing/culling diagnosis.

interface InspMesh {
    name?: string;
    material: { backFaceCulling?: boolean; diffuseColor?: [number, number, number] };
    boundMin?: [number, number, number];
    boundMax?: [number, number, number];
    skeleton?: { boneCount: number } | null;
    morphTargets?: { count: number } | null;
    _cpuPositions?: Float32Array;
    _cpuIndices?: Uint32Array;
}
interface InspScene {
    meshes: InspMesh[];
    lights: unknown[];
    animationGroups: { duration?: number }[];
}
interface InspCam {
    alpha: number;
    beta: number;
    radius: number;
    target: { x: number; y: number; z: number };
}

interface InspVec {
    x: number;
    y: number;
    z: number;
}
interface InspNode {
    name: string;
    position: InspVec;
    rotation: InspVec;
    rotationQuaternion: { x: number; y: number; z: number; w: number };
    scaling: InspVec;
    children: InspNode[];
    material?: unknown;
}

function el(tag: string, css: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    e.style.cssText = css;
    if (text !== undefined) {
        e.textContent = text;
    }
    return e;
}

function setParam(key: string, value: string | null): void {
    const q = new URLSearchParams(window.location.search);
    if (value === null) {
        q.delete(key);
    } else {
        q.set(key, value);
    }
    window.location.search = q.toString();
}

function buildInspector(scene: InspScene, cam: InspCam, model: string, roots: InspNode[]): void {
    const params = new URLSearchParams(window.location.search);
    const cullOff = params.get("cull") === "0";

    const panel = el(
        "div",
        "position:fixed;top:10px;right:10px;z-index:20;width:330px;max-height:92vh;overflow:auto;background:rgba(18,18,28,0.93);color:#e6e6e6;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;border:1px solid #444;border-radius:6px;padding:10px;box-shadow:0 6px 22px rgba(0,0,0,0.55);"
    );
    panel.id = "fbxInspector";

    const title = el("div", "font-weight:700;font-size:12px;margin-bottom:6px;color:#9ecbff;", `🔎 Inspector — ${model}`);
    panel.appendChild(title);

    // Controls
    const btnCss = "cursor:pointer;background:#2a2a3e;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px;margin:0 4px 4px 0;font:inherit;";
    const controls = el("div", "margin-bottom:8px;");
    const flipBtn = el("button", btnCss, "⟳ Flip 180°");
    flipBtn.addEventListener("click", () => {
        cam.alpha += Math.PI;
    });
    const cullBtn = el("button", btnCss, cullOff ? "◫ Double-sided: ON" : "◫ Double-sided: OFF");
    cullBtn.addEventListener("click", () => setParam("cull", cullOff ? null : "0"));
    const hideBtn = el("button", btnCss, "✕ Hide");
    hideBtn.addEventListener("click", () => panel.remove());
    controls.appendChild(flipBtn);
    controls.appendChild(cullBtn);
    controls.appendChild(hideBtn);
    panel.appendChild(controls);

    // Scene stats
    let totalV = 0;
    let totalT = 0;
    for (const m of scene.meshes) {
        totalV += (m._cpuPositions?.length ?? 0) / 3;
        totalT += (m._cpuIndices?.length ?? 0) / 3;
    }
    const stats = el(
        "div",
        "margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #383848;",
        `meshes: ${scene.meshes.length}   verts: ${totalV.toLocaleString()}   tris: ${totalT.toLocaleString()}\n` +
            `lights: ${scene.lights.length}   anim groups: ${scene.animationGroups.length}   ` +
            `cull: ${cullOff ? "OFF (double-sided)" : "ON (back-face)"}`
    );
    stats.style.whiteSpace = "pre";
    panel.appendChild(stats);

    // ── Node hierarchy (shows the RH→LH handedness correction) ──
    const hdr = el("div", "font-weight:700;margin:4px 0 4px;color:#9ecbff;", "node hierarchy (S=scale, R=rot°, P=pos)");
    panel.appendChild(hdr);
    const treeBox = el("div", "margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #383848;");
    const f2 = (n: number): string => (Object.is(n, -0) ? 0 : n).toFixed(2);
    const d0 = (r: number): string => Math.round((r * 180) / Math.PI).toString();
    const renderNode = (node: InspNode, depth: number): void => {
        const sx = node.scaling.x;
        const sy = node.scaling.y;
        const sz = node.scaling.z;
        const neg = sx < 0 || sy < 0 || sz < 0;
        const isMesh = node.material != null;
        const isStruct = node.name.startsWith("__");
        const color = neg ? "#ff9a9a" : isStruct ? "#9ecbff" : isMesh ? "#bfe8a0" : "#d8d8d8";
        const indent = "  ".repeat(depth);
        const row = el(
            "div",
            `white-space:pre;color:${color};padding:1px 0;`,
            `${indent}${node.name}${isMesh ? " ▸mesh" : ""}\n` +
                `${indent}  S(${f2(sx)}, ${f2(sy)}, ${f2(sz)})  R(${d0(node.rotation.x)}°, ${d0(node.rotation.y)}°, ${d0(node.rotation.z)}°)  P(${f2(node.position.x)}, ${f2(node.position.y)}, ${f2(node.position.z)})`
        );
        treeBox.appendChild(row);
        for (const c of node.children) {
            renderNode(c, depth + 1);
        }
    };
    for (const r of roots) {
        renderNode(r, 0);
    }
    if (!roots.length) {
        treeBox.appendChild(el("div", "color:#888;", "(no transform nodes)"));
    }
    panel.appendChild(treeBox);

    // Per-mesh rows
    const list = el("div", "margin-bottom:8px;");
    scene.meshes.forEach((m, i) => {
        const v = (m._cpuPositions?.length ?? 0) / 3;
        const t = (m._cpuIndices?.length ?? 0) / 3;
        const flags: string[] = [];
        if (m.skeleton) {
            flags.push(`skel:${m.skeleton.boneCount}`);
        }
        if (m.morphTargets) {
            flags.push(`morph:${m.morphTargets.count}`);
        }
        const culling = m.material.backFaceCulling === false ? "double-sided" : "back-face";
        let size = "";
        if (m.boundMin && m.boundMax) {
            const sx = (m.boundMax[0] - m.boundMin[0]).toFixed(2);
            const sy = (m.boundMax[1] - m.boundMin[1]).toFixed(2);
            const sz = (m.boundMax[2] - m.boundMin[2]).toFixed(2);
            size = `  bbox: ${sx}×${sy}×${sz}`;
        }
        const row = el(
            "div",
            "padding:3px 0;border-top:1px solid #2a2a38;white-space:pre;",
            `[${i}] ${m.name ?? "mesh"}\n  v:${v.toLocaleString()} t:${t.toLocaleString()} ${culling}${flags.length ? "  " + flags.join(" ") : ""}${size}`
        );
        list.appendChild(row);
    });
    panel.appendChild(list);

    // Diagnostics
    if (state.diagnostics.length) {
        const diag = el("div", "margin-bottom:8px;color:#ffcf8a;white-space:pre-wrap;", "diagnostics:\n" + state.diagnostics.slice(0, 12).join("\n"));
        panel.appendChild(diag);
    }

    // Live camera readout
    const camLine = el("div", "color:#8af0c0;white-space:pre;border-top:1px solid #383848;padding-top:6px;");
    panel.appendChild(camLine);
    const tip = el("div", "margin-top:6px;color:#888;", "drag = orbit · wheel = zoom · right-drag = pan");
    panel.appendChild(tip);

    document.body.appendChild(panel);

    const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(0);
    const tick = (): void => {
        if (!panel.isConnected) {
            return;
        }
        camLine.textContent = `cam α:${deg(cam.alpha)}° β:${deg(cam.beta)}° r:${cam.radius.toFixed(1)}  target:(${cam.target.x.toFixed(1)}, ${cam.target.y.toFixed(1)}, ${cam.target.z.toFixed(1)})`;
        requestAnimationFrame(tick);
    };
    tick();
}

async function run(): Promise<void> {
    try {
        const model = new URLSearchParams(window.location.search).get("model") ?? "m01_cube_phong";

        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);

        const container = await loadFbx(engine, `/fbx/${model}.fbx`);
        addToScene(scene, container);

        // The FBX may supply its own camera + lights. addToScene already applied
        // the camera (as scene.camera) and the lights (into scene.lights) when
        // present; only fall back to a fill light for files that have neither.
        const hasFbxCamera = !!container.camera;
        const fbxLightCount = scene.lights.length;

        // Fill light so unlit faces are still visible (non-blank) — only when the
        // FBX provides no lights of its own.
        if (fbxLightCount === 0) {
            addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
        }

        // Always attach an interactive ArcRotate camera so every model can be
        // orbited / zoomed / panned with the mouse (left-drag = orbit, wheel =
        // zoom, right-drag = pan). This overrides any FBX-authored camera for
        // inspection purposes (the FBX camera data is still validated separately).
        // createDefaultCamera auto-frames the loaded meshes.
        const cam = createDefaultCamera(scene);
        attachControl(cam, canvas, scene);

        // Optional initial-viewpoint overrides: some FBX showcase models are
        // arranged for a non-default viewpoint (flat texture cards face +Z; the
        // dice row is strung along the camera's default +Z view axis). The harness
        // (or you, via the URL) can request an explicit starting orbit.
        const camParams = new URLSearchParams(window.location.search);
        const alphaParam = camParams.get("alpha");
        const betaParam = camParams.get("beta");
        if (alphaParam !== null) {
            (cam as { alpha: number }).alpha = parseFloat(alphaParam);
        } else {
            // Default-flip 180° to look at the FRONT of the models. The default
            // ArcRotate framing looks down the −Z side; many FBX models face +Z, so
            // their single-sided front faces would be back-face culled (invisible)
            // from the default angle. This is NOT an import issue — the geometry is
            // correct; pass `?cull=0` to render double-sided and confirm.
            (cam as { alpha: number }).alpha += Math.PI;
        }
        if (betaParam !== null) {
            (cam as { beta: number }).beta = parseFloat(betaParam);
        }

        state.meshCount = scene.meshes.length;
        state.cameraCount = hasFbxCamera ? 1 : 0;
        state.lightCount = fbxLightCount;

        // Morph targets (FBX blend shapes): report the total across meshes and drive
        // the first morph weight to 1.0 so the smoke capture renders a deformed pose.
        let morphTargetCount = 0;
        for (const mesh of scene.meshes) {
            if (mesh.morphTargets) {
                morphTargetCount += mesh.morphTargets.count;
                setMorphTargetWeights(engine, mesh.morphTargets, [1]);
            }
        }
        state.morphTargetCount = morphTargetCount;

        // Skeletons (FBX skin deformers): report the maximum bone count across the
        // skinned meshes. m09 renders at its REST/bind pose here — Standard-pipeline
        // skeleton rendering (the visual deform) is wired in a later phase.
        let skeletonBoneCount = 0;
        for (const mesh of scene.meshes) {
            if (mesh.skeleton) {
                skeletonBoneCount = Math.max(skeletonBoneCount, mesh.skeleton.boneCount);
            }
        }
        state.skeletonBoneCount = skeletonBoneCount;

        // Node (transform) animation: report the group count and, when the harness
        // requests `?seekTime=<seconds>`, freeze every group at that time so the
        // capture is deterministic. Without a seek time the groups keep playing.
        state.animationGroupCount = scene.animationGroups.length;
        state.animationDurationSec = scene.animationGroups.reduce((m, g) => Math.max(m, g.duration ?? 0), 0);
        const seekTimeParam = new URLSearchParams(window.location.search).get("seekTime");
        if (seekTimeParam !== null) {
            const seekTime = parseFloat(seekTimeParam);
            for (const group of scene.animationGroups) {
                goToFrame(group, seekTime * (group.frameRate ?? 60), engine);
            }
        }

        // Double-sided toggle (`?cull=0`): disable back-face culling on every
        // material so single-sided faces render from both sides. Use this to
        // confirm geometry is present/correctly imported regardless of facing.
        if (camParams.get("cull") === "0") {
            for (const mesh of scene.meshes) {
                (mesh.material as { backFaceCulling?: boolean }).backFaceCulling = false;
            }
        }

        await registerScene(scene);
        await startEngine(engine);

        // Node hierarchy roots for the inspector (the FBX __root__ handedness node
        // + any axis-conversion node + model nodes). Lights are entities too but
        // have no transform tree, so keep only nodes with children/transform.
        const roots = (container.entities as unknown[]).filter((e): e is InspNode => !!e && typeof e === "object" && "children" in (e as object) && "scaling" in (e as object));

        buildInspector(scene as unknown as InspScene, cam as unknown as InspCam, model, roots);

        state.ready = true;
        canvas.dataset.ready = "true";
    } catch (e) {
        state.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        state.ready = true;
        canvas.dataset.ready = "true";
    }
}

void run();
