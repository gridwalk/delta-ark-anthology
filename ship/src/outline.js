import {
  Fn,
  abs,
  cameraFar,
  cameraNear,
  color,
  float,
  max,
  min,
  mix,
  perspectiveDepthToViewZ,
  clamp,
  floor,
  mod,
  pow,
  screenSize,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';

/**
 * Screen-space edge detection over a scene pass's depth and view-normal buffers.
 *
 * A Roberts cross (four diagonal taps) rather than a full 3x3 Sobel: half the
 * samples, and it yields a tighter one-pixel stroke, which is what we want for
 * a line look rather than a glow.
 *
 * Depth discontinuities give the outer contour and any overlapping silhouettes;
 * normal discontinuities give the interior creases (deck edge, transom, the
 * superstructure boxes) that depth alone can't see because they're continuous
 * surfaces.
 */
export function createOutline(scenePass, options = {}) {
  const thickness = uniform(options.thickness ?? 1.0);
  // Depth sensitivity is relative to view distance, so a far edge needs the
  // same proportional jump as a near one to register.
  const depthSensitivity = uniform(options.depthSensitivity ?? 0.012);
  // A fixed threshold in world units replaces the relative one when given.
  // For a distant, narrow camera the relative threshold grows with the
  // distance while the ship's detail does not, so it misses real steps
  // between modules; a fixed one keeps them.
  const depthThreshold =
    options.depthThreshold === undefined ? null : uniform(options.depthThreshold);
  const normalSensitivity = uniform(options.normalSensitivity ?? 0.35);

  const depthTexture = scenePass.getTextureNode('depth');
  const normalTexture = scenePass.getTextureNode('normal');

  const rawDepthAt = (coord) => depthTexture.sample(coord).r;
  const viewZAt = (coord) =>
    perspectiveDepthToViewZ(rawDepthAt(coord), cameraNear, cameraFar);
  const normalAt = (coord) => normalTexture.sample(coord).rgb;

  const taps = (coord) => {
    const texel = screenSize.reciprocal().mul(thickness);
    return [
      coord.add(texel.mul(vec2(-1, -1))),
      coord.add(texel.mul(vec2(1, 1))),
      coord.add(texel.mul(vec2(-1, 1))),
      coord.add(texel.mul(vec2(1, -1))),
    ];
  };

  const edge = Fn(() => {
    const center = uv();
    const [a, b, c, d] = taps(center);

    const deltaDepth = max(
      abs(viewZAt(a).sub(viewZAt(b))),
      abs(viewZAt(c).sub(viewZAt(d))),
    );
    const threshold = depthThreshold ?? viewZAt(center).abs().mul(depthSensitivity);
    const depthEdge = smoothstep(threshold, threshold.mul(3), deltaDepth);

    const deltaNormal = normalAt(a)
      .sub(normalAt(b))
      .abs()
      .add(normalAt(c).sub(normalAt(d)).abs());
    const normalEdge = smoothstep(
      normalSensitivity,
      normalSensitivity.mul(2),
      deltaNormal.x.add(deltaNormal.y).add(deltaNormal.z),
    );

    return max(depthEdge, normalEdge);
  })();

  // The nearest ship depth across the stroke's own footprint. A silhouette
  // stroke straddles the object boundary, so sampling depth at just the centre
  // pixel would read background on the outer half and mis-classify the stroke.
  const nearestShipDepth = Fn(() => {
    const center = uv();
    const [a, b, c, d] = taps(center);
    return min(
      min(rawDepthAt(center), rawDepthAt(a)),
      min(min(rawDepthAt(b), rawDepthAt(c)), rawDepthAt(d)),
    );
  })();

  return {
    edge,
    thickness,
    depthSensitivity,
    depthThreshold,
    normalSensitivity,
    /**
     * Composites the ship over `waterPass` by comparing depth rather than
     * masking by silhouette, so the water surface occludes the hull below the
     * waterline instead of the hull always winning.
     *
     * `submergedColor` defaults to `lineColor`, which makes every stroke in the
     * frame identical. Pass a dimmer colour to bring back a visible waterline.
     *
     * `highlightColor` colours the strokes of the lit group, wherever the
     * scene pass's red channel carries a highlight mask (see highlight.js).
     * The faces stay unfilled, so a lit module looks like a hovered panel's
     * cargo: the same drawing, with orange edges.
     *
     * `backdrop` ({ color, scale, width, guide, centre }) draws a rectangle
     * outline behind the ship, `scale` times the frame's width and height, so
     * it has the frame's own aspect ratio. It sits `centre` away from the
     * frame's centre (a vec2 uniform in shares of the frame's size), or on it
     * when there is no `centre`. Its line is `width` buffer pixels wide.
     * With `guide` set to 'horizontal' or 'vertical', it also draws a line of
     * the same width and colour through the rectangle's centre, edge to edge
     * of the frame, so the line always cuts the rectangle in half. With `dot`
     * (buffer pixels), both lines are dotted, one dot on and one off. Both draw
     * only on the background -- pixels where neither the ship nor the sea was
     * drawn -- so the ship always stands in front of them.
     *
     * `cargoColor` replaces the stroke colour on cargo edges only. The cargo
     * materials write 1 to the scene pass's green channel and the hull writes
     * 0, so an edge counts as cargo if any tap across its footprint is cargo.
     *
     * `fog` ({ near, far }, float uniforms in world units of view distance)
     * darkens everything with distance: full colour at `near`, black at
     * `far`. The optional `curve` uniform is a power on the fade, where 1 is
     * linear. The strokes, the sea, and the highlight
     * fill each use their own depth, so the ship and the sea fade as one.
     */
    compose(
      waterPass,
      lineColor = color(0xffffff),
      submergedColor = lineColor,
      highlightColor = null,
      backdrop = null,
      cargoColor = null,
      fog = null,
    ) {
      // 1 at fog.near, 0 at fog.far. Without fog, 1 everywhere.
      //
      // In this pass, cameraNear and cameraFar are the values of the
      // full-screen quad's camera, not of the view camera. Thus the fog uses
      // the near and far uniforms of the scene pass, which three.js keeps in
      // step with the view camera. The sea pass uses the same camera.
      const passNear = scenePass._cameraNear;
      const passFar = scenePass._cameraFar;
      const fogAt = (rawDepth) =>
        fog
          ? pow(
              clamp(
                fog.far
                  .add(perspectiveDepthToViewZ(rawDepth, passNear, passFar))
                  .div(fog.far.sub(fog.near)),
                0,
                1,
              ),
              fog.curve ?? float(1),
            )
          : float(1);

      const waterDepth = waterPass.getTextureNode('depth').sample(uv()).r;

      const waterInFront = step(waterDepth, rawDepthAt(uv()));
      const aboveWater = step(nearestShipDepth, waterDepth);

      let fill = waterPass.rgb.mul(waterInFront).mul(fogAt(waterDepth));
      // 1 on the backdrop's lines. They are dotted already, so the dither
      // must not touch them: two dot patterns on one line can cancel out.
      // compose() stores this as `this.undithered` (see main.js).
      let undithered = float(0);
      if (backdrop) {
        // Depth stays at the clear value, 1, where nothing was drawn.
        const empty = step(float(1), rawDepthAt(uv())).mul(step(float(1), waterDepth));
        const offset = uv().sub(0.5).mul(screenSize);
        const fromRect = backdrop.centre
          ? uv().sub(0.5).sub(backdrop.centre).mul(screenSize)
          : offset;
        const outer = screenSize.mul(backdrop.scale / 2);
        const inner = outer.sub(backdrop.width);
        const within = (half) =>
          step(abs(fromRect.x), half.x).mul(step(abs(fromRect.y), half.y));
        // Inside the outer edge and not inside the inner one.
        const frame = within(outer).sub(within(inner));
        // With `dot` set, every other dot of a line is off, the same as a CSS
        // 1px dotted border. `dot` is the dot size in buffer pixels. The dots
        // count along each line, not on a screen checkerboard. Thus a dot
        // covers the full width of the line, also when the line falls between
        // two pixel columns as the rectangle follows the pointer.
        const cell = backdrop.dot ? floor(uv().mul(screenSize).div(backdrop.dot)) : null;
        const dotsAlongX = cell ? mod(cell.x, 2).oneMinus() : float(1);
        const dotsAlongY = cell ? mod(cell.y, 2).oneMinus() : float(1);
        // The left and right sides run along y. The top and bottom run along x.
        const sides = within(outer).sub(within(vec2(inner.x, outer.y)));
        const ends = within(outer).sub(within(vec2(outer.x, inner.y)));
        const dots = max(sides.mul(dotsAlongY), ends.mul(dotsAlongX));
        fill = mix(fill, backdrop.color, frame.mul(empty).mul(dots));
        undithered = max(undithered, frame.mul(empty));

        if (backdrop.guide) {
          // The pixels from half a line width before the rectangle's centre up
          // to, but not including, half a line width after it, across the
          // axis. Half-open, so the line is exactly `width` pixels whether
          // the centre falls on a pixel or between two. The line follows the
          // rectangle, so it always cuts it in half, and still runs edge to
          // edge of the frame.
          const across = backdrop.guide === 'horizontal' ? fromRect.y : fromRect.x;
          const half = float(backdrop.width / 2);
          const guide = step(half.negate(), across).mul(step(half, across).oneMinus());
          // A horizontal guide runs along x, a vertical one along y.
          const guideDots = backdrop.guide === 'horizontal' ? dotsAlongX : dotsAlongY;
          fill = mix(fill, backdrop.color, guide.mul(empty).mul(guideDots));
          undithered = max(undithered, guide.mul(empty));
        }
      }
      let stroke = mix(submergedColor, lineColor, aboveWater);
      // The strongest mask value in `channel` around this pixel. A stroke
      // straddles the edge between two surfaces, as with nearestShipDepth, so
      // the mask under the stroke's centre can be the outside surface. Thus
      // this checks two rings of eight neighbours: one at one pixel, and one
      // at the stroke's own reach, so a thick stroke is covered to its outer
      // edge too.
      const maskTexture = scenePass.getTextureNode('output');
      const texel = screenSize.reciprocal();
      const reach = max(thickness.mul(1.5), float(1));
      const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
      const maskNear = (channel) => {
        const at = (offset) => maskTexture.sample(uv().add(offset))[channel];
        let value = at(vec2(0, 0));
        for (const [dx, dy] of ring) {
          value = max(value, at(texel.mul(vec2(dx, dy))));
          value = max(value, at(texel.mul(vec2(dx, dy)).mul(reach)));
        }
        return value;
      };
      if (cargoColor) {
        // Cargo is in the green channel.
        stroke = mix(stroke, cargoColor, maskNear('g'));
      }
      if (highlightColor) {
        // The lit group's strokes take the highlight colour, the same edge
        // look as cargoColor. The mask is in the red channel, at the
        // highlight's strength, so the colour fades in and out with it.
        stroke = mix(stroke, highlightColor, maskNear('r').mul(waterInFront.oneMinus()));
      }
      stroke = stroke.mul(fogAt(nearestShipDepth));
      this.undithered = undithered;
      return vec4(fill.add(stroke.mul(edge)), 1);
    },
  };
}
