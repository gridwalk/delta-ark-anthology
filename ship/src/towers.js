import { Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, attribute, float, positionLocal, select, vec3 } from 'three/tsl';
import { buildTowers } from './cargo.js';
import { withoutWindows } from './detail.js';
import { clock } from './visibility.js';
import { exploded } from './explode.js';

/**
 * The towers that a lit chunk builds on top of its containers (see
 * buildTowers in cargo.js).
 *
 * A chunk builds its towers the first time it lights, and never again. The
 * towers stay after the hover ends. Each copy appears at its own `showAt`
 * time, so a tower grows from the bottom up. A tower writes the highlight
 * mask only while its own chunk is lit, so it is orange with its chunk and
 * white at other times, the same as the containers.
 *
 * `highlight` is the object from createHighlight, for its `active` group and
 * its `strength`.
 */
export function createTowers(highlight) {
  const material = new MeshBasicNodeMaterial();
  const shown = clock.greaterThanEqual(attribute('showAt', 'float'));
  // With its chunk lit, or with every module lit (see setAll in highlight.js).
  const lit = abs(attribute('group', 'float').sub(highlight.active))
    .lessThan(0.5)
    .or(highlight.all.greaterThan(0.5));
  // Green marks every cargo pixel, the same as the containers (highlight.js).
  material.colorNode = vec3(select(lit, highlight.strength, float(0)), 1, 0);
  material.positionNode = withoutWindows(select(shown, exploded(positionLocal), vec3(0, 0, 0)));

  const meshes = [];

  return {
    /**
     * Builds the towers of `group` on `cargo`, if that chunk has not built
     * yet. `litAt(n)` is the time that module n lights. `options` goes to
     * buildTowers: { odds, rate }.
     */
    build(cargo, group, origin, litAt, options) {
      const built = (cargo.userData.builtChunks ??= new Set());
      if (built.has(group)) return;
      built.add(group);
      const geometry = buildTowers(cargo, group, origin, litAt, options);
      if (!geometry) return;
      const mesh = new Mesh(geometry, material);
      cargo.add(mesh);
      meshes.push(mesh);
    },

    /** Removes every tower, for a new cargo. */
    clear() {
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
      meshes.length = 0;
    },

    dispose() {
      this.clear();
      material.dispose();
    },
  };
}
