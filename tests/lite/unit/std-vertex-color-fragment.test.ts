import { describe, expect, it } from "vitest";

import { createStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-vertex-color-fragment.js";

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
