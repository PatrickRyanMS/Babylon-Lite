/** glTF animation feature.
 *  Triggered when the asset has any animations. Per-asset hook parses clips,
 *  binds them to the uploaded meshes, and returns AnimationGroups. */

import type { GltfFeature } from "./gltf-feature.js";
import type { EngineContext } from "../engine/engine.js";

const feature: GltfFeature = {
    id: "_animations",
    async applyAsset(meshes, _root, ctx) {
        const [{ parseAnimationData }, { createAnimationGroups, tickAnimation }] = await Promise.all([import("./gltf-animation.js"), import("../animation/animation-group.js")]);
        const animData = parseAnimationData(ctx._json, ctx._binChunk, meshes, ctx._parentMap, ctx._worldMatrixCache, ctx._nodeMap);
        if (!animData) {
            return {};
        }
        const animationGroups = createAnimationGroups(animData);
        // Stepper built here, inside the dynamically-loaded animation chunk, so the always-loaded
        // scene-core chunk never statically imports animation-group.ts (keeps it out of non-animated bundles).
        const _animationStep = (deltaMs: number, engine?: EngineContext): void => {
            for (const group of animationGroups) {
                tickAnimation(group, deltaMs, engine);
            }
        };
        return { animationGroups, _animationStep };
    },
};
export default feature;
