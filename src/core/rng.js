// Deterministic PRNG utilities. No Math.random() anywhere in src/core.
// sfc32 + string hashing. Same seed => identical stream on every platform
// (all ops are 32-bit integer ops, which are exactly reproducible in JS).

export function hashSeed(str) {
  // cyrb128-ish -> 4x32
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const a = (h ^= h >>> 16) >>> 0;
  const b = (Math.imul(a, 2246822507) ^ 3266489909) >>> 0;
  const c = (Math.imul(b ^ a, 668265263) ^ 374761393) >>> 0;
  const d = (Math.imul(c ^ b, 2246822519) ^ 4245849) >>> 0;
  return [a, b, c, d];
}

export function makeRng(seed) {
  const s = typeof seed === 'string' ? hashSeed(seed) : [seed >>> 0, (seed * 2654435761) >>> 0, (seed ^ 0x9e3779b9) >>> 0, (seed + 12345) >>> 0];
  let a = s[0], b = s[1], c = s[2], d = s[3];
  // warmup
  for (let i = 0; i < 16; i++) {
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    c = (c + t) | 0;
  }
  const next = () => {
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    c = (c + t) | 0;
    return ((t + d) >>> 0) / 4294967296;
  };
  next.int32 = () => {
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    c = (c + t) | 0;
    return (t + d) >>> 0;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => lo + (next.int32() % (hi - lo + 1));
  next.sign = () => (next.int32() & 1) ? 1 : -1;
  // normally-distributed via Box-Muller (deterministic)
  next.gauss = () => {
    let u = next();
    if (u < 1e-9) u = 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * next());
  };
  next.fork = (tag) => makeRng(`${seed}:${tag}`);
  return next;
}
