import { attribute, uniform } from 'three/tsl';

/**
 * The exploded view of the cargo, on the about page.
 *
 * Each container moves by its own offset (the `explode` vertex attribute,
 * made in createCargo): outward from the middle of the deck, and up, in steps
 * that grow with its grid place. Two containers that touch on a side, or that
 * stand on each other, then move apart by at least one gap step, so every
 * container has some space around it. All of them also lift off the hull.
 *
 * `explodeAmount` blends the offsets in, from 0 (packed) to 1 (exploded).
 * main.js eases it.
 */
export const explodeAmount = uniform(0);

/** `position` with the vertex's explode offset blended in. */
export const exploded = (position) => position.add(attribute('explode', 'vec3').mul(explodeAmount));
