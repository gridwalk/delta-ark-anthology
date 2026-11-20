import * as THREE from 'three';
import { BEAM, DEPTH, LOA, deckHalfBeam } from './dimensions.js';
import { initVisibility } from './visibility.js';

// --- tunables -------------------------------------------------------------

export const CELL = 0.32; // grid module, ~6.4 m
export const LAYER_H = 0.3; // one stacking tier
export const MAX_LAYERS = 22; // ceiling for ordinary stacking, unreasonable on purpose
const GRID_LAYERS = 32; // occupancy depth, so megastructures can overtop it
const EDGE_MARGIN = 0.18; // keep stacks off the deck edge
const MODULE_GAP = 0.014; // shrink each module so neighbours never touch
const VACANCY = 0.17; // chance a scan position is simply left alone

// Footprints in cells. Sorted largest-first at load: the packer takes the
// biggest thing that fits, which is what produces dense courses. The huge
// entries are rarely *attempted* (see ATTEMPT_ODDS) so they read as
// occasional megastructures rather than paving the whole deck.
const FOOTPRINTS = [
  [8, 6], [6, 6], [8, 4], [5, 5], [6, 4], [6, 3], [4, 4], [5, 2],
  [4, 3], [3, 3], [4, 2], [2, 3], [3, 2], [2, 2], [3, 1], [1, 3],
  [2, 1], [1, 2], [1, 1],
].sort((a, b) => b[0] * b[1] - a[0] * a[1]);

// Upper bounds on what the blink crawl is allowed to touch. Landmarks and the
// bigger modules read as permanent structure, so blinking them looks like a
// glitch rather than activity.
const CRAWL_MAX_AREA = 8; // footprint cells
const CRAWL_MAX_HEIGHT = 3; // tiers

// Small windows, tightly packed. At the start view, one unit is about 40
// pixels, so the smallest window is about one pixel. Smaller windows would
// drop below a pixel and flicker.
const WINDOW_SIZES = [0.022, 0.03, 0.04];
const WINDOW_RELIEF = 0.01;
const WINDOW_MARGIN = 0.024;
const WINDOW_GAP = 0.014;
const WINDOW_FILL = 0.8;
// Medium and large containers are almost covered (see isLarge).
const WINDOW_FILL_LARGE = 0.95;

// Antennas: thin masts on the roofs of some containers with nothing above
// them (see pushAntenna). Heights in units, radius in units.
const ANTENNA_ODDS = 0.07;
const ANTENNA_MIN = 0.8;
const ANTENNA_MAX = 2.4;
const ANTENNA_RADIUS = 0.014;
// Roof shapes with a clear top point for the mast's base. A shed slopes, an
// L shape can miss its centre, and a split has two heights, so they get none.
// A stepped module can end below its full height, so it gets none either.
const ANTENNA_KINDS = ['box', 'chamfer', 'ribbed', 'frustum', 'prism', 'tank', 'gabled'];

// --- grid -----------------------------------------------------------------

const NX = Math.floor(LOA / CELL);
const NZ = Math.floor(BEAM / CELL);
const X0 = -(NX * CELL) / 2;
const Z0 = -(NZ * CELL) / 2;

const cellX = (i) => X0 + i * CELL;
const cellZ = (k) => Z0 + k * CELL;
const at = (i, k, y) => (y * NZ + k) * NX + i;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultSeed() {
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('seed');
    if (q) return Number(q) >>> 0;
  }
  return (Math.random() * 0xffffffff) >>> 0;
}

// How many highlight groups to allocate, from ?groups=N. The page that frames
// the ship passes one group per entry in its listing.
function defaultGroups() {
  if (typeof location !== 'undefined') {
    const q = Number(new URLSearchParams(location.search).get('groups'));
    if (q > 0) return Math.floor(q);
  }
  return 0;
}

// EXPERIMENT: how the modules are shared out to the listing's groups, from
// ?grouping=. 'chunks' (the default) gives each group one contiguous chunk of
// the layout (see assignChunks). 'scatter' spreads each group over the whole
// deck (see assignGroups), for the hide and build hover.
export const GROUPING =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('grouping') === 'scatter'
    ? 'scatter'
    : 'chunks';

// A cell is usable only if it clears the deck edge at both ends of its span --
// the deck narrows toward the bow, so testing the centre would overhang.
function cellOnDeck(i, k) {
  const half = Math.min(deckHalfBeam(cellX(i)), deckHalfBeam(cellX(i) + CELL)) - EDGE_MARGIN;
  if (half <= 0) return false;
  const za = cellZ(k);
  const zb = za + CELL;
  return Math.max(Math.abs(za), Math.abs(zb)) <= half;
}

// A skyline of soft peaks, so height varies across the deck instead of
// levelling off into a slab. Peaks are elongated fore-and-aft.
function makeSkyline(rand) {
  const base = 3 + Math.round(rand() * 2);
  const peaks = [];
  const count = 4 + Math.floor(rand() * 5);
  for (let n = 0; n < count; n++) {
    peaks.push({
      x: rand(),
      z: rand(),
      h: MAX_LAYERS * (0.45 + rand() * 0.55),
      rx: 0.12 + rand() * 0.3,
      rz: 0.25 + rand() * 0.65,
    });
  }

  // A slow lateral lean whose direction reverses along the length, so the
  // massing never comes out mirror-symmetric about the centreline bow-on.
  const leanPhase = rand() * Math.PI * 2;
  const leanFreq = 1.2 + rand() * 2.2;
  const leanAmp = 0.35 + rand() * 0.35;

  // Per-cell roughness. The peaks and the lean are both smooth fields, which
  // left the massing reading as tidy hills; this breaks up every column a
  // little and is what stops the two sides matching cell for cell.
  const jitter = new Float32Array(NX * NZ);
  for (let n = 0; n < jitter.length; n++) jitter[n] = 0.78 + rand() * 0.5;

  return (i, k) => {
    const nx = i / (NX - 1);
    const nz = k / (NZ - 1);

    let h = base;
    for (const p of peaks) {
      const dx = (nx - p.x) / p.rx;
      const dz = (nz - p.z) / p.rz;
      const d = dx * dx + dz * dz;
      if (d < 1) h = Math.max(h, p.h * (1 - d));
    }

    h *= 1 + Math.sin(nx * leanFreq * Math.PI + leanPhase) * leanAmp * (nz - 0.5) * 2;
    h *= jitter[k * NX + i];

    // Step down over the forward third and just aft of the transom.
    if (nx > 0.68) h *= Math.max(0.12, 1 - ((nx - 0.68) / 0.32) * 0.85);
    if (nx < 0.1) h *= 0.7;
    return Math.max(1, Math.round(h));
  };
}

// Voids are what make arches possible: nothing may be built inside one, so a
// wide module landing on the layer above it has solid ground at its ends and
// nothing under its middle. Stacking void bands with a single layer between
// them produces arches stacked directly above one another.
function makeArchVoids(rand) {
  const voids = [];
  const count = 3 + Math.floor(rand() * 5);

  for (let n = 0; n < count; n++) {
    const w = 2 + Math.floor(rand() * 3);
    const d = 3 + Math.floor(rand() * 6);
    const i0 = 2 + Math.floor(rand() * Math.max(1, NX - w - 4));
    const k0 = Math.floor(rand() * Math.max(1, NZ - d));
    const openH = 2 + Math.floor(rand() * 3);
    const tiers = 1 + Math.floor(rand() * 3);

    let y = Math.floor(rand() * 3);
    for (let tier = 0; tier < tiers; tier++) {
      voids.push({ i0, k0, w, d, y0: y, y1: y + openH });
      y += openH + 1; // the +1 is the course the span itself occupies
    }
  }

  return voids;
}

// Plazas differ from arch voids: nothing spans them, they stay open to the sky
// from their floor upward. These are the courtyards and canyons.
function makePlazas(rand) {
  const plazas = [];
  const count = 2 + Math.floor(rand() * 4);

  for (let n = 0; n < count; n++) {
    const w = 2 + Math.floor(rand() * 4);
    const d = 2 + Math.floor(rand() * 5);
    plazas.push({
      i0: Math.floor(rand() * Math.max(1, NX - w)),
      k0: Math.floor(rand() * Math.max(1, NZ - d)),
      w,
      d,
      // Most cut all the way to the deck; the rest are terraces part-way up.
      y0: rand() < 0.6 ? 0 : 1 + Math.floor(rand() * 5),
      y1: GRID_LAYERS,
    });
  }

  return plazas;
}

function makeReserved(rand) {
  const regions = [...makeArchVoids(rand), ...makePlazas(rand)];
  return (i, k, y) =>
    regions.some(
      (v) =>
        i >= v.i0 && i < v.i0 + v.w &&
        k >= v.k0 && k < v.k0 + v.d &&
        y >= v.y0 && y < v.y1,
    );
}

