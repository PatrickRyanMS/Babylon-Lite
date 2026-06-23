import { describe, expect, it } from "vitest";

import { createSkeletonFragment } from "../../../packages/babylon-lite/src/shader/fragments/skeleton-fragment.js";
import { stdSkeletonExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-skeleton-fragment.js";
import { HAS_SKELETON, HAS_SKELETON_8 } from "../../../packages/babylon-lite/src/material/standard/standard-flags.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material.js";

describe("createSkeletonFragment (shared)", () => {
    it("declares joints/weights attributes, bone helper, and skinning VW for the 4-bone path", () => {
        const frag = createSkeletonFragment(false);

        expect(frag._id).toBe("skeleton");

        // 4-bone path → exactly two attributes: uint32x4 joints + float32x4 weights (stride 16 each).
        expect(frag._vertexAttributes).toHaveLength(2);
        expect(frag._vertexAttributes![0]).toMatchObject({ _name: "joints", _type: "vec4<u32>", _gpuFormat: "uint32x4", _arrayStride: 16 });
        expect(frag._vertexAttributes![1]).toMatchObject({ _name: "weights", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 });

        // Bone-matrix sampler helper + skinning math.
        expect(frag._vertexHelperFunctions).toContain("readMatrixFromRawSampler");
        const vw = frag._vertexSlots?.VW;
        expect(vw).toBeDefined();
        expect(vw).toContain("finalWorld = mesh.world * influence;");
        // 4-bone path must NOT reference the 8-bone joints1/weights1 attributes.
        expect(vw).not.toContain("joints1");
    });

    it("adds joints1/weights1 attributes and skinning terms for the 8-bone path", () => {
        const frag = createSkeletonFragment(true);

        expect(frag._vertexAttributes).toHaveLength(4);
        expect(frag._vertexAttributes![2]).toMatchObject({ _name: "joints1", _type: "vec4<u32>", _gpuFormat: "uint32x4", _arrayStride: 16 });
        expect(frag._vertexAttributes![3]).toMatchObject({ _name: "weights1", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 });
        expect(frag._vertexSlots?.VW).toContain("joints1[0]");
    });

    it("places the bone texture as `_bindings` (afterBase) for Standard, and `_vertexBindings` (default) for PBR", () => {
        // Standard wrapper relocates the shared fragment's single bone binding to the mesh-group
        // `_bindings` (where the Standard trailing ext-bind loop runs), with vertex-stage
        // visibility (0x1) and no `_vertexBindings`.
        const afterBase = stdSkeletonExt._frag(HAS_SKELETON);
        expect(afterBase._vertexBindings).toBeUndefined();
        expect(afterBase._bindings).toHaveLength(1);
        expect(afterBase._bindings![0]!._name).toBe("boneSampler");
        expect(afterBase._bindings![0]!._visibility).toBe(0x1);

        // Shared fragment ("vertex" placement) → bone texture rides in `_vertexBindings`
        // (PBR placement, unchanged/byte-identical).
        const vertexStyle = createSkeletonFragment(false);
        expect(vertexStyle._bindings).toBeUndefined();
        expect(vertexStyle._vertexBindings).toHaveLength(1);
        expect(vertexStyle._vertexBindings![0]!._name).toBe("boneSampler");
        expect(vertexStyle._vertexBindings![0]!._visibility).toBe(0x1);
    });
});

describe("stdSkeletonExt registry wiring", () => {
    it("gates on HAS_SKELETON in the mesh phase and composes the 4/8-bone fragment from features", () => {
        expect(stdSkeletonExt._id).toBe("skeleton");
        expect(stdSkeletonExt._phase).toBe("mesh");
        expect(stdSkeletonExt._feature).toBe(HAS_SKELETON);

        // _frag derives the 8-bone path from HAS_SKELETON_8 in the composed feature mask.
        expect(stdSkeletonExt._frag(HAS_SKELETON)._vertexAttributes).toHaveLength(2);
        expect(stdSkeletonExt._frag(HAS_SKELETON | HAS_SKELETON_8)._vertexAttributes).toHaveLength(4);
    });
});

/** Minimal mock of `GPURenderPassEncoder.setVertexBuffer` that records each call. */
function mockPass() {
    const calls: { slot: number; buffer: unknown; offset?: number }[] = [];
    const pass = {
        setVertexBuffer(slot: number, buffer: unknown, offset?: number) {
            calls.push({ slot, buffer, offset });
        },
    } as unknown as GPURenderPassEncoder;
    return { pass, calls };
}

/** Build a mesh with a mock skeleton. `eightBone` toggles joints1/weights1 presence. */
function meshWithSkeleton(eightBone: boolean) {
    const boneView = { id: "boneView" };
    const boneTexture = { createView: () => boneView } as unknown as GPUTexture;
    const skeleton = {
        boneTexture,
        jointsBuffer: { id: "jointsBuf" } as unknown as GPUBuffer,
        weightsBuffer: { id: "weightsBuf" } as unknown as GPUBuffer,
        joints1Buffer: eightBone ? ({ id: "joints1Buf" } as unknown as GPUBuffer) : null,
        weights1Buffer: eightBone ? ({ id: "weights1Buf" } as unknown as GPUBuffer) : null,
    };
    const mesh = { skeleton } as unknown as Mesh;
    return { mesh, skeleton, boneView };
}

describe("stdSkeletonExt._bind (group 1, afterBase)", () => {
    it("pushes the bone-texture view at the incoming binding and returns the next binding", () => {
        const { mesh, boneView } = meshWithSkeleton(false);
        const entries: GPUBindGroupEntry[] = [];

        // Base bindings (mesh UBO=0, material UBO=1, ...) already consumed bindings 0..3, so the
        // bone texture lands at binding 4 (the afterBase ext-bind slot).
        const next = stdSkeletonExt._bind!({} as StandardMaterialProps, entries, 4, mesh);

        expect(next).toBe(5);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toEqual({ binding: 4, resource: boneView });
    });
});

describe("stdSkeletonExt._bindVertexBuffers", () => {
    it("binds joints then weights for the 4-bone path and returns the next slot", () => {
        const { mesh, skeleton } = meshWithSkeleton(false);
        const { pass, calls } = mockPass();

        // Base attrs (pos/normal/uv/uv2) consumed slots 0..3; skinning buffers bind at 4,5.
        const next = stdSkeletonExt._bindVertexBuffers!(mesh, pass, 4);

        expect(next).toBe(6);
        expect(calls).toEqual([
            { slot: 4, buffer: skeleton.jointsBuffer, offset: undefined },
            { slot: 5, buffer: skeleton.weightsBuffer, offset: undefined },
        ]);
    });

    it("also binds joints1/weights1 (in order) for the 8-bone path", () => {
        const { mesh, skeleton } = meshWithSkeleton(true);
        const { pass, calls } = mockPass();

        const next = stdSkeletonExt._bindVertexBuffers!(mesh, pass, 2);

        expect(next).toBe(6);
        expect(calls).toEqual([
            { slot: 2, buffer: skeleton.jointsBuffer, offset: undefined },
            { slot: 3, buffer: skeleton.weightsBuffer, offset: undefined },
            { slot: 4, buffer: skeleton.joints1Buffer, offset: undefined },
            { slot: 5, buffer: skeleton.weights1Buffer, offset: undefined },
        ]);
    });

    it("binds nothing and leaves the slot untouched when the mesh has no skeleton", () => {
        const mesh = { skeleton: null } as unknown as Mesh;
        const { pass, calls } = mockPass();

        const next = stdSkeletonExt._bindVertexBuffers!(mesh, pass, 3);

        expect(next).toBe(3);
        expect(calls).toHaveLength(0);
    });
});
