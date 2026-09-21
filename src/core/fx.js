// Fixed-capacity ring of visual events emitted by the sim and consumed by the renderer.
// The renderer keeps its own cursor; events are never mutated after emit.
// Oldest events are overwritten if the renderer falls behind (bounded memory, no GC churn).

export const FX_EXPLOSION = 1;
export const FX_IMPACT = 2;
export const FX_MUZZLE = 3;
export const FX_SHIELD_HIT = 4;
export const FX_DEBRIS = 5;

const CAP = 4096;

export function createFx() {
  // SoA: type + 10 float payload slots per event.
  const type = new Uint8Array(CAP);
  const data = new Float32Array(CAP * 10);
  let head = 0;      // next write index
  let seq = 0;      // monotonic count of emitted events
  let overflow = 0;  // events lost to overwrite

  return {
    type,
    data,
    get seq() { return seq; },
    get capacity() { return CAP; },

    reset() { head = 0; seq = 0; overflow = 0; },

    emit(t, a, b, c, d, e, f, g, h, i, j) {
      const o = head * 10;
      type[head] = t;
      data[o] = a; data[o + 1] = b; data[o + 2] = c; data[o + 3] = d; data[o + 4] = e;
      data[o + 5] = f; data[o + 6] = g; data[o + 7] = h; data[o + 8] = i; data[o + 9] = j;
      head = (head + 1) & (CAP - 1);
      seq++;
    },

    // Drain events with index >= cursor. Calls fn(t, dataOffset) in emission order.
    drain(cursor, fn) {
      const total = seq;
      if (total === cursor) return total;
      let start = cursor;
      if (total - start > CAP) { start = total - CAP; overflow += (cursor < start) ? (total - CAP - cursor) : 0; }
      // index in ring for absolute event index k is (k mod CAP)
      for (let k = start; k < total; k++) {
        const idx = k & (CAP - 1);
        fn(type[idx], idx * 10);
      }
      return total;
    },
  };
}
