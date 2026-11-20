import * as THREE from 'three/webgpu';
import { color, mix, mrt, normalView, output, pass, renderOutput, uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BEAM, createShip, LOA } from './ship.js';
import { createOutline } from './outline.js';
import { createWater } from './water.js';
import { createCrawl } from './crawl.js';
import { createFill } from './fill.js';
import { createModuleView } from './modules.js';
import { createHighlight, startFan } from './highlight.js';
import { createTowers } from './towers.js';
import { createLaser } from './laser.js';
import { createDrop } from './drop.js';
import { clock, isShown, transition } from './visibility.js';
import { GROUPING, chooseKept } from './cargo.js';
import { createPanels, fitView, VIEWS } from './panels.js';
import { createFlight } from './flight.js';
import { createDitherParams, dither } from './dither.js';
import { createSmearParams, smear } from './smear.js';

// Every stroke in the frame -- hull, cargo, water grid, above and below the
// waterline -- is drawn in this one colour at one weight.
const LINE_COLOR = 0xffffff;

// Fill for the cargo modules of the highlighted group. Matches the link hover
// colour of the anthology listing that frames this page, so a hovered name and
// its buildings read as one thing.
const HIGHLIGHT_COLOR = 0xf15a30;

// The rectangle and centre guide line behind the ship in the panel views. The
// anthology listing's sea green, the colour of the frames the panels sit in.
const GUIDE_COLOR = 0x00b49b;

// Full display resolution. Antialiasing stays off and the canvas keeps
// image-rendering: pixelated, so edges are hard rather than smoothed -- though
// at native scale there is no upscale left for the pixelated hint to act on,
// and the lo-fi character now comes from the missing AA alone.
const PIXEL_SCALE = Math.min(window.devicePixelRatio, 2);

// The look of the dither and the fog. The framing page can change these
// values while the page runs, with a 'ship:tune' message (see onMessage).
// TUNING: remove the message and the panel on the framing page when these
// values are final.
// - dither.levels: levels per colour channel.
// - dither.dot: dot size in CSS pixels.
// - dither.strength: 0 is the original frame, 1 is the full dither.
// - fog.front: full colour this far in front of the orbit target, in ship
//   lengths.
// - fog.back: black this far past the orbit target, in ship lengths.
// - fog.curve: the shape of the fade. 1 is linear. More than 1 darkens the
//   middle distance. Less than 1 brightens it.
// - cargo.keep: the share of the other containers that stay in view while a
//   group is lit. Only supported containers are candidates (see chooseKept).
//   A change shows on the next hover.
// - cargo.build: the speed of the fast build, in layers per second, when
//   containers go away or come back.
// - cargo.overlap: how much the new orange copies overlap the teardown. 0
//   waits for the last old container to go. 1 starts the copies at once.
// - tiles.fogPush: in the three tiles, the fog acts as if the ship were this
//   many ship lengths farther from the camera. More push gives a darker ship
//   with sparser dither dots.
// - tiles.lineWeight: the stroke weight in the three tiles, as a multiple of
//   the main view's weight. Thicker lines keep more of their shape through
//   the dither.
// - smear.step: pixels that the smear moves on each step.
// - smear.rects: the number of rectangles, up to 16.
// - smear.size: the largest rectangle, as a share of the smear area.
// - smear.clearBlack: 1 makes black pixels in the moved copy transparent, so
//   only the bright lines leave trails. 0 moves the whole copy.
// - camera.spin: the speed of the automatic rotation. 2 is one turn in 30
//   seconds, so 0.5 is one turn in 2 minutes. A negative value turns the
//   other way.
// - highlight.fan: the speed of the light's fan-out over a chunk, in hops
//   from container to container per second.
// - highlight.towerOdds: the odds that a container of a lit chunk, other
//   than the hovered one, builds a tower. Only containers with nothing above
//   them can build, and each chunk builds only once.
// - highlight.towerRate: how fast a tower grows, in layers per second.
// - camera.hold: seconds that the camera stays at a tile's view after a
//   flight, before it starts back to the start height.
// - camera.settle: how fast the camera goes back to the start height,
//   distance, and look-at point, per second. 0.25 covers most of the way in
//   about 10 seconds.
const TUNE = {
  dither: { levels: 2, dot: 1, strength: 1 },
  fog: { front: 1, back: 4.25, curve: 2.3 },
  cargo: { keep: 0.9, build: 40, overlap: 1 },
  tiles: { fogPush: 2.2, lineWeight: 3 },
  smear: { step: 1, rects: 16, size: 0.15, clearBlack: 1 },
  camera: { spin: 0.15, hold: 0, settle: 0.02 },
  highlight: { fan: 23, towerOdds: 0.25, towerRate: 20 },
};

// ?dither=1 puts an ordered dither on every view (see dither.js).
const DITHER = new URLSearchParams(window.location.search).get('dither') === '1'
  ? createDitherParams({ ...TUNE.dither, dot: TUNE.dither.dot * PIXEL_SCALE })
  : null;

// Depth fog, so the frame has a gradient for the dither: white near the
// camera, black far away. Each view has its own fog band around its focus
// distance (see buildPipeline), and all views share the curve. The fog is on
// only with the dither.
const fogCurve = uniform(TUNE.fog.curve);

