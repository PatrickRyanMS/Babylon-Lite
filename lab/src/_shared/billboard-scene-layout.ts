// Shared camera + sprite layout for the billboard validation scenes 34/35/36.
// Both the BJS reference path and the Lite scene path consume this so the
// only thing that changes between the three scenes is the billboard variant
// (facing / yaw-locked / axis-locked) and the atlas frame index.

export const BILLBOARD_SCENE_LAYOUT = {
    clearColor: { r: 0.05, g: 0.07, b: 0.1, a: 1 } as const,
    groundColor: [0.18, 0.2, 0.22] as readonly [number, number, number],
    // ArcRotateCamera angles: beta=π/3 = 60° from world-Y = 30° downward tilt.
    camera: {
        alpha: -Math.PI / 2,
        beta: Math.PI / 3,
        radius: 10,
        target: { x: 0, y: 0.6, z: 0 } as const,
        fov: Math.PI / 4,
        near: 0.1,
        far: 50,
    } as const,
    // Five sprites at varying X / Y / Z so the orientation difference between
    // billboard variants is visible (sprites at different heights diverge most
    // under camera tilt).
    sprites: [
        { position: [-3.0, 0.8, 0] as readonly [number, number, number], sizeWorld: [1.6, 1.6] as readonly [number, number] },
        { position: [-1.5, 1.1, 1] as readonly [number, number, number], sizeWorld: [1.6, 1.6] as readonly [number, number] },
        { position: [0.0, 0.8, 0] as readonly [number, number, number], sizeWorld: [1.6, 1.6] as readonly [number, number] },
        { position: [1.5, 1.1, 1] as readonly [number, number, number], sizeWorld: [1.6, 1.6] as readonly [number, number] },
        { position: [3.0, 0.8, 0] as readonly [number, number, number], sizeWorld: [1.6, 1.6] as readonly [number, number] },
    ],
} as const;
