/** Small things every part of the stage uses: a seeded random, noise, colours. */

export type RGB = [number, number, number];

/** A seeded random in [0, 1): the same place draws the same mountains every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One-dimensional fractal noise, made once for a ridge: `at(x)` for x in [0, 1]. */
export function ridgeNoise(rand: () => number, octaves: number, roughness: number): (x: number) => number {
  const layers = Array.from({ length: octaves }, (_, o) => {
    const n = 4 * 2 ** o;
    return { n, values: Array.from({ length: n + 2 }, () => rand()), amp: roughness ** o };
  });
  const total = layers.reduce((s, l) => s + l.amp, 0);
  return (x: number) => {
    let v = 0;
    for (const l of layers) {
      const p = x * l.n;
      const i = Math.floor(p);
      const f = p - i;
      const s = f * f * (3 - 2 * f);
      v += (l.values[i] * (1 - s) + l.values[i + 1] * s) * l.amp;
    }
    return v / total;
  };
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const rgba = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const ease = (t: number) => 1 - (1 - clamp01(t)) ** 3;
