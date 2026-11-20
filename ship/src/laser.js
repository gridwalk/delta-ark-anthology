import { Line2NodeMaterial, Vector3 } from 'three/webgpu';
import { Line2 } from 'three/addons/lines/webgpu/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const FORWARD = new Vector3(0, 0, 1);

/**
 * A white line that shoots out of a chosen chunk (see focusGroup in main.js).
 *
 * The line is one segment from 0 to 1 along +Z. The object's position,
 * rotation and z scale put it in place, so the growth animation only changes
 * the scale. Its width is in screen pixels, so it stays one thin line at any
 * distance.
 *
 * Add it to the sea scene: that pass draws lines in their own colour, and the
 * compositor hides it where the ship is in front of it.
 */
export function createLaser(scene, { width = 2 } = {}) {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 0, 0, 1]);
  const material = new Line2NodeMaterial({ color: 0xffffff, linewidth: width, worldUnits: false });
  const line = new Line2(geometry, material);
  line.visible = false;
  line.frustumCulled = false;
  scene.add(line);

  let length = 0;
  let goal = 0;
  let speed = 1;

  const apply = () => {
    line.scale.set(1, 1, Math.max(length, 1e-4));
    line.visible = length > 1e-3;
  };

  return {
    /** Shoots the line from `from` along unit vector `dir`, `to` units long, over `seconds`. */
    fire(from, dir, to, seconds) {
      line.position.copy(from);
      line.quaternion.setFromUnitVectors(FORWARD, dir);
      length = 0;
      goal = to;
      speed = to / seconds;
      apply();
    },

    /** Pulls the line back to its start over `seconds`. */
    retract(seconds) {
      goal = 0;
      speed = Math.max(length, 1e-3) / seconds;
    },

    update(delta) {
      if (length === goal) return;
      length = length < goal ? Math.min(goal, length + speed * delta) : Math.max(goal, length - speed * delta);
      apply();
    },

    dispose() {
      line.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
