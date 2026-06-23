/** Standard mesh renderable — builds Renderables from Mesh + StandardMaterial.
 *
 *  `buildStandardMeshRenderables` does shared per-scene setup, then delegates
 *  per-mesh work to `buildSingleStandardRenderable`. The same single-mesh
 *  function is reused by the material-swap path. */

import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { Renderable, MeshGroupBuildResult } from "../../render/renderable.js";
import { collectStdBoundTextures } from "./collect-std-bound-textures.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _computeStandardMaterialFeatures, _standardShaderVariantKey } from "./standard-material.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { getOrCreateStandardBindings, getOrCreateStandardPipeline, createStandardMeshBindGroup, clearStandardPipelineCache, writeStdMaterialData } from "./standard-pipeline.js";
import {
    ESM_SHADOW_OUTPUT,
    NO_COLOR_OUTPUT,
    NEEDS_UV,
    NEEDS_UV2,
    HAS_OPACITY_TEXTURE,
    HAS_VERTEX_COLOR,
    HAS_MORPH_TARGETS,
    HAS_SKELETON,
    HAS_SKELETON_8,
    HAS_BUMP_TEXTURE,
    HAS_NORMAL_TANGENT,
    SCENE_HAS_FOG,
    _getStdExtsSorted,
    type StdExt,
} from "./standard-flags.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import type { Material, MaterialRenderFeatures } from "../material.js";
import {
    _computeMeshFeatures,
    MSH_HAS_INSTANCE_COLOR,
    MSH_HAS_MORPH_TARGETS,
    MSH_HAS_SKELETON,
    MSH_HAS_SKELETON_8,
    MSH_HAS_TANGENTS,
    MSH_HAS_VERTEX_COLOR,
    MSH_HAS_THIN_INSTANCES,
    MSH_RECEIVE_SHADOWS,
} from "../mesh-features.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";

/** Scratch buffer for material UBO writes (24 floats = 96 bytes). Reused across
 *  every Standard renderable since binding updates are single-threaded per frame. */
const _stdMatScratch = new F32(24);

/** Deform/vertex StdExt feature bits that have been wired into THIS bundle. Each dynamic feature
 *  chunk (std-vertex-color/morph/skeleton/normal-tangent-fragment) ORs its `HAS_*` bit in via
 *  `_installStdExtFeature` on import. A scene that loads none keeps this `0`, so the per-mesh
 *  feature-OR + the draw-time vertex-buffer binder loop below fold away — the resolver-hook fold the
 *  stencil path uses, keeping non-deform Standard scenes byte-identical to upstream. */
let _stdExtBits = 0;
/** @internal OR a deform/vertex feature bit into the active set (called by feature chunks on load). */
export function _installStdExtFeature(bit: number): void {
    _stdExtBits |= bit;
}

/** Thin instance GPU sync callback type — loaded dynamically only when needed. */
type ThinInstanceSync = (
    engine: EngineContext,
    ti: any,
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    slot: number,
    hasColor: boolean,
    drawBuffers?: import("../../mesh/thin-instance-gpu.js").ThinInstanceDrawBuffers | null
) => number;

/** Fragment factories passed from the async group builder. */
export interface StdFragmentFactories {
    tiSync?: ThinInstanceSync;
    tiFragment?: (hasColor: boolean) => ShaderFragment;
    shadowFragment?: (shadowLights: import("./fragments/std-shadow-fragment.js").ShadowLightSlot[]) => ShaderFragment;
    /** Present only when the scene has at least one culling-enabled thin-instance mesh. */
    cull?: typeof import("../../mesh/thin-instance-cull-binding.js");
    /** `calcFogFactor` helper WGSL — non-empty only when `scene.fog` (dynamic-imported from std-fog-wgsl). */
    fogHelper?: string;
    /** Fog blend block WGSL — non-empty only when `scene.fog`. */
    fogBlock?: string;
}

/** Build Renderable(s) + a SceneUniformUpdater for a set of standard meshes.
 *  The `rebuildSingle` closure is reused later (via `_rebuildSingle` on the group
 *  builder) for material swaps + per-pass material overrides. */
