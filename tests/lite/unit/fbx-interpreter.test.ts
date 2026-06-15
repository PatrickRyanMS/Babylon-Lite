import { describe, it, expect } from "vitest";
import { parseBinaryFBX } from "../../../packages/babylon-lite/src/loader-fbx/parsers/fbx-binary-parser.js";
import { interpretFBX, type FBXScene } from "../../../packages/babylon-lite/src/loader-fbx/interpreter/fbx-interpreter.js";
import type { FBXNode } from "../../../packages/babylon-lite/src/loader-fbx/types/fbx-types.js";
import { fbxAssetsAvailable, readFbxModel } from "../fbx-assets";

/** Copy bytes into a standalone ArrayBuffer that exactly matches the file bytes. */
function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
}

/** Read the model (local checkout or Babylon CDN) and run the engine-agnostic interpreter. */
async function interpret(name: string): Promise<FBXScene> {
    return interpretFBX(parseBinaryFBX(toArrayBuffer(await readFbxModel(name))));
}

/** Depth-first search for the first node with the given name. */
function findNode(nodes: readonly FBXNode[], nodeName: string): FBXNode | undefined {
    for (const node of nodes) {
        if (node.name === nodeName) {
            return node;
        }
        const child = findNode(node.children, nodeName);
        if (child) {
            return child;
        }
    }
    return undefined;
}

/** Count the FBX polygons (faces) in a PolygonVertexIndex array (negative entries end a polygon). */
async function countPolygons(name: string): Promise<number> {
    const doc = parseBinaryFBX(toArrayBuffer(await readFbxModel(name)));
    const pvi = findNode(doc.nodes, "PolygonVertexIndex");
    expect(pvi).toBeDefined();
    const raw = pvi!.properties[0]!.value as Int32Array;
    let polygons = 0;
    for (let i = 0; i < raw.length; i++) {
        if (raw[i]! < 0) {
            polygons++;
        }
    }
    return polygons;
}

// Skip ONLY when there is neither a local Assets checkout NOR network (explicit OFFLINE=1);
// otherwise the models come from the local checkout or the Babylon CDN.
const SKIP_REAL = !fbxAssetsAvailable && process.env.OFFLINE === "1";

