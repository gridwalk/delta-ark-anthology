/* Background scene for the table of contents.
 *
 * A three-dimensional lattice. Every point in the lattice is one of two things:
 * a wireframe rectangle at 16:9 standing in for a work, or a dot. There are
 * deliberately more lattice points than works, so the surplus reads as empty
 * slots waiting to be filled.
 *
 * Hovering a row in the table of contents flies the camera to that artist's
 * placeholder and frames it. Releasing returns to the overview.
 *
 * The artist count arrives via data-count on the canvas, so the scene stays in
 * step with the build without hardcoding a number.
 */

import * as THREE from 'three';
import { LineSegments2 } from './vendor/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from './vendor/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from './vendor/jsm/lines/LineMaterial.js';

// ── Lattice ──────────────────────────────────────────────────────────────────

const RECT_W = 1.6; // 16:9, the aspect every placeholder holds
const RECT_H = 0.9;

const GAP_X = 2.6;
const GAP_Y = 1.9;
const GAP_Z = 2.6;

const HOME = new THREE.Vector3(0, 0, 22);
const FRAME_MARGIN = 1.3; // headroom around a framed placeholder
const EASE = 0.2; // camera catch-up per frame — high, so the move reads as fast

/* Base lattice. Deeper on Z than it is tall so the grid reads as receding
   rather than as a wall. Grows on Z alone if a build ever exceeds it. */
function latticeDims(count) {
  const dims = { x: 7, y: 4, z: 5 };
  while (dims.x * dims.y * dims.z < count) dims.z += 1;
  return dims;
}

/* Seeded so the arrangement is identical on every load. An unseeded shuffle
   would reshuffle the whole grid on each navigation, which reads as noise. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Ordered, not a set: position N in the returned array is artist N's slot, so
   a hovered row maps to a known placeholder. */
function pickSlots(total, wanted, rand) {
  const idx = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, wanted);
}

// ── Scene ────────────────────────────────────────────────────────────────────

