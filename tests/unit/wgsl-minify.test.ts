import { describe, expect, it } from "vitest";
import { mangleInlineWgsl, minifyTemplateWgsl } from "../../scripts/bundle-scenes-core";

describe("bundle WGSL minifier", () => {
    it("keeps generated shader interface fields stable", () => {
        const source = `
const shader = \`
@vertex fn main() -> VertexOutput {
    var out: VertexOutput;
    let worldPos4 = mesh.world * vec4<f32>(position, 1.0);
    out.worldPos = worldPos4.xyz;
    return out;
}
@fragment fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    let V = normalize(scene.vEyePosition.xyz - input.worldPos);
    return vec4<f32>(V, 1.0);
}
\`;
`;

        const out = minifyTemplateWgsl(source);

        expect(out).toContain("out.worldPos=");
        expect(out).toContain("input.worldPos");
        expect(out).not.toContain("out.wp=");
        expect(out).not.toContain("input.wp");
    });

    it("keeps reserved PBR/NME identifiers stable while shortening safe shader names", () => {
        const source = `
const socketName = "worldNormal";
const clearcoatName = "ccNormalW";
const shader = \`
fn demo(nme_pbr_distGGX: f32, finalIrradiance: vec3<f32>) -> vec3<f32> {
    let colorSpecEnvReflectance = finalIrradiance * vec3<f32>(1.0);
    let baseSpecEnvReflectance = vec3<f32>(nme_pbr_distGGX);
    let ccNormalW = vec3<f32>(0.0, 1.0, 0.0);
    return colorSpecEnvReflectance + baseSpecEnvReflectance + ccNormalW;
}
\`;
`;

        const out = mangleInlineWgsl(minifyTemplateWgsl(source));

        expect(out).toContain(`"worldNormal"`);
        expect(out).toContain(`"ccNormalW"`);
        expect(out).toContain("pDG");
        expect(out).toContain("bser");
        expect(out).toContain("fi");
        expect(out).toContain("colorSpecEnvReflectance");
        expect(out).toContain("ccNormalW");
        expect(out).not.toContain(`"wnm"`);
        expect(out).not.toContain(`"cnw"`);
        expect(out).not.toContain("nme_pbr_distGGX");
        expect(out).not.toContain("baseSpecEnvReflectance");
        expect(out).not.toContain("finalIrradiance");
        expect(out).not.toContain("vec3<f32>(1.0)");
    });
});
