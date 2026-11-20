import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  float,
  fract,
  fwidth,
  min,
  oneMinus,
  positionLocal,
  positionView,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';

/**
 * A subdivided plane that shades its own grid and undulates on summed sine
 * waves.
 *
 * The grid is drawn in the fragment shader rather than built from line
 * geometry because GridHelper emits each line as a single full-width segment --
 * displacing its two endpoints would only tilt a straight line, never curve it.
 * Shading it also welds the lines to the surface however it deforms, and lets
 * the line weight stay constant in pixels.
 */
export function createWater({
  size,
  segments = 220,
  cell = 1,
  fadeNear,
  fadeFar,
  lineColor = 0xffffff,
  lineWeight = 1.0,
  drift = 0,
}) {
  // Pre-rotated so local XZ matches world XZ and we can displace Y directly.
  // `segments` per side. The waves' shortest wave is about 27 units long, so
  // a few units per segment keeps them smooth.
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  // Deliberately unrealistic: at 1 unit ~= 20 m, a physically-scaled 2 m swell
  // is invisible. This reads as gentle motion instead of vanishing.
  const amplitude = uniform(0.55);
  const speed = uniform(0.3);

  // Forward motion. The plane itself never moves -- only the pattern sampled
  // on it slides astern. Because the grid is built from fract() it repeats
  // forever, so there is nothing to run out of however long it runs, and no
  // seam to hide.
  const driftRate = uniform(drift);
  const planX = positionLocal.x.add(time.mul(driftRate));

  // Three waves at different wavelengths and headings, so the surface never
  // resolves into an obvious repeating pattern. Fed the drifting X too, so the
  // swell travels with the grid rather than standing still under it.
  const waveHeight = (x, z) => {
    const t = time.mul(speed);
    return sin(x.mul(0.16).add(t))
      .mul(0.5)
      .add(sin(z.mul(0.23).sub(t.mul(0.8))).mul(0.32))
      .add(sin(x.mul(0.09).add(z.mul(0.13)).add(t.mul(0.55))).mul(0.45))
      .mul(amplitude);
  };

  // Dividing by fwidth gives distance-to-line in pixels rather than world
  // units, so the grid holds a constant weight into the distance instead of
  // aliasing into moire.
  const gridMask = (spacing, weight) => {
    const c = vec2(planX, positionLocal.z).div(spacing);
    const d = abs(fract(c.sub(0.5)).sub(0.5)).div(fwidth(c));
    return oneMinus(smoothstep(float(0), weight, min(d.x, d.y)));
  };

  const material = new THREE.MeshBasicNodeMaterial();

  material.positionNode = vec3(
    positionLocal.x,
    positionLocal.y.add(waveHeight(planX, positionLocal.z)),
    positionLocal.z,
  );

  // With fadeNear equal to fadeFar the grid ends in a hard edge. smoothstep
  // is undefined when its edges meet, so that case gets a plain cut instead.
  // fadeShift moves the fade out by that many units. main.js sets it to how
  // much farther the camera is from the ship than in the start view, so the
  // grid around the ship fades at the same distance from the ship at any
  // zoom, and not only at the start view's distance.
  const fadeShift = uniform(0);
  const distance = positionView.length().sub(fadeShift);
  const fade =
    fadeFar > fadeNear
      ? oneMinus(smoothstep(float(fadeNear), float(fadeFar), distance))
      : step(distance, float(fadeFar));

  // Lines only, over nothing. There is no base surface colour: away from a
  // line the water renders black, so the grid reads as strokes on the
  // background rather than as a lit plane. It still writes depth, which is
  // what lets it occlude the hull below the waterline.
  const weight = uniform(lineWeight);
  material.colorNode = color(lineColor).mul(gridMask(float(cell), weight)).mul(fade);

  const water = new THREE.Mesh(geometry, material);
  water.userData.fadeShift = fadeShift;
  water.userData.amplitude = amplitude;
  water.userData.speed = speed;
  water.userData.lineWeight = weight;
  water.userData.drift = driftRate;
  water.userData.dispose = () => {
    geometry.dispose();
    material.dispose();
  };

  return water;
}
