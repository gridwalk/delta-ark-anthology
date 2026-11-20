const DEFAULTS = {
  duration: 2, // seconds from empty deck to complete city
  raggedness: 0.22, // world units of random slop in the wavefront
};

/**
 * Builds the cargo on from an empty deck, sweeping bottom to top.
 *
 * Modules are revealed in height order rather than on individual timers, so the
 * front is always a single rising surface -- nothing appears floating above a
 * gap that hasn't filled in yet. A little random slop is mixed into each
 * module's sort key so the front reads as a ragged tide line instead of a
 * perfectly flat plane sweeping upward.
 */
export function createFill(view, cargo, options = {}) {
  const { duration, raggedness } = { ...DEFAULTS, ...options };
  const baseY = cargo?.userData?.moduleBaseY;
  if (!view || !baseY) return { update: () => true };

  let low = Infinity;
  let high = -Infinity;
  const order = [];
  for (let n = 0; n < view.count; n++) {
    const key = baseY[n] + Math.random() * raggedness;
    order.push({ index: n, key });
    if (key < low) low = key;
    if (key > high) high = key;
  }
  order.sort((a, b) => a.key - b.key);

  view.hideAll();

  let cursor = 0;
  let started = null;

  return {
    /** Returns true once every module is showing. */
    update(time) {
      if (started === null) started = time;

      const t = Math.min(1, (time - started) / duration);
      // Ease out, so the city rushes in and settles rather than stopping dead.
      const eased = 1 - Math.pow(1 - t, 1.6);
      const front = low + eased * (high - low);

      while (cursor < order.length && order[cursor].key <= front) {
        view.show(order[cursor].index);
        cursor++;
      }

      if (t >= 1) {
        while (cursor < order.length) view.show(order[cursor++].index);
        return true;
      }
      return false;
    },
  };
}