// PROTOTYPE: the pixel smear on the main view, driven by the tile hover (see
// smear.js and the render loop).
const SMEAR = createSmearParams();
// The start values come from TUNE, so the page without the tuner uses them.
SMEAR.step.value = TUNE.smear.step;
SMEAR.rects.value = TUNE.smear.rects;
SMEAR.size.value = TUNE.smear.size;
SMEAR.clearBlack.value = TUNE.smear.clearBlack;

function applyTune(next) {
  for (const group of Object.keys(TUNE)) {
    for (const key of Object.keys(TUNE[group])) {
      const value = Number(next?.[group]?.[key]);
      if (Number.isFinite(value)) TUNE[group][key] = value;
    }
  }
  controls.autoRotateSpeed = TUNE.camera.spin;
  SMEAR.step.value = TUNE.smear.step;
  SMEAR.rects.value = TUNE.smear.rects;
  SMEAR.size.value = TUNE.smear.size;
  SMEAR.clearBlack.value = TUNE.smear.clearBlack;
  if (!DITHER) return;
  DITHER.levels.value = TUNE.dither.levels;
  DITHER.dot.value = Math.max(1, Math.round(TUNE.dither.dot * PIXEL_SCALE));
  DITHER.strength.value = TUNE.dither.strength;
  fogCurve.value = TUNE.fog.curve;
}

const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setPixelRatio(PIXEL_SCALE);
renderer.setSize(window.innerWidth, window.innerHeight);
// Transparent clear so the scene pass's alpha doubles as a silhouette mask.
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);
await renderer.init();

// The ship lives alone in its own scene: the outline pass keys off depth and
// normal discontinuities, and the sea grid's line geometry has no usable
// normals, so it would smear edges everywhere if it shared the pass.
const scene = new THREE.Scene();
const seaScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  500,
);
// Three-quarter view from off the port bow, looking aft down the stacks, so
// the bow points left on screen. From the orbit target: 22.4 units out, 32°
// off the bow, 15.6° up.
camera.position.set(18.29, 8.22, -11.43);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 2.2, 0);
controls.minDistance = 4;
controls.maxDistance = 120;
// A drag turns the camera around the ship, and the wheel zooms. There is no
// pan, so the ship stays in the middle. Between drags, the camera also turns
// slowly by itself. After a drag, it drifts back to the start view, the same
// as after a tile click (see settleCamera).
controls.enableRotate = true;
controls.enableZoom = true;
controls.enablePan = false;
controls.autoRotate = true;
let dragging = false;
controls.addEventListener('start', () => {
  dragging = true;
});
controls.addEventListener('end', () => {
  dragging = false;
  holdUntil = performance.now() / 1000 + TUNE.camera.hold;
});
controls.autoRotateSpeed = TUNE.camera.spin;

// The start view, which the camera always drifts back to (see settleCamera).
const START_TARGET = controls.target.clone();
const START_VIEW = new THREE.Spherical().setFromVector3(
  camera.position.clone().sub(controls.target),
);

// A solid surface, not just lines: the compositor occludes by depth, so the
// water needs to write depth everywhere, not only where a line happens to fall.
const water = createWater({
  // Big enough that the plane's own square edge stays outside the fade
  // circle in every view, so only the circle shows. On the artwork view the
  // camera is far out and the fade moves out with it (see fadeShift), so the
  // circle reaches about 170 units from the camera.
  size: LOA * 30,
  segments: 300, // about 2 units per segment
  cell: 2.5, // one cell per 50 m
  // A narrow fade: the grid holds full strength out to fadeNear, then falls
  // off over a short band to nothing at fadeFar. Wide enough to soften the
  // edge, not so wide that the grid reads as fading across the whole view.
  fadeNear: LOA * 3.2,
  fadeFar: LOA * 3.8,
  lineColor: LINE_COLOR,
  lineWeight: 1.1,
  // ~0.3 units/s at 20 m per unit is about 6 m/s, near a real container
  // ship's cruise. Slow enough to read as drift rather than motion.
  drift: 0.3,
});
seaScene.add(water);

const highlight = createHighlight();
const drop = createDrop(highlight.strength);
let litGroup = null;
// The chunk towers (see towers.js). Only the chunk grouping builds them.
const towers = createTowers(highlight);

const shipOptions = { cargoMaterial: highlight.material };
let ship = createShip(shipOptions);
scene.add(ship);

// ?ship=0 shows the sea alone, for pages that want the water as a backdrop
// without the ship. The ship still exists, so everything that reads it works.
const showShip = new URLSearchParams(window.location.search).get('ship') !== '0';
ship.visible = showShip;

// What the panel views frame: the whole ship, keel to the top of the stacks.
// The panels draw no water, so the hull below the waterline shows too.
// Measured now, before the fill collapses the cargo, which would shrink the
// box to the deck.
const panelBounds = new THREE.Box3();
const measureShip = () => {
  panelBounds.setFromObject(ship);
};
measureShip();

// The cargo layout is reseeded every load. Pin one you like with ?seed=N.
const announceSeed = () => {
  console.info(`cargo seed ${ship.userData.cargoSeed} — pin it with ?seed=${ship.userData.cargoSeed}`);
  const { groupCount, moduleCount } = ship.userData.cargo.userData;
  if (groupCount) console.info(`highlight groups: ${moduleCount} modules over ${groupCount} groups`);
};
announceSeed();

// The deck builds itself on load; the blink crawl only starts once it has,
// otherwise a walker would reveal modules the fill hasn't reached yet.
let view = createModuleView(ship.userData.cargo);
let fill = createFill(view, ship.userData.cargo);
let crawl = null;