// --- packing --------------------------------------------------------------

function attemptOdds(area) {
  if (area >= 24) return 0.07;
  if (area >= 12) return 0.25;
  if (area >= 6) return 0.65;
  return 0.85;
}

function place(occ, skyline, inVoid, i, k, y, fw, fd, h) {
  if (i + fw > NX || k + fd > NZ || y + h > MAX_LAYERS) return null;

  for (let a = i; a < i + fw; a++) {
    for (let b = k; b < k + fd; b++) {
      if (y + h > skyline(a, b)) return null;
      for (let c = y; c < y + h; c++) {
        if (occ[at(a, b, c)] || inVoid(a, b, c)) return null;
      }
      if (y === 0 && !cellOnDeck(a, b)) return null;
    }
  }

  if (y === 0) return 'full';

  // Column/row support, where a line counts as supported only if every cell
  // along it is carried. Anything less is treated as open.
  const colOk = (a) => {
    for (let b = k; b < k + fd; b++) if (!occ[at(a, b, y - 1)]) return false;
    return true;
  };
  const rowOk = (b) => {
    for (let a = i; a < i + fw; a++) if (!occ[at(a, b, y - 1)]) return false;
    return true;
  };

  const cols = [];
  for (let a = i; a < i + fw; a++) cols.push(colOk(a));
  const rows = [];
  for (let b = k; b < k + fd; b++) rows.push(rowOk(b));

  if (cols.every(Boolean)) return 'full';

  // Bridging: both ends carried, middle spanning open air. Turns a void into
  // an arch.
  if (fw >= 3 && cols[0] && cols[fw - 1]) return 'bridge';
  if (fd >= 3 && rows[0] && rows[fd - 1]) return 'bridge';

  // Cantilever: a contiguous run of support from one edge carrying at least
  // half the footprint, with the remainder jutting into open air. This is what
  // makes stacks lean and overhang instead of sitting square on each other.
  // Capped by height, or tall towers end up balanced on a corner.
  if (h <= 3) {
    const run = (flags) => {
      let pre = 0;
      while (pre < flags.length && flags[pre]) pre++;
      let suf = 0;
      while (suf < flags.length && flags[flags.length - 1 - suf]) suf++;
      return Math.max(pre, suf);
    };
    if (run(cols) >= Math.ceil(fw / 2)) return 'cantilever';
    if (run(rows) >= Math.ceil(fd / 2)) return 'cantilever';
  }

  return null;
}

// The shapes, with their odds. A kind that does not suit the module's size
// is left out, and the kinds that fit share its odds. About two fifths of
// the modules stay boxes, since only boxes get windows.
//
// - prism: an upright hexagon or octagon, on a square footprint.
// - frustum: a box that narrows to the top.
// - stepped: a stack of shrinking boxes, like a ziggurat.
// - chamfer: a box with its vertical corners cut off.
// - gabled: a box with a pitched roof.
// - shed: a box with a roof that slopes to one side.
// - lshape: a box with one corner taken out, an L seen from above.
// - split: two boxes side by side, at two heights.
// - ribbed: a box with a raised band at each tier.
// - tank: an upright cylinder with a short tapered cap.
const KINDS = [
  ['prism', 0.06, (fw, fd) => fw === fd && fw >= 2],
  ['frustum', 0.08, () => true],
  ['stepped', 0.07, (fw, fd, h) => h >= 2],
  ['chamfer', 0.07, (fw, fd) => fw >= 2 && fd >= 2],
  ['gabled', 0.06, () => true],
  ['shed', 0.05, () => true],
  ['lshape', 0.06, (fw, fd) => fw >= 2 && fd >= 2],
  ['split', 0.05, (fw, fd) => fw >= 2 || fd >= 2],
  ['ribbed', 0.05, (fw, fd, h) => h >= 2],
  ['tank', 0.05, (fw, fd) => Math.abs(fw - fd) <= 1],
];


// Medium and large containers must not show big blank walls. They take only
// the kinds with flat, upright walls, and those walls are almost covered in
// windows (see WINDOW_FILL_LARGE and windowSpec).
const LARGE_KINDS = [
  ['box', 0.4],
  ['chamfer', 0.25],
  ['gabled', 0.2],
  ['shed', 0.15],
];

function isLarge(m) {
  const area = m.fw * m.fd;
  return Boolean(m.landmark) || area >= 6 || (area >= 4 && m.h >= 3);
}

// Picks from `kinds` ([kind, odds]) with one random number `r` in [0, 1).
function pickKind(kinds, r) {
  const total = kinds.reduce((sum, [, odds]) => sum + odds, 0);
  let left = r * total;
  for (const [kind, odds] of kinds) {
    if (left < odds) return kind;
    left -= odds;
  }
  return kinds[kinds.length - 1][0];
}

// Each call uses exactly one random number, so the kinds never change the
// layout: the packer's later random numbers stay the same.
function chooseKind(rand, fw, fd, h, support) {
  // A bridge needs a flat underside and solid ends.
  if (support === 'bridge') return rand() < 0.3 ? 'ribbed' : 'box';
  if (isLarge({ fw, fd, h })) return pickKind(LARGE_KINDS, rand());
  // Only the kinds that fit share the odds. Their odds scale up, so a small
  // module, which fits fewer kinds, is not more often a box.
  const fitting = KINDS.filter(([, , fits]) => fits(fw, fd, h));
  const total = KINDS.reduce((sum, [, odds]) => sum + odds, 0);
  const fitTotal = fitting.reduce((sum, [, odds]) => sum + odds, 0);
  let r = rand();
  for (const [kind, odds] of fitting) {
    const share = (odds * total) / fitTotal;
    if (r < share) return kind;
    r -= share;
  }
  return 'box';
}

function tryLandmark(rand, occ, owner, inVoid, modules, fw, fd, h, midships = false) {
  if (fw > NX || fd > NZ || h > GRID_LAYERS) return false;

  // A deep footprint only clears the deck edge near midships, so the giant
  // searches there rather than uniformly along the hull.
  const i = midships
    ? Math.floor((NX - fw + 1) * (0.2 + rand() * 0.45))
    : Math.floor(rand() * (NX - fw + 1));
  const k = midships
    ? Math.floor((NZ - fd + 1) * (0.15 + rand() * 0.7))
    : Math.floor(rand() * (NZ - fd + 1));

  for (let a = i; a < i + fw; a++) {
    for (let b = k; b < k + fd; b++) {
      if (!cellOnDeck(a, b) || occ[at(a, b, 0)]) return false;
      for (let c = 0; c < h; c++) if (inVoid(a, b, c)) return false;
    }
  }

  // A landmark is never one monolithic block. It is a stack of two or three
  // modules. Each tier above the first can step in by one cell on a side, so
  // the stack narrows as it goes up, but every tier stands fully on the one
  // below it. The lower tiers have flat tops. The top tier can have any
  // shape.
  const tiers = h >= 6 && rand() < 0.5 ? 3 : 2;
  const heights = [];
  let left = h;
  for (let t = tiers; t > 1; t--) {
    // Each tier gets at least two layers. The rest is shared at random.
    const most = left - 2 * (t - 1);
    const part = Math.max(2, Math.min(most, Math.round((left / t) * (0.7 + rand() * 0.6))));
    heights.push(part);
    left -= part;
  }
  heights.push(left);

  let ti = i, tk = k, tw = fw, td = fd, y = 0;
  heights.forEach((th, t) => {
    if (t > 0) {
      // Step in by one cell on each side, at random, if the tier stays at
      // least three cells wide.
      if (tw >= 5 && rand() < 0.6) { ti++; tw--; }
      if (tw >= 4 && rand() < 0.6) { tw--; }
      if (td >= 5 && rand() < 0.6) { tk++; td--; }
      if (td >= 4 && rand() < 0.6) { td--; }
    }
    const index = modules.length;
    for (let a = ti; a < ti + tw; a++) {
      for (let b = tk; b < tk + td; b++) {
        for (let c = y; c < y + th; c++) {
          occ[at(a, b, c)] = 1;
          owner[at(a, b, c)] = index;
        }
      }
    }

    const top = t === heights.length - 1;
    const r = rand();
    // A large block's parts are large containers, so they take the kinds
    // with flat walls for windows (see LARGE_KINDS). The lower parts need a
    // flat top too.
    const kind = !top ? (r < 0.6 ? 'box' : 'chamfer') : pickKind(LARGE_KINDS, r);

    modules.push({ i: ti, k: tk, y, fw: tw, fd: td, h: th, kind, bridge: false, landmark: true });
    y += th;
  });
  return true;
}

