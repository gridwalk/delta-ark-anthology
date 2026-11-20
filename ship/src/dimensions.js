// The hull's defining dimensions and deck plan, in their own module so that
// both the hull builder and anything that sits on the deck can read them
// without importing each other.
//
// 1 unit ~= 20 m. Proportions started from a modern ULCV (~400 m LOA, 61 m
// beam) and have since been widened well past it -- this carries a city.

export const LOA = 20;
export const BEAM = 7.2;
export const DEPTH = 2.3;
// Floats at exactly half depth, so the waterline cuts the hull midway down.
export const DRAFT = DEPTH / 2;

// Half-beam along the length: a blunt stern, a long parallel midbody (the flat
// part that makes a container ship a container ship), then a bow taper.
export function halfBeam(t) {
  if (t < 0.1) return (BEAM / 2) * (0.93 + 0.07 * (t / 0.1));
  if (t < 0.7) return BEAM / 2;
  // Clamp before the fractional power: u can land a hair above 1.0 at the stem
  // through float error, and Math.pow() of a negative base returns NaN.
  const u = Math.min(1, (t - 0.7) / 0.3);
  return (BEAM / 2) * Math.max(0.012, Math.pow(Math.max(0, 1 - u * u), 0.5));
}

/** Deck half-width at a world X, for anything that needs to sit on the deck. */
export function deckHalfBeam(x) {
  const t = (x + LOA / 2) / LOA;
  if (t < 0 || t > 1) return 0;
  return halfBeam(t);
}