// The panel rectangles the framing page last sent, so the panels can be
// framed again when the ship changes.
let panelRects = [];

// Replaces the ship with a freshly seeded one, which builds itself up from
// the deck as it does on load. Any lit group and its fill copies belong to
// the old layout, so they go. The new ship can stand taller or shorter, so
// the panel framing is measured again.
function respawn(create = createShip) {
  crawl?.dispose();
  drop.clear();
  towers.clear();
  highlight.set(null);
  litGroup = null;
  scene.remove(ship);
  ship.userData.dispose();
  scene.add((ship = create(shipOptions)));
  ship.visible = showShip;
  measureShip();
  view = createModuleView(ship.userData.cargo);
  fill = createFill(view, ship.userData.cargo);
  crawl = null;
  announceSeed();
  if (panelRects.length) panels.place(panelRects);
}

// The full frame for one camera: the ship's outline over the sea, with the
// highlight fill. The main view and every panel view are built with this, so
// they all draw the scene the same way.
//
// With `sea: false` the frame has no water: the sea pass draws an empty scene,
// so nothing occludes the hull and no grid shows. `depthThreshold` sets a
// fixed depth-edge threshold in world units (see createOutline). `backdrop`
// ({ scale, width, guide }) draws a rectangle outline and a centre guide line
// behind the ship, in the guide colour. `hover` (a uniform, 0 or 1) turns the
// cargo's strokes from the line colour to the highlight colour, and the
// hull's strokes to the guide colour.
const emptySea = new THREE.Scene();
// The outline's sample offset, in buffer pixels (see createOutline).
const LINE_THICKNESS = 0.44;
//
// With the dither on, the frame also gets a depth fog. The returned
// `setFocus(distance)` places the fog band around that distance from the
// camera: full colour TUNE.fog.front ship lengths before it, black
// TUNE.fog.back ship lengths past it. Call it each frame, so that a change to
// TUNE or to the camera shows immediately.
//
// With `tile`, the frame is one of the three tiles: it uses TUNE.tiles for
// the fog push and the line weight.
//
// `smearParams` puts the pixel smear on the frame (see smear.js).
function buildPipeline(target, viewCamera, { sea = true, depthThreshold, backdrop, hover, tile = false, smearParams = null } = {}) {
  const fog = DITHER ? { near: uniform(0), far: uniform(1), curve: fogCurve } : null;
  const setFocus = (focus) => {
    // Set here because setFocus runs each frame, so a dial change shows at once.
    if (tile) outline.thickness.value = LINE_THICKNESS * TUNE.tiles.lineWeight;
    if (!fog) return;
    // In a tile, the band moves closer to the camera, which has the same
    // effect as a ship farther away.
    const distance = tile ? focus - TUNE.tiles.fogPush * LOA : focus;
    fog.near.value = Math.max(distance - TUNE.fog.front * LOA, 0);
    fog.far.value = Math.max(distance + TUNE.fog.back * LOA, fog.near.value + 0.01);
  };

  const scenePass = pass(scene, viewCamera);
  scenePass.setMRT(mrt({ output, normal: normalView }));

  const seaPass = pass(sea ? seaScene : emptySea, viewCamera);

  // Stroke weight. This and the water's lineWeight aren't the same units -- the
  // outline's is a sample offset for the edge detector, the water's a half-width
  // in pixels -- so matching them is done by eye, not by using the same number.
  // Both weights are in buffer pixels, so they track PIXEL_SCALE: these are the
  // half-resolution values doubled, which keeps the on-screen width unchanged.
  const outline = createOutline(scenePass, { thickness: LINE_THICKNESS, depthThreshold });

  const line = hover ? mix(color(LINE_COLOR), color(GUIDE_COLOR), hover) : color(LINE_COLOR);

  const result = new THREE.RenderPipeline(target);
  const frame = outline.compose(
    seaPass,
    line,
    line,
    color(HIGHLIGHT_COLOR),
    backdrop ? { color: color(GUIDE_COLOR), ...backdrop } : null,
    hover ? mix(color(LINE_COLOR), color(HIGHLIGHT_COLOR), hover) : null,
    fog,
  );
  // The smear and the dither need display values, so apply the colour
  // transform first and tell the pipeline not to apply it again.
  result.outputColorTransform = false;
  let out = renderOutput(frame);
  // The smear goes before the dither, so the smeared image gets the dither
  // too.
  if (smearParams) out = smear(out, smearParams);
  // The tile backdrop lines are dotted already, so they skip the dither.
  if (DITHER) out = dither(out, DITHER, outline.undithered);
  result.outputNode = out;
  return { pipeline: result, outline, setFocus };
}

const { pipeline, outline, setFocus } = buildPipeline(renderer, camera, { smearParams: SMEAR });

// Fixed front, side, and top views, laid over frames on the framing page.
// Built only when a page asks for them, so the ship alone stays one view.
const panels = createPanels({ buildPipeline, pixelRatio: PIXEL_SCALE, bounds: panelBounds });