// One to three landmarks, placed before anything else so they always land and
// always dominate. Leaving these to the ordinary packer meant some layouts got
// none, since the biggest footprints are deliberately rare.
//
// The first is a megastructure at roughly twice the footprint and height of
// the others, and it overtops MAX_LAYERS. Its dimensions step down on repeated
// failure -- a 14-cell-deep footprint only fits near midships, so without the
// fallback a bad draw could leave a layout with no giant at all.
function placeLandmarks(rand, occ, owner, inVoid, modules) {
  let mega = 0;
  let megaSize = null;

  for (let shrink = 0; shrink < 8 && mega === 0; shrink++) {
    const scale = 1 - shrink * 0.09;
    const fw = Math.max(6, Math.round((13 + Math.floor(rand() * 8)) * scale));
    const fd = Math.max(4, Math.round((8 + Math.floor(rand() * 6)) * scale));
    const h = Math.max(8, Math.round((20 + Math.floor(rand() * 10)) * scale));

    for (let attempt = 0; attempt < 250 && mega === 0; attempt++) {
      if (tryLandmark(rand, occ, owner, inVoid, modules, fw, fd, h, true)) {
        mega++;
        megaSize = [fw, fd, h];
      }
    }
  }

  const extra = Math.floor(rand() * 3); // 0-2 more, for 1-3 total
  let rest = 0;
  for (let attempt = 0; attempt < 500 && rest < extra; attempt++) {
    const fw = 6 + Math.floor(rand() * 5);
    const fd = 4 + Math.floor(rand() * 4);
    const h = 8 + Math.floor(rand() * 7);
    if (tryLandmark(rand, occ, owner, inVoid, modules, fw, fd, h)) rest++;
  }

  return { count: mega + rest, megaSize };
}

