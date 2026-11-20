import * as THREE from 'three';
import { DEPTH, DRAFT, LOA, halfBeam } from './dimensions.js';
import { createCargo } from './cargo.js';

export { BEAM, DEPTH, DRAFT, LOA, deckHalfBeam } from './dimensions.js';

const STATIONS = 26; // sections along the length
const ARCS = 7; // points per half-section, keel -> deck edge
const RING = ARCS * 2 + 1;

// Keel line: flat bottom over most of the length, sweeping up at the forefoot
// into the raked stem and lifting slightly under the transom.
function keelY(t) {
  if (t > 0.86) {
    const u = (t - 0.86) / 0.14;
    return DEPTH * 0.62 * u * u;
  }
  if (t < 0.05) {
    const u = 1 - t / 0.05;
    return DEPTH * 0.1 * u * u;
  }
  return 0;
}

// Section fullness: high = boxy with a tight bilge radius, low = V-shaped.
function fullness(t) {
  if (t > 0.7) return 6 - 4.5 * ((t - 0.7) / 0.3);
  return 6;
}

// A point on one half of a cross-section, as a superellipse quadrant.
// s = 0 at the keel, s = 1 at the deck edge.
function sectionPoint(t, s) {
  const b = halfBeam(t);
  const y0 = keelY(t);
  const p = fullness(t);
  const th = (s * Math.PI) / 2;
  return [
    b * Math.pow(Math.sin(th), 2 / p),
    y0 + (DEPTH - y0) * (1 - Math.pow(Math.cos(th), 2 / p)),
  ];
}

function toGeometry(pos, idx) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// The shell: keel up to the deck edge, both sides. The deck and transom are
// built as separate geometries rather than extra triangles in this one --
// sharing vertices would make computeVertexNormals() average across the sheer
// and round off the exact creases the outline pass keys on.
function buildHull() {
  const pos = [];
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = -LOA / 2 + t * LOA;
    for (let k = 0; k < RING; k++) {
      const side = k < ARCS ? -1 : 1;
      const [z, y] = sectionPoint(t, Math.abs(k - ARCS) / ARCS);
      pos.push(x, y, side * z);
    }
  }

  const at = (i, k) => i * RING + k;
  const idx = [];
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let k = 0; k < RING - 1; k++) {
      idx.push(at(i, k), at(i + 1, k), at(i + 1, k + 1));
      idx.push(at(i, k), at(i + 1, k + 1), at(i, k + 1));
    }
  }

  return toGeometry(pos, idx);
}

// Main deck, as a strip between the port and starboard deck edges.
function buildDeck() {
  const pos = [];
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = -LOA / 2 + t * LOA;
    const b = halfBeam(t);
    pos.push(x, DEPTH, -b);
    pos.push(x, DEPTH, b);
  }

  const idx = [];
  for (let i = 0; i < STATIONS - 1; i++) {
    const port = i * 2;
    const stbd = port + 1;
    idx.push(port, stbd, stbd + 2);
    idx.push(port, stbd + 2, port + 2);
  }

  return toGeometry(pos, idx);
}

// Transom, as a fan from the keel point of the aftmost station.
function buildTransom() {
  const pos = [];
  for (let k = 0; k < RING; k++) {
    const side = k < ARCS ? -1 : 1;
    const [z, y] = sectionPoint(0, Math.abs(k - ARCS) / ARCS);
    pos.push(-LOA / 2, y, side * z);
  }

  const idx = [];
  for (let k = 0; k < RING - 1; k++) {
    if (k === ARCS || k + 1 === ARCS) continue;
    idx.push(ARCS, k, k + 1);
  }
  idx.push(ARCS, RING - 1, 0);

  return toGeometry(pos, idx);
}