// The framing page drives the highlight: { type: 'ship:highlight', group: n }
// lights group n, and group: null clears it. Same origin only -- the groups
// are listing indices, so another page has no business setting them.
function onMessage(event) {
  if (event.origin !== window.location.origin) return;
  // { type: 'ship:panels', rects: [{ x, y, width, height }, ...] } lays the
  // front, side, and top views over those rectangles, in that order.
  // { type: 'ship:view', index } flies the main camera to the panel view at
  // that index: 0 front, 1 side, 2 top. The cargo layout stays the same. A
  // second click on the same tile soon after flies to the reverse view (see
  // viewForClick).
  // { type: 'ship:tune', dither: {...}, fog: {...} } sets the TUNE values.
  // { type: 'ship:focusCenter', x, y } is where, in viewport pixels, the
  // laser's end goes on the artwork view: the centre of the media box. null
  // is the middle of the window on that axis.
  if (event.data?.type === 'ship:focusCenter') {
    focusCenterX = Number.isFinite(event.data.x) ? event.data.x : null;
    focusCenterY = Number.isFinite(event.data.y) ? event.data.y : null;
    applyViewOffset();
    camera.updateProjectionMatrix();
    return;
  }
  // { type: 'ship:focus', group } fires the laser from that chunk and flies
  // the camera out along it. group: null goes back (see focusGroup).
  if (event.data?.type === 'ship:focus') {
    focusGroup(Number.isInteger(event.data.group) ? event.data.group : null);
    return;
  }
  if (event.data?.type === 'ship:tune') {
    applyTune(event.data);
    return;
  }
  if (event.data?.type === 'ship:view') {
    flyToView(viewForClick(event.data.index));
    return;
  }
  // { type: 'ship:cursor', index, x, y } points that panel's rectangle at the
  // pointer, given as shares of the panel from its top left; x: null centres
  // it again.
  if (event.data?.type === 'ship:cursor') {
    panels.point(event.data.index, event.data.x, event.data.y);
    return;
  }
  // { type: 'ship:panelClip', x } hides the tiles left of x, in viewport
  // pixels. x: null shows them whole (see clip in panels.js).
  if (event.data?.type === 'ship:panelClip') {
    panels.clip(event.data.x);
    return;
  }
  if (event.data?.type === 'ship:panels') {
    const rects = event.data.rects ?? [];
    panelRects = rects;
    panels.place(rects);
    // The panels cover the right side of the window, so the main view centres
    // itself on the space to their left.
    const shown = rects.filter((r) => r && r.width >= 1 && r.height >= 1);
    freeWidth = shown.length ? Math.min(...shown.map((r) => r.x)) : null;
    applyViewOffset();
    return;
  }
  if (event.data?.type !== 'ship:highlight') return;
  setGroup(event.data.group);
}

// Lights `group` on the ship, or clears the light with null. A hovered name
// in the listing and a hovered container on the ship both come here.
//
// `origin` is the module under the pointer, for a hover on the ship. The
// light fans out from it (see startFan). A name hover has no origin, so the
// light fans out from the chunk's centre.
function setGroup(group, origin = null) {
  const { cargo } = ship.userData;
  const next = Number.isInteger(group) && group >= 0 && group < cargo.userData.groupCount ? group : null;
  let litAt = null;
  if (next !== null && next !== litGroup) {
    litAt = startFan(cargo, next, origin, clock.value, TUNE.highlight.fan);
  }
  highlight.set(next);

  // With chunk groups, a hover lights the chunk's edges, and the first time
  // a chunk lights, it builds towers (see towers.js). Nothing hides or drops.
  if (GROUPING === 'chunks') {
    if (litAt) {
      towers.build(cargo, next, origin, litAt, {
        odds: TUNE.highlight.towerOdds,
        rate: TUNE.highlight.towerRate,
      });
    }
    litGroup = next;
    return;
  }

  // The drop fill restarts only when the lit group changes, so a repeated
  // message for the same group does not replay it.
  if (next === litGroup) return;
  litGroup = next;

  // A fast build from one set of containers to the next. The old drop fill
  // goes back up first. Containers that go away leave top down at once.
  // Containers that come back wait for the old fill to go, then return
  // bottom up. The new fill starts part way through the teardown, set by
  // TUNE.cargo.overlap, so the two read as one blend. A copy can show for a
  // moment next to an old container that has not gone yet.
  const now = clock.value;
  const retractTime = drop.retract();
  const { modules, moduleGroup } = cargo.userData;
  if (next === null) {
    transition(cargo, new Uint8Array(modules.length).fill(1), now, TUNE.cargo.build, retractTime);
    return;
  }
  const kept = chooseKept(cargo, next, TUNE.cargo.keep);
  const target = kept.map((k, n) => (k || moduleGroup[n] === next ? 1 : 0));
  const hideTime = transition(cargo, target, now, TUNE.cargo.build, retractTime);
  const overlap = Math.min(Math.max(TUNE.cargo.overlap, 0), 1);
  drop.start(cargo, next, kept, Math.max(hideTime, retractTime) * (1 - overlap));
}
window.addEventListener('message', onMessage);