export function buildStandardMeshRenderables(scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories): MeshGroupBuildResult {
    const engine = scene.surface.engine;
    const device = engine._device;
    const { tiSync, tiFragment, shadowFragment, cull } = factories;
    // Fog WGSL strings (empty unless the scene has fog). Threaded into the compose call on a
    // cache miss; `hasFog` ORs SCENE_HAS_FOG into the per-mesh feature mask so the template
    // emits the fog varying/helper/block and the pipeline cache key stays fog-distinct.
    const fogHelper = factories.fogHelper ?? "";
    const fogBlock = factories.fogBlock ?? "";
    const hasFog = !!scene.fog;

    // Collect per-light shadow info.
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf" | "csm"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg._shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;

    // All receiving meshes in this build share the same shadow generators,
    // so keying the shadow BG by `bindings._shadowBGL` alone is correct.
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();
    // Closure used both for the initial per-mesh build below AND for later
    // material-swap / per-pass-override rebuilds (set on standardGroupBuilder._rebuildSingle).
    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
        const mat = (materialOverride ?? mesh.material) as StandardMaterialProps;
        const renderFeatures = (mat._renderFeatures ??= { features: _computeStandardMaterialFeatures(mat) }) as MaterialRenderFeatures;
        const isOverride = materialOverride != null;
        const shadowOutput = (renderFeatures.features & (NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT)) !== 0;
        const receiveShadows = !shadowOutput && mesh.receiveShadows && hasSomeShadows;
        const meshFeatures = _computeMeshFeatures(mesh, receiveShadows);
        // Per-vertex color, morph, skeleton (mesh-driven) and fog (scene-driven) are OR'd into a
        // *local* copy of the cached material features (never mutate `renderFeatures.features`).
        // Each bit is both the pipeline cache key and the StdExt loop gate below, so the composed
        // shader and the key stay consistent with no masking. All are suppressed on shadow/depth
        // passes (no color; shadow-pass deform isn't wired — m09/m10/m12/m13 don't cast shadows).
        // Skeleton + thin-instance both reassign `finalWorld` in the VW slot, so that combo is
        // skipped this round (m09/m12 aren't thin-instanced, so it never triggers).
        let features = renderFeatures.features;
        if (!shadowOutput) {
            // Deform/vertex feature bits are OR'd in only when the matching dynamic StdExt chunk has
            // been loaded (each installs its bit via `_installStdExtFeature`). When none is loaded
            // `_stdExtBits` is provably 0 and this whole block folds away (non-deform scenes stay
            // byte-identical). The `_stdExtBits & HAS_*` guard is always satisfied once the matching
            // chunk is present, so behaviour is identical to a direct `meshFeatures & MSH_*` test.
            if (_stdExtBits) {
                if (_stdExtBits & HAS_VERTEX_COLOR && meshFeatures & MSH_HAS_VERTEX_COLOR) {
                    features |= HAS_VERTEX_COLOR;
                }
                if (_stdExtBits & HAS_MORPH_TARGETS && meshFeatures & MSH_HAS_MORPH_TARGETS) {
                    features |= HAS_MORPH_TARGETS;
                }
                if (_stdExtBits & HAS_SKELETON && meshFeatures & MSH_HAS_SKELETON && !(meshFeatures & MSH_HAS_THIN_INSTANCES)) {
                    features |= HAS_SKELETON | (meshFeatures & MSH_HAS_SKELETON_8 ? HAS_SKELETON_8 : 0);
                }
                // Normal-mapped meshes that carry a tangent buffer render the bump through the
                // explicit-tangent TBN (Babylon FBX parity) instead of the cotangent frame.
                if (_stdExtBits & HAS_NORMAL_TANGENT && meshFeatures & MSH_HAS_TANGENTS && features & HAS_BUMP_TEXTURE) {
                    features |= HAS_NORMAL_TANGENT;
                }
            }
            if (hasFog) {
                features |= SCENE_HAS_FOG;
            }
        }
        // Build per-feature fragment list (deduped via pipeline cache). The morph ext (gated on
        // HAS_MORPH_TARGETS) composes its vertex-stage fragment here; `composeStandardShader`
        // derives `_hasMorph` from fragment presence, keeping geometry/depth paths safe.
        // Iterate the registry in CANONICAL sorted order (same order the composer topo-sorts
        // fragments into vertex-attribute layout, and the same order the group-1 ext-bind and
        // draw-time vertex-buffer loops use) so layout/bind orders stay mutually consistent.
        // Compose the active feature fragments AND collect their draw-time vertex-buffer binders
        // in ONE pass over the registry in CANONICAL sorted order (same order the composer topo-
        // sorts fragments into vertex-attribute layout, and the group-1 ext-bind + draw-time
        // vertex-buffer loops use), so layout/bind orders stay mutually consistent. Collecting both
        // in a single iteration avoids a second sorted-registry walk per rebuild.
        const frags: ShaderFragment[] = [];
        const vbBinders: NonNullable<StdExt["_bindVertexBuffers"]>[] = [];
        for (const ext of _getStdExtsSorted()) {
            if (features & ext._feature) {
                const f = ext._frag(features);
                if (f) {
                    frags.push(f);
                }
                // Draw-time vertex-buffer binders come only from deform/vertex exts; gate their
                // collection on `_stdExtBits` so it folds away in non-deform bundles.
                if (_stdExtBits && ext._bindVertexBuffers) {
                    vbBinders.push(ext._bindVertexBuffers);
                }
            }
        }
        let shaderKey = "";
        if (meshFeatures & MSH_RECEIVE_SHADOWS && shadowFragment) {
            const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
            shaderKey = _standardShaderVariantKey(slots);
            frags.push(shadowFragment(slots));
        }
        if (meshFeatures & MSH_HAS_THIN_INSTANCES && tiFragment) {
            const hasColor = !!(meshFeatures & MSH_HAS_INSTANCE_COLOR);
            const tiFrag = tiFragment(hasColor);
            if (hasColor) {
                // Standard applies instance color to final color (BC), not to baseColor (AT) like PBR.
                const { _fragmentSlots: _fragmentSlots, ...rest } = tiFrag;
                frags.push({
                    ...rest,
                    _fragmentSlots: {
                        BC: `color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, color.a * input.vInstanceColor.a);`,
                    },
                });
            } else {
                frags.push(tiFrag);
            }
        }
        const esmShadowDepthCode = (features & ESM_SHADOW_OUTPUT) !== 0 ? (mat as StandardMaterialProps & { readonly _esmShadowDepthCode: string })._esmShadowDepthCode : "";
        const bindings = getOrCreateStandardBindings(
            engine,
            features,
            meshFeatures,
            frags,
            shaderKey,
            esmShadowDepthCode,
            fogHelper,
            fogBlock,
            (mat as StandardMaterialProps).stencil ?? null
        );

        const meshShadowGens = receiveShadows ? shadowLights.map((sl) => sl.gen) : [];

        const meshUboData = new F32(bindings._composed._meshUboSpec._totalBytes / 4);
        const _packMeshWorld = engine._makePackMeshWorld?.(s as SceneContext) ?? packMat4IntoF32;
        _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
        writeMeshLightSelection(mesh, s.lights, meshUboData);
        const meshUBO = createUniformBuffer(engine, meshUboData);
        const textureLevel = (features & NEEDS_UV) !== 0 ? 1.0 : 0;
        const matData = new F32(24);
        writeStdMaterialData(matData, mat, textureLevel);
        const materialUBO = createUniformBuffer(engine, matData);
        const meshBindGroup = createStandardMeshBindGroup(engine, bindings, meshUBO, materialUBO, mat, mesh);

        // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
        let shadowBindGroup: GPUBindGroup | null = null;
        if (meshShadowGens.length > 0 && bindings._shadowBGL) {
            let cached = shadowBGCache.get(bindings._shadowBGL);
            if (!cached) {
                const entries: GPUBindGroupEntry[] = [];
                let b = 0;
                for (const sg of meshShadowGens) {
                    entries.push({ binding: b++, resource: sg._depthTexture.createView() });
                    entries.push({ binding: b++, resource: sg._depthSampler });
                    entries.push({ binding: b++, resource: { buffer: sg._shadowUBO } });
                }
                cached = device.createBindGroup({ layout: bindings._shadowBGL, entries });
                shadowBGCache.set(bindings._shadowBGL, cached);
            }
            shadowBindGroup = cached;
        }

        const needsUV = (features & NEEDS_UV) !== 0;
        const needsUV2 = (features & NEEDS_UV2) !== 0;
        const hasThinInstances = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
        const hasInstanceColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
        const isTransparent = !shadowOutput && ((features & HAS_OPACITY_TEXTURE) !== 0 || mat.alpha < 1);

        const boundTextures = collectStdBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        s._meshDisposables.set(mesh, [
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
        ]);

        let _lastWorldVersion = mesh.worldMatrixVersion;
        let _lastLightsCount = s.lights.length;
        const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];
        const _baseUpdate = (): void => {
            const worldVersion = mesh.worldMatrixVersion;
            if (worldVersion !== _lastWorldVersion || s.lights.length !== _lastLightsCount) {
                sortCenter[0] = mesh.worldMatrix[12]!;
                sortCenter[1] = mesh.worldMatrix[13]!;
                sortCenter[2] = mesh.worldMatrix[14]!;
                _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
                writeMeshLightSelection(mesh, s.lights, meshUboData);
                device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
                _lastWorldVersion = worldVersion;
                _lastLightsCount = s.lights.length;
            }
            const uboVersion = mat._uboVersion;
            if (uboVersion !== _lastUboVersion) {
                _lastUboVersion = uboVersion;
                _stdMatScratch.fill(0);
                writeStdMaterialData(_stdMatScratch, mat, textureLevel);
                device.queue.writeBuffer(materialUBO, 0, _stdMatScratch.buffer, 0, 96);
            }
        };
        // FO-version wrapper applied only when the engine has floating-origin
        // on. The wrapper lives in the dynamic-imported `floating-origin.ts`
        // module and is the sole owner of `_lastFoVersion` tracking. For
        // non-LWR engines `_wrapRenderableForFO` is undefined and `update`
        // is the bare closure — no FO bytes in the closure body.
        const _invalidate = (): void => {
            _lastWorldVersion = -1;
        };
        const update = engine._wrapRenderableForFO?.(_baseUpdate, s as SceneContext, _invalidate) ?? _baseUpdate;

        const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder, cullBinding?: import("../../mesh/thin-instance-cull-binding.js").TiCullBinding): number => {
            // For per-pass material overrides, skip the mesh.material === mat guard
            // because the override material is intentionally not the mesh's current one.
            if (!isOverride && mesh.material !== mat) {
                return 0;
            }
            const g = mesh._gpu;
            let slot = 0;
            const vb = g._vbLayout;
            pass.setVertexBuffer(slot++, g.positionBuffer, vb?._p?._offset);
            pass.setVertexBuffer(slot++, g.normalBuffer, vb?._n?._offset);
            if (needsUV) {
                pass.setVertexBuffer(slot++, g.uvBuffer, vb?._u?._offset);
            }
            if (needsUV2 && g.uv2Buffer) {
                pass.setVertexBuffer(slot++, g.uv2Buffer, vb?._u2?._offset);
            }
            // Generic ext-contributed draw-time vertex buffers (e.g. vertex color, skeleton
            // joints/weights, normal-map tangent). Bound in canonical sorted order — matching the
            // composer's fragment vertex-attribute layout — after base attrs/uv/uv2 and before thin
            // instances. Gated on `_stdExtBits` so the loop folds out of non-deform bundles.
            if (_stdExtBits) {
                for (const bind of vbBinders) {
                    slot = bind(mesh, pass, slot);
                }
            }

            const ti = hasThinInstances ? mesh.thinInstances : null;
            if (ti && tiSync) {
                slot = tiSync(engine, ti, pass, slot, hasInstanceColor, cullBinding?.cullDrawBufs);
            }

            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, meshBindGroup);
            if (receiveShadows && shadowBindGroup) {
                pass.setBindGroup(2, shadowBindGroup);
            }
            if (cullBinding) {
                cullBinding.draw(pass, g.indexCount, ti!.count);
            } else if (ti && ti.count > 0) {
                pass.drawIndexed(g.indexCount, ti.count);
            } else {
                pass.drawIndexed(g.indexCount);
            }
            return 1;
        };

        const r: Renderable = {
            order: mesh.renderOrder ?? (isTransparent ? 200 : 100),
            isTransparent,
            mesh,
            bind(eng, sig) {
                const pipeline = getOrCreateStandardPipeline(eng as EngineContext, sig, bindings);
                // Opaque-only GPU culling (opt-in): tryBind gates on opt-in + transparency, returns the per-binding cull lifecycle.
                const cb = cull?.tryBind(r, s, mesh, engine, hasInstanceColor, isTransparent, update);
                return {
                    renderable: r,
                    pipeline,
                    update: cb ? cb.update : update,
                    draw: (pass) => draw(pass, cb),
                };
            },
        };
        r._worldCenter = sortCenter;
        let _lastUboVersion = mat._uboVersion;
        return r;
    };

    const renderables = meshes.map((m) => rebuildSingle(scene, m));

    scene._disposables.push(
        () => clearStandardPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, rebuildSingle };
}
