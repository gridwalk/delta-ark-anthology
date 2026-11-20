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

const WINDOW_SIZES = [0.028, 0.044, 0.064];
const WINDOW_RELIEF = 0.01;
const WINDOW_MARGIN = 0.034;
const WINDOW_GAP = 0.026;
const WINDOW_FILL = 0.74;

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

function chooseKind(rand, fw, fd, h, support) {
  if (support === 'bridge') return 'box'; // a tapered span reads as a mistake
  const r = rand();
  if (fw === fd && fw >= 2 && r < 0.1) return 'prism';
  if (r < 0.22) return 'frustum';
  if (r < 0.34 && h >= 2) return 'stepped';
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

  const index = modules.length;
  for (let a = i; a < i + fw; a++) {
    for (let b = k; b < k + fd; b++) {
      for (let c = 0; c < h; c++) {
        occ[at(a, b, c)] = 1;
        owner[at(a, b, c)] = index;
      }
    }
  }

  // A prism needs a roughly square footprint or it inscribes to a stub.
  const r = rand();
  const kind =
    Math.abs(fw - fd) <= 1 && r < 0.3 ? 'prism'
    : r < 0.6 ? 'frustum'
    : r < 0.8 ? 'stepped'
    : 'box';

  modules.push({ i, k, y: 0, fw, fd, h, kind, bridge: false, landmark: true });
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
// tower of RISE_MIN to RISE_MAX copies upward.
const RISE_MIN = 5;
const RISE_MAX = 10;
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
  const pushCopy = (n, bottom, layers, distance) => {
    const m = modules[n];
    const { start, count, indexStart, indexCount } = moduleRanges[n];
    const baseY = DEPTH + m.y * LAYER_H;
    const squash = layers / m.h;
    const y0 = DEPTH + bottom * LAYER_H;
    const copyStart = positions.length / 3;

    for (let v = start; v < start + count; v++) {
      positions.push(
        basePositions[v * 3],
        y0 + (basePositions[v * 3 + 1] - baseY) * squash,
        basePositions[v * 3 + 2],
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

  const candidates = members.filter((n) => roomAbove(n) >= RISE_MIN);
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
    for (let k = 1; k <= copies; k++) pushCopy(n, m.y + m.h * k, m.h, m.h * k);
    fill(m, m.y + m.h, m.y + m.h * (copies + 1));
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

// Windows are studs standing a hair off the face rather than holes cut into
// it. With an outline renderer the two read the same -- you only see the
// stroke at the border -- and this needs no re-tessellation. The relief is far
// too shallow for the depth term to catch, so the normal term draws them: a
// stud's side walls are perpendicular to the face.
function pushWindows(target, c, s, axis, sign, rand) {
  const uAxis = axis === 0 ? 2 : 0;
  const spacing = Math.max(...WINDOW_SIZES) + WINDOW_GAP;

  const uSpan = s[uAxis] - 2 * WINDOW_MARGIN;
  const vSpan = s[1] - 2 * WINDOW_MARGIN;
  const cols = Math.floor(uSpan / spacing);
  const rows = Math.floor(vSpan / spacing);
  if (cols < 1 || rows < 1) return;

  const uStep = uSpan / cols;
  const vStep = vSpan / rows;

  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      if (rand() > WINDOW_FILL) continue;

      const size = WINDOW_SIZES[Math.floor(rand() * WINDOW_SIZES.length)];
      const wc = [0, 0, 0];
      wc[axis] = c[axis] + (sign * s[axis]) / 2;
      wc[uAxis] = c[uAxis] - uSpan / 2 + (col + 0.5) * uStep;
      wc[1] = c[1] - vSpan / 2 + (r + 0.5) * vStep;

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
  const moduleGroup = assignGroups(mulberry32(seed ^ 0x9e3779b9), modules, groups);

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

    if (m.kind === 'prism') {
      pushPrism(target, c, s, rand() < 0.5 ? 6 : 8, rand() * Math.PI);
    } else if (m.kind === 'frustum') {
      pushFrustum(target, c, s, 0.35 + rand() * 0.45);
    } else if (m.kind === 'stepped') {
      pushStepped(target, c, s, rand);
    } else {
      pushBox(target, c, s);
    }

    // Only the flat-sided kinds get windows; they'd float off a sloped face.
    // They come after the body, so one span covers all of a module's windows.
    const windowStart = target.positions.length / 3;
    if (m.kind === 'box') {
      for (const [axis, sign] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
        if (faceExposed(occ, m, axis, sign)) {
          pushWindows(target, c, s, axis, sign, rand);
        }
      }
    }

    windowRanges.push([windowStart, target.positions.length / 3]);
    ranges.push({
      start: vertexStart,
      count: target.positions.length / 3 - vertexStart,
      indexStart,
      indexCount: target.indices.length - indexStart,
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
  mesh.userData.adjacency = buildAdjacency(modules, owner);
  mesh.userData.crawlable = Uint8Array.from(modules, (m) =>
    !m.landmark && m.fw * m.fd <= CRAWL_MAX_AREA && m.h <= CRAWL_MAX_HEIGHT ? 1 : 0,
  );
  mesh.userData.groupCount = groups;
  // What the drop fill needs to copy a module: its grid placement, its group,
  // and its vertices as built. The live position buffer is no use for that,
  // since the fill and crawl effects collapse modules in it.
  mesh.userData.modules = modules;
  mesh.userData.moduleGroup = moduleGroup;
  mesh.userData.basePositions = Float32Array.from(target.positions);
  mesh.userData.landmarkCount = landmarks.count;
  mesh.userData.megaSize = landmarks.megaSize;
  mesh.userData.cantileverCount = modules.filter((m) => m.cantilever).length;
  initVisibility(mesh);
  return mesh;
}
