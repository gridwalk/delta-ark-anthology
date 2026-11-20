/**
 * Shared show/hide control over the cargo's modules.
 *
 * The cargo is one merged geometry with no per-module object to toggle, so a
 * module is hidden by collapsing all of its vertices onto a single point: every
 * triangle degenerates and rasterises to nothing. No second material, no shader
 * work, and the outline pass strokes the resulting hole correctly because it
 * reads the depth and normal buffers.
 *
 * This lives in one place because more than one effect drives it. Each keeping
 * its own pristine copy would mean whichever was constructed second captured
 * the buffer mid-effect and treated collapsed vertices as the truth.
 */
export function createModuleView(cargo) {
  const attribute = cargo?.geometry?.attributes?.position;
  const ranges = cargo?.userData?.moduleRanges;
  if (!attribute || !ranges?.length) return null;

  const positions = attribute.array;
  const original = Float32Array.from(positions);

  const hide = (index) => {
    const { start, count } = ranges[index];
    const x = original[start * 3];
    const y = original[start * 3 + 1];
    const z = original[start * 3 + 2];
    for (let v = start; v < start + count; v++) {
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
    }
    attribute.needsUpdate = true;
  };

  const show = (index) => {
    const { start, count } = ranges[index];
    positions.set(original.subarray(start * 3, (start + count) * 3), start * 3);
    attribute.needsUpdate = true;
  };

  return {
    count: ranges.length,
    hide,
    show,
    hideAll() {
      for (let n = 0; n < ranges.length; n++) hide(n);
    },
    showAll() {
      positions.set(original);
      attribute.needsUpdate = true;
    },
  };
}