// EXPERIMENT: two-way navigation. A container under the pointer lights its
// group, the same as a hover on that group's name, and the framing page
// marks the name with { type: 'ship:hover', group }.
//
// The pick casts a ray from the pointer against the grid box of each
// container in view. A hover hides some containers, so the ray can suddenly
// pass through to a container of another group. Thus a change waits a short
// time: PICK_SWITCH to go to another group, PICK_CLEAR to go to none. A
// short pass over a gap does not flicker the light.
// With chunk groups nothing hides, so the ray cannot jump, and the waits are
// short.
const PICK_SWITCH = GROUPING === 'chunks' ? 0.05 : 0.25; // seconds
const PICK_CLEAR = GROUPING === 'chunks' ? 0.1 : 0.35; // seconds
const pointer = { x: 0, y: 0, inside: false };
const pickRay = new THREE.Ray();
const pickInverse = new THREE.Matrix4();
const pickNdc = new THREE.Vector2();
const pickBox = new THREE.Box3();
const pickHit = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
let shipHover = null; // the group that the pointer lit, or null
let pickPending = null;
let pickSince = 0;

window.addEventListener('pointermove', (event) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.inside = true;
});

// On the artwork view (an artist is chosen), the orbit controls are off: no
// drag, zoom, or turn (see the render loop). The wheel goes to the framing
// page instead, so the page scrolls with the artwork text also when the
// pointer is over the ship. preventDefault stops the browser from also
// passing the wheel on by itself, which would scroll twice.
window.addEventListener(
  'wheel',
  (event) => {
    if (focused === null || window.parent === window) return;
    event.preventDefault();
    const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    window.parent.postMessage({ type: 'ship:wheel', dy }, window.location.origin);
  },
  { passive: false, capture: true },
);

// A click on a container (a press and release with almost no movement, so not
// a drag) chooses its chunk's artist. The framing page does the navigation
// and then sends 'ship:focus' back, so a click here and a click on the name
// in the listing do the same thing.
const CLICK_SLOP = 5; // pixels
let pressAt = null;
window.addEventListener('pointerdown', (event) => {
  pressAt = { x: event.clientX, y: event.clientY };
});
window.addEventListener('pointerup', (event) => {
  if (!pressAt) return;
  const moved = Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y);
  pressAt = null;
  if (moved > CLICK_SLOP) return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.inside = true;
  const group = pickGroup(true);
  if (group === null) return;
  // On the artwork view, a click on any container goes back to the listing.
  if (focused !== null) {
    highlight.setAll(false);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ship:home' }, window.location.origin);
    } else {
      setGroup(null);
      focusGroup(null);
    }
    return;
  }
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'ship:select', group }, window.location.origin);
  } else {
    setGroup(group);
    focusGroup(group);
  }
});
// The pointer left the ship, maybe onto a name in the listing. The ship drops
// its own hover at once, without a delay, and does not clear the light
// itself: the framing page clears it, but only if no name has the hover.
document.documentElement.addEventListener('mouseleave', () => {
  pointer.inside = false;
  document.body.style.cursor = '';
  highlight.setAll(false);
  if (shipHover === null) return;
  shipHover = null;
  pickPending = null;
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'ship:hover', group: null, left: true }, window.location.origin);
  } else {
    setGroup(null);
  }
});

// The nearest container in view under the pointer: its group goes in the
// return value, and its index in pickModule. Null if there is none.
let pickModule = null;
function pickGroup(forClick = false) {
  pickModule = null;
  // A drag turns the camera, so it does not light the containers it passes.
  // A click is checked after its pointer-up, when the controls may still
  // count it as a drag.
  if ((dragging && !forClick) || !pointer.inside || !ship.visible) return null;
  const { cargo } = ship.userData;
  const { boxes, moduleGroup } = cargo.userData;
  if (!boxes) return null;

  pickNdc.set((pointer.x / window.innerWidth) * 2 - 1, -(pointer.y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pickNdc, camera);
  cargo.updateWorldMatrix(true, false);
  pickInverse.copy(cargo.matrixWorld).invert();
  pickRay.copy(raycaster.ray).applyMatrix4(pickInverse);

  const now = clock.value;
  let best = Infinity;
  let group = null;
  for (let n = 0; n < moduleGroup.length; n++) {
    if (moduleGroup[n] < 0 || !isShown(cargo, n, now)) continue;
    pickBox.min.fromArray(boxes, n * 6);
    pickBox.max.fromArray(boxes, n * 6 + 3);
    if (!pickRay.intersectBox(pickBox, pickHit)) continue;
    const distance = pickHit.distanceToSquared(pickRay.origin);
    if (distance < best) {
      best = distance;
      group = moduleGroup[n];
      pickModule = n;
    }
  }
  return group;
}

function updatePick(time) {
  // On the artwork view, the ship is one button back to the listing: with the
  // pointer over any container, every container lights, and a click goes
  // home (see the pointer-up handler). The chunks do not light one by one.
  if (focused !== null) {
    const over = pickGroup() !== null;
    highlight.setAll(over);
    document.body.style.cursor = over ? 'pointer' : '';
    return;
  }
  highlight.setAll(false);
  const candidate = pickGroup();
  document.body.style.cursor = candidate === null ? '' : 'pointer';
  if (candidate === shipHover) {
    pickPending = shipHover;
    pickSince = time;
    return;
  }
  if (candidate !== pickPending) {
    pickPending = candidate;
    pickSince = time;
  }
  const wait = candidate === null ? PICK_CLEAR : shipHover === null ? 0 : PICK_SWITCH;
  if (time - pickSince < wait) return;
  shipHover = candidate;
  setGroup(candidate, pickModule);
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'ship:hover', group: candidate }, window.location.origin);
  }
}

// Tells the framing page the ship is running, so it can send its panel frames.
if (window.parent !== window) {
  // The TUNE values go with it, so a tuning panel can start from them.
  window.parent.postMessage({ type: 'ship:ready', tune: TUNE }, window.location.origin);
}

