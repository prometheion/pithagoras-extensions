import type { PlaceLook, Time } from "../../game/pack";
import { BLOOD_SKY, PALETTES, type Palette } from "./palette";
import { hash, mix, rgba, ridgeNoise, seeded, type RGB } from "./util";

/**
 * A place, drawn once into layers when the scene, the time or the stage's size changes: the sky, then ridges from far
 * to near, each with what stands on it, in the ink-wash manner (each ridge darker and sharper the nearer it is, its
 * foot lost in haze). The stage moves the layers against each other (parallax) and draws what moves on top: water,
 * a waterfall, lanterns, clouds, weather and effects.
 */

export interface Layer {
  canvas: HTMLCanvasElement;
  /** 0 is the sky, 1 the nearest ground: how much it moves with the camera. */
  depth: number;
}

export interface Dynamic {
  water?: { y: number };
  river?: { points: [number, number][] };
  waterfall?: { x: number; top: number; bottom: number; width: number };
  lanterns: { x: number; y: number; r: number }[];
  cloudsBelow?: { y: number };
  shafts?: { x: number; w: number }[];
  crystals?: { x: number; y: number; r: number }[];
  interior: boolean;
}

export interface Backdrop {
  palette: Palette;
  layers: Layer[];
  dynamic: Dynamic;
  /** Each layer is wider than the stage by this much on each side, for the camera to pan over. */
  margin: number;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext("2d")!];
}

// --- what stands on a ridge ---

function pine(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(x - s * 0.03, y - s * 0.5, s * 0.06, s * 0.5);
  for (let i = 0; i < 4; i++) {
    const ty = y - s * (0.35 + i * 0.17);
    const tw = s * (0.32 - i * 0.06);
    g.beginPath();
    g.moveTo(x - tw, ty + s * 0.08);
    g.quadraticCurveTo(x, ty - s * 0.14, x + tw, ty + s * 0.06);
    g.quadraticCurveTo(x, ty + s * 0.02, x - tw, ty + s * 0.08);
    g.fill();
  }
}

function pagoda(g: CanvasRenderingContext2D, x: number, y: number, s: number, tiers: number, color: string): void {
  g.fillStyle = color;
  let base = y;
  let w = s * 0.42;
  for (let i = 0; i < tiers; i++) {
    const h = s * 0.16;
    g.fillRect(x - w * 0.62, base - h, w * 1.24, h);
    // The eave, its ends turned up.
    g.beginPath();
    g.moveTo(x - w * 1.15, base - h - s * 0.005);
    g.quadraticCurveTo(x - w * 0.9, base - h + s * 0.02, x - w * 0.55, base - h - s * 0.05);
    g.lineTo(x + w * 0.55, base - h - s * 0.05);
    g.quadraticCurveTo(x + w * 0.9, base - h + s * 0.02, x + w * 1.15, base - h - s * 0.005);
    g.lineTo(x + w * 0.5, base - h - s * 0.09);
    g.lineTo(x - w * 0.5, base - h - s * 0.09);
    g.closePath();
    g.fill();
    base -= h + s * 0.08;
    w *= 0.8;
  }
  g.fillRect(x - s * 0.008, base - s * 0.12, s * 0.016, s * 0.13);
}

function hall(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(x - s * 0.9, y - s * 0.08, s * 1.8, s * 0.08);
  g.fillRect(x - s * 0.7, y - s * 0.32, s * 1.4, s * 0.24);
  for (const [w, top] of [
    [1.0, 0.32],
    [0.7, 0.5],
  ]) {
    g.beginPath();
    g.moveTo(x - s * w * 1.05, y - s * top + s * 0.02);
    g.quadraticCurveTo(x - s * w * 0.8, y - s * top - s * 0.01, x - s * w * 0.6, y - s * top - s * 0.12);
    g.lineTo(x + s * w * 0.6, y - s * top - s * 0.12);
    g.quadraticCurveTo(x + s * w * 0.8, y - s * top - s * 0.01, x + s * w * 1.05, y - s * top + s * 0.02);
    g.closePath();
    g.fill();
  }
  g.fillRect(x - s * 0.45, y - s * 0.5, s * 0.9, s * 0.08);
}