describe.skipIf(SKIP_REAL)("fbx interpreter — real models (local checkout or Babylon CDN)", () => {
    it("m01_cube_phong: single mesh model, triangulated geometry, one Phong material, raw transform", async () => {
        const scene = await interpret("m01_cube_phong.fbx");

        // Exactly one root model, and it carries attached geometry.
        expect(scene.rootModels.length).toBe(1);
        const root = scene.rootModels[0]!;
        expect(root.subType).toBe("Mesh");
        expect(root.geometry).toBeDefined();

        // Geometry triangulates into whole triangles with real positions.
        const geometry = root.geometry!;
        expect(geometry.indices.length).toBeGreaterThan(0);
        expect(geometry.indices.length % 3).toBe(0);
        expect(geometry.positions.length).toBeGreaterThan(0);
        expect(geometry.positions.length % 3).toBe(0);

        // Exactly one material, and it is a Phong surface (has a specular color).
        expect(scene.materials.length).toBe(1);
        const material = scene.materials[0]!;
        expect(material.type).toBe("Phong");
        expect(material.properties.specularColor).toBeDefined();
        expect(material.properties.specularColor!.length).toBe(3);

        // The model carries raw transform fields (numbers only — no matrices are built in this phase).
        for (const triple of [
            root.translation,
            root.rotation,
            root.scale,
            root.preRotation,
            root.postRotation,
            root.rotationPivot,
            root.scalingPivot,
            root.geometricTranslation,
            root.geometricScaling,
        ]) {
            expect(Array.isArray(triple)).toBe(true);
            expect(triple.length).toBe(3);
            for (const component of triple) {
                expect(typeof component).toBe("number");
            }
        }
        expect(typeof root.rotationOrder).toBe("number");
        expect(typeof root.inheritType).toBe("number");
    });

    it("m02_geo_ngons: n-gons triangulate to more triangles than faces, no throw", async () => {
        const scene = await interpret("m02_geo_ngons.fbx");
        expect(scene.geometries.length).toBeGreaterThan(0);

        const geometry = scene.geometries[0]!;
        const triangleCount = geometry.indices.length / 3;
        expect(geometry.indices.length % 3).toBe(0);
        expect(triangleCount).toBeGreaterThan(0);

        // Triangulation must produce strictly more triangles than the source polygons (n-gons were split).
        const polygonCount = await countPolygons("m02_geo_ngons.fbx");
        expect(polygonCount).toBeGreaterThan(0);
        expect(triangleCount).toBeGreaterThan(polygonCount);
    });

    it("m07_multimaterial: per-triangle material indices with >=2 distinct values, model has >=2 materials", async () => {
        const scene = await interpret("m07_multimaterial.fbx");
        expect(scene.geometries.length).toBeGreaterThan(0);

        const geometry = scene.geometries[0]!;
        expect(geometry.materialIndices).not.toBeNull();
        const distinct = new Set(Array.from(geometry.materialIndices!));
        expect(distinct.size).toBeGreaterThanOrEqual(2);
        expect(geometry.materialIndices!.length).toBe(geometry.indices.length / 3);

        // At least one model is assigned two or more materials.
        const maxModelMaterials = Math.max(...scene.rootModels.map((m) => m.materials.length));
        expect(maxModelMaterials).toBeGreaterThanOrEqual(2);
    });

    it("m16: Y-up / Z-up / unit-scaled models expose distinct global settings", async () => {
        const yup = await interpret("m16_axis_yup.fbx");
        const zup = await interpret("m16_axis_zup.fbx");
        const units = await interpret("m16_units_254.fbx");

        // Baseline Y-up scene: up = Y (1), front = Z (2), unit scale 1.
        expect(yup.upAxis).toBe(1);
        expect(yup.frontAxis).toBe(2);
        expect(yup.unitScaleFactor).toBeCloseTo(1, 6);

        // Z-up scene: up becomes Z (2), and the front axis / sign differ from the Y-up baseline.
        expect(zup.upAxis).toBe(2);
        expect(zup.upAxis).not.toBe(yup.upAxis);
        expect(zup.frontAxis).not.toBe(yup.frontAxis);
        expect(zup.frontAxisSign).toBe(-1);
        expect(zup.unitScaleFactor).toBeCloseTo(1, 6);

        // Unit-scaled scene: same axes as Y-up baseline, but unit scale factor ~2.54 (inches → cm).
        expect(units.upAxis).toBe(yup.upAxis);
        expect(units.frontAxis).toBe(yup.frontAxis);
        expect(units.unitScaleFactor).toBeCloseTo(2.54, 4);
        expect(units.unitScaleFactor).not.toBeCloseTo(yup.unitScaleFactor, 2);
    });

    it("m15_camera_lights: at least one camera and one light with sane fov / light type", async () => {
        const scene = await interpret("m15_camera_lights.fbx");

        expect(scene.cameras.length).toBeGreaterThanOrEqual(1);
        for (const camera of scene.cameras) {
            expect(Number.isFinite(camera.fieldOfView)).toBe(true);
            expect(camera.fieldOfView).toBeGreaterThan(0);
            expect(camera.fieldOfView).toBeLessThan(180);
            expect(camera.projectionType === "perspective" || camera.projectionType === "orthographic").toBe(true);
        }

        expect(scene.lights.length).toBeGreaterThanOrEqual(1);
        for (const light of scene.lights) {
            // FBX light type: 0=Point, 1=Directional, 2=Spot.
            expect([0, 1, 2]).toContain(light.lightType);
            expect(light.color.length).toBe(3);
        }
    });

    it("exposes _objectMap (with objects) and _propertyTemplates for lazy feature extraction", async () => {
        const scene = await interpret("m01_cube_phong.fbx");
        expect(scene._objectMap).toBeDefined();
        expect(scene._objectMap.objects.size).toBeGreaterThan(0);
        expect(scene._propertyTemplates).toBeInstanceOf(Map);
    });
});
