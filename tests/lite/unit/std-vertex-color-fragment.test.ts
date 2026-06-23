import { describe, expect, it } from "vitest";

import { createStdVertexColorFragment, stdVertexColorExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-vertex-color-fragment.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";

describe("std-vertex-color-fragment", () => {
    it("declares the tight RGB vertex-color attribute, varying, and slots", () => {
        const frag = createStdVertexColorFragment();

        expect(frag._id).toBe("std-vcolor");

        // Single tight float32x3 `color` vertex attribute (stride 12).
        expect(frag._vertexAttributes).toHaveLength(1);
        const attr = frag._vertexAttributes![0]!;
        expect(attr._name).toBe("color");
        expect(attr._type).toBe("vec3<f32>");
        expect(attr._gpuFormat).toBe("float32x3");
        expect(attr._arrayStride).toBe(12);

        // `vColor` vec3 varying.
        expect(frag._varyings).toHaveLength(1);
        const varying = frag._varyings![0]!;
        expect(varying._name).toBe("vColor");
        expect(varying._type).toBe("vec3<f32>");

        // VB vertex slot passes the attribute through to the varying.
        expect(frag._vertexSlots?.VB).toContain("out.vColor = color;");

        // AT fragment slot multiplies baseColor by the per-vertex color (pre-lighting).
        const at = frag._fragmentSlots?.AT;
        expect(at).toBeDefined();
        expect(at).toContain("input.vColor");
        expect(at).toContain("baseColor");
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

describe("stdVertexColorExt._bindVertexBuffers", () => {
    it("binds the color buffer at the incoming slot with the interleave offset and returns the next slot", () => {
        const colorBuffer = { id: "colorBuf" } as unknown as GPUBuffer;
        const mesh = { _gpu: { colorBuffer, _vbLayout: { _c: { _offset: 48 } } } } as unknown as Mesh;
        const { pass, calls } = mockPass();

        // Simulate the draw closure's generic loop body: base attrs (pos/normal/uv/uv2) already
        // consumed slots 0..3, so the color buffer should bind at slot 4 (matching the composer's
        // fragment vertex-attribute layout order) and the hook returns slot 5.
        const next = stdVertexColorExt._bindVertexBuffers!(mesh, pass, 4);

        expect(next).toBe(5);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ slot: 4, buffer: colorBuffer, offset: 48 });
    });

    it("uses an undefined offset for a tight (non-interleaved) color buffer", () => {
        const colorBuffer = { id: "colorBuf" } as unknown as GPUBuffer;
        const mesh = { _gpu: { colorBuffer } } as unknown as Mesh;
        const { pass, calls } = mockPass();

        const next = stdVertexColorExt._bindVertexBuffers!(mesh, pass, 2);

        expect(next).toBe(3);
        expect(calls).toEqual([{ slot: 2, buffer: colorBuffer, offset: undefined }]);
    });

    it("binds nothing and leaves the slot untouched when the mesh has no color buffer", () => {
        const mesh = { _gpu: { colorBuffer: null } } as unknown as Mesh;
        const { pass, calls } = mockPass();

        const next = stdVertexColorExt._bindVertexBuffers!(mesh, pass, 3);

        expect(next).toBe(3);
        expect(calls).toHaveLength(0);
    });

    it("preserves order when run as one binder in the draw closure's generic loop", () => {
        // Mirror the renderable's `for (const bind of vbBinders) { slot = bind(mesh, pass, slot); }`
        // with the real vertex-color binder plus a second stub binder, asserting each consumes the
        // next contiguous slot in iteration order.
        const colorBuffer = { id: "colorBuf" } as unknown as GPUBuffer;
        const jointBuffer = { id: "jointBuf" } as unknown as GPUBuffer;
        const mesh = { _gpu: { colorBuffer } } as unknown as Mesh;
        const { pass, calls } = mockPass();

        const stubBinder = (_m: Mesh, p: GPURenderPassEncoder, slot: number): number => {
            p.setVertexBuffer(slot++, jointBuffer);
            return slot;
        };
        const vbBinders = [stdVertexColorExt._bindVertexBuffers!, stubBinder];

        let slot = 2; // base attrs consumed slots 0..1
        for (const bind of vbBinders) {
            slot = bind(mesh, pass, slot);
        }

        expect(slot).toBe(4);
        expect(calls).toEqual([
            { slot: 2, buffer: colorBuffer, offset: undefined },
            { slot: 3, buffer: jointBuffer, offset: undefined },
        ]);
    });
});