// Dev handle for reading or setting the view live, without a reload.
if (import.meta.env.DEV) {
  window.view = {
    camera, controls, scene, outline, water, highlight,
    get ship() { return ship; },
    setPixelScale(scale) {
      renderer.setPixelRatio(scale);
      renderer.setSize(window.innerWidth, window.innerHeight);
    },
  };
}

// Width of the open space at the left of the window, not covered by panels,
// or null when nothing covers the window.
let freeWidth = null;

// How far the main view's image sits below the middle of the window, as a
// share of the window height. Leaves room for the listing across the top.
const VIEW_DROP = 0.08;

// Shifts the main view's projection so its centre sits in the middle of the
// open space instead of the middle of the window, and a little low. The camera
// does not move: only the image slides, so the angle and the orbit are
// unchanged.
// While an artist is chosen, the listing's shift eases out (offsetShare goes
// to 0) and the artwork view's shift eases in. The camera looks at the
// laser's end, so that end lands at focusCenterX across and the middle of the
// window down: the middle of the space that the text column leaves free (see
// updateViewOffset).
let offsetShare = 1;
let focusCenterX = null;
let focusCenterY = null;
const OFFSET_EASE = 4; // per second, about the length of a camera flight
function updateViewOffset(delta) {
  const goal = focused === null ? 1 : 0;
  if (offsetShare === goal) return;
  const k = 1 - Math.exp(-OFFSET_EASE * delta);
  offsetShare += (goal - offsetShare) * k;
  if (Math.abs(goal - offsetShare) < 0.001) offsetShare = goal;
  applyViewOffset();
  camera.updateProjectionMatrix();
}
function applyViewOffset() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const listShift = freeWidth === null ? 0 : Math.max(0, (width - freeWidth) / 2);
  // A negative x offset moves the image right, to a centre right of the
  // middle.
  const focusShift = focusCenterX === null ? 0 : width / 2 - focusCenterX;
  const shiftX = listShift * offsetShare + focusShift * (1 - offsetShare);
  // A negative offset moves the sampled window up, so the image moves down.
  // A positive y offset moves the image up, to a centre above the middle.
  const focusShiftY = focusCenterY === null ? 0 : height / 2 - focusCenterY;
  const shiftY = -height * VIEW_DROP * offsetShare + focusShiftY * (1 - offsetShare);
  camera.setViewOffset(width, height, shiftX, shiftY, width, height);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  applyViewOffset();
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
applyViewOffset();

const flight = createFlight(camera, controls);

// Breathing room around the ship when the main view frames a panel view.
const VIEW_MARGIN = 1.15;