function pack(rand) {
  const skyline = makeSkyline(rand);
  const inVoid = makeReserved(rand);

  // Sized to GRID_LAYERS, not MAX_LAYERS: a megastructure overtops the
  // ordinary ceiling, and its upper cells would otherwise index past the end
  // of the array, where typed-array writes are silently discarded.
  const occ = new Uint8Array(NX * NZ * GRID_LAYERS);
  // Which module owns each cell, so adjacency can be read off the grid instead
  // of comparing every module against every other.
  const owner = new Int32Array(NX * NZ * GRID_LAYERS).fill(-1);
  const modules = [];
  const landmarks = placeLandmarks(rand, occ, owner, inVoid, modules);

  for (let y = 0; y < MAX_LAYERS; y++) {
    for (let i = 0; i < NX; i++) {
      for (let k = 0; k < NZ; k++) {
        if (occ[at(i, k, y)] || inVoid(i, k, y)) continue;
        // Leave some positions alone entirely, so the packer stops reading as
        // an exhaustive fill.
        if (rand() < VACANCY) continue;

        for (const [fw, fd] of FOOTPRINTS) {
          if (rand() > attemptOdds(fw * fd)) continue;

          const roll = rand();
          const heights =
            roll < 0.05 ? [7, 5, 3, 1]
            : roll < 0.16 ? [4, 2, 1]
            : roll < 0.42 ? [2, 1]
            : [1];

          let placed = false;
          for (const h of heights) {
            const support = place(occ, skyline, inVoid, i, k, y, fw, fd, h);
            if (!support) continue;

            const index = modules.length;
            for (let a = i; a < i + fw; a++) {
              for (let b = k; b < k + fd; b++) {
                for (let c = y; c < y + h; c++) {
                  occ[at(a, b, c)] = 1;
                  owner[at(a, b, c)] = index;
                }
              }
            }
            modules.push({
              i, k, y, fw, fd, h,
              kind: chooseKind(rand, fw, fd, h, support),
              bridge: support === 'bridge',
              cantilever: support === 'cantilever',
            });
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
    }
  }

  return { occ, owner, modules, landmarks };
}

// Two modules are adjacent if one touches the shell of cells surrounding the
// other. Walking the shell is far cheaper than comparing all module pairs.
function buildAdjacency(modules, owner) {
  return modules.map((m, mi) => {
    const found = new Set();
    for (let a = m.i - 1; a <= m.i + m.fw; a++) {
      if (a < 0 || a >= NX) continue;
      for (let b = m.k - 1; b <= m.k + m.fd; b++) {
        if (b < 0 || b >= NZ) continue;
        for (let c = m.y - 1; c <= m.y + m.h; c++) {
          if (c < 0 || c >= GRID_LAYERS) continue;
          const inside =
            a >= m.i && a < m.i + m.fw &&
            b >= m.k && b < m.k + m.fd &&
            c >= m.y && c < m.y + m.h;
          if (inside) continue;
          const o = owner[at(a, b, c)];
          if (o >= 0 && o !== mi) found.add(o);
        }
      }
    }
    return [...found];
  });
}

// --- highlight groups -----------------------------------------------------

// Shares every module out among `groups` groups, so each block on the deck
// belongs to exactly one group. Group sizes differ by one at most.
//
// To spread each group over the whole deck, the modules are sorted along the
// length and dealt out in runs of `groups`. Every run gives one module to each
// group, so each group has one module in every stretch of the hull. Inside a
// run, each module goes to the free group whose nearest module so far is
// farthest away. That keeps a group's modules apart across the beam and up the
// stack as well.
//
// Takes its own random stream so allocating groups never changes the layout a
// given ?seed= produces.
// The outer surface of module m that nothing covers: its top, and each side
// face, cell by cell, where the next cell is empty. The bottom does not
// count. In square units.
function exposure(occ, m) {
  const free = (a, b, c) =>
    a < 0 || a >= NX || b < 0 || b >= NZ || c >= GRID_LAYERS || !occ[at(a, b, c)];
  const top = m.y + m.h;
  let area = 0;
  for (let a = m.i; a < m.i + m.fw; a++) {
    for (let b = m.k; b < m.k + m.fd; b++) if (free(a, b, top)) area += CELL * CELL;
  }
  for (let c = m.y; c < top; c++) {
    for (let b = m.k; b < m.k + m.fd; b++) {
      if (free(m.i - 1, b, c)) area += CELL * LAYER_H;
      if (free(m.i + m.fw, b, c)) area += CELL * LAYER_H;
    }
    for (let a = m.i; a < m.i + m.fw; a++) {
      if (free(a, m.k - 1, c)) area += CELL * LAYER_H;
      if (free(a, m.k + m.fd, c)) area += CELL * LAYER_H;
    }
  }
  return area;
}

// One contiguous chunk of the layout for each group, with about the same
// exposed surface in each (see exposure).
//
// A recursive cut: the modules are sorted along the longer side of their
// area in plan, and cut where the exposure on each side is in proportion to
// the groups that side gets. Then each side is cut again, until each part
// has one group. A cut goes through the whole height, so a chunk is a block
// of whole stacks, except where a cut falls inside one stack. The groups
// are then numbered in order around the ship (see orderAround), so the
// listing order goes once around the hull.
//
// A cut leaves at least one module for each group on each side, so a large
// landmark tier with a lot of exposure cannot leave a group empty. After the
// cuts, gaps in the layout can leave a chunk in more than one piece. Each
// piece apart from the largest then joins the chunk that it touches most
// (see joinStrays).
function assignChunks(modules, occ, groups, adjacency) {
  const group = new Int32Array(modules.length).fill(-1);
  if (!groups) return group;

  const items = modules.map((m, n) => ({
    n,
    x: m.i + m.fw / 2,
    z: m.k + m.fd / 2,
    y: m.y,
    w: exposure(occ, m),
  }));

  const split = (list, first, count) => {
    if (count <= 1 || list.length <= 1) {
      for (const item of list) group[item.n] = first;
      return;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const { x, z } of list) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const [a, b] = maxX - minX >= maxZ - minZ ? ['x', 'z'] : ['z', 'x'];
    list.sort((p, q) => p[a] - q[a] || p[b] - q[b] || p.y - q.y);

    const firstCount = Math.floor(count / 2);
    const total = list.reduce((sum, item) => sum + item.w, 0);
    const wanted = (total * firstCount) / count;
    // Each side keeps at least one module for each of its groups.
    const lowest = Math.max(1, firstCount);
    const highest = Math.min(list.length - 1, list.length - (count - firstCount));
    let cut = 1;
    let sum = list[0].w;
    while (cut < list.length - 1 && sum + list[cut].w / 2 < wanted) {
      sum += list[cut].w;
      cut++;
    }
    cut = Math.max(lowest, Math.min(highest, cut));
    split(list.slice(0, cut), first, firstCount);
    split(list.slice(cut), first + firstCount, count - firstCount);
  };

  split(items, 0, groups);
  joinStrays(group, groups, adjacency, items);
  return orderAround(group, groups, items);
}

// Numbers the chunks in order around the ship, so the listing's neighbours
// are neighbours on the ship too. The angle of each chunk's centre is taken
// on the hull's own proportions (length and beam both scaled to 1), so a long
// ship does not crowd the side chunks together. The order starts at the
// stern and goes around once. The listing order of the artists does not
// change: only which chunk each one gets.
function orderAround(group, groups, items) {
  const sum = Array.from({ length: groups }, () => ({ x: 0, z: 0, n: 0 }));
  for (const { n, x, z } of items) {
    const g = group[n];
    if (g < 0) continue;
    sum[g].x += x;
    sum[g].z += z;
    sum[g].n++;
  }
  const angle = sum.map(({ x, z, n }) => {
    if (!n) return 0;
    const u = (x / n - NX / 2) / (NX / 2);
    const v = (z / n - NZ / 2) / (NZ / 2);
    // From the stern (angle pi), so the order runs stern, one side, bow,
    // other side.
    return (Math.atan2(v, u) - Math.PI + 4 * Math.PI) % (2 * Math.PI);
  });
  const order = angle.map((a, g) => g).sort((p, q) => angle[p] - angle[q]);
  const renumber = new Int32Array(groups);
  order.forEach((g, rank) => (renumber[g] = rank));
  return group.map((g) => (g < 0 ? g : renumber[g]));
}

// Joins each stray piece of a chunk to the neighbouring chunk that it touches
// most. A piece is a set of modules of one group that touch each other. The
// largest piece of each group, by exposure, stays. A stray piece with no
// neighbour in another group stays too.
function joinStrays(group, groups, adjacency, items) {
  const weight = new Float64Array(group.length);
  for (const { n, w } of items) weight[n] = w;

  for (let g = 0; g < groups; g++) {
    const members = [];
    for (let n = 0; n < group.length; n++) if (group[n] === g) members.push(n);

    const pieces = [];
    const seen = new Set();
    for (const start of members) {
      if (seen.has(start)) continue;
      const piece = [start];
      seen.add(start);
      for (let p = 0; p < piece.length; p++) {
        for (const o of adjacency[piece[p]]) {
          if (group[o] === g && !seen.has(o)) {
            seen.add(o);
            piece.push(o);
          }
        }
      }
      pieces.push(piece);
    }
    if (pieces.length < 2) continue;

    const size = (piece) => piece.reduce((sum, n) => sum + weight[n], 0);
    pieces.sort((p, q) => size(q) - size(p));
    for (const piece of pieces.slice(1)) {
      const votes = new Map();
      for (const n of piece) {
        for (const o of adjacency[n]) {
          if (group[o] !== g) votes.set(group[o], (votes.get(group[o]) ?? 0) + 1);
        }
      }
      let best = null;
      let most = 0;
      for (const [other, count] of votes) {
        if (count > most) {
          best = other;
          most = count;
        }
      }
      if (best !== null) for (const n of piece) group[n] = best;
    }
  }
}

function assignGroups(rand, modules, groups) {
  const group = new Int32Array(modules.length).fill(-1);
  if (!groups) return group;

  const shuffle = (list) => {
    for (let n = list.length - 1; n > 0; n--) {
      const r = Math.floor(rand() * (n + 1));
      [list[n], list[r]] = [list[r], list[n]];
    }
    return list;
  };

  // Centres in cell units, with height rescaled so all three axes are alike.
  const centre = modules.map((m) => [
    m.i + m.fw / 2,
    ((m.y + m.h / 2) * LAYER_H) / CELL,
    m.k + m.fd / 2,
  ]);
  const order = modules.map((_, n) => n).sort((a, b) => centre[a][0] - centre[b][0]);
  const members = Array.from({ length: groups }, () => []);

  for (let from = 0; from < order.length; from += groups) {
    // Both shuffled, so no module or group always gets first choice.
    const run = shuffle(order.slice(from, from + groups));
    const free = shuffle(Array.from({ length: groups }, (_, g) => g));

    for (const n of run) {
      let best = 0;
      let bestDistance = -1;
      free.forEach((g, slot) => {
        let nearest = Infinity;
        for (const o of members[g]) {
          const dx = centre[n][0] - centre[o][0];
          const dy = centre[n][1] - centre[o][1];
          const dz = centre[n][2] - centre[o][2];
          nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
        }
        if (nearest > bestDistance) {
          bestDistance = nearest;
          best = slot;
        }
      });
      const g = free.splice(best, 1)[0];
      group[n] = g;
      members[g].push(n);
    }
  }

  return group;
}

// --- drop fill ------------------------------------------------------------

// On each hover, RISERS_MIN to RISERS_MAX modules of the lit group also grow a
// tower of RISE_MIN to RISE_MAX copies upward. The copies near the top of a
// tower are smaller (see SMALL_MIN and SMALL_MAX).
const RISE_MIN = 5;
const RISE_MAX = 10;
// The size of the small copies near the top of a tower, as a share of the
// module. Each tower picks one size in this range.
const SMALL_MIN = 0.5;
const SMALL_MAX = 0.7;
// No tower reaches higher than half a ship length above the deck, in layers.
// A tower stops at the last copy that fits under this line.
const TOWER_TOP = (0.5 * LOA) / LAYER_H;
const RISERS_MIN = 1;
const RISERS_MAX = 3;

/**
 * Geometry for the drop fill around one group.
 *
 * Downward: each module of the group is copied downward, one module height at
 * a time, until a copy would meet another module of the group or go through
 * the deck. The last copy is squashed to fit the gap that is left, so each
 * column closes up exactly.
 *
 * Upward: one to three modules of the group, chosen at random on each call,
 * also stack RISE_MIN to RISE_MAX copies on top of themselves. Only modules
 * with room for at least RISE_MIN copies are chosen, so a tower never runs
 * into a module of the group above it. The towers are laid out first and then
 * count as solid, so a column falling from above stops on a tower too.
 *
 * Only the group's own modules and the `kept` modules (see chooseKept) stop a
 * column. The rest of the cargo is hidden
 * while a group is lit, so a column that stopped on a hidden module would end
 * in mid-air.
 *
 * Each vertex carries `reach`: how many layers its copy sits from the module
 * it copies, measured to the far end of the copy. The drop shader shows a
 * copy once its growing front has passed that distance, so columns fall and
 * towers rise together. Returns null when there is nothing to copy.
 */
/**
 * Chooses the containers that stay in view while `group` is lit.
 *
 * Usually, a lit group hides all the other containers. This keeps about
 * `share` of them, so the lit group does not stand alone. The choice goes up
 * from the deck. A container is a candidate only if the deck, a kept
 * container, or a container of the lit group carries every cell under its
 * footprint. Thus no kept container floats.
 *
 * Returns one flag per module, 1 for kept. Pass the flags to buildDrop, so
 * the drop fill stops on the kept containers instead of going through them.
 * main.js also uses them to set which containers are in view.
 */
export function chooseKept(cargo, group, share, rand = Math.random) {
  const { modules, moduleGroup } = cargo.userData;
  const kept = new Uint8Array(modules?.length ?? 0);
  if (!modules) return kept;

  const solid = new Uint8Array(NX * NZ * GRID_LAYERS);
  const fill = (m) => {
    for (let a = m.i; a < m.i + m.fw; a++) {
      for (let b = m.k; b < m.k + m.fd; b++) {
        for (let c = m.y; c < Math.min(m.y + m.h, GRID_LAYERS); c++) solid[at(a, b, c)] = 1;
      }
    }
  };
  const supported = (m) => {
    if (m.y === 0) return true;
    if (m.y > GRID_LAYERS) return false;
    for (let a = m.i; a < m.i + m.fw; a++) {
      for (let b = m.k; b < m.k + m.fd; b++) if (!solid[at(a, b, m.y - 1)]) return false;
    }
    return true;
  };

  // The lit group's own containers stay in view, so they can carry others.
  for (let n = 0; n < modules.length; n++) if (moduleGroup[n] === group) fill(modules[n]);

  // Bottom up, so every container under a candidate is decided first.
  const order = [];
  for (let n = 0; n < modules.length; n++) if (moduleGroup[n] !== group) order.push(n);
  order.sort((a, b) => modules[a].y - modules[b].y);

  for (const n of order) {
    const m = modules[n];
    if (!supported(m) || rand() >= share) continue;
    kept[n] = 1;
    fill(m);
  }

  return kept;
}

export function buildDrop(cargo, group, kept = null, rand = Math.random) {
  const { modules, moduleGroup, moduleRanges, basePositions } = cargo.userData;
  if (!modules) return null;
  const baseNormals = cargo.geometry.attributes.normal.array;
  const baseWindows = cargo.geometry.attributes.window.array;
  const baseIndices = cargo.geometry.index.array;

  // Cells above GRID_LAYERS are always free; only towers can reach them.
  const solid = new Uint8Array(NX * NZ * GRID_LAYERS);
  const fill = (m, from, to) => {
    for (let a = m.i; a < m.i + m.fw; a++) {
      for (let b = m.k; b < m.k + m.fd; b++) {
        for (let c = from; c < Math.min(to, GRID_LAYERS); c++) solid[at(a, b, c)] = 1;
      }
    }
  };
  const layerFree = (m, c) => {
    if (c >= GRID_LAYERS) return true;
    for (let a = m.i; a < m.i + m.fw; a++) {
      for (let b = m.k; b < m.k + m.fd; b++) if (solid[at(a, b, c)]) return false;
    }
    return true;
  };

  const members = [];
  for (let n = 0; n < modules.length; n++) {
    if (moduleGroup[n] !== group) continue;
    members.push(n);
    fill(modules[n], modules[n].y, modules[n].y + modules[n].h);
  }
  // Kept containers are solid too, so a column lands on them and a tower
  // stops under them.
  if (kept) {
    for (let n = 0; n < modules.length; n++) {
      if (kept[n]) fill(modules[n], modules[n].y, modules[n].y + modules[n].h);
    }
  }

  const positions = [];
  const normals = [];
  const reach = [];
  const windows = [];
  const indices = [];

  // One copy of module n with its base on layer `bottom`, `layers` tall.
  // `scale` shrinks the copy's width and depth around the module's centre.
  // Pass layers = m.h x scale too, so the copy keeps its proportions.
  const pushCopy = (n, bottom, layers, distance, scale = 1) => {
    const m = modules[n];
    const cx = cellX(m.i) + (m.fw * CELL) / 2;
    const cz = cellZ(m.k) + (m.fd * CELL) / 2;
    // The copy leaves out the module's antenna, so a stack of copies has no
    // mast sticking up through it (see copyCount in createCargo).
    const { start, copyCount: count, indexStart, copyIndexCount: indexCount } = moduleRanges[n];
    const baseY = DEPTH + m.y * LAYER_H;
    const squash = layers / m.h;
    const y0 = DEPTH + bottom * LAYER_H;
    const copyStart = positions.length / 3;

    for (let v = start; v < start + count; v++) {
      positions.push(
        cx + (basePositions[v * 3] - cx) * scale,
        y0 + (basePositions[v * 3 + 1] - baseY) * squash,
        cz + (basePositions[v * 3 + 2] - cz) * scale,
      );
      normals.push(baseNormals[v * 3], baseNormals[v * 3 + 1], baseNormals[v * 3 + 2]);
      reach.push(distance);
      windows.push(baseWindows[v]);
    }
    for (let x = indexStart; x < indexStart + indexCount; x++) {
      indices.push(baseIndices[x] - start + copyStart);
    }
  };

  // How many whole copies fit on top of module n, up to RISE_MAX.
  const roomAbove = (n) => {
    const m = modules[n];
    let copies = 0;
    let c = m.y + m.h;
    while (copies < RISE_MAX) {
      for (let layer = c; layer < c + m.h; layer++) if (!layerFree(m, layer)) return copies;
      copies++;
      c += m.h;
    }
    return copies;
  };

  // A container with an antenna has a mast on its roof, so it does not rise.
  const candidates = members.filter((n) => !modules[n].antenna && roomAbove(n) >= RISE_MIN);
  for (let n = candidates.length - 1; n > 0; n--) {
    const r = Math.floor(rand() * (n + 1));
    [candidates[n], candidates[r]] = [candidates[r], candidates[n]];
  }
  const risers = RISERS_MIN + Math.floor(rand() * (RISERS_MAX - RISERS_MIN + 1));

  // Towers are chosen one by one and filled in at once, so a later choice
  // sees the earlier towers as solid and cannot grow through them.
  let raised = 0;
  for (const n of candidates) {
    if (raised === risers) break;
    const room = roomAbove(n);
    if (room < RISE_MIN) continue;
    const m = modules[n];
    const wanted = RISE_MIN + Math.floor(rand() * (RISE_MAX - RISE_MIN + 1));
    const copies = Math.min(room, wanted);
    // Two sizes: full size at the bottom, then smaller copies to the top.
    // The first small copy is anywhere from about the middle of the tower to
    // the last copy, so at least the top copy is small. A small copy shrinks
    // in all three directions, so it keeps the module's shape.
    const middle = Math.max(1, Math.ceil(copies / 2));
    const firstSmall = copies - Math.floor(rand() * (copies - middle + 1));
    const small = SMALL_MIN + rand() * (SMALL_MAX - SMALL_MIN);
    let bottom = m.y + m.h;
    for (let k = 1; k <= copies; k++) {
      const scale = k >= firstSmall ? small : 1;
      const layers = m.h * scale;
      if (bottom + layers > TOWER_TOP) break;
      pushCopy(n, bottom, layers, bottom - m.y, scale);
      bottom += layers;
    }
    fill(m, m.y + m.h, Math.ceil(bottom));
    raised++;
  }

  for (const n of members) {
    const m = modules[n];
    let floor = m.y;
    while (floor > 0 && layerFree(m, floor - 1)) floor--;
    for (let top = m.y; top > floor; top -= m.h) {
      const bottom = Math.max(floor, top - m.h);
      pushCopy(n, bottom, top - bottom, m.y - bottom);
    }
  }

  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('reach', new THREE.Float32BufferAttribute(reach, 1));
  geometry.setAttribute('window', new THREE.Float32BufferAttribute(windows, 1));
  geometry.setIndex(indices);
  geometry.userData.risers = raised;
  return geometry;
}

/**
 * Geometry for the towers of one chunk group: copies of a module stacked on
 * top of it, full size at the bottom and smaller near the top, as with the
 * drop's risers.
 *
 * - `origin` always builds a tower, if it can. Each other module of the group
 *   builds one with the odds `odds`. The parts of a large block never build.
 * - A module can build only if nothing is directly above it: no module, and
 *   no tower from an earlier call. A tower stops below anything in its way.
 * - `litAt(n)` is the time that module n lights. Its tower starts to grow
 *   then, at `rate` layers a second. Each vertex carries `showAt`, the time
 *   its copy appears, and `group`, so the tower can light with its chunk.
 *
 * The cells of each new tower are marked in cargo.userData.solid, so later
 * towers do not grow into it. Returns null if no tower was built.
 */
export function buildTowers(cargo, group, origin, litAt, { odds, rate, rand = Math.random }) {
  const { modules, moduleGroup, moduleRanges, basePositions } = cargo.userData;
  if (!modules) return null;
  const baseNormals = cargo.geometry.attributes.normal.array;
  const baseWindows = cargo.geometry.attributes.window.array;
  const baseIndices = cargo.geometry.index.array;

  // Every module's cells, made once for each cargo. Towers add to it.
  if (!cargo.userData.solid) {
    const grid = new Uint8Array(NX * NZ * GRID_LAYERS);
    for (const m of modules) {
      for (let a = m.i; a < m.i + m.fw; a++) {
        for (let b = m.k; b < m.k + m.fd; b++) {
          for (let c = m.y; c < Math.min(m.y + m.h, GRID_LAYERS); c++) grid[at(a, b, c)] = 1;
        }
      }
    }
    cargo.userData.solid = grid;
  }
  const solid = cargo.userData.solid;
  const layerFree = (m, c) => {
    if (c >= GRID_LAYERS) return true;
    for (let a = m.i; a < m.i + m.fw; a++) {
      for (let b = m.k; b < m.k + m.fd; b++) if (solid[at(a, b, c)]) return false;
    }
    return true;
  };
  // Whole copies of module n that fit on top of it, up to RISE_MAX.
  const room = (m) => {
    let copies = 0;
    for (let c = m.y + m.h; copies < RISE_MAX; c += m.h) {
      for (let layer = c; layer < c + m.h; layer++) if (!layerFree(m, layer)) return copies;
      copies++;
    }
    return copies;
  };

  const positions = [];
  const normals = [];
  const windows = [];
  const groups = [];
  const showAt = [];
  const indices = [];

  const pushCopy = (n, bottom, layers, scale, time) => {
    const m = modules[n];
    // The copy leaves out the module's antenna, so a stack of copies has no
    // mast sticking up through it (see copyCount in createCargo).
    const { start, copyCount: count, indexStart, copyIndexCount: indexCount } = moduleRanges[n];
    const cx = cellX(m.i) + (m.fw * CELL) / 2;
    const cz = cellZ(m.k) + (m.fd * CELL) / 2;
    const baseY = DEPTH + m.y * LAYER_H;
    const squash = layers / m.h;
    const y0 = DEPTH + bottom * LAYER_H;
    const copyStart = positions.length / 3;
    for (let v = start; v < start + count; v++) {
      positions.push(
        cx + (basePositions[v * 3] - cx) * scale,
        y0 + (basePositions[v * 3 + 1] - baseY) * squash,
        cz + (basePositions[v * 3 + 2] - cz) * scale,
      );
      normals.push(baseNormals[v * 3], baseNormals[v * 3 + 1], baseNormals[v * 3 + 2]);
      windows.push(baseWindows[v]);
      groups.push(group);
      showAt.push(time);
    }
    for (let x = indexStart; x < indexStart + indexCount; x++) {
      indices.push(baseIndices[x] - start + copyStart);
    }
  };

  const members = [];
  for (let n = 0; n < modules.length; n++) if (moduleGroup[n] === group) members.push(n);
  // The origin goes first, so it gets the room before its neighbours.
  members.sort((p, q) => (p === origin ? -1 : q === origin ? 1 : 0));

  let built = 0;
  for (const n of members) {
    if (n !== origin && rand() >= odds) continue;
    const m = modules[n];
    // The parts of a large block do not build. Their copies are up to 13
    // layers high, so even a short tower of them is very tall.
    if (m.landmark) continue;
    // A mast stands on this roof.
    if (m.antenna) continue;
    const fits = room(m);
    if (fits < 1) continue;

    const wanted = RISE_MIN + Math.floor(rand() * (RISE_MAX - RISE_MIN + 1));
    const copies = Math.min(fits, wanted);
    const middle = Math.max(1, Math.ceil(copies / 2));
    const firstSmall = copies - Math.floor(rand() * (copies - middle + 1));
    const small = SMALL_MIN + rand() * (SMALL_MAX - SMALL_MIN);

    const start = litAt(n);
    let bottom = m.y + m.h;
    for (let k = 1; k <= copies; k++) {
      const scale = k >= firstSmall ? small : 1;
      const layers = m.h * scale;
      if (bottom + layers > TOWER_TOP) break;
      // A copy appears once the growth has reached its top.
      pushCopy(n, bottom, layers, scale, start + (bottom + layers - (m.y + m.h)) / rate);
      bottom += layers;
    }
    for (let a = m.i; a < m.i + m.fw; a++) {
      for (let b = m.k; b < m.k + m.fd; b++) {
        for (let c = m.y + m.h; c < Math.min(Math.ceil(bottom), GRID_LAYERS); c++) solid[at(a, b, c)] = 1;
      }
    }
    built++;
  }

  if (!built) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('window', new THREE.Float32BufferAttribute(windows, 1));
  geometry.setAttribute('group', new THREE.Float32BufferAttribute(groups, 1));
  geometry.setAttribute('showAt', new THREE.Float32BufferAttribute(showAt, 1));
  geometry.setIndex(indices);
  geometry.userData.towers = built;
  return geometry;
}

// --- geometry -------------------------------------------------------------

// Convention for every emitter below: list a shape's bottom ring counter-
// clockwise as seen from above, and side faces [B(n), B(n+1), T(n+1), T(n)]
// come out facing outward, top ring faces +Y, reversed bottom ring faces -Y.
function pushFace(target, verts) {
  const [a, b, c] = verts;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;

  const base = target.positions.length / 3;
  for (const v of verts) {
    target.positions.push(v[0], v[1], v[2]);
    target.normals.push(nx, ny, nz);
  }
  for (let n = 1; n < verts.length - 1; n++) {
    target.indices.push(base, base + n, base + n + 1);
  }
}

function ring(cx, cz, hx, hz, y) {
  return [
    [cx - hx, y, cz + hz],
    [cx + hx, y, cz + hz],
    [cx + hx, y, cz - hz],
    [cx - hx, y, cz - hz],
  ];
}

function pushSolid(target, bottom, top) {
  pushFace(target, top);
  pushFace(target, bottom.slice().reverse());
  for (let n = 0; n < bottom.length; n++) {
    const m = (n + 1) % bottom.length;
    pushFace(target, [bottom[n], bottom[m], top[m], top[n]]);
  }
}

function pushBox(target, c, s) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  pushSolid(
    target,
    ring(c[0], c[2], s[0] / 2, s[2] / 2, y0),
    ring(c[0], c[2], s[0] / 2, s[2] / 2, y1),
  );
}

function pushFrustum(target, c, s, topScale) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  pushSolid(
    target,
    ring(c[0], c[2], s[0] / 2, s[2] / 2, y0),
    ring(c[0], c[2], (s[0] / 2) * topScale, (s[2] / 2) * topScale, y1),
  );
}

function pushPrism(target, c, s, sides, twist) {
  const r = Math.min(s[0], s[2]) / 2;
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const bottom = [];
  const top = [];
  for (let n = 0; n < sides; n++) {
    // Negative angle keeps the ring counter-clockwise seen from above.
    const a = (-2 * Math.PI * n) / sides + twist;
    const x = c[0] + r * Math.cos(a);
    const z = c[2] + r * Math.sin(a);
    bottom.push([x, y0, z]);
    top.push([x, y1, z]);
  }
  pushSolid(target, bottom, top);
}

function pushStepped(target, c, s, rand) {
  const steps = 2 + Math.floor(rand() * 3);
  const stepH = s[1] / steps;
  for (let n = 0; n < steps; n++) {
    const f = 1 - n * (0.2 + rand() * 0.12);
    if (f <= 0.2) break;
    pushBox(
      target,
      [c[0], c[1] - s[1] / 2 + stepH * (n + 0.5), c[2]],
      [s[0] * f, stepH, s[2] * f],
    );
  }
}

// A convex solid from its faces, in any order and any winding. Each face is
// turned to face away from the solid's centre, so the new shapes below need
// no care about vertex order.
function pushConvex(target, faces) {
  const centre = [0, 0, 0];
  let count = 0;
  for (const face of faces) {
    for (const v of face) {
      centre[0] += v[0]; centre[1] += v[1]; centre[2] += v[2];
      count++;
    }
  }
  centre[0] /= count; centre[1] /= count; centre[2] /= count;

  for (const face of faces) {
    const [a, b, c] = face;
    const n = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ];
    const mid = [0, 0, 0];
    for (const v of face) { mid[0] += v[0]; mid[1] += v[1]; mid[2] += v[2]; }
    const out =
      n[0] * (mid[0] / face.length - centre[0]) +
      n[1] * (mid[1] / face.length - centre[1]) +
      n[2] * (mid[2] / face.length - centre[2]);
    pushFace(target, out < 0 ? face.slice().reverse() : face);
  }
}

