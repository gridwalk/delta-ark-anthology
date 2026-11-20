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
  const cargo = createCargo(cargoMaterial ?? fillMat);
  ship.add(cargo);
  ship.userData.cargo = cargo;
  ship.userData.cargoSeed = cargo.userData.seed;

  // Float the hull so the waterline sits at y = 0.
  ship.position.y = -DRAFT;

  ship.userData.dispose = () => {
    ship.traverse((o) => o.geometry?.dispose());
    fillMat.dispose();
  };

  return ship;
}
