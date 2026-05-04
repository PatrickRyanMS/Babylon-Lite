import { describe, it, expect } from "vitest";
import { shadowOnlyExt, createShadowOnlyFragment, writeShadowOnlyUBO } from "../../packages/babylon-lite/src/material/pbr/fragments/shadow-only-fragment";
import { PBR2_HAS_SHADOW_ONLY } from "../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { MAX_LIGHTS } from "../../packages/babylon-lite/src/light/types";
import type { PbrFragCtx } from "../../packages/babylon-lite/src/material/pbr/pbr-flags";
import type { PbrMaterialProps } from "../../packages/babylon-lite/src/material/pbr/pbr-material";

// Minimal PbrFragCtx stub — frag() only reads `features2`.
function makeCtx(features2: number): PbrFragCtx {
    return {
        features: 0,
        features2,
        hasIbl: false,
        hasAnyNormal: false,
        hasSpecularAA: false,
    };
}

describe("shadowOnlyExt.detect", () => {
    it("returns PBR2_HAS_SHADOW_ONLY only when mode === 'shadowOnly'", () => {
        expect(shadowOnlyExt.detect!({ mode: "shadowOnly" })).toEqual({ f: 0, f2: PBR2_HAS_SHADOW_ONLY });
    });

    it("returns no flags for lit material (no mode field)", () => {
        expect(shadowOnlyExt.detect!({})).toEqual({ f: 0, f2: 0 });
    });

    it("returns no flags for explicit lit/unlit/skybox modes", () => {
        for (const mode of ["lit", "unlit", "skybox"] as const) {
            expect(shadowOnlyExt.detect!({ mode })).toEqual({ f: 0, f2: 0 });
        }
    });
});

describe("shadowOnlyExt.frag", () => {
    it("returns null when PBR2_HAS_SHADOW_ONLY is not set", () => {
        expect(shadowOnlyExt.frag!(makeCtx(0))).toBeNull();
    });

    it("returns the shadow-only fragment when the flag is set", () => {
        const frag = shadowOnlyExt.frag!(makeCtx(PBR2_HAS_SHADOW_ONLY));
        expect(frag).not.toBeNull();
        expect(frag!.id).toBe("shadow-only");
    });
});

describe("createShadowOnlyFragment", () => {
    it("declares shadowOnlyColor (vec3) + shadowOnlyFalloff (f32) UBO fields", () => {
        const frag = createShadowOnlyFragment();
        expect(frag.uboFields).toEqual([
            { name: "shadowOnlyColor", type: "vec3<f32>" },
            { name: "shadowOnlyFalloff", type: "f32" },
        ]);
    });

    it("emits a BC slot that mins across MAX_LIGHTS shadowFactors entries", () => {
        const frag = createShadowOnlyFragment();
        const bc = frag.fragmentSlots?.BC ?? "";
        // One min(...) per light — simple, unambiguous proxy for full unrolling.
        for (let i = 0; i < MAX_LIGHTS; i++) {
            expect(bc).toContain(`shadowFactors[${i}]`);
        }
        expect(bc).toContain("color = material.shadowOnlyColor");
        expect(bc).toContain("alpha = saturate((1.0 - so_shadowMin) * material.shadowOnlyFalloff)");
    });
});

describe("writeShadowOnlyUBO", () => {
    // The ext's writeUbo is registered with the shape (data, mat, offsets) — match it.
    const offsets = new Map<string, number>([
        ["shadowOnlyColor", 0],
        ["shadowOnlyFalloff", 16],
    ]);

    it("writes color tint + falloff for shadowOnly materials", () => {
        const data = new Float32Array(8);
        const mat: PbrMaterialProps = { mode: "shadowOnly", color: [0.25, 0.5, 0.75], falloff: 2.5 };
        writeShadowOnlyUBO(data, mat, offsets);
        expect(Array.from(data.subarray(0, 3))).toEqual([0.25, 0.5, 0.75]);
        expect(data[4]).toBe(2.5);
    });

    it("uses documented defaults: color [0,0,0], falloff 1.0", () => {
        const data = new Float32Array(8);
        // Pre-fill with a sentinel to verify writes really happen.
        data.fill(9);
        const mat: PbrMaterialProps = { mode: "shadowOnly" };
        writeShadowOnlyUBO(data, mat, offsets);
        expect(Array.from(data.subarray(0, 3))).toEqual([0, 0, 0]);
        expect(data[4]).toBe(1);
    });

    it("is a no-op for non-shadowOnly modes (must not touch other UBO fields)", () => {
        const data = new Float32Array(8);
        data.fill(7);
        const lit: PbrMaterialProps = { baseColorTexture: undefined };
        writeShadowOnlyUBO(data, lit, offsets);
        expect(Array.from(data)).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);

        // Same for skybox/unlit variants.
        for (const mode of ["unlit", "skybox"] as const) {
            const d2 = new Float32Array(8);
            d2.fill(3);
            writeShadowOnlyUBO(d2, { mode } as PbrMaterialProps, offsets);
            expect(Array.from(d2)).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
        }
    });

    it("skips fields whose offsets are absent from the layout", () => {
        const data = new Float32Array(8);
        data.fill(5);
        // Empty offsets map — writes should be skipped entirely, no crash.
        writeShadowOnlyUBO(data, { mode: "shadowOnly", color: [1, 1, 1], falloff: 2 }, new Map());
        expect(Array.from(data)).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
    });
});
