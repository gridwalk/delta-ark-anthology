import { attribute, select, uniform, vec3 } from 'three/tsl';

/**
 * Set to 1 to drop the cargo's windows from what is drawn, 0 to show them.
 *
 * One uniform shared by every material that draws cargo, so a caller can
 * hide the windows for one render and show them again for the next. The
 * panel views do this: at their size a window is a pixel or less, and the
 * specks crowd out the module edges.
 */
export const hideWindows = uniform(0);

/**
 * Wraps a position node so that window vertices collapse to a point while
 * hideWindows is set. Window vertices carry `window` = 1 (see createCargo),
 * and a collapsed triangle rasterises to nothing.
 */
export function withoutWindows(position) {
  const isWindow = attribute('window', 'float').greaterThan(0.5);
  return select(hideWindows.greaterThan(0.5).and(isWindow), vec3(0, 0, 0), position);
}