// The faces of a solid between two rings with the same vertex count: both
// caps and the sides.
function ringFaces(bottom, top) {
  const faces = [bottom, top];
  for (let n = 0; n < bottom.length; n++) {
    const m = (n + 1) % bottom.length;
    faces.push([bottom[n], bottom[m], top[m], top[n]]);
  }
  return faces;
}

// A box from its min and max corners.
function pushBlock(target, min, max) {
  pushConvex(
    target,
    ringFaces(
      ring((min[0] + max[0]) / 2, (min[2] + max[2]) / 2, (max[0] - min[0]) / 2, (max[2] - min[2]) / 2, min[1]),
      ring((min[0] + max[0]) / 2, (min[2] + max[2]) / 2, (max[0] - min[0]) / 2, (max[2] - min[2]) / 2, max[1]),
    ),
  );
}

// An octagon in plan: the box with its vertical corners cut. `cut` is the
// share of the shorter side that each corner loses.
function pushChamfer(target, c, s, cut) {
  const hx = s[0] / 2;
  const hz = s[2] / 2;
  const d = Math.min(s[0], s[2]) * cut;
  const plan = [
    [-hx + d, -hz], [hx - d, -hz], [hx, -hz + d], [hx, hz - d],
    [hx - d, hz], [-hx + d, hz], [-hx, hz - d], [-hx, -hz + d],
  ];
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  pushConvex(
    target,
    ringFaces(
      plan.map(([x, z]) => [c[0] + x, y0, c[2] + z]),
      plan.map(([x, z]) => [c[0] + x, y1, c[2] + z]),
    ),
  );
}

