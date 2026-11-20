import { PerspectiveCamera, Vector2, Vector3, WebGPURenderer, MathUtils } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { hideWindows } from './detail.js';

// A narrow field of view from far away: close to an orthographic projection,
// so each panel reads as a flat elevation, while the outline pass, which
// assumes perspective depth, still finds its edges.
const FOV = 8;
const MARGIN = 1.1; // breathing room around the ship in each panel

// Depth step, in world units, that starts to draw an edge in a panel. It
// reaches full strength at three times this. A module is 0.32 units deep, so a
// module standing one cell in front of another draws a full line. The main
// view's relative threshold works out near 1 unit at panel distances, which
// hid most of those steps.
const DEPTH_THRESHOLD = 0.08;

// The rectangle outline behind the ship in each panel, as a share of the
// panel's width and height, so it keeps the panel's aspect ratio.
const BACKDROP_SCALE = 0.7;

// How far the rectangle's centre may move from the panel's centre, as a
// share of the panel's width and height. At this limit its edge sits flush
// with the panel's edge, so it is never cut off.
const FOLLOW_LIMIT = 0.5 - BACKDROP_SCALE / 2;

// How quickly the rectangle closes on the pointer, per second. Higher is
// snappier.
const FOLLOW_RATE = 10;

// The fixed views, in panel order. `from` is the direction the camera looks
// from, `up` is the world direction that points up the panel, and `guide` is
// the direction of the centre line drawn behind the ship.
export const VIEWS = [
  // Bow-on, from dead ahead.
  { from: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), guide: 'horizontal' },
  // Broadside, from the starboard side, bow to the right.
  { from: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), guide: 'vertical' },
  // Plan, from straight overhead, bow pointing down.
  { from: new Vector3(0, 1, 0), up: new Vector3(-1, 0, 0), guide: 'horizontal' },
];

/**
 * Fixed-camera views of the ship, each drawn into its own canvas.
 *
 * The framing page owns the layout: it sends the screen rectangles of its
 * panel frames, and each view's canvas is laid over its rectangle. Every view
 * renders the same ship as the main view, so the highlight, the drop fill,
 * and the blink crawl all show in every panel. The canvases take no pointer
 * events, so they are never interactive.
 *
 * `buildPipeline(renderer, camera, options)` builds the frame for one camera,
 * the same way as the main view, but without the water. `bounds` is the box
 * to frame, in world space.
 */