// A thick triangle outline under the keel, seen only from below. It is a flat
// band: an outer triangle with an inner triangle cut out. The keel is flat
// from about 10% to 85% of the length, and nearly flat across the middle of
// the beam, so the band lies just under it.
//
// Its material writes 1 to the scene pass's blue channel and nothing else, and
// the compositor fills that mask in the line colour (see compose in
// outline.js). Thus the band shows as a solid white stroke, not as an outline
// of a band.
// An equilateral triangle, centred on the middle of the hull, with one corner
// to the bow. MARK_SIDE is the length of each side. The keel curves up toward
// the sides, so the side length keeps the base corners near the flat middle,
// about 2.5 units out from the centre line.
const MARK_SIDE = 5;
const MARK_HEIGHT = (MARK_SIDE * Math.sqrt(3)) / 2;
const MARK_TIP = (MARK_HEIGHT * 2) / 3; // x of the point, toward the bow
const MARK_BASE = -MARK_HEIGHT / 3; // x of the base, toward the stern
const MARK_HALF = MARK_SIDE / 2; // half the base width, in z
const MARK_WIDTH = 0.4; // the stroke width
const MARK_DROP = 0.012; // how far under the keel it sits

function buildKeelMark() {
  const outer = [
    [MARK_TIP, 0],
    [MARK_BASE, MARK_HALF],
    [MARK_BASE, -MARK_HALF],
  ];
  // Shrink about the incentre, so each side of the inner triangle is
  // MARK_WIDTH in from the outer side.
  const side = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const a = side(outer[1], outer[2]);
  const b = side(outer[0], outer[2]);
  const c = side(outer[0], outer[1]);
  const perimeter = a + b + c;
  const centre = [
    (a * outer[0][0] + b * outer[1][0] + c * outer[2][0]) / perimeter,
    (a * outer[0][1] + b * outer[1][1] + c * outer[2][1]) / perimeter,
  ];
  const area = Math.abs(
    (outer[1][0] - outer[0][0]) * (outer[2][1] - outer[0][1]) -
      (outer[2][0] - outer[0][0]) * (outer[1][1] - outer[0][1]),
  ) / 2;
  const radius = (2 * area) / perimeter;
  const k = (radius - MARK_WIDTH) / radius;
  const inner = outer.map(([x, z]) => [centre[0] + (x - centre[0]) * k, centre[1] + (z - centre[1]) * k]);

  const pos = [];
  for (const [x, z] of [...outer, ...inner]) pos.push(x, -MARK_DROP, z);
  // One quad for each side, between the outer and the inner edge.
  const idx = [];
  for (let n = 0; n < 3; n++) {
    const m = (n + 1) % 3;
    idx.push(n, m, 3 + m, n, 3 + m, 3 + n);
  }
  return toGeometry(pos, idx);
}

// `cargoMaterial` replaces the black fill on the cargo alone, for effects that
// key off the cargo's per-module attributes. The caller owns and disposes it.
export function createShip({ cargoMaterial } = {}) {
  const ship = new THREE.Group();

  // Solid black fill. The silhouette and creases come from the edge-detection
  // pass in main.js, which reads this geometry's depth and view normals.
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

  ship.add(new THREE.Mesh(buildHull(), fillMat));
  ship.add(new THREE.Mesh(buildDeck(), fillMat));
  ship.add(new THREE.Mesh(buildTransom(), fillMat));
  // Blue is the paint mask for the keel mark (see buildKeelMark). Both sides
  // draw, so the winding does not matter.
  const markMat = new THREE.MeshBasicMaterial({ color: 0x0000ff, side: THREE.DoubleSide });
  ship.add(new THREE.Mesh(buildKeelMark(), markMat));
  const cargo = createCargo(cargoMaterial ?? fillMat);
  ship.add(cargo);
  ship.userData.cargo = cargo;
  ship.userData.cargoSeed = cargo.userData.seed;

  // Float the hull so the waterline sits at y = 0.
  ship.position.y = -DRAFT;

  ship.userData.dispose = () => {
    ship.traverse((o) => o.geometry?.dispose());
    fillMat.dispose();
    markMat.dispose();
  };

  return ship;
}