function start(canvas) {
  const count = Number(canvas.dataset.count) || 0;

  // Palette comes from the stylesheet so the colors stay single-sourced.
  const css = getComputedStyle(document.documentElement);
  const color = (name, fallback) =>
    new THREE.Color((css.getPropertyValue(name) || '').trim() || fallback);

  const white = color('--white', '#ffffff');
  const gray = color('--neutral-gray', '#4f5557');
  const black = color('--black', '#111314');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return; // No WebGL — the page is fully readable without the backdrop.
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  // Light fog only: enough to give depth, not so much that it eats the lines.
  scene.fog = new THREE.FogExp2(black, 0.02);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.copy(HOME);

  const grid = new THREE.Group();
  scene.add(grid);

  const dims = latticeDims(count);
  const total = dims.x * dims.y * dims.z;
  const chosen = pickSlots(total, Math.min(count, total), mulberry32(0x5eed));
  const isRect = new Set(chosen);

  const spanX = (dims.x - 1) * GAP_X;
  const spanY = (dims.y - 1) * GAP_Y;
  const spanZ = (dims.z - 1) * GAP_Z;

  /* Lattice index -> local position. Must match the traversal order used to
     build the geometry, since slot numbers are shared between the two. */
  function slotPosition(i) {
    const iz = i % dims.z;
    const iy = Math.floor(i / dims.z) % dims.y;
    const ix = Math.floor(i / (dims.z * dims.y));
    return new THREE.Vector3(
      ix * GAP_X - spanX / 2,
      iy * GAP_Y - spanY / 2,
      iz * GAP_Z - spanZ / 2
    );
  }

  // Artist N's placeholder, in grid-local space.
  const rectAt = chosen.map(slotPosition);

  // Rectangles merge into a single line geometry — one draw call for all.
  const hw = RECT_W / 2;
  const hh = RECT_H / 2;
  const corners = [
    [-hw, -hh], [hw, -hh],
    [hw, -hh], [hw, hh],
    [hw, hh], [-hw, hh],
    [-hw, hh], [-hw, -hh],
  ];

  const rectVerts = [];
  const dotVerts = [];

  for (let i = 0; i < total; i++) {
    const p = slotPosition(i);
    if (isRect.has(i)) {
      for (const [cx, cy] of corners) rectVerts.push(p.x + cx, p.y + cy, p.z);
    } else {
      dotVerts.push(p.x, p.y, p.z);
    }
  }

  /* Drawn as screen-space quads rather than GL hairlines. A 1px hairline's
     pixel coverage flips on and off as the geometry moves, which is the crawl
     that MSAA alone cannot fix — MSAA antialiases a static edge, but the line
     is thinner than the sample grid can track between frames. A quad is a real
     surface with a stable, continuously-shaded edge, so it holds together in
     motion. alphaToCoverage feeds that soft edge through the multisampled
     target instead of hard-clipping it. */
  const rectGeo = new LineSegmentsGeometry();
  rectGeo.setPositions(rectVerts);

  /* Opaque, not transparent. Each rectangle is four separate quads meeting at
     coplanar corners; blended, those overlaps composite twice and their depth
     order flips as the lattice turns, which flickers at every corner. Opaque
     quads of identical color resolve to the same pixel whichever one wins, so
     the corner is stable. Brightness that opacity used to remove is taken out
     of the color instead. alphaToCoverage still antialiases the edges through
     the multisampled target. */
  const rectMat = new LineMaterial({
    color: white.clone().multiplyScalar(0.78),
    linewidth: 1.6, // device-independent pixels
    transparent: false,
    alphaToCoverage: true,
    dashed: false,
  });

  grid.add(new LineSegments2(rectGeo, rectMat));

  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(dotVerts, 3));
  grid.add(
    new THREE.Points(
      dotGeo,
      new THREE.PointsMaterial({
        color: gray,
        size: 0.07,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
      })
    )
  );

  // ── Camera targeting ───────────────────────────────────────────────────────

  /* Distance at which the placeholder just fills the frame. Depends on aspect,
     so it is recomputed rather than cached — a narrow window needs more room
     to fit the same 16:9 rectangle. */
  function frameDistance() {
    const half = THREE.MathUtils.degToRad(camera.fov) / 2;
    const fitH = hh / Math.tan(half);
    const fitW = hw / (Math.tan(half) * camera.aspect);
    return Math.max(fitH, fitW) * FRAME_MARGIN;
  }

  let focus = null; // artist index, or null for the overview

  const lookAt = new THREE.Vector3(0, 0, 0);
  const wantPos = new THREE.Vector3();
  const wantLook = new THREE.Vector3();
  const normal = new THREE.Vector3();
  /* Camera roll. Held as state so it eases like the position does — snapping
     the up vector would whip the frame around on the first hovered row. */
  const camUp = new THREE.Vector3(0, 1, 0);
  const wantUp = new THREE.Vector3();

  for (const link of document.querySelectorAll('.toc-link[data-index]')) {
    const i = Number(link.dataset.index);
    if (!Number.isInteger(i) || i >= rectAt.length) continue;
    const enter = () => { focus = i; };
    const leave = () => { focus = null; };
    link.addEventListener('pointerenter', enter);
    link.addEventListener('pointerleave', leave);
    // Keyboard parity: tabbing the list drives the camera the same way.
    link.addEventListener('focus', enter);
    link.addEventListener('blur', leave);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    // Quad-based lines need the viewport to convert linewidth into geometry.
    rectMat.resolution.set(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  resize();
  new ResizeObserver(resize).observe(canvas);

  let drift = 0;

  function render(t) {
    // Drift only in the overview — a rotating lattice would slide a framed
    // placeholder back out of view.
    if (focus === null) drift = t;

    grid.rotation.y = Math.sin(drift * 0.00006) * 0.55;
    grid.rotation.x = Math.sin(drift * 0.00004) * 0.18;

    if (focus === null) {
      wantPos.copy(HOME);
      wantLook.set(0, 0, 0);
      wantUp.set(0, 1, 0);
    } else {
      // Local -> world, so framing survives whatever rotation the drift left.
      grid.updateMatrixWorld();
      wantLook.copy(rectAt[focus]).applyMatrix4(grid.matrixWorld);
      normal.set(0, 0, 1).applyQuaternion(grid.quaternion);
      wantPos.copy(wantLook).addScaledVector(normal, frameDistance());
      /* Roll with the lattice rather than holding world up. The placeholder is
         tilted by the drift, so a world-up camera would frame it on an angle;
         sharing its up lands it square in frame. */
      wantUp.set(0, 1, 0).applyQuaternion(grid.quaternion);
    }

    camera.position.lerp(wantPos, EASE);
    lookAt.lerp(wantLook, EASE);
    camUp.lerp(wantUp, EASE).normalize();
    camera.up.copy(camUp);
    camera.lookAt(lookAt);

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(render);

  // Pause when the tab is hidden rather than burning frames in the background.
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : render);
  });
}

// Kick off last: start() reads the const config above, and those bindings are
// in the temporal dead zone until this point in the module body.
const canvas = document.getElementById('scene');
if (canvas) start(canvas);
