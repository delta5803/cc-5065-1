// Shared scene + exposure setup used by the headless harness and the UI.
import { buildScene, makeCamera } from './scene.js';
import { ExposureController, zoneFromRect } from './exposure.js';

export const WIDTH = 96;
export const HEIGHT = 64;

export function defaultZoneA() {
  // Emitting zone of exposure A: a tall slab on the left of the board.
  return zoneFromRect(0.12, 0.10, 0.62, 0.92);
}
export function defaultZoneB() {
  // Exposure B grows the bright zone to the right; part of it is new area that
  // exposure A's table assigned zero probability to.
  return zoneFromRect(0.30, 0.06, 0.88, 0.94);
}

export function makeDefaultSetup({ width = WIDTH, height = HEIGHT, lightScale = 1, zone = null } = {}) {
  const scene = buildScene({
    lightScale,
    sphereMaterial: { roughness: 0.18, metallic: 0.85 },
  });
  const cam = makeCamera({ width, height });
  const controller = new ExposureController(scene, zone || defaultZoneA());
  return { scene, cam, controller };
}

export function boardFrontCamera(width, height) {
  return makeCamera({ width, height });
}
