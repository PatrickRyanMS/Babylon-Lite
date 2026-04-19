/**
 * Shared renderable-builder helper for billboard sprite systems.
 *
 * The three billboard variants share the bind-group layout shape, the
 * per-instance attribute layout, and the per-frame upload + draw logic — they
 * differ only in (a) the WGSL emitted by their composer and (b) the size +
 * contents of the per-system UBO at `@group(1) @binding(2)`.
 *
 * This helper takes a composed shader, the system UBO bytes, and a per-frame
 * UBO writer, and wires up everything else. Each variant's renderable file
 * stays small and dynamic-importable.
 */

import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Renderable } from "../../render/renderable.js";
import type { BillboardSpriteSystem } from "../sprite-billboard-shared.js";
import { SPRITE_BILLBOARD_STRIDE, _tickBillboardSpriteClips } from "../sprite-billboard-shared.js";
import type { SpriteBlendMode } from "./sprite-atlas.js";
import { syncSpriteStorage, disposeSpriteStorage } from "./sprite-gpu.js";
import { ensureSprite3DSceneUBO } from "./sprite-3d-scene-ubo.js";
import { createPipelineCache, type PipelineCache, type PipelineCacheEntry } from "../../material/pipeline-cache.js";

interface BillboardPipelineVariant extends PipelineCacheEntry {
    pipeline: GPURenderPipeline;
    sceneBGL: GPUBindGroupLayout;
    layerBGL: GPUBindGroupLayout;
}

/** Per-variant pipeline cache key prefix (unique per WGSL composer). */
export type BillboardCacheKey = "facing" | "yaw" | "axis";

const _caches: Record<BillboardCacheKey, PipelineCache<BillboardPipelineVariant> | null> = {
    facing: null,
    yaw: null,
    axis: null,
};

function getCache(key: BillboardCacheKey): PipelineCache<BillboardPipelineVariant> {
    let cache = _caches[key];
    if (!cache) {
        cache = createPipelineCache<BillboardPipelineVariant>();
        _caches[key] = cache;
    }
    return cache;
}

