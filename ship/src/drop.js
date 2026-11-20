import { Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, positionLocal, select, uniform, vec3 } from 'three/tsl';
import { buildDrop } from './cargo.js';
import { withoutWindows } from './detail.js';

const RATE = 18; // layers per second that the fill front falls
const RETRACT = 3; // the front goes back this many times faster

/**
 * The drop fill under a lit group: copies of each floating module that stack
 * downward to the deck or to the next module of the group (see buildDrop).
 *
 * The copies are built once per hover as one mesh. A falling front, in layers
 * below each module, sweeps down from zero, and a copy shows once the front
 * has passed its `reach`. Copies the front has not reached collapse to a
 * point, the same trick highlight.js uses to hide modules.
 *
 * A fill does not vanish when the hover ends or moves to another group. Its
 * front goes back up, faster than it came down, and the mesh goes when the
 * front reaches zero. A new fill can wait before it starts, so the old
 * containers can leave first.
 *
 * `strength` is the highlight's strength, so the copies write the same mask
 * as the lit modules and get the same orange edges.
 */
export function createDrop(strength) {
  // Each fill has its own front, so one fill can go back while the next one
  // waits. { mesh, material, front, max, back }
  const fills = [];

  const remove = (entry) => {
    entry.mesh.removeFromParent();
    entry.mesh.geometry.dispose();
    entry.material.dispose();
  };

  const clear = () => {
    for (const entry of fills) remove(entry);
    fills.length = 0;
  };

  return {
    /**
     * Starts the fill under `group`, on a cargo mesh from createCargo. `kept`
     * holds the containers that stay in view (see chooseKept). The front
     * starts after `delay` seconds. Any earlier fill goes back.
     */
    start(cargo, group, kept, delay = 0) {
      this.retract();
      const geometry = buildDrop(cargo, group, kept);
      if (!geometry) return;

      const front = uniform(-delay * RATE);
      const material = new MeshBasicNodeMaterial();
      // Green marks the copies as cargo, the same as the modules (highlight.js).
      material.colorNode = vec3(strength, 1, 0);
      material.positionNode = withoutWindows(
        select(attribute('reach', 'float').greaterThan(front), vec3(0, 0, 0), positionLocal),
      );

      const mesh = new Mesh(geometry, material);
      cargo.add(mesh);
      const reach = geometry.attributes.reach.array;
      let max = 0;
      for (let v = 0; v < reach.length; v++) max = Math.max(max, reach[v]);
      fills.push({ mesh, material, front, max, back: false });
    },

    /**
     * Sends every fill back up. Returns the seconds until the last copy is
     * gone.
     */
    retract() {
      let time = 0;
      for (const entry of fills) {
        entry.back = true;
        time = Math.max(time, Math.max(entry.front.value, 0) / (RATE * RETRACT));
      }
      return time;
    },

    clear,

    update(delta) {
      for (let n = fills.length - 1; n >= 0; n--) {
        const entry = fills[n];
        if (entry.back) {
          entry.front.value -= delta * RATE * RETRACT;
          if (entry.front.value <= 0) {
            remove(entry);
            fills.splice(n, 1);
          }
        } else {
          // Capped, so a later retract takes no longer than the fill did.
          entry.front.value = Math.min(entry.front.value + delta * RATE, entry.max);
        }
      }
    },

    dispose: clear,
  };
}