// Walls up to `wallShare` of the height, then a pitched roof to a ridge
// along `axis` (0 for x, 2 for z).
function pushGabled(target, c, s, axis, wallShare) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const yw = y0 + s[1] * wallShare;
  const hx = s[0] / 2;
  const hz = s[2] / 2;
  pushBlock(target, [c[0] - hx, y0, c[2] - hz], [c[0] + hx, yw, c[2] + hz]);

  // The roof is a triangular prism: one triangle at each end of the ridge.
  const end = (t) =>
    axis === 0
      ? [[c[0] + t, yw, c[2] - hz], [c[0] + t, yw, c[2] + hz], [c[0] + t, y1, c[2]]]
      : [[c[0] - hx, yw, c[2] + t], [c[0] + hx, yw, c[2] + t], [c[0], y1, c[2] + t]];
  const half = axis === 0 ? hx : hz;
  pushConvex(target, ringFaces(end(-half), end(half)));
}

// A roof that slopes down along `axis`, toward the + side if `towardPlus`.
// The low side is `lowShare` of the full height.
function pushShed(target, c, s, axis, towardPlus, lowShare) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const yLow = y0 + s[1] * lowShare;
  const hx = s[0] / 2;
  const hz = s[2] / 2;
  const bottom = ring(c[0], c[2], hx, hz, y0);
  const top = ring(c[0], c[2], hx, hz, y1).map((v) => {
    const offset = axis === 0 ? v[0] - c[0] : v[2] - c[2];
    const low = towardPlus ? offset > 0 : offset < 0;
    return low ? [v[0], yLow, v[2]] : v;
  });
  pushConvex(target, ringFaces(bottom, top));
}

