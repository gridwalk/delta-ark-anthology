import { MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, attribute, float, positionLocal, select, uniform, vec3 } from 'three/tsl';
import { withoutWindows } from './detail.js';
import { shownNode } from './visibility.js';

const FADE = 0.12; // seconds for a highlight to come up or go down

/**
 * Lights one highlight group of the cargo at a time.
 *
 * The cargo's fill is black and never reaches the screen -- the compositor
 * only reads the scene pass's depth and normals -- so its colour output is
 * free to carry a mask. This material writes the active group's strength into
 * the red channel and zero everywhere else, and the compositor paints the
 * highlight colour on the strokes wherever that mask is set.
 *
 * Reading the mask from the scene pass, not drawing a second pass, means
 * occlusion comes for free: a grouped module behind another module is not
 * the frontmost surface, so it never writes to the mask.
 *
 * While a group is lit, every other cargo module is hidden, except the ones
 * that chooseKept in cargo.js keeps. main.js sets which modules are in view,
 * and visibility.js times the change as a fast build. A hidden module's vertices all collapse onto one
 * point, as in modules.js, so its triangles rasterise to nothing. Doing it in
 * the vertex shader leaves the position buffer alone, so the fill and crawl
 * effects, which edit that buffer, never see it.
 */
export function createHighlight() {
  const active = uniform(-1);
  const strength = uniform(0);
  let target = 0;

  const material = new MeshBasicNodeMaterial();
  const lit = abs(attribute('group', 'float').sub(active)).lessThan(0.5);
  // Green marks every cargo pixel, so the compositor can tell cargo edges
  // from hull edges (see compose's cargoColor).
  material.colorNode = vec3(select(lit, strength, float(0)), 1, 0);
  // Which containers are in view, and when they change, comes from
  // visibility.js.
  material.positionNode = withoutWindows(select(shownNode(), positionLocal, vec3(0, 0, 0)));

  return {
    material,
    strength,

    /** Lights `group`, or clears the highlight when it is null. */
    set(group) {
      if (group === null || group === undefined || group < 0) {
        // Keep the group so it can fade out rather than vanish.
        target = 0;
        return;
      }
      // Switching straight from one group to another swaps at full strength,
      // so moving down the listing reads as one continuous highlight.
      active.value = group;
      target = 1;
    },

    update(delta) {
      const step = delta / FADE;
      strength.value =
        target > strength.value
          ? Math.min(target, strength.value + step)
          : Math.max(target, strength.value - step);
    },

    dispose() {
      material.dispose();
    },
  };
}
