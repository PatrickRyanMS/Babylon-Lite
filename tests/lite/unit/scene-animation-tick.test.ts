import { describe, expect, it } from "vitest";

import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { tickAnimation } from "../../../packages/babylon-lite/src/animation/animation-group";
import type { AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import type { AnimationController } from "../../../packages/babylon-lite/src/skeleton/skeleton-updater";
import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

// Mirrors the per-frame stepper the glTF loader attaches to the AssetContainer.
function makeStep(groups: AnimationGroup[]): (deltaMs: number, engine?: EngineContext) => void {
    return (deltaMs, engine) => {
        for (const g of groups) {
            tickAnimation(g, deltaMs, engine);
        }
    };
}

// Minimal animation controller that advances its own clock when playing. It deliberately
// starts with stale playback state (speedRatio 1, playing true) so the test can verify the
// stepper syncs the group's state into the controller before ticking, and writes the
// advanced time back to group.currentFrame afterwards.
function makeStubController(): AnimationController {
    const ctrl = {
        time: 0,
        playing: true,
        speedRatio: 1,
        loop: true,
        tick(deltaMs: number): void {
            if (ctrl.playing) {
                ctrl.time += (deltaMs / 1000) * ctrl.speedRatio;
            }
        },
    };
    return ctrl as AnimationController;
}

function makeGroup(ctrl: AnimationController): AnimationGroup {
    return {
        name: "test",
        duration: 100,
        frameRate: 60,
        isPlaying: true,
        currentFrame: 0,
        speedRatio: 3,
        loopAnimation: true,
        weight: 1,
        _ctrl: ctrl,
        _stopped: false,
    };
}

function makeScene(): SceneContext {
    return {
        surface: { engine: {} },
        animationGroups: [],
        _beforeRender: [],
        camera: undefined,
    } as unknown as SceneContext;
}

describe("Scene animation tick (addToScene render-loop wiring)", () => {
    it("writes the advanced controller time back to group.currentFrame each frame", () => {
        const ctrl = makeStubController();
        const group = makeGroup(ctrl);
        const scene = makeScene();
        const container = { entities: [], animationGroups: [group], _animationStep: makeStep([group]) } as unknown as AssetContainer;

        addToScene(scene, container);
        expect(scene._beforeRender).toHaveLength(1);

        // Simulate a 1s frame. The group plays at 3x, so the controller must advance to 3s and
        // that value must be written back to group.currentFrame. Before the fix, the render loop
        // called the controller directly (no speed sync, no writeback) and currentFrame stayed 0.
        scene._beforeRender[0]!(1000);
        expect(group.currentFrame).toBeCloseTo(3);
    });

    it("does not advance a paused group", () => {
        const ctrl = makeStubController();
        const group = makeGroup(ctrl);
        group.isPlaying = false;
        const scene = makeScene();
        const container = { entities: [], animationGroups: [group], _animationStep: makeStep([group]) } as unknown as AssetContainer;

        addToScene(scene, container);
        scene._beforeRender[0]!(1000);
        expect(group.currentFrame).toBe(0);
    });
});
