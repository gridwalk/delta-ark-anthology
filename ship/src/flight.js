import { MathUtils, Spherical, Vector3 } from 'three/webgpu';

const DURATION = 1.2; // seconds for one flight

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Camera flights that take over from the orbit controls and hand back after.
 *
 * A flight moves the orbit target in a straight line and the camera's offset
 * from the target in spherical coordinates, so the camera swings around the
 * ship on an arc instead of cutting through it.
 */
export function createFlight(camera, controls) {
  let flight = null;

  const offsetOf = (position, target) =>
    new Spherical().setFromVector3(position.clone().sub(target));

  return {
    /** Flies to `position`, looking at `target`. */
    fly(position, target) {
      const fromTarget = controls.target.clone();
      const from = offsetOf(camera.position, fromTarget);
      const to = offsetOf(position, target);
      // The orbit controls cannot look exactly along the vertical, so end a
      // hair short of it, the same as the controls would clamp to.
      to.makeSafe();
      // Turn the short way round, not through the far side of the ship.
      let turn = to.theta - from.theta;
      if (turn > Math.PI) turn -= 2 * Math.PI;
      if (turn < -Math.PI) turn += 2 * Math.PI;

      flight = { fromTarget, toTarget: target.clone(), from, to, turn, t: 0 };
      controls.enabled = false;
    },

    /** Advances a flight. Returns true while a flight owns the camera. */
    update(delta) {
      if (!flight) return false;

      flight.t = Math.min(1, flight.t + delta / DURATION);
      const e = easeInOutCubic(flight.t);
      const { from, to } = flight;

      const target = new Vector3().lerpVectors(flight.fromTarget, flight.toTarget, e);
      const offset = new Spherical(
        MathUtils.lerp(from.radius, to.radius, e),
        MathUtils.lerp(from.phi, to.phi, e),
        from.theta + flight.turn * e,
      );
      camera.position.setFromSpherical(offset).add(target);
      controls.target.copy(target);
      camera.lookAt(target);

      if (flight.t >= 1) {
        flight = null;
        controls.enabled = true;
        // Sync the controls to where the flight left the camera.
        controls.update();
      }
      return true;
    },
  };
}
