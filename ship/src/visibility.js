import { Float32BufferAttribute } from 'three/webgpu';
import { attribute, select, uniform } from 'three/tsl';

/**
 * Timed show and hide of the cargo containers.
 *
 * A change of the hover state changes which containers are in view. The
 * change is not instant. It is a fast build: containers that go away leave
 * from the top down, and containers that come back return from the bottom up.
 *
 * Each container has three values in the `vis` vertex attribute: the state
 * before the switch, the state after it (1 shown, 0 hidden), and the time of
 * the switch. The shader compares the time with `clock`, so a transition needs
 * one buffer upload when it starts and no work per frame. If a new transition
 * starts while one is still running, each container starts from the state it
 * shows at that moment.
 */

// Seconds since the page started. main.js sets it each frame.
export const clock = uniform(0);

// A node that is true while the container of this vertex is in view.
export const shownNode = () => {
  const vis = attribute('vis', 'vec3');
  return select(clock.greaterThanEqual(vis.z), vis.y, vis.x).greaterThan(0.5);
};

/** Adds the `vis` attribute to a cargo mesh from createCargo. All shown. */
export function initVisibility(cargo) {
  const { modules, moduleRanges } = cargo.userData;
  const count = cargo.geometry.attributes.position.count;
  const array = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    array[v * 3] = 1;
    array[v * 3 + 1] = 1;
  }
  cargo.geometry.setAttribute('vis', new Float32BufferAttribute(array, 3));
  cargo.userData.visibility = {
    from: new Uint8Array(modules.length).fill(1),
    to: new Uint8Array(modules.length).fill(1),
    at: new Float32Array(modules.length),
    ranges: moduleRanges,
  };
}

/**
 * Starts a transition to `target` (one flag per module, 1 shown) at time
 * `now`. Containers go away top down at `rate` layers per second, starting
 * at once. Containers come back bottom up at the same rate, starting after
 * `showDelay` seconds.
 *
 * Returns the seconds until the last container has gone away.
 */
export function transition(cargo, target, now, rate, showDelay = 0) {
  const state = cargo.userData.visibility;
  if (!state) return 0;
  const { modules } = cargo.userData;
  const { from, to, at, ranges } = state;

  const current = (n) => (now >= at[n] ? to[n] : from[n]);

  // The highest top of the containers that go away, and the lowest base of
  // the containers that come back. Each sweep starts there.
  let top = -Infinity;
  let base = Infinity;
  for (let n = 0; n < modules.length; n++) {
    const m = modules[n];
    const was = current(n);
    if (was && !target[n]) top = Math.max(top, m.y + m.h);
    if (!was && target[n]) base = Math.min(base, m.y);
  }

  let hideTime = 0;
  for (let n = 0; n < modules.length; n++) {
    const m = modules[n];
    const was = current(n);
    const next = target[n] ? 1 : 0;
    from[n] = was;
    to[n] = next;
    if (was === next) {
      at[n] = now;
    } else if (next === 0) {
      const delay = (top - (m.y + m.h)) / rate;
      at[n] = now + delay;
      hideTime = Math.max(hideTime, delay);
    } else {
      at[n] = now + showDelay + (m.y - base) / rate;
    }
  }

  const attribute = cargo.geometry.attributes.vis;
  const array = attribute.array;
  for (let n = 0; n < modules.length; n++) {
    const { start, count } = ranges[n];
    for (let v = start; v < start + count; v++) {
      array[v * 3] = from[n];
      array[v * 3 + 1] = to[n];
      array[v * 3 + 2] = at[n];
    }
  }
  attribute.needsUpdate = true;
  return hideTime;
}