// The chosen artist. A choice fires a white laser out of that artist's chunk
// and flies the camera to look along it, so that the chunk is near the
// bottom-right corner (CORNER) and the laser's end is at the centre of the
// media box (see focusCenterX and focusCenterY). The automatic turn and the
// drift back to the start view stop until the choice ends.
//
// The laser points away from the ship: along the outward normal of an
// ellipse around the hull, through the chunk. Thus a chunk at the stern
// points back, one at the bow points forward, and one on a side points
// sideways, and no laser crosses the ship. The camera stands a quarter turn
// around from that direction, so the laser runs from the bottom right up to
// the centre of the view, toward the screen's left. Each chunk also has its
// own tilt below the horizon, from FOCUS_TILT_MIN to FOCUS_TILT_MAX.
//
// The chunks are numbered in order around the ship (see orderAround in
// cargo.js), so the previous and the next artist are neighbouring chunks,
// with nearly the same outward direction. A move between them turns the
// camera only a little.
//
// With the direction fixed, the rest follows: the chunk is on the line of
// sight through CORNER, FOCUS_DISTANCE from the camera, and the laser's end
// is straight ahead, at the same distance. The laser then always rises,
// because the corner is below the centre of the view: from about 15 degrees
// at the steepest tilt to about 36 at the flattest.
const FOCUS_TILT_MIN = THREE.MathUtils.degToRad(15);
const FOCUS_TILT_MAX = THREE.MathUtils.degToRad(45);
// A fixed value in [0, 1) for each group and `salt`, for the chunk's angles.
const groupShare = (group, salt) => {
  const v = Math.sin((group + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
const LASER_TIME = 0.35; // seconds for the laser to reach full length
const LASER_BACK = 0.25; // seconds to pull it back
// The camera's distance from the laser's end on the artwork view. Close
// enough that the fog leaves the water grid faintly in view, which it does
// not at the orbit's largest distance.
const FOCUS_DISTANCE = 80;
// Where the chunk shows on the artwork view, in normalized screen units:
// -1 to 1 from left to right and from bottom to top.
const CORNER = new THREE.Vector2(0.8, -0.75);

// CORNER, in the normalized units of the camera before its picture shift.
// The picture is shifted so that its centre is at focusCenterX and
// focusCenterY, so a place in the window moves by the same amount.
function cornerGoal() {
  const half = window.innerWidth / 2;
  const halfY = window.innerHeight / 2;
  const centre = focusCenterX ?? half;
  const centreY = focusCenterY ?? halfY;
  return new THREE.Vector2(
    (half * (1 + CORNER.x) - centre) / half,
    (centreY - halfY * (1 - CORNER.y)) / halfY,
  );
}

// The camera position and the laser's end for a chunk at `start`, with the
// camera turned `theta` around the ship and tilted `tilt` down.
function focusView(start, theta, tilt) {
  // Forward, right and up of a camera with that turn and tilt. The world up
  // is kept, as the orbit controls do, so the view has no roll.
  const forward = new THREE.Vector3(
    -Math.sin(theta) * Math.cos(tilt),
    -Math.sin(tilt),
    -Math.cos(theta) * Math.cos(tilt),
  );
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  // The line of sight through CORNER.
  const goal = cornerGoal();
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const ray = forward
    .clone()
    .addScaledVector(right, goal.x * tanY * camera.aspect)
    .addScaledVector(up, goal.y * tanY)
    .normalize();
  const position = start.clone().addScaledVector(ray, -FOCUS_DISTANCE);
  const end = position.clone().addScaledVector(forward, FOCUS_DISTANCE);
  return { position, end };
}
// One pixel wide. Line2's width already follows the pixel ratio, so it is
// not multiplied by PIXEL_SCALE here.
const laser = createLaser(seaScene, { width: 1 });
let focused = null;

function focusGroup(group) {
  if (group === focused) return;
  if (group === null) {
    focused = null;
    laser.retract(LASER_BACK);
    controls.autoRotate = true;
    // Back to the start distance and height, from the current side.
    const turn = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const home = new THREE.Spherical(START_VIEW.radius, START_VIEW.phi, turn.theta);
    flight.fly(new THREE.Vector3().setFromSpherical(home).add(START_TARGET), START_TARGET);
    return;
  }

  const { cargo } = ship.userData;
  const { boxes, moduleGroup } = cargo.userData;
  if (!boxes) return;
  // The chunk's centre in plan, and its highest top, in the cargo's space.
  let x = 0, z = 0, top = -Infinity, count = 0;
  for (let n = 0; n < moduleGroup.length; n++) {
    if (moduleGroup[n] !== group) continue;
    x += (boxes[n * 6] + boxes[n * 6 + 3]) / 2;
    z += (boxes[n * 6 + 2] + boxes[n * 6 + 5]) / 2;
    top = Math.max(top, boxes[n * 6 + 4]);
    count++;
  }
  if (!count) return;
  focused = group;
  cargo.updateWorldMatrix(true, false);
  const start = cargo.localToWorld(new THREE.Vector3(x / count, top, z / count));

  // The outward normal of an ellipse with the hull's length and beam, at the
  // chunk: (x / a^2, z / b^2). The camera stands a quarter turn around from
  // it, on up x outward, so the laser runs to the left of the view.
  const local = new THREE.Vector3(start.x - START_TARGET.x, 0, start.z - START_TARGET.z);
  const out = new THREE.Vector3(local.x / (LOA / 2) ** 2, 0, local.z / (BEAM / 2) ** 2);
  if (out.lengthSq() < 1e-8) out.set(-1, 0, 0);
  out.normalize();
  const back = new THREE.Vector3(0, 1, 0).cross(out);
  const theta = Math.atan2(back.x, back.z);
  const tilt = FOCUS_TILT_MIN + groupShare(group, 2) * (FOCUS_TILT_MAX - FOCUS_TILT_MIN);
  const view = focusView(start, theta, tilt);
  const toEnd = view.end.clone().sub(start);
  const length = toEnd.length();
  laser.fire(start, toEnd.normalize(), length, LASER_TIME);
  controls.autoRotate = false;
  flight.fly(view.position, view.end);
}

// A second click on the same tile within REVERSE_WINDOW seconds of the last
// one gives the reverse view: from the stern, from the other side, or from
// below. A further click in time flips back again.
const REVERSE_WINDOW = 3; // seconds
const lastViewClick = { index: null, time: -Infinity, reversed: false };
function viewForClick(index) {
  const view = VIEWS[index];
  if (!view) return null;
  const now = performance.now() / 1000;
  const again = lastViewClick.index === index && now - lastViewClick.time < REVERSE_WINDOW;
  lastViewClick.reversed = again ? !lastViewClick.reversed : false;
  lastViewClick.index = index;
  lastViewClick.time = now;
  return lastViewClick.reversed ? { ...view, from: view.from.clone().negate() } : view;
}

// Flies the main camera to frame the ship in one of the panel views. The fit
// uses the open space left of the panels, which the view offset centres the
// image in.
function flyToView(view) {
  if (!view) return;
  const aspect = (freeWidth ?? window.innerWidth) / window.innerHeight;
  const { center, back, distance } = fitView(view, panelBounds, camera.fov, aspect, VIEW_MARGIN);
  const position = center.clone().addScaledVector(back, distance);
  // Straight down has no compass heading, so nudge the camera a hair toward
  // the side the view's `up` points away from. That turns the plan view so
  // the bow points down the screen, as in its panel.
  if (Math.abs(back.y) > 0.999) position.addScaledVector(view.up, -distance * 1e-3);
  flight.fly(position, center);
}

// The hovered tile drives the smear. The tile's rectangle maps to the same
// place in the main view, inside the free space left of the tiles, and the
// smear stays inside that area. The direction goes from the tile's centre,
// where the ship is, to the rectangle. The strength grows with the distance
// and eases in and out. It sets the odds of a step on each frame.
//
// The rectangles get new places only when the pointer enters a tile or moves
// to another tile. While the pointer stays in one tile, they stay in place.
const SMEAR_EASE = 8; // per second
let smearTile = null;
let smearCount = 0;
function updateSmear(time, delta) {
  const tile = panels.hovered();
  const index = tile ? tile.index : null;
  if (index !== null && index !== smearTile) SMEAR.seed.value = Math.random() * 1000;
  smearTile = index;
  let target = 0;
  if (tile) {
    const c = tile.centre;
    target = Math.min(1, Math.max(Math.abs(c.x), Math.abs(c.y)) / tile.limit);
    const length = c.length();
    if (length > 1e-4) SMEAR.direction.value.set(c.x / length, c.y / length);
    const free = freeWidth ? freeWidth / window.innerWidth : 1;
    SMEAR.centre.value.set(free * (0.5 + c.x), 0.5 + c.y);
    SMEAR.half.value.set((free * tile.scale) / 2, tile.scale / 2);
  }
  const k = 1 - Math.exp(-SMEAR_EASE * delta);
  SMEAR.strength.value += (target - SMEAR.strength.value) * k;
  if (SMEAR.strength.value < 0.01 && target === 0) SMEAR.strength.value = 0;
  // Steps at an even rhythm: the strength fills a counter on each frame, and
  // the smear steps each time the counter passes 1. Random steps came in
  // bursts and pauses at low strength, which looked like a stutter.
  smearCount += SMEAR.strength.value;
  SMEAR.pulse.value = smearCount >= 1 ? 1 : 0;
  if (smearCount >= 1) smearCount -= 1;
  if (SMEAR.strength.value === 0) smearCount = 0;
}

// After a flight to a tile's view or a drag, the camera holds that view for
// a while.
// Then it eases back to the start view's height (polar angle), distance, and
// look-at point. The auto-rotation keeps turning it around the ship all the
// time, so the turn angle is left alone.
let flying = false;
let holdUntil = 0;
const settleOffset = new THREE.Vector3();
const settleView = new THREE.Spherical();
function settleCamera(delta) {
  const k = 1 - Math.exp(-TUNE.camera.settle * delta);
  settleOffset.copy(camera.position).sub(controls.target);
  settleView.setFromVector3(settleOffset);
  settleView.phi += (START_VIEW.phi - settleView.phi) * k;
  settleView.radius += (START_VIEW.radius - settleView.radius) * k;
  settleView.makeSafe();
  controls.target.lerp(START_TARGET, k);
  camera.position.setFromSpherical(settleView).add(controls.target);
}

// TUNING: frame statistics for the tuning panel. Every half second, the ship
// sends the frame rate, the average and the slowest frame time, and the
// number of slow frames (over 25 ms, so a dropped frame at 60 Hz) to the
// framing page.
const stats = { frames: 0, total: 0, worst: 0, slow: 0, since: performance.now() };
function recordFrame(ms) {
  stats.frames++;
  stats.total += ms;
  stats.worst = Math.max(stats.worst, ms);
  if (ms > 25) stats.slow++;
  const now = performance.now();
  if (now - stats.since < 500) return;
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        type: 'ship:stats',
        fps: (stats.frames * 1000) / (now - stats.since),
        avg: stats.total / stats.frames,
        worst: stats.worst,
        slow: stats.slow,
      },
      window.location.origin,
    );
  }
  Object.assign(stats, { frames: 0, total: 0, worst: 0, slow: 0, since: now });
}