export function createPanels({ buildPipeline, pixelRatio, bounds }) {
  const panels = [];
  let building = null;

  async function build() {
    for (const view of VIEWS) {
      const renderer = new WebGPURenderer({ antialias: false });
      renderer.setPixelRatio(pixelRatio);
      renderer.setClearColor(0x000000, 0);
      Object.assign(renderer.domElement.style, {
        position: 'fixed',
        pointerEvents: 'none',
        display: 'none',
      });
      document.body.appendChild(renderer.domElement);
      await renderer.init();

      const camera = new PerspectiveCamera(FOV, 1, 1, 1000);
      // The rectangle's centre, as an offset from the panel's centre in
      // shares of its size. It eases toward the pointer (see point()).
      const centre = uniform(new Vector2());
      // 1 while the pointer is over this panel and 0 otherwise. With it, the
      // cargo's strokes in this panel turn to the highlight colour and the
      // hull's to the guide colour.
      const hover = uniform(0);
      // No water in the panels: they are drawings of the ship alone.
      const { pipeline, setFocus } = buildPipeline(renderer, camera, {
        sea: false,
        depthThreshold: DEPTH_THRESHOLD,
        // One CSS pixel wide, like the other strokes. The width is in buffer
        // pixels, so it follows the pixel ratio.
        // Dotted, one CSS pixel per dot, like the CSS border of the frame.
        backdrop: { scale: BACKDROP_SCALE, width: pixelRatio, dot: pixelRatio, guide: view.guide, centre },
        // The tiles have their own fog push and line weight (see TUNE.tiles).
        tile: true,
        hover,
      });
      panels.push({
        view,
        renderer,
        camera,
        pipeline,
        setFocus,
        // The camera's distance to the centre of the ship. The fog band sits
        // around it (see frame()).
        focus: 0,
        centre,
        target: new Vector2(),
        hover,
        shown: false,
      });
    }
  }

  function frame(panel, width, height) {
    const { view, camera } = panel;
    camera.aspect = width / height;
    const { center, back, distance, fit, halfDepth } = fitView(
      view,
      bounds,
      FOV,
      camera.aspect,
      MARGIN,
    );

    camera.position.copy(center).addScaledVector(back, distance);
    panel.focus = distance;
    camera.up.copy(view.up);
    camera.lookAt(center);
    // Tight clip planes keep the depth buffer precise at this range, which the
    // outline's depth edges depend on.
    camera.near = Math.max(0.1, fit - 1);
    camera.far = distance + halfDepth + 1;
    camera.updateProjectionMatrix();
  }

  return {
    /** Lays the views over `rects` ([{ x, y, width, height }], CSS pixels). */
    async place(rects) {
      building ??= build();
      await building;

      panels.forEach((panel, n) => {
        const rect = rects[n];
        const canvas = panel.renderer.domElement;
        if (!rect || rect.width < 1 || rect.height < 1) {
          canvas.style.display = 'none';
          panel.shown = false;
          return;
        }
        Object.assign(canvas.style, {
          display: 'block',
          left: `${rect.x}px`,
          top: `${rect.y}px`,
        });
        panel.renderer.setSize(rect.width, rect.height);
        frame(panel, rect.width, rect.height);
        panel.shown = true;
      });
    },

    /**
     * Points panel `index`'s rectangle at (`x`, `y`), the pointer's place in
     * the panel as shares of its width and height from the top left. With x
     * null, the pointer has left: the rectangle goes back to the centre. The
     * centre is clamped so the rectangle stays whole inside the panel. While
     * the pointer is over a panel, that panel counts as hovered.
     */
    point(index, x, y) {
      const panel = panels[index];
      if (!panel) return;
      if (x === null || x === undefined) {
        panel.target.set(0, 0);
        panel.hover.value = 0;
        return;
      }
      panel.hover.value = 1;
      panel.target.set(
        MathUtils.clamp(x - 0.5, -FOLLOW_LIMIT, FOLLOW_LIMIT),
        MathUtils.clamp(y - 0.5, -FOLLOW_LIMIT, FOLLOW_LIMIT),
      );
    },

    /** Eases each rectangle toward its target. */
    update(delta) {
      const k = 1 - Math.exp(-FOLLOW_RATE * delta);
      for (const panel of panels) panel.centre.value.lerp(panel.target, k);
    },

    // The panels draw without the cargo's windows. The flag is shared with the
    // main view, so it is set for these renders only and cleared after.
    render() {
      hideWindows.value = 1;
      for (const panel of panels) {
        if (!panel.shown) continue;
        panel.setFocus(panel.focus);
        panel.pipeline.render();
      }
      hideWindows.value = 0;
    },

    dispose() {
      for (const panel of panels) {
        panel.renderer.setAnimationLoop(null);
        panel.renderer.dispose();
        panel.renderer.domElement.remove();
      }
      panels.length = 0;
    },
  };
}

/**
 * Where a camera must stand to frame `bounds` in `view`: on the view's
 * `from` axis, far enough back that the box fits a `fov`-degree field at
 * `aspect`, with `margin` to spare. The box's corners are projected onto the
 * view's own axes, so the fit holds for any view direction.
 *
 * Returns the box centre, the view's back axis, the camera's distance from
 * the centre, the distance to the box's near face (`fit`), and half the box's
 * depth along the line of sight.
 */
export function fitView(view, bounds, fov, aspect, margin) {
  const center = bounds.getCenter(new Vector3());

  // The camera's axes: back toward the camera, then right and up.
  const back = view.from;
  const right = new Vector3().crossVectors(view.up, back).normalize();
  const up = new Vector3().crossVectors(back, right);

  let halfWidth = 0;
  let halfHeight = 0;
  let halfDepth = 0;
  const corner = new Vector3();
  for (let n = 0; n < 8; n++) {
    corner.set(
      n & 1 ? bounds.max.x : bounds.min.x,
      n & 2 ? bounds.max.y : bounds.min.y,
      n & 4 ? bounds.max.z : bounds.min.z,
    ).sub(center);
    halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
    halfHeight = Math.max(halfHeight, Math.abs(corner.dot(up)));
    halfDepth = Math.max(halfDepth, Math.abs(corner.dot(back)));
  }

  const vfov = MathUtils.degToRad(fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  // Fit at the near face of the box, then step back to its centre.
  const fit = Math.max(halfWidth / Math.tan(hfov / 2), halfHeight / Math.tan(vfov / 2)) * margin;
  return { center, back, distance: fit + halfDepth, fit, halfDepth };
}
