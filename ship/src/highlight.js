import { MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, attribute, float, positionLocal, select, uniform, vec3 } from 'three/tsl';
import { withoutWindows } from './detail.js';
import { clock, shownNode } from './visibility.js';

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
/**
 * Sets the light times for a fan-out over `group` of `cargo`, starting at
 * time `now`. The light starts at module `origin`, or at the module nearest
 * the group's centre when `origin` is null. Then it moves through touching
 * modules of the group, at `rate` hops a second, until the whole group is lit.
 *
 * Returns a function that gives the light time of module n.
 */
export function startFan(cargo, group, origin, now, rate) {
  const { modules, moduleGroup, moduleRanges, adjacency } = cargo.userData;
  const attribute = cargo.geometry.attributes.litAt;
  if (!attribute || !adjacency) return () => now;

  const members = [];
  for (let n = 0; n < modules.length; n++) if (moduleGroup[n] === group) members.push(n);
  if (!members.length) return () => now;

  if (origin === null || moduleGroup[origin] !== group) {
    const centre = [0, 0, 0];
    const mid = (m) => [m.i + m.fw / 2, m.y + m.h / 2, m.k + m.fd / 2];
    for (const n of members) mid(modules[n]).forEach((v, a) => (centre[a] += v / members.length));
    let best = Infinity;
    for (const n of members) {
      const p = mid(modules[n]);
      const d = (p[0] - centre[0]) ** 2 + (p[1] - centre[1]) ** 2 + (p[2] - centre[2]) ** 2;
      if (d < best) {
        best = d;
        origin = n;
      }
    }
  }

  // Hops from the origin, through touching modules of the group only.
  const hops = new Map([[origin, 0]]);
  const queue = [origin];
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q];
    for (const o of adjacency[n]) {
      if (moduleGroup[o] !== group || hops.has(o)) continue;
      hops.set(o, hops.get(n) + 1);
      queue.push(o);
    }
  }
  const last = Math.max(...hops.values()) + 1;

  const array = attribute.array;
  for (const n of members) {
    const { start, count } = moduleRanges[n];
    // A module that the walk did not reach lights last.
    array.fill(now + (hops.get(n) ?? last) / rate, start, start + count);
  }
  attribute.needsUpdate = true;
  return (n) => now + (hops.get(n) ?? last) / rate;
}

export function createHighlight() {
  const active = uniform(-1);
  const strength = uniform(0);
  // 1 lights every module, whatever its group (see setAll).
  const all = uniform(0);
  let target = 0;

  const material = new MeshBasicNodeMaterial();
  // A module of the active group lights once the clock passes its `litAt`
  // time, so the light fans out over the chunk (see startFan).
  const lit = abs(attribute('group', 'float').sub(active))
    .lessThan(0.5)
    .or(all.greaterThan(0.5))
    .and(clock.greaterThanEqual(attribute('litAt', 'float')));
  // Green marks every cargo pixel, so the compositor can tell cargo edges
  // from hull edges (see compose's cargoColor).
  material.colorNode = vec3(select(lit, strength, float(0)), 1, 0);
  // Which containers are in view, and when they change, comes from
  // visibility.js.
  material.positionNode = withoutWindows(select(shownNode(), positionLocal, vec3(0, 0, 0)));

  return {
    material,
    strength,
    active,
    all,

    /**
     * Lights every module with `on`, on top of the lit group, at the
     * highlight's strength. With `on` false, only the lit group stays lit.
     */
    setAll(on) {
      all.value = on ? 1 : 0;
    },

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
