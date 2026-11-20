import { Fn, float, floor, fract, max, mix, screenCoordinate, uniform, vec4 } from 'three/tsl';

/**
 * Ordered dither on the final frame.
 *
 * Each colour channel snaps to a small number of levels. A 4x4 Bayer pattern
 * moves the threshold from pixel to pixel, so a smooth gradient becomes a
 * fixed pattern of dots. The pattern stays fixed to the screen, so it does not
 * crawl when the camera moves.
 *
 * The frame is a line drawing, so most pixels are flat colour and do not
 * change. The dots show in the gradients: the depth fog, the sea grid as it
 * fades out, and the edges of the highlight fill.
 *
 * `params` holds uniforms, so the values can change while the page runs:
 * - `levels`: levels per channel. Fewer levels give a stronger effect.
 * - `dot`: dot size in buffer pixels.
 * - `strength`: 0 shows the original frame, 1 shows the full dither.
 *
 * Give this the frame after the tone mapping and the sRGB conversion. In
 * linear values, the steps are not even to the eye.
 */
export function createDitherParams({ levels = 4, dot = 1, strength = 1 } = {}) {
  return { levels: uniform(levels), dot: uniform(dot), strength: uniform(strength) };
}

export function dither(frame, params, skip = null) {
  // Threshold in [0, 1) for the 2x2 Bayer cell that `a` falls in.
  const bayer2 = (a) => {
    const p = floor(a);
    return fract(p.x.mul(0.5).add(p.y.mul(p.y).mul(0.75)));
  };

  return Fn(() => {
    const cell = screenCoordinate.xy.div(max(params.dot, float(1)));
    // 4x4 from two 2x2 levels: the coarse cell sets the high bits.
    const threshold = bayer2(cell.mul(0.5)).mul(0.25).add(bayer2(cell));

    const steps = max(params.levels.sub(1), float(1));
    const snapped = floor(frame.rgb.mul(steps).add(threshold)).div(steps);
    // `skip` (0 to 1) keeps the original frame, for pixels with their own
    // pattern already.
    const amount = skip ? params.strength.mul(skip.oneMinus()) : params.strength;
    return vec4(mix(frame.rgb, snapped, amount), frame.a);
  })();
}
