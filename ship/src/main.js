import * as THREE from 'three/webgpu';
import { color, mix, mrt, normalView, output, pass, renderOutput, uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createShip, LOA } from './ship.js';
import { createOutline } from './outline.js';
import { createWater } from './water.js';
import { createCrawl } from './crawl.js';
import { createFill } from './fill.js';
import { createModuleView } from './modules.js';
import { createHighlight } from './highlight.js';
import { createDrop } from './drop.js';
import { clock, transition } from './visibility.js';
import { chooseKept } from './cargo.js';
import { createPanels, fitView, VIEWS } from './panels.js';
import { createFlight } from './flight.js';
import { createDitherParams, dither } from './dither.js';

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
const TUNE = {
  dither: { levels: 2, dot: 1, strength: 1 },
  fog: { front: 1.05, back: 3.15, curve: 4 },
  cargo: { keep: 0.9, build: 40, overlap: 1 },
  tiles: { fogPush: 1, lineWeight: 4.25 },
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

function applyTune(next) {
  for (const group of Object.keys(TUNE)) {
    for (const key of Object.keys(TUNE[group])) {
      const value = Number(next?.[group]?.[key]);
      if (Number.isFinite(value)) TUNE[group][key] = value;
    }
  }
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

// A solid surface, not just lines: the compositor occludes by depth, so the
// water needs to write depth everywhere, not only where a line happens to fall.
const water = createWater({
  // Big enough that the plane's own square edge stays outside the fade
  // circle across the whole default view, so only the circle shows.
  size: LOA * 10,
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
function buildPipeline(target, viewCamera, { sea = true, depthThreshold, backdrop, hover, tile = false } = {}) {
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
  if (DITHER) {
    // The dither needs display values, so apply the colour transform first
    // and tell the pipeline not to apply it again.
    result.outputColorTransform = false;
    // The tile backdrop lines are dotted already, so they skip the dither.
    result.outputNode = dither(renderOutput(frame), DITHER, outline.undithered);
  } else {
    result.outputNode = frame;
  }
  return { pipeline: result, outline, setFocus };
}

const { pipeline, outline, setFocus } = buildPipeline(renderer, camera);

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
  // that index: 0 front, 1 side, 2 top. The cargo layout stays the same.
  // { type: 'ship:tune', dither: {...}, fog: {...} } sets the TUNE values.
  if (event.data?.type === 'ship:tune') {
    applyTune(event.data);
    return;
  }
  if (event.data?.type === 'ship:view') {
    flyToView(VIEWS[event.data.index]);
    return;
  }
  // { type: 'ship:cursor', index, x, y } points that panel's rectangle at the
  // pointer, given as shares of the panel from its top left; x: null centres
  // it again.
  if (event.data?.type === 'ship:cursor') {
    panels.point(event.data.index, event.data.x, event.data.y);
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
  const { cargo } = ship.userData;
  const group = event.data.group;
  const next = Number.isInteger(group) && group >= 0 && group < cargo.userData.groupCount ? group : null;
  highlight.set(next);

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
function applyViewOffset() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const shiftX = freeWidth === null ? 0 : Math.max(0, (width - freeWidth) / 2);
  // A negative offset moves the sampled window up, so the image moves down.
  const shiftY = -height * VIEW_DROP;
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

let lastTime = null;
renderer.setAnimationLoop(() => {
  const time = performance.now() / 1000;
  const delta = lastTime === null ? 0 : time - lastTime;

  // A flight owns the camera while it runs; the orbit controls take over after.
  if (!flight.update(delta)) controls.update();
  clock.value = time;
  highlight.update(delta);
  drop.update(delta);
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
    drop.dispose();
    panels.dispose();
    controls.dispose();
    ship.userData.dispose();
    water.userData.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  });
}
