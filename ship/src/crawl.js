const DEFAULTS = {
  walkers: 5,
  interval: 0.13, // seconds a module stays hidden before the walk moves on
  jitter: 0.7, // +/- fraction of the interval, so the walkers drift apart
};

/**
 * A random walk that blinks cargo modules out and back in, stepping to a
 * touching neighbour each time. Show/hide is delegated to the shared module
 * view, so this and the fill effect never disagree about what a module's
 * untouched vertices look like.
 */
export function createCrawl(view, cargo, options = {}) {
  const { walkers: count, interval, jitter } = { ...DEFAULTS, ...options };

  const adjacency = cargo?.userData?.adjacency;
  const crawlable = cargo?.userData?.crawlable;
  if (!view) return { update() {}, dispose() {} };

  const { hide, show } = view;

  // Restrict the walk to ordinary modules, and prune the neighbour lists to
  // match -- otherwise a walker steps onto a landmark and blinks it.
  const eligible = [];
  for (let n = 0; n < view.count; n++) if (!crawlable || crawlable[n]) eligible.push(n);
  if (!eligible.length) return { update() {}, dispose() {} };

  const neighbours = adjacency
    ? adjacency.map((list) => list.filter((o) => !crawlable || crawlable[o]))
    : Array.from({ length: view.count }, () => []);

  const pick = () => eligible[Math.floor(Math.random() * eligible.length)];

  // Walkers can land on the same module, so hiding is refcounted -- otherwise
  // one leaving would reveal a module another is still standing on.
  const occupants = new Map();

  const enter = (index) => {
    const n = (occupants.get(index) ?? 0) + 1;
    occupants.set(index, n);
    if (n === 1) hide(index);
  };

  const leave = (index) => {
    const n = (occupants.get(index) ?? 1) - 1;
    if (n > 0) {
      occupants.set(index, n);
    } else {
      occupants.delete(index);
      show(index);
    }
  };

  const nextDue = (time) => time + interval * (1 + (Math.random() * 2 - 1) * jitter);

  const walkers = [];
  for (let n = 0; n < count; n++) {
    const index = pick();
    enter(index);
    walkers.push({ index, due: 0 });
  }

  return {
    update(time) {
      for (const walker of walkers) {
        if (time < walker.due) continue;

        // A module can be left with no eligible neighbours once landmarks and
        // large modules are pruned out. Teleport rather than stall.
        const options = neighbours[walker.index];
        const next = options?.length
          ? options[Math.floor(Math.random() * options.length)]
          : pick();

        leave(walker.index);
        walker.index = next;
        enter(walker.index);
        walker.due = nextDue(time);
      }
    },

    dispose() {
      for (const index of occupants.keys()) show(index);
      occupants.clear();
    },
  };
}
