// Deterministic PRNG (sfc32) seeded from an integer. All randomness in the
// multi-strategy kernel flows through this object so runs are reproducible.

function splitmix32(seed) {
  let z = seed >>> 0;
  return function next() {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Rng {
  constructor(seed) {
    const s = splitmix32(seed >>> 0);
    this.a = s();
    this.b = s();
    this.c = s();
    this.d = 1;
    // Discard the first few correlated outputs.
    for (let i = 0; i < 12; i++) this.nextU32();
  }
  nextU32() {
    let { a, b, c, d } = this;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return t;
  }
  // Uniform in [0, 1) with 53 bits of precision.
  next() {
    const hi = this.nextU32() >>> 5;
    const lo = this.nextU32() >>> 6;
    return (hi * 67108864 + lo) * (1 / 9007199254740992);
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
}

// Independent stream per (seed, texture index) so tiles never share sequences.
export function streamSeed(seed, index) {
  let h = (seed >>> 0) ^ 0x85ebca6b;
  h = Math.imul(h ^ (index + 0x9e3779b9), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function makeTiles(seed, tiles) {
  const streams = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const index = ty * tiles + tx;
      streams.push({ seed: streamSeed(seed, index), tx, ty });
    }
  }
  return streams;
}

// mode: 'uniform' draws one stream per job; 'perPhotons' gives each photon
// its own stream (experimental: exposes the bias that a Correlated Multi-
// Jittered tile would otherwise hide; only sound for single-strategy runs
// because global strategies cannot stay correlated across distant tiles).
export function jobStream(seed, mode, index) {
  if (mode === 'perPhotons') return new Rng(streamSeed(seed ^ 0x5bd1e995, index));
  return new Rng(streamSeed(seed, index));
}