function bamboo(g: CanvasRenderingContext2D, x: number, ground: number, h: number, w: number, color: string, rand: () => number): void {
  g.fillStyle = color;
  g.strokeStyle = color;
  const lean = (rand() - 0.5) * w * 3;
  g.beginPath();
  g.moveTo(x - w / 2, ground);
  g.quadraticCurveTo(x + lean * 0.5, ground - h * 0.5, x + lean - w * 0.35, ground - h);
  g.lineTo(x + lean + w * 0.35, ground - h);
  g.quadraticCurveTo(x + lean * 0.5 + w, ground - h * 0.5, x + w / 2, ground);
  g.fill();
  for (let k = 1; k < 7; k++) {
    const t = k / 7;
    const nx = x + lean * t * t;
    const ny = ground - h * t;
    g.fillRect(nx - w * 0.7, ny, w * 1.4, Math.max(1, w * 0.18));
    if (rand() < 0.5) {
      const dir = rand() < 0.5 ? -1 : 1;
      g.beginPath();
      g.moveTo(nx, ny);
      g.quadraticCurveTo(nx + dir * w * 4, ny - w * 2, nx + dir * w * 7, ny + w * 1.5);
      g.quadraticCurveTo(nx + dir * w * 4, ny, nx, ny);
      g.fill();
    }
  }
}

function lanternGlow(dyn: Dynamic, x: number, y: number, r: number): void {
  if (dyn.lanterns.length < 24) dyn.lanterns.push({ x, y, r });
}

// --- the layers ---

