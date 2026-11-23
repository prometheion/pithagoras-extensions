import type { Fx } from "../../game/pack";
import { clamp01, ease, rgba, seeded, type RGB } from "./util";

/**
 * The effects: each a few seconds of light, particles and camera, played where it is aimed (a figure, or the middle).
 * The stage asks each frame what the camera should do (`shake`, `zoom`) and how much of the screen goes white
 * (`flash`), and the effects draw themselves over the scene.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  spin?: number;
}

interface Running {
  kind: Fx;
  start: number;
  dur: number;
  color: RGB;
  x: number;
  y: number;
  rand: () => number;
  particles: Particle[];
  bolts: [number, number][][];
  nextBolt: number;
}

const DEFAULT_COLOR: Partial<Record<Fx, RGB>> = {
  lightning: [200, 220, 255],
  aura: [120, 200, 255],
  slash: [235, 245, 255],
  impact: [255, 240, 220],
  breakthrough: [255, 210, 110],
  fire: [255, 130, 40],
  ice: [160, 220, 255],
  heal: [120, 255, 170],
  darkness: [20, 0, 30],
  flash: [255, 255, 255],
  shake: [255, 255, 255],
  petals: [255, 170, 200],
  shockwave: [255, 230, 200],
  sword_rain: [190, 230, 255],
  golden_light: [255, 220, 140],
};

const DURATION: Record<Fx, number> = {
  lightning: 1.6,
  aura: 2.6,
  slash: 0.8,
  impact: 0.9,
  breakthrough: 3.4,
  fire: 2.2,
  ice: 2,
  heal: 2.2,
  darkness: 2.4,
  flash: 0.7,
  shake: 0.8,
  petals: 3,
  shockwave: 1.4,
  sword_rain: 2.2,
  golden_light: 3,
};

export const fxDuration = (kind: Fx) => DURATION[kind];

function bolt(rand: () => number, x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = [[x0, y0]];
  const n = 12;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    pts.push([x0 + (x1 - x0) * t + (rand() - 0.5) * 0.08, y0 + (y1 - y0) * t + (rand() - 0.5) * 0.02]);
  }
  pts.push([x1, y1]);
  return pts;
}

export class Effects {
  private running: Running[] = [];
  private seed = 1;
  /** Fewer particles and no shaking, for those who ask for less motion. */
  reduced = false;

  play(kind: Fx, now: number, at: { x: number; y: number }, color?: RGB): void {
    const rand = seeded(this.seed++ * 7919);
    this.running.push({ kind, start: now, dur: DURATION[kind], color: color ?? DEFAULT_COLOR[kind] ?? [255, 255, 255], x: at.x, y: at.y, rand, particles: [], bolts: [], nextBolt: 0 });
  }

  clear(): void {
    this.running = [];
  }

  get busy(): boolean {
    return this.running.length > 0;
  }

  /** What the camera does now: a shake in pixels, a zoom, and the white over everything. */
  camera(now: number): { shake: number; zoom: number; flash: number; flashColor: RGB; dark: number } {
    let shake = 0;
    let zoom = 0;
    let flash = 0;
    let dark = 0;
    let flashColor: RGB = [255, 255, 255];
    for (const r of this.running) {
      const t = (now - r.start) / r.dur;
      const k = r.kind;
      if (k === "lightning") {
        const f = r.bolts.length && now - r.nextBolt > -0.05 ? 0.6 : 0;
        if (f > flash) {
          flash = f * (1 - t);
          flashColor = r.color;
        }
        shake = Math.max(shake, 10 * (1 - t));
      } else if (k === "impact" || k === "shockwave") {
        shake = Math.max(shake, 16 * (1 - t) ** 2);
        zoom = Math.max(zoom, 0.04 * (1 - t));
        if (t < 0.2) flash = Math.max(flash, 0.5 * (1 - t / 0.2));
      } else if (k === "shake") shake = Math.max(shake, 14 * (1 - t));
      else if (k === "flash") {
        flash = Math.max(flash, 1 - t);
        flashColor = r.color;
      } else if (k === "slash") {
        shake = Math.max(shake, 6 * (1 - t));
        if (t < 0.15) flash = Math.max(flash, 0.3);
      } else if (k === "breakthrough") {
        zoom = Math.max(zoom, 0.05 * Math.sin(Math.PI * clamp01(t)));
        if (t > 0.75) {
          flash = Math.max(flash, (1 - (t - 0.75) / 0.25) * 0.9);
          flashColor = r.color;
        }
        shake = Math.max(shake, t < 0.75 ? 3 * t : 0);
      } else if (k === "darkness") dark = Math.max(dark, Math.sin(Math.PI * clamp01(t)));
      else if (k === "sword_rain") shake = Math.max(shake, t > 0.4 ? 5 * (1 - t) : 0);
    }
    if (this.reduced) {
      shake = 0;
      zoom = 0;
      flash *= 0.5;
    }
    return { shake, zoom, flash, flashColor, dark };
  }

  draw(g: CanvasRenderingContext2D, now: number, dt: number, W: number, H: number): void {
    this.running = this.running.filter((r) => now - r.start < r.dur);
    const amount = this.reduced ? 0.3 : 1;
    for (const r of this.running) {
      const t = (now - r.start) / r.dur;
      const cx = r.x * W;
      const cy = r.y * H;
      const c = r.color;
      const spawn = (n: number, make: () => Particle) => {
        for (let i = 0; i < Math.round(n * amount); i++) r.particles.push(make());
      };
      g.save();
      switch (r.kind) {
        case "lightning": {
          if (now >= r.nextBolt && t < 0.75) {
            const x1 = cx + (r.rand() - 0.5) * W * 0.1;
            r.bolts = [bolt(r.rand, cx / W + (r.rand() - 0.5) * 0.4, 0, x1 / W, cy / H)];
            if (r.rand() < 0.6) r.bolts.push(bolt(r.rand, r.rand(), 0, (x1 + (r.rand() - 0.5) * W * 0.3) / W, (cy / H) * (0.5 + r.rand() * 0.4)));
            r.nextBolt = now + 0.12 + r.rand() * 0.25;
          }
          const fade = clamp01(1 - (now - (r.nextBolt - 0.3)) / 0.3);
          g.globalCompositeOperation = "lighter";
          for (const b of r.bolts) {
            for (const [width, alpha] of [
              [10, 0.15],
              [4, 0.5],
              [1.5, 1],
            ]) {
              g.strokeStyle = rgba(c, alpha * fade * (1 - t * 0.5));
              g.lineWidth = width;
              g.beginPath();
              b.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
              g.stroke();
            }
          }
          break;
        }
        case "aura":
        case "heal": {
          if (t < 0.8)
            spawn(r.kind === "aura" ? 6 : 3, () => {
              const a = r.rand() * Math.PI * 2;
              const d = H * (0.08 + r.rand() * 0.06);
              return { x: cx + Math.cos(a) * d, y: cy + H * 0.15 + Math.sin(a) * d * 0.3, vx: -Math.sin(a) * 40, vy: -60 - r.rand() * 90, life: 0, max: 1 + r.rand(), size: 1.5 + r.rand() * 2.5 };
            });
          g.globalCompositeOperation = "lighter";
          const glow = g.createRadialGradient(cx, cy, 0, cx, cy, H * 0.3);
          glow.addColorStop(0, rgba(c, 0.35 * Math.sin(Math.PI * t)));
          glow.addColorStop(1, rgba(c, 0));
          g.fillStyle = glow;
          g.fillRect(cx - H * 0.3, cy - H * 0.3, H * 0.6, H * 0.6);
          break;
        }
        case "slash": {
          g.globalCompositeOperation = "lighter";
          const lines = 3;
          for (let i = 0; i < lines; i++) {
            const local = clamp01((t - i * 0.12) / 0.35);
            if (local <= 0) continue;
            const fade = 1 - clamp01((t - i * 0.12 - 0.35) / 0.4);
            const ang = -0.6 + i * 0.45;
            const len = W * 0.7;
            const x0 = cx - Math.cos(ang) * len * 0.5;
            const y0 = cy - Math.sin(ang) * len * 0.5;
            g.strokeStyle = rgba(c, fade);
            g.shadowColor = rgba(c, 1);
            g.shadowBlur = 20;
            g.lineWidth = 3 + (1 - local) * 5;
            g.beginPath();
            g.moveTo(x0, y0);
            g.lineTo(x0 + Math.cos(ang) * len * ease(local), y0 + Math.sin(ang) * len * ease(local));
            g.stroke();
          }
          break;
        }
        case "impact":
        case "shockwave": {
          g.globalCompositeOperation = "lighter";
          const rings = r.kind === "shockwave" ? 3 : 1;
          for (let i = 0; i < rings; i++) {
            const local = clamp01(t * 1.4 - i * 0.15);
            if (local <= 0 || local >= 1) continue;
            g.strokeStyle = rgba(c, (1 - local) * 0.9);
            g.lineWidth = 2 + (1 - local) * 10;
            g.beginPath();
            g.ellipse(cx, cy, W * 0.6 * ease(local), H * 0.25 * ease(local), 0, 0, Math.PI * 2);
            g.stroke();
          }
          if (t < 0.05 + dt)
            spawn(r.kind === "shockwave" ? 50 : 30, () => {
              const a = r.rand() * Math.PI * 2;
              const v = 200 + r.rand() * 500;
              return { x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6, life: 0, max: 0.4 + r.rand() * 0.5, size: 1.5 + r.rand() * 2 };
            });
          break;
        }
        case "breakthrough":
        case "golden_light": {
          g.globalCompositeOperation = "lighter";
          const strength = Math.sin(Math.PI * clamp01(t));
          const px = r.kind === "golden_light" ? W * 0.5 : cx;
          const beamW = W * (r.kind === "golden_light" ? 0.5 : 0.12 + 0.08 * strength);
          const beam = g.createLinearGradient(px - beamW, 0, px + beamW, 0);
          beam.addColorStop(0, rgba(c, 0));
          beam.addColorStop(0.5, rgba(c, 0.55 * strength));
          beam.addColorStop(1, rgba(c, 0));
          g.fillStyle = beam;
          g.fillRect(px - beamW, 0, beamW * 2, r.kind === "golden_light" ? H : cy + H * 0.2);
          // Rays turning round the hero.
          g.translate(px, r.kind === "golden_light" ? 0 : cy);
          g.rotate(now * 0.3);
          for (let i = 0; i < 12; i++) {
            g.rotate((Math.PI * 2) / 12);
            g.fillStyle = rgba(c, 0.12 * strength);
            g.beginPath();
            g.moveTo(0, 0);
            g.lineTo(W, -W * 0.04);
            g.lineTo(W, W * 0.04);
            g.fill();
          }
          if (t < 0.85) spawn(4, () => ({ x: px + (r.rand() - 0.5) * beamW, y: cy + H * 0.2, vx: (r.rand() - 0.5) * 20, vy: -150 - r.rand() * 250, life: 0, max: 1.2, size: 1 + r.rand() * 2.5 }));
          break;
        }
        case "fire": {
          g.globalCompositeOperation = "lighter";
          const glow = g.createRadialGradient(cx, cy + H * 0.1, 0, cx, cy + H * 0.1, H * 0.45);
          glow.addColorStop(0, rgba(c, 0.5 * Math.sin(Math.PI * t)));
          glow.addColorStop(1, rgba(c, 0));
          g.fillStyle = glow;
          g.fillRect(0, 0, W, H);
          if (t < 0.8) spawn(8, () => ({ x: cx + (r.rand() - 0.5) * H * 0.3, y: cy + H * 0.2, vx: (r.rand() - 0.5) * 60, vy: -120 - r.rand() * 200, life: 0, max: 0.6 + r.rand() * 0.8, size: 2 + r.rand() * 4 }));
          break;
        }
        case "ice": {
          g.globalCompositeOperation = "lighter";
          const grow = ease(t * 2);
          g.strokeStyle = rgba(c, 0.8 * (1 - t));
          g.lineWidth = 2;
          for (let i = 0; i < 9; i++) {
            const a = (i / 9) * Math.PI * 2 + 0.3;
            g.beginPath();
            g.moveTo(cx, cy);
            g.lineTo(cx + Math.cos(a) * H * 0.35 * grow, cy + Math.sin(a) * H * 0.35 * grow);
            g.stroke();
          }
          g.fillStyle = rgba(c, 0.15 * Math.sin(Math.PI * t));
          g.fillRect(0, 0, W, H);
          if (t < 0.7) spawn(3, () => ({ x: r.rand() * W, y: -5, vx: (r.rand() - 0.5) * 20, vy: 60 + r.rand() * 60, life: 0, max: 2, size: 1 + r.rand() * 2 }));
          break;
        }
        case "petals":
          if (t < 0.5) spawn(5, () => ({ x: cx + (r.rand() - 0.5) * 40, y: cy, vx: (r.rand() - 0.5) * 400, vy: -100 - r.rand() * 250, life: 0, max: 2.5, size: 3 + r.rand() * 3, spin: r.rand() * 6 }));
          break;
        case "sword_rain": {
          g.globalCompositeOperation = "lighter";
          if (t < 0.6)
            spawn(3, () => {
              const x = cx + (r.rand() - 0.5) * W * 0.7;
              return { x, y: -20, vx: (cx - x) * 0.3, vy: 700 + r.rand() * 400, life: 0, max: 0.9, size: 18 + r.rand() * 14 };
            });
          break;
        }
        default:
          break;
      }
      g.restore();
      // The particles, of every kind.
      g.save();
      g.globalCompositeOperation = r.kind === "petals" ? "source-over" : "lighter";
      for (const p of r.particles) {
        p.life += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (r.kind === "petals") {
          p.vy += 120 * dt;
          p.vx *= 0.99;
        } else if (r.kind === "impact" || r.kind === "shockwave") {
          p.vx *= 0.92;
          p.vy *= 0.92;
        }
        const a = 1 - p.life / p.max;
        if (a <= 0) continue;
        if (r.kind === "sword_rain") {
          g.strokeStyle = rgba(c, a);
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(p.x, p.y);
          g.lineTo(p.x - p.vx * 0.03, p.y - p.size);
          g.stroke();
        } else if (r.kind === "petals") {
          g.fillStyle = rgba(c, a);
          g.save();
          g.translate(p.x, p.y);
          g.rotate((p.spin ?? 0) + p.life * 4);
          g.beginPath();
          g.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        } else {
          g.fillStyle = rgba(c, a);
          g.beginPath();
          g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          g.fill();
        }
      }
      r.particles = r.particles.filter((p) => p.life < p.max);
      g.restore();
    }
  }
}
