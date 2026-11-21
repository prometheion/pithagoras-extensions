import type { Weather } from "../../game/pack";
import { rgba, type RGB } from "./util";

/** Weather, always going: rain, snow, petals, mist, embers, fireflies, falling leaves, a storm's rain and its flashes. */

interface Drop {
  x: number;
  y: number;
  v: number;
  s: number;
  p: number;
}

export class WeatherLayer {
  private drops: Drop[] = [];
  private kind: Weather = "clear";
  private flash = 0;
  private nextFlash = 0;
  reduced = false;

  set(kind: Weather, W: number, H: number): void {
    this.kind = kind;
    const n = { clear: 0, mist: 0, rain: 220, storm: 320, snow: 160, petals: 60, embers: 70, fireflies: 40, leaves: 40 }[kind];
    this.drops = Array.from({ length: Math.round(n * (this.reduced ? 0.35 : 1) * Math.min(1.5, (W * H) / (800 * 500))) }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      v: 0.6 + Math.random() * 0.8,
      s: Math.random(),
      p: Math.random() * Math.PI * 2,
    }));
  }

  /** A storm's flash, for the stage to light the sky with. */
  get lightning(): number {
    return this.flash;
  }

  draw(g: CanvasRenderingContext2D, t: number, dt: number, W: number, H: number, fog: RGB): void {
    const k = this.kind;
    g.save();
    if (k === "mist" || k === "storm" || k === "rain") {
      // Bands of mist drifting across.
      for (let i = 0; i < 4; i++) {
        const y = H * (0.45 + i * 0.13);
        const x = ((t * (8 + i * 5) + i * 300) % (W * 2)) - W * 0.5;
        const grad = g.createRadialGradient(x, y, 0, x, y, W * 0.6);
        grad.addColorStop(0, rgba(fog, k === "mist" ? 0.35 : 0.15));
        grad.addColorStop(1, rgba(fog, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
    }
    if (k === "storm") {
      if (t > this.nextFlash) {
        this.flash = 0.5 + Math.random() * 0.4;
        this.nextFlash = t + 3 + Math.random() * 6;
      }
      this.flash = Math.max(0, this.flash - dt * 2.5);
    } else this.flash = 0;
    for (const d of this.drops) {
      switch (k) {
        case "rain":
        case "storm": {
          const v = (k === "storm" ? 1100 : 800) * d.v;
          d.y += v * dt;
          d.x += v * 0.18 * dt;
          if (d.y > H) {
            d.y = -20;
            d.x = Math.random() * W * 1.2 - W * 0.2;
          }
          g.strokeStyle = `rgba(200,215,235,${0.15 + d.s * 0.3})`;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(d.x, d.y);
          g.lineTo(d.x - 3, d.y - 14 * d.v);
          g.stroke();
          break;
        }
        case "snow": {
          d.y += 40 * d.v * dt;
          d.x += Math.sin(t + d.p) * 20 * dt;
          if (d.y > H) d.y = -5;
          g.fillStyle = `rgba(255,255,255,${0.5 + d.s * 0.5})`;
          g.beginPath();
          g.arc(d.x, d.y, 1 + d.s * 2, 0, Math.PI * 2);
          g.fill();
          break;
        }
        case "petals":
        case "leaves": {
          d.y += 50 * d.v * dt;
          d.x += (Math.sin(t * 0.8 + d.p) * 40 + 25) * dt;
          if (d.y > H || d.x > W + 10) {
            d.y = -10;
            d.x = Math.random() * W - W * 0.2;
          }
          g.fillStyle = k === "petals" ? `rgba(255,${170 + d.s * 40},${200 + d.s * 30},0.85)` : `rgba(${180 + d.s * 60},${90 + d.s * 50},30,0.85)`;
          g.save();
          g.translate(d.x, d.y);
          g.rotate(t * 2 * d.v + d.p);
          g.beginPath();
          g.ellipse(0, 0, 3 + d.s * 2, 1.5 + d.s, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
          break;
        }
        case "embers": {
          d.y -= 40 * d.v * dt;
          d.x += Math.sin(t * 2 + d.p) * 15 * dt;
          if (d.y < -5) {
            d.y = H + 5;
            d.x = Math.random() * W;
          }
          g.globalCompositeOperation = "lighter";
          g.fillStyle = `rgba(255,${120 + d.s * 80},40,${0.4 + 0.5 * Math.abs(Math.sin(t * 3 + d.p))})`;
          g.beginPath();
          g.arc(d.x, d.y, 1 + d.s * 1.8, 0, Math.PI * 2);
          g.fill();
          g.globalCompositeOperation = "source-over";
          break;
        }
        case "fireflies": {
          d.x += Math.sin(t * 0.7 + d.p) * 15 * dt;
          d.y += Math.cos(t * 0.5 + d.p * 2) * 10 * dt;
          const a = Math.max(0, Math.sin(t * 1.5 + d.p * 3));
          g.globalCompositeOperation = "lighter";
          const r = 6 + d.s * 6;
          const grad = g.createRadialGradient(d.x, d.y, 0, d.x, d.y, r);
          grad.addColorStop(0, `rgba(220,255,140,${a})`);
          grad.addColorStop(1, "rgba(220,255,140,0)");
          g.fillStyle = grad;
          g.fillRect(d.x - r, d.y - r, r * 2, r * 2);
          g.globalCompositeOperation = "source-over";
          break;
        }
      }
    }
    g.restore();
  }
}