function blendState(mode: SpriteBlendMode): GPUBlendState | undefined {
    switch (mode) {
        case "alpha":
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "premultiplied":
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "additive":
            return {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            };
        case "multiply":
            return {
                color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case "cutout":
            return undefined;
    }
}

export interface BillboardRenderableSpec {
    cacheKey: BillboardCacheKey;
    /** Diagnostic label prefix (e.g. "sprite-billboard-facing"). */
    label: string;
    vertexWGSL: string;
    fragmentWGSL: string;
    /** Size of the per-system UBO at @group(1) @binding(2). 32 B for layer UBO; 32 B (16-aligned) for axis UBO. */
    systemUboBytes: number;
    /** Writes the current per-system UBO contents into `scratch`. */
    writeSystemUbo: (scratch: Float32Array) => void;
}

/** Build the renderable for a billboard system. */
export async function buildBillboardRenderable(system: BillboardSpriteSystem, scene: SceneContext, spec: BillboardRenderableSpec): Promise<void> {
    const ctx = scene as SceneContextInternal;
    const engine = ctx.engine as EngineContextInternal;

    // Per-frame clip tick — registered with `unshift` so it runs BEFORE user
    // `onBeforeRender` callbacks (matches the sprite freeze-flag convention).
    ctx._beforeRender.unshift((dt) => _tickBillboardSpriteClips(system, dt));

    const sceneUBO = ensureSprite3DSceneUBO(scene);
    const cache = getCache(spec.cacheKey);
    cache.ensureDevice(engine);

    const isCutout = system.blendMode === "cutout";
    const pipelineKey = `${spec.cacheKey}|${engine.format}|${engine.msaaSamples}|${system.blendMode}|${system.depthWrite ? 1 : 0}|${system.alphaCutoff.toFixed(4)}`;

    let variant = cache.getOrIncRef(pipelineKey);
    if (!variant) {
        const device = engine.device;
        const sceneBGL = device.createBindGroupLayout({
            label: `${spec.label}-scene-bgl`,
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
        });
        const layerBGL = device.createBindGroupLayout({
            label: `${spec.label}-layer-bgl`,
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                {
                    binding: 2,
                    // Axis-locked needs the UBO in the vertex stage; the layer-only
                    // variants (facing, yaw) need it only in the fragment stage. Bind
                    // both stages — cost is one bit in the bind-group layout.
                    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" },
                },
            ],
        });

        const vertModule = device.createShaderModule({ code: spec.vertexWGSL, label: `${spec.label}-vert` });
        const fragModule = device.createShaderModule({ code: spec.fragmentWGSL, label: `${spec.label}-frag` });

        // Per-instance attribute layout (stride 96 B = 24 floats):
        //   worldPos3 (12) | reserved0 (4) | reserved1 (8) | sizeWorld2 (8) | pivot2 (8) |
        //   sinCos2 (8) | uvRect4 (16) | color4 (16) | flagsAndPad4 (16)
        const instanceLayout: GPUVertexBufferLayout = {
            arrayStride: SPRITE_BILLBOARD_STRIDE * 4,
            stepMode: "instance",
            attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" },
                { shaderLocation: 1, offset: 12, format: "float32" },
                { shaderLocation: 2, offset: 16, format: "float32x2" },
                { shaderLocation: 3, offset: 24, format: "float32x2" },
                { shaderLocation: 4, offset: 32, format: "float32x2" },
                { shaderLocation: 5, offset: 40, format: "float32x2" },
                { shaderLocation: 6, offset: 48, format: "float32x4" },
                { shaderLocation: 7, offset: 64, format: "float32x4" },
                { shaderLocation: 8, offset: 80, format: "float32x4" },
            ],
        };

        const colorTarget: GPUColorTargetState = { format: engine.format, blend: blendState(system.blendMode) };

        const pipeline = device.createRenderPipeline({
            label: `${spec.label}-pipeline`,
            layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL, layerBGL] }),
            vertex: { module: vertModule, entryPoint: "vs_main", buffers: [instanceLayout] },
            fragment: { module: fragModule, entryPoint: "fs_main", targets: [colorTarget] },
            primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
            multisample: { count: engine.msaaSamples },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthCompare: "less-equal",
                // Cutout writes depth (opaque queue); blended modes inherit `depthWrite`.
                depthWriteEnabled: system.depthWrite,
            },
        });
        variant = { pipeline, sceneBGL, layerBGL, refCount: 1 };
        cache.set(pipelineKey, variant);
    }

    const device = engine.device;

    const layerUBO = device.createBuffer({
        label: `${spec.label}-layer-ubo`,
        size: spec.systemUboBytes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layerScratch = new Float32Array(spec.systemUboBytes / 4);

    const sceneBG = device.createBindGroup({
        label: `${spec.label}-scene-bg`,
        layout: variant.sceneBGL,
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });
    const layerBG = device.createBindGroup({
        label: `${spec.label}-layer-bg`,
        layout: variant.layerBGL,
        entries: [
            { binding: 0, resource: system.atlas.texture.view },
            { binding: 1, resource: system.atlas.texture.sampler },
            { binding: 2, resource: { buffer: layerUBO } },
        ],
    });

    const renderable: Renderable = {
        // Cutout = opaque queue (110 + order); blended = transparent queue (210 + order).
        order: (isCutout ? 110 : 210) + system.order,
        isTransparent: !isCutout,
        _pipeline: variant.pipeline,
        _sceneBG: sceneBG,
        _worldCenter: [0, 0, 0],
        updateUBOs(): void {
            spec.writeSystemUbo(layerScratch);
            device.queue.writeBuffer(layerUBO, 0, layerScratch.buffer, layerScratch.byteOffset, spec.systemUboBytes);
            syncSpriteStorage(engine, system._storage, `${spec.label}-instances`);
        },
        draw(pass): number {
            if (!system.visible || system._storage.count === 0 || !system._storage.gpuBuffer) {
                return 0;
            }
            pass.setBindGroup(1, layerBG);
            pass.setVertexBuffer(0, system._storage.gpuBuffer);
            pass.draw(6, system._storage.count);
            return 1;
        },
    };

    ctx._renderables.push(renderable);
    ctx._disposables.push(() => {
        layerUBO.destroy();
        disposeSpriteStorage(system._storage);
    });
}