let lastTime = null;
renderer.setAnimationLoop(() => {
  const time = performance.now() / 1000;
  const delta = lastTime === null ? 0 : time - lastTime;
  if (lastTime !== null) recordFrame(delta * 1000);

  // A flight owns the camera while it runs; the orbit controls take over after.
  // With the delta, the auto-rotation speed does not depend on the frame
  // rate.
  if (flight.update(delta)) {
    flying = true;
  } else {
    // A flight turns the controls back on when it ends. On the artwork view
    // they stay off.
    controls.enabled = focused === null;
    if (flying) holdUntil = time + TUNE.camera.hold;
    flying = false;
    // No return while the pointer drags the camera.
    if (!dragging && focused === null && time >= holdUntil) settleCamera(delta);
    controls.update(delta);
  }
  clock.value = time;
  updatePick(time);
  updateSmear(time, delta);
  highlight.update(delta);
  drop.update(delta);
  laser.update(delta);
  // The water's fade follows the camera's distance from the ship (see
  // fadeShift in water.js), so the grid also shows from far out.
  water.userData.fadeShift.value = Math.max(0, camera.position.distanceTo(START_TARGET) - START_VIEW.radius);
  updateViewOffset(delta);
  lastTime = time;
  if (fill.update(time)) {
    crawl ??= createCrawl(view, ship.userData.cargo);
    crawl.update(time);
  }

  // The fog band follows the distance to the orbit target, so a zoom keeps
  // the same fade across the ship.
  setFocus(camera.position.distanceTo(controls.target));
  pipeline.render();
  panels.update(delta);
  panels.render();
});

// HMR: tear down the old scene so edits don't stack renderers/listeners.
if (import.meta.hot) {
  import.meta.hot.accept('./ship.js', (mod) => {
    if (mod) respawn(mod.createShip);
  });

  import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null);
    crawl?.dispose();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('message', onMessage);
    highlight.dispose();
    towers.dispose();
    laser.dispose();
    drop.dispose();
    panels.dispose();
    controls.dispose();
    ship.userData.dispose();
    water.userData.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  });
}