// An L in plan: two boxes, with the corner `corner` (0 to 3) taken out.
// `share` is the width of each arm, as a share of the side.
function pushLShape(target, c, s, corner, share) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const x0 = c[0] - s[0] / 2;
  const x1 = c[0] + s[0] / 2;
  const z0 = c[2] - s[2] / 2;
  const z1 = c[2] + s[2] / 2;
  const sx = corner & 1 ? 1 : -1; // the side of the full-depth arm
  const sz = corner & 2 ? 1 : -1; // the side of the full-width arm
  const xArm = sx < 0 ? [x0, x0 + s[0] * share] : [x1 - s[0] * share, x1];
  const zArm = sz < 0 ? [z0, z0 + s[2] * share] : [z1 - s[2] * share, z1];
  // The full-depth arm, then the rest of the full-width arm beside it.
  pushBlock(target, [xArm[0], y0, z0], [xArm[1], y1, z1]);
  const rest = sx < 0 ? [xArm[1], x1] : [x0, xArm[0]];
  pushBlock(target, [rest[0], y0, zArm[0]], [rest[1], y1, zArm[1]]);
}

// Two boxes side by side along `axis`. The first takes `share` of the side
// at full height. The second is `lowShare` of the height.
function pushSplit(target, c, s, axis, share, lowShare) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const min = [c[0] - s[0] / 2, y0, c[2] - s[2] / 2];
  const max = [c[0] + s[0] / 2, y1, c[2] + s[2] / 2];
  const cut = min[axis] + s[axis] * share;
  const firstMax = max.slice();
  firstMax[axis] = cut;
  pushBlock(target, min, firstMax);
  const secondMin = min.slice();
  secondMin[axis] = cut;
  const secondMax = max.slice();
  secondMax[1] = y0 + s[1] * lowShare;
  pushBlock(target, secondMin, secondMax);
}

// A core box with a raised band at each tier boundary, so the stack of tiers
// shows on the outside.
function pushRibbed(target, c, s, tiers) {
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const inset = Math.min(s[0], s[2]) * 0.05;
  const band = Math.min(0.03, s[1] / (tiers * 4));
  pushBlock(
    target,
    [c[0] - s[0] / 2 + inset, y0, c[2] - s[2] / 2 + inset],
    [c[0] + s[0] / 2 - inset, y1, c[2] + s[2] / 2 - inset],
  );
  for (let t = 1; t < tiers; t++) {
    const y = y0 + (s[1] * t) / tiers;
    pushBlock(target, [c[0] - s[0] / 2, y - band / 2, c[2] - s[2] / 2], [c[0] + s[0] / 2, y + band / 2, c[2] + s[2] / 2]);
  }
  // A band at the top edge too, so the roof reads as a parapet.
  pushBlock(target, [c[0] - s[0] / 2, y1 - band, c[2] - s[2] / 2], [c[0] + s[0] / 2, y1, c[2] + s[2] / 2]);
}

// An upright cylinder with `sides` sides, and a short tapered cap on top.
function pushTank(target, c, s, sides) {
  const r = Math.min(s[0], s[2]) / 2;
  const y0 = c[1] - s[1] / 2;
  const y1 = c[1] + s[1] / 2;
  const yCap = y1 - Math.min(s[1] * 0.2, r * 0.6);
  const circle = (radius, y) => {
    const points = [];
    for (let n = 0; n < sides; n++) {
      const a = (2 * Math.PI * n) / sides;
      points.push([c[0] + radius * Math.cos(a), y, c[2] + radius * Math.sin(a)]);
    }
    return points;
  };
  pushConvex(target, ringFaces(circle(r, y0), circle(r, yCap)));
  pushConvex(target, ringFaces(circle(r, yCap), circle(r * 0.55, y1)));
}

// True if no cell directly above module m is taken.
function topExposed(occ, m) {
  const top = m.y + m.h;
  if (top >= GRID_LAYERS) return true;
  for (let a = m.i; a < m.i + m.fw; a++) {
    for (let b = m.k; b < m.k + m.fd; b++) if (occ[at(a, b, top)]) return false;
  }
  return true;
}

// A thin mast standing on `base`, `height` tall: a lower section to 60% of
// the height, then a taper to a sharp point.
function pushAntenna(target, base, height) {
  const sides = 6;
  const circle = (radius, y) => {
    const points = [];
    for (let n = 0; n < sides; n++) {
      const a = (2 * Math.PI * n) / sides;
      points.push([base[0] + radius * Math.cos(a), y, base[2] + radius * Math.sin(a)]);
    }
    return points;
  };
  const split = base[1] + height * 0.6;
  pushConvex(target, ringFaces(circle(ANTENNA_RADIUS, base[1]), circle(ANTENNA_RADIUS, split)));
  // A cone: the base ring, then one triangle from each edge to the tip.
  const ring = circle(ANTENNA_RADIUS, split);
  const tip = [base[0], base[1] + height, base[2]];
  const faces = [ring];
  for (let n = 0; n < sides; n++) faces.push([ring[n], ring[(n + 1) % sides], tip]);
  pushConvex(target, faces);
}

// Windows are studs standing a hair off the face rather than holes cut into
// it. With an outline renderer the two read the same -- you only see the
// stroke at the border -- and this needs no re-tessellation. The relief is far
// too shallow for the depth term to catch, so the normal term draws them: a
// stud's side walls are perpendicular to the face.
//
// `spec` limits the windows to the flat part of the wall: `uInset` keeps them
// off each side edge (a chamfer's cut corners), and `vTop` is the wall's
// height from the bottom (a gabled or shed roof starts above it). `fill` is
// the share of places with a window.
function pushWindows(target, c, s, axis, sign, rand, spec = {}) {
  const { uInset = 0, vTop = s[1], fill = WINDOW_FILL } = spec;
  const uAxis = axis === 0 ? 2 : 0;
  const spacing = Math.max(...WINDOW_SIZES) + WINDOW_GAP;

  const uSpan = s[uAxis] - 2 * (WINDOW_MARGIN + uInset);
  const vSpan = vTop - 2 * WINDOW_MARGIN;
  // The middle of the wall part, from the bottom of the module.
  const vMid = c[1] - s[1] / 2 + vTop / 2;
  const cols = Math.floor(uSpan / spacing);
  const rows = Math.floor(vSpan / spacing);
  if (cols < 1 || rows < 1) return;

  const uStep = uSpan / cols;
  const vStep = vSpan / rows;

  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      if (rand() > fill) continue;

      const size = WINDOW_SIZES[Math.floor(rand() * WINDOW_SIZES.length)];
      const wc = [0, 0, 0];
      wc[axis] = c[axis] + (sign * s[axis]) / 2;
      wc[uAxis] = c[uAxis] - uSpan / 2 + (col + 0.5) * uStep;
      wc[1] = vMid - vSpan / 2 + (r + 0.5) * vStep;

      const ws = [0, 0, 0];
      ws[axis] = WINDOW_RELIEF * 2;
      ws[uAxis] = size;
      ws[1] = size;

      pushBox(target, wc, ws);
    }
  }
}