export function buildBackdrop(look: PlaceLook, time: Time, place: string, width: number, height: number): Backdrop {
  const palette = look.features.includes("blood_sky") ? BLOOD_SKY : PALETTES[time];
  const rand = seeded(hash(`${place}:${time}`));
  const margin = Math.round(width * 0.08);
  const W = width + margin * 2;
  const H = height;
  const dyn: Dynamic = { lanterns: [], interior: look.kind === "interior" };
  const layers: Layer[] = [];
  const has = (f: string) => look.features.includes(f as never);
  const night = time === "night";
  /** A lantern's glow, by where it is on a layer in pixels: kept as a share of the stage, as the stage draws it. */
  const lamp = (px: number, py: number, r: number) => lanternGlow(dyn, (px - margin) / width, py / H, r);

  // The sky: a gradient, the orb, stars.
  {
    const [c, g] = canvas(W, H);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, rgba(palette.sky[0]));
    sky.addColorStop(0.55, rgba(palette.sky[1]));
    sky.addColorStop(1, rgba(palette.sky[2]));
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const stars = Math.max(palette.stars, has("stars_dense") ? 0.6 : 0);
    for (let i = 0; i < 260 * stars; i++) {
      const s = rand();
      g.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.6})`;
      g.fillRect(rand() * W, rand() * H * 0.6, s < 0.9 ? 1 : 2, s < 0.9 ? 1 : 2);
    }
    const orb = palette.orb && (look.kind === "outdoor" || has("big_moon")) ? palette.orb : undefined;
    if (orb) {
      const big = has("big_moon");
      const r = (big ? orb.r * 2.6 : orb.r) * H;
      const ox = orb.x * W;
      const oy = (big ? 0.3 : orb.y) * H;
      const glow = g.createRadialGradient(ox, oy, r * 0.5, ox, oy, r * 5);
      glow.addColorStop(0, rgba(orb.color, 0.45));
      glow.addColorStop(1, rgba(orb.color, 0));
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
      g.fillStyle = rgba(orb.color, 0.95);
      g.beginPath();
      g.arc(ox, oy, r, 0, Math.PI * 2);
      g.fill();
      if (orb.moon || big) {
        g.fillStyle = rgba(mix(orb.color, palette.sky[1], 0.4), 0.25);
        for (let i = 0; i < 6; i++) {
          g.beginPath();
          g.arc(ox + (rand() - 0.5) * r, oy + (rand() - 0.5) * r, r * (0.1 + rand() * 0.2), 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    layers.push({ canvas: c, depth: 0 });
  }

  if (look.kind === "interior") {
    layers.push(...interior(look, palette, rand, W, H, dyn));
    return { palette, layers, dynamic: dyn, margin };
  }

  // Ridges from far to near.
  const count = look.ridges;
  const groundY = H * (has("lake") || has("clouds_below") ? 0.66 : 0.78);
  for (let i = 0; i < count; i++) {
    const near = count === 1 ? 1 : i / (count - 1);
    const [c, g] = canvas(W, H);
    const noise = ridgeNoise(rand, 5, 0.35 + look.roughness * 0.4);
    const peak = H * look.height * (0.55 + near * 0.6);
    const base = groundY + (H - groundY) * near * 0.55;
    const color = mix(palette.fog, palette.ink, 0.18 + near * 0.82);
    const top = (x: number) => base - peak * (0.25 + noise(x / W) * 0.95);
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) g.lineTo(x, top(x));
    g.lineTo(W, H);
    g.closePath();
    const fill = g.createLinearGradient(0, base - peak, 0, H);
    fill.addColorStop(0, rgba(color));
    fill.addColorStop(0.55, rgba(mix(color, palette.fog, 0.35)));
    fill.addColorStop(1, rgba(mix(color, palette.fog, 0.75)));
    g.fillStyle = fill;
    g.fill();
    // The haze at its foot.
    const haze = g.createLinearGradient(0, base - peak * 0.4, 0, base + 10);
    haze.addColorStop(0, rgba(palette.fog, 0));
    haze.addColorStop(1, rgba(palette.fog, 0.55 - near * 0.3));
    g.fillStyle = haze;
    g.fillRect(0, base - peak * 0.4, W, H);
    // Ink texture: faint strokes down the slopes.
    g.strokeStyle = rgba(mix(color, palette.ink, 0.5), 0.12 + near * 0.12);
    g.lineWidth = 1;
    for (let k = 0; k < 40 * (0.3 + near); k++) {
      const x = rand() * W;
      const y = top(x);
      g.beginPath();
      g.moveTo(x, y + 2);
      g.quadraticCurveTo(x + (rand() - 0.5) * 30, y + peak * 0.2, x + (rand() - 0.5) * 40, y + peak * (0.3 + rand() * 0.4));
      g.stroke();
    }

    const ink = rgba(mix(color, palette.ink, 0.3));
    const mid = i === Math.max(0, count - 3) || (count <= 2 && i === 0);
    const nearest = i === count - 1;
    if (has("pines") && near > 0.3) {
      const n = Math.round(6 + near * 16);
      for (let k = 0; k < n; k++) {
        const x = rand() * W;
        pine(g, x, top(x) + 4, H * (0.04 + near * 0.08) * (0.7 + rand() * 0.6), ink);
      }
    }
    if (has("pagodas") && mid) {
      const x = W * (0.3 + rand() * 0.4);
      pagoda(g, x, top(x) + 6, H * 0.22, 3 + Math.floor(rand() * 3), ink);
      const x2 = W * (rand() < 0.5 ? 0.15 : 0.82);
      pagoda(g, x2, top(x2) + 6, H * 0.14, 2 + Math.floor(rand() * 2), ink);
      if (night || time === "dusk") for (let k = 0; k < 4; k++) lamp(x + (rand() - 0.5) * W * 0.05, top(x) - H * 0.02 - rand() * H * 0.08, 0.004);
    }
    if (has("palace") && mid) {
      const x = W * 0.5;
      hall(g, x, top(x) + 8, H * 0.22, ink);
      if (night || time === "dusk") for (let k = 0; k < 8; k++) lamp(x + (k - 3.5) * W * 0.035, top(x) - H * 0.03, 0.007);
    }
    if (has("ruins") && i === count - 2) {
      for (let k = 0; k < 7; k++) {
        const x = rand() * W;
        const h = H * (0.05 + rand() * 0.12);
        g.fillStyle = ink;
        g.fillRect(x, top(x) - h, H * 0.018, h + 6);
        if (rand() < 0.4) g.fillRect(x - H * 0.01, top(x) - h, H * 0.07, H * 0.012);
      }
    }
    if (has("waterfall") && i === count - 2 && !dyn.waterfall) {
      const x = W * (0.55 + rand() * 0.2);
      dyn.waterfall = { x: (x - margin) / width, top: top(x) / H, bottom: Math.min(0.95, (base + 20) / H), width: 0.035 };
    }
    if (nearest) {
      if (has("bamboo")) {
        for (let k = 0; k < 26; k++) {
          const x = rand() * W;
          bamboo(g, x, H + 4, H * (0.6 + rand() * 0.5), H * (0.008 + rand() * 0.008), rgba(mix(palette.ink, palette.fog, rand() * 0.25)), rand);
        }
      }
      if (has("cliff")) {
        const left = rand() < 0.5;
        g.fillStyle = rgba(palette.ink);
        g.beginPath();
        const x0 = left ? 0 : W;
        const dir = left ? 1 : -1;
        g.moveTo(x0, H);
        g.lineTo(x0, H * 0.62);
        g.quadraticCurveTo(x0 + dir * W * 0.12, H * 0.6, x0 + dir * W * 0.2, H * 0.7);
        g.lineTo(x0 + dir * W * 0.26, H * 0.74);
        g.lineTo(x0 + dir * W * 0.3, H);
        g.fill();
        pine(g, x0 + dir * W * 0.12, H * 0.62, H * 0.2, rgba(palette.ink));
      }
      if (has("walls")) {
        g.fillStyle = rgba(mix(palette.ink, palette.fog, 0.2));
        const wy = H * 0.8;
        g.fillRect(0, wy, W, H - wy);
        for (let x = 0; x < W; x += H * 0.05) g.fillRect(x, wy - H * 0.025, H * 0.03, H * 0.026);
        if (night || time === "dusk") for (let x = 0.08; x < 1; x += 0.16) lamp(margin + x * width, H * 0.77, 0.008);
      }
      if (has("stalls")) {
        for (let k = 0; k < 6; k++) {
          const x = (k + 0.5) * (W / 6) + (rand() - 0.5) * 40;
          const sw = H * 0.2;
          const sy = H * 0.86;
          g.fillStyle = rgba(palette.ink);
          g.fillRect(x - sw / 2, sy - H * 0.08, H * 0.01, H * 0.2);
          g.fillRect(x + sw / 2 - H * 0.01, sy - H * 0.08, H * 0.01, H * 0.2);
          g.fillRect(x - sw / 2, sy, sw, H * 0.03);
          g.fillStyle = rgba(mix(palette.ink, [150, 40, 40], 0.4));
          g.beginPath();
          g.moveTo(x - sw * 0.62, sy - H * 0.07);
          g.lineTo(x, sy - H * 0.14);
          g.lineTo(x + sw * 0.62, sy - H * 0.07);
          g.fill();
          lamp(x + sw * 0.4, sy - H * 0.05, 0.009);
        }
      }
      if (has("gate")) {
        const x = W / 2;
        g.fillStyle = rgba(palette.ink);
        const gw = H * 0.5;
        g.fillRect(x - gw / 2, H * 0.42, H * 0.035, H);
        g.fillRect(x + gw / 2 - H * 0.035, H * 0.42, H * 0.035, H);
        g.fillRect(x - gw * 0.62, H * 0.47, gw * 1.24, H * 0.03);
        g.beginPath();
        g.moveTo(x - gw * 0.78, H * 0.41);
        g.quadraticCurveTo(x, H * 0.37, x + gw * 0.78, H * 0.41);
        g.lineTo(x + gw * 0.6, H * 0.36);
        g.lineTo(x - gw * 0.6, H * 0.36);
        g.fill();
        g.fillStyle = rgba(mix(palette.ink, [200, 160, 60], 0.4));
        g.fillRect(x - H * 0.06, H * 0.385, H * 0.12, H * 0.07);
      }
      if (has("graves")) {
        for (let k = 0; k < 9; k++) {
          const x = rand() * W;
          const gy = H * (0.82 + rand() * 0.1);
          g.fillStyle = rgba(mix(palette.ink, palette.fog, 0.15));
          g.beginPath();
          g.ellipse(x, gy, H * 0.05, H * 0.02, 0, Math.PI, 0);
          g.fill();
          g.fillRect(x - H * 0.012, gy - H * 0.06, H * 0.024, H * 0.06);
        }
      }
      if (has("lanterns") && !has("stalls") && !has("walls")) for (let k = 0; k < 5; k++) lamp(margin + (0.1 + rand() * 0.8) * width, H * (0.7 + rand() * 0.15), 0.008);
    }
    layers.push({ canvas: c, depth: 0.15 + near * 0.85 });
  }

  if (has("lake")) dyn.water = { y: groundY / H };
  if (has("clouds_below")) dyn.cloudsBelow = { y: groundY / H };
  if (has("river")) {
    const pts: [number, number][] = [];
    for (let k = 0; k <= 8; k++) pts.push([0.45 + Math.sin(k * 0.9 + rand() * 3) * 0.12 * (k / 8) + (k / 8 - 0.5) * 0.1, 0.72 + (k / 8) * 0.3]);
    dyn.river = { points: pts };
  }
  return { palette, layers, dynamic: dyn, margin };
}

function interior(look: PlaceLook, palette: Palette, rand: () => number, W: number, H: number, dyn: Dynamic): Layer[] {
  const has = (f: string) => look.features.includes(f as never);
  const warm: RGB = [70, 38, 26];
  const [c, g] = canvas(W, H);
  if (has("cave")) {
    const bg = g.createRadialGradient(W / 2, H * 0.45, H * 0.05, W / 2, H * 0.5, W * 0.7);
    bg.addColorStop(0, "rgb(70,90,110)");
    bg.addColorStop(0.5, "rgb(22,28,38)");
    bg.addColorStop(1, "rgb(5,6,10)");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // Rock: dark blobs round the edge, an opening in the middle.
    for (let k = 0; k < 90; k++) {
      const a = rand() * Math.PI * 2;
      const d = 0.42 + rand() * 0.4;
      const x = W / 2 + Math.cos(a) * W * d * 0.75;
      const y = H * 0.5 + Math.sin(a) * H * d * 0.85;
      g.fillStyle = `rgba(${8 + rand() * 18},${10 + rand() * 18},${16 + rand() * 20},${0.7 + rand() * 0.3})`;
      g.beginPath();
      g.ellipse(x, y, H * (0.08 + rand() * 0.18), H * (0.05 + rand() * 0.12), rand() * 3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(10,12,18,0.9)";
    g.fillRect(0, H * 0.84, W, H * 0.16);
    dyn.crystals = Array.from({ length: 10 }, () => ({ x: 0.08 + rand() * 0.84, y: 0.55 + rand() * 0.35, r: 0.008 + rand() * 0.012 }));
    return [{ canvas: c, depth: 0.4 }];
  }
  // A hall: a back wall, a floor in perspective, pillars, a dais.
  const wall = g.createLinearGradient(0, 0, 0, H * 0.62);
  wall.addColorStop(0, rgba(mix(warm, palette.ink, 0.5)));
  wall.addColorStop(1, rgba(mix(warm, [140, 90, 50], 0.4)));
  g.fillStyle = wall;
  g.fillRect(0, 0, W, H * 0.62);
  for (let k = 0; k < 7; k++) {
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect((k + 0.5) * (W / 7) - W * 0.03, H * 0.12, W * 0.06, H * 0.5);
  }
  const floor = g.createLinearGradient(0, H * 0.62, 0, H);
  floor.addColorStop(0, "rgb(52,34,26)");
  floor.addColorStop(1, "rgb(18,12,10)");
  g.fillStyle = floor;
  g.fillRect(0, H * 0.62, W, H * 0.38);
  g.strokeStyle = "rgba(255,220,170,0.06)";
  for (let k = -10; k <= 10; k++) {
    g.beginPath();
    g.moveTo(W / 2 + k * W * 0.02, H * 0.62);
    g.lineTo(W / 2 + k * W * 0.2, H);
    g.stroke();
  }
  g.fillStyle = "rgba(40,22,16,0.9)";
  g.fillRect(W * 0.36, H * 0.56, W * 0.28, H * 0.07);
  g.fillStyle = "rgba(170,120,60,0.35)";
  g.fillRect(W * 0.43, H * 0.2, W * 0.14, H * 0.22);
  g.fillStyle = "rgba(20,10,6,0.6)";
  g.fillRect(W * 0.445, H * 0.215, W * 0.11, H * 0.19);
  const back: Layer = { canvas: c, depth: 0.3 };
  const [pc, pg] = canvas(W, H);
  if (has("pillars")) {
    for (const [x, w] of [
      [0.06, 0.07],
      [0.22, 0.045],
      [0.78, 0.045],
      [0.94, 0.07],
    ]) {
      const px = x * W;
      const pw = w * W;
      const grad = pg.createLinearGradient(px - pw / 2, 0, px + pw / 2, 0);
      grad.addColorStop(0, "rgb(60,14,14)");
      grad.addColorStop(0.4, "rgb(130,30,26)");
      grad.addColorStop(1, "rgb(40,8,8)");
      pg.fillStyle = grad;
      pg.fillRect(px - pw / 2, 0, pw, H);
      pg.fillStyle = "rgba(200,160,70,0.5)";
      pg.fillRect(px - pw * 0.6, H * 0.08, pw * 1.2, H * 0.015);
    }
    dyn.shafts = [
      { x: 0.35, w: 0.08 },
      { x: 0.6, w: 0.06 },
    ];
  }
  if (has("lanterns")) for (const x of [0.14, 0.86, 0.3, 0.7]) lanternGlow(dyn, x, 0.22 + rand() * 0.08, 0.012);
  return [back, { canvas: pc, depth: 0.85 }];
}