// A face only gets windows if nothing abuts it anywhere across its span,
// otherwise they end up buried inside the stack. Bridges are always exposed
// underneath, so they get treated as open on every side.
function faceExposed(occ, m, axis, sign) {
  if (axis === 0) {
    const i = sign > 0 ? m.i + m.fw : m.i - 1;
    if (i < 0 || i >= NX) return true;
    for (let b = m.k; b < m.k + m.fd; b++) {
      for (let c = m.y; c < m.y + m.h; c++) if (occ[at(i, b, c)]) return false;
    }
    return true;
  }

  const k = sign > 0 ? m.k + m.fd : m.k - 1;
  if (k < 0 || k >= NZ) return true;
  for (let a = m.i; a < m.i + m.fw; a++) {
    for (let c = m.y; c < m.y + m.h; c++) if (occ[at(a, k, c)]) return false;
  }
  return true;
}

export function createCargo(material, seed = defaultSeed(), groups = defaultGroups()) {
  const rand = mulberry32(seed);
  const { occ, owner, modules, landmarks } = pack(rand);
  const adjacency = buildAdjacency(modules, owner);
  const moduleGroup =
    GROUPING === 'chunks'
      ? assignChunks(modules, occ, groups, adjacency)
      : assignGroups(mulberry32(seed ^ 0x9e3779b9), modules, groups);

  const target = { positions: [], normals: [], indices: [] };
  const g = MODULE_GAP / 2;
  // Vertex span of each module, windows included, so it can be hidden as a unit.
  const ranges = [];
  // Height each module sits at, for effects that sweep bottom to top.
  const baseHeights = [];
  // Vertex span of each module's windows, so they can be hidden on their own.
  const windowRanges = [];

  for (const m of modules) {
    const vertexStart = target.positions.length / 3;
    const indexStart = target.indices.length;
    const minX = cellX(m.i) + g;
    const maxX = cellX(m.i + m.fw) - g;
    const minZ = cellZ(m.k) + g;
    const maxZ = cellZ(m.k + m.fd) - g;
    const minY = DEPTH + m.y * LAYER_H + g;
    const maxY = DEPTH + (m.y + m.h) * LAYER_H - g;

    const c = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    const s = [maxX - minX, maxY - minY, maxZ - minZ];

    // The flat part of the walls, for the windows. Null for a kind without
    // windows.
    let windowSpec = null;
    if (m.kind === 'prism') {
      pushPrism(target, c, s, rand() < 0.5 ? 6 : 8, rand() * Math.PI);
    } else if (m.kind === 'frustum') {
      pushFrustum(target, c, s, 0.35 + rand() * 0.45);
    } else if (m.kind === 'stepped') {
      pushStepped(target, c, s, rand);
    } else if (m.kind === 'chamfer') {
      const cut = 0.18 + rand() * 0.14;
      pushChamfer(target, c, s, cut);
      windowSpec = { uInset: Math.min(s[0], s[2]) * cut };
    } else if (m.kind === 'gabled') {
      // The ridge runs along the longer side.
      const wallShare = 0.55 + rand() * 0.2;
      pushGabled(target, c, s, s[0] >= s[2] ? 0 : 2, wallShare);
      windowSpec = { vTop: s[1] * wallShare };
    } else if (m.kind === 'shed') {
      const lowShare = 0.45 + rand() * 0.3;
      pushShed(target, c, s, rand() < 0.5 ? 0 : 2, rand() < 0.5, lowShare);
      // Every wall is at least as tall as the low side.
      windowSpec = { vTop: s[1] * lowShare };
    } else if (m.kind === 'lshape') {
      pushLShape(target, c, s, Math.floor(rand() * 4), 0.4 + rand() * 0.2);
    } else if (m.kind === 'split') {
      pushSplit(target, c, s, s[0] >= s[2] ? 0 : 2, 0.4 + rand() * 0.2, 0.5 + rand() * 0.3);
    } else if (m.kind === 'ribbed') {
      pushRibbed(target, c, s, m.h);
    } else if (m.kind === 'tank') {
      pushTank(target, c, s, 12 + 2 * Math.floor(rand() * 3));
    } else {
      pushBox(target, c, s);
      windowSpec = {};
    }

    // Only the kinds with flat, upright walls get windows; they would float
    // off a sloped face. Small containers get windows only as boxes. Medium
    // and large ones get them on every flat-walled kind, almost full. They
    // come after the body, so one span covers all of a module's windows.
    const windowStart = target.positions.length / 3;
    const large = isLarge(m);
    if (windowSpec && (large || m.kind === 'box')) {
      if (large) windowSpec.fill = WINDOW_FILL_LARGE;
      for (const [axis, sign] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
        if (faceExposed(occ, m, axis, sign)) {
          pushWindows(target, c, s, axis, sign, rand, windowSpec);
        }
      }
    }

    windowRanges.push([windowStart, target.positions.length / 3]);

    // The antenna comes last, so the copies can leave it out: copyCount and
    // copyIndexCount end before it. Only a container with nothing above it
    // gets one, and such a container never builds a tower.
    const copyCount = target.positions.length / 3 - vertexStart;
    const copyIndexCount = target.indices.length - indexStart;
    m.antenna = false;
    if (ANTENNA_KINDS.includes(m.kind) && topExposed(occ, m) && rand() < ANTENNA_ODDS) {
      // On a flat roof the mast can stand off centre. On a pointed roof it
      // stands on the peak.
      const flat = m.kind === 'box' || m.kind === 'chamfer' || m.kind === 'ribbed';
      const x = c[0] + (flat ? (rand() - 0.5) * s[0] * 0.5 : 0);
      const z = c[2] + (flat ? (rand() - 0.5) * s[2] * 0.5 : 0);
      pushAntenna(target, [x, maxY, z], ANTENNA_MIN + rand() * (ANTENNA_MAX - ANTENNA_MIN));
      m.antenna = true;
    }

    ranges.push({
      start: vertexStart,
      count: target.positions.length / 3 - vertexStart,
      indexStart,
      indexCount: target.indices.length - indexStart,
      copyCount,
      copyIndexCount,
    });
    baseHeights.push(minY);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(target.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(target.normals, 3));
  geometry.setIndex(target.indices);

  // Highlight group of every vertex, -1 for none. Constant across a module, so
  // the material can match it against the active group per fragment.
  const vertexGroup = new Float32Array(target.positions.length / 3).fill(-1);
  ranges.forEach(({ start, count }, n) => {
    if (moduleGroup[n] >= 0) vertexGroup.fill(moduleGroup[n], start, start + count);
  });
  geometry.setAttribute('group', new THREE.Float32BufferAttribute(vertexGroup, 1));

  // 1 on window vertices, 0 elsewhere, so a view can drop the windows (see
  // detail.js).
  const vertexWindow = new Float32Array(target.positions.length / 3);
  for (const [from, to] of windowRanges) vertexWindow.fill(1, from, to);
  geometry.setAttribute('window', new THREE.Float32BufferAttribute(vertexWindow, 1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.seed = seed;
  mesh.userData.moduleCount = modules.length;
  mesh.userData.bridgeCount = modules.filter((m) => m.bridge).length;
  mesh.userData.moduleRanges = ranges;
  mesh.userData.moduleBaseY = Float32Array.from(baseHeights);
  mesh.userData.adjacency = adjacency;
  mesh.userData.crawlable = Uint8Array.from(modules, (m) =>
    !m.landmark && m.fw * m.fd <= CRAWL_MAX_AREA && m.h <= CRAWL_MAX_HEIGHT ? 1 : 0,
  );
  mesh.userData.groupCount = groups;
  // What the drop fill needs to copy a module: its grid placement, its group,
  // and its vertices as built. The live position buffer is no use for that,
  // since the fill and crawl effects collapse modules in it.
  mesh.userData.modules = modules;
  // Each module's grid box in the cargo's local space, as min x, y, z then
  // max x, y, z. The pointer pick tests these, not the full geometry.
  mesh.userData.boxes = Float32Array.from(
    modules.flatMap((m) => [
      cellX(m.i), DEPTH + m.y * LAYER_H, cellZ(m.k),
      cellX(m.i + m.fw), DEPTH + (m.y + m.h) * LAYER_H, cellZ(m.k + m.fd),
    ]),
  );
  mesh.userData.moduleGroup = moduleGroup;
  mesh.userData.basePositions = Float32Array.from(target.positions);
  mesh.userData.landmarkCount = landmarks.count;
  mesh.userData.megaSize = landmarks.megaSize;
  mesh.userData.cantileverCount = modules.filter((m) => m.cantilever).length;
  initVisibility(mesh);
  // The time at which each vertex's module lights, for the fan-out of the
  // highlight (see startFan in highlight.js). 0 lights at once.
  mesh.geometry.setAttribute(
    'litAt',
    new THREE.Float32BufferAttribute(new Float32Array(target.positions.length / 3), 1),
  );
  return mesh;
}
