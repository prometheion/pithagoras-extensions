import { COLOR_RGB, type Color, type Fx, type Look, type PlaceLook, type Time, type Weather } from "../../game/pack";
import { buildBackdrop, type Backdrop } from "./backdrop";
import { drawFigure } from "./figures";
import { Effects } from "./fx";
import { WeatherLayer } from "./weather";
import { clamp01, ease, mix, rgba } from "./util";

/**
 * The stage: one canvas, drawn every frame. A place (its layers, moved against each other by a slow camera), or a
 * picture where the scene gives one, slowly zooming; what moves in the place (water, lanterns, clouds); the figures;
 * the weather; the effects; and the camera's shake, zoom and flash over all of it. A new place fades in over the old.
 *
 * It knows nothing of the game: the panel tells it the place, who stands where and who speaks, and what to play.
 */

export interface StageSet {
  place: string;
  look: PlaceLook;
  time: Time;
  weather: Weather;
  picture?: string;
}

export interface StageFigure {
  id: string;
  look: Look;
  color: Color;
  /** Where it stands, as a share of the width. */
  x: number;
  facing: 1 | -1;
  down?: boolean;
  picture?: string;
  /** Smaller for a crowded stage: a fight. */
  scale?: number;
}

interface Shown extends StageFigure {
  since: number;
  leaving?: number;
  hurt: number;
}

export class Stage {
  private readonly g: CanvasRenderingContext2D;
  private W = 1;
  private H = 1;
  private dpr = 1;
  private set?: StageSet;
  private backdrop?: Backdrop;
  private picture?: HTMLImageElement;
  private prev?: HTMLCanvasElement;
  private prevAt = 0;
  private figures = new Map<string, Shown>();
  private speaker?: string;
  private readonly fx = new Effects();
  private readonly weather = new WeatherLayer();
  private frame = 0;
  private last = 0;
  private t = 0;
  private readonly observer: ResizeObserver;
  private readonly images = new Map<string, HTMLImageElement>();
  private rebuildTimer?: ReturnType<typeof setTimeout>;
  private scratch?: HTMLCanvasElement;

  /** A canvas the size of the stage, to draw a figure that fades in or out. */
  private offscreen(): HTMLCanvasElement {
    if (!this.scratch) this.scratch = document.createElement("canvas");
    if (this.scratch.width !== this.canvas.width || this.scratch.height !== this.canvas.height) {
      this.scratch.width = this.canvas.width;
      this.scratch.height = this.canvas.height;
    }
    return this.scratch;
  }

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d")!;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.fx.reduced = reduced;
    this.weather.reduced = reduced;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.last = performance.now() / 1000;
    this.frame = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    clearTimeout(this.rebuildTimer);
  }

  private resize(): void {
    const box = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(box.width));
    const H = Math.max(1, Math.round(box.height));
    if (W === this.W && H === this.H && dpr === this.dpr) return;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.build(), 60);
  }

  private build(): void {
    if (!this.set) return;
    this.backdrop = buildBackdrop(this.set.look, this.set.time, this.set.place, this.W, this.H);
    this.weather.set(this.set.weather, this.W, this.H);
  }

  private image(src: string): HTMLImageElement {
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = src;
      this.images.set(src, img);
    }
    return img;
  }

  /** The place: drawn anew where it changed, fading in over what was. */
  setPlace(set: StageSet): void {
    const same = this.set && this.set.place === set.place && this.set.time === set.time && this.set.picture === set.picture;
    if (same) {
      if (this.set!.weather !== set.weather) this.weather.set(set.weather, this.W, this.H);
      this.set = set;
      return;
    }
    if (this.set) {
      // What is on screen now, to fade out.
      const snap = document.createElement("canvas");
      snap.width = this.canvas.width;
      snap.height = this.canvas.height;
      snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
      this.prev = snap;
      this.prevAt = this.t;
    }
    this.set = set;
    this.picture = set.picture ? this.image(set.picture) : undefined;
    this.build();
  }

  /** Who stands on the stage now. Those who come fade in, those who go fade out. */
  setFigures(figures: StageFigure[], speaker?: string): void {
    const ids = new Set(figures.map((f) => f.id));
    for (const [id, f] of this.figures) if (!ids.has(id) && f.leaving === undefined) f.leaving = this.t;
    for (const f of figures) {
      const was = this.figures.get(f.id);
      if (was && was.leaving === undefined) Object.assign(was, f);
      else this.figures.set(f.id, { ...f, since: this.t, hurt: 0 });
      if (f.picture) this.image(f.picture);
    }
    this.speaker = speaker;
  }

  /** Where a figure stands, as a share of the stage, for an effect aimed at it: the middle where there is none. */
  private aim(on?: string): { x: number; y: number } {
    const f = on ? [...this.figures.values()].find((x) => x.id === on || x.id.toLowerCase() === on.toLowerCase()) : undefined;
    return f ? { x: f.x, y: 0.62 } : { x: 0.5, y: 0.55 };
  }

  play(kind: Fx, color?: Color, on?: string): void {
    this.fx.play(kind, this.t, this.aim(on), color ? COLOR_RGB[color] : undefined);
  }

  hurt(id: string): void {
    const f = this.figures.get(id);
    if (f) f.hurt = 1;
  }

  private tick = (ms: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const now = ms / 1000;
    const dt = Math.min(0.05, now - this.last);
    this.last = now;
    this.t += dt;
    this.draw(dt);
  };

  private draw(dt: number): void {
    const { g, W, H, t } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cam = this.fx.camera(t);
    const bd = this.backdrop;
    const pal = bd?.palette;
    g.fillStyle = "#05060a";
    g.fillRect(0, 0, W, H);
    g.save();
    // The camera: a slow drift, the shake, the zoom toward the middle.
    const zoom = 1 + cam.zoom;
    const sx = (Math.random() - 0.5) * cam.shake;
    const sy = (Math.random() - 0.5) * cam.shake;
    g.translate(W / 2 + sx, H / 2 + sy);
    g.scale(zoom, zoom);
    g.translate(-W / 2, -H / 2);
    const drift = Math.sin(t * 0.06) * 0.5 + Math.sin(t * 0.023) * 0.5;

    const pic = this.picture;
    if (pic && pic.complete && pic.naturalWidth) {
      // Cover the stage, slowly closing in.
      const k = 1.04 + ((t * 0.004) % 0.1);
      const scale = Math.max(W / pic.naturalWidth, H / pic.naturalHeight) * k;
      const pw = pic.naturalWidth * scale;
      const ph = pic.naturalHeight * scale;
      g.drawImage(pic, (W - pw) / 2 + drift * W * 0.02, (H - ph) / 2, pw, ph);
    } else if (bd) {
      for (const layer of bd.layers) {
        const dx = -bd.margin + drift * bd.margin * layer.depth * 0.9;
        g.drawImage(layer.canvas, dx, 0, layer.canvas.width, H);
        if (layer.depth === 0 && !bd.dynamic.interior) this.drawSkyClouds(t, pal!.fog, pal!.light);
      }
      this.drawDynamic(t, dt, bd, drift);
    }

    // The figures, nearest last: the one speaking a little forward and brighter.
    const ink = pal ? mix(pal.ink, [0, 0, 0], 0.5) : ([5, 6, 10] as [number, number, number]);
    const figs = [...this.figures.values()].sort((a, b) => Number(a.id === this.speaker) - Number(b.id === this.speaker));
    for (const f of figs) {
      const enter = ease((t - f.since) / 0.7);
      const leave = f.leaving === undefined ? 1 : 1 - clamp01((t - f.leaving) / 0.5);
      if (leave <= 0) {
        this.figures.delete(f.id);
        continue;
      }
      f.hurt = Math.max(0, f.hurt - dt * 2.5);
      const speaking = this.speaker === f.id;
      const others = this.speaker !== undefined && !speaking;
      const h = Math.min(H * 0.5, W * 0.7) * (speaking ? 1.06 : 1) * (f.scale ?? 1);
      const x = f.x * W + (1 - enter) * 30 * -f.facing;
      const y = H * 0.97;
      const img = f.picture ? this.images.get(f.picture) : undefined;
      if (img && img.complete && img.naturalWidth) {
        const s = (h * 1.1) / img.naturalHeight;
        g.save();
        g.globalAlpha = enter * leave * (others ? 0.7 : 1);
        g.drawImage(img, x - (img.naturalWidth * s) / 2, y - img.naturalHeight * s, img.naturalWidth * s, img.naturalHeight * s);
        g.restore();
        continue;
      }
      g.save();
      if (f.down) {
        g.translate(x, y);
        g.rotate(f.facing * 1.35);
        g.translate(-x, -y);
      }
      // Drawn whole and then faded, so that where its parts overlap does not show through.
      const alpha = enter * leave;
      if (alpha >= 1) drawFigure(g, f.look, x, y, h, COLOR_RGB[f.color], { lit: speaking ? 1 : others || f.down ? 0.1 : 0.35, t, facing: f.facing, alpha: 1, ink: f.down ? mix(ink, [60, 60, 70], 0.4) : ink, hurt: f.hurt });
      else {
        const off = this.offscreen();
        const og = off.getContext("2d")!;
        og.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        og.clearRect(0, 0, W, H);
        drawFigure(og, f.look, x, y, h, COLOR_RGB[f.color], { lit: speaking ? 1 : 0.35, t, facing: f.facing, alpha: 1, ink, hurt: f.hurt });
        g.globalAlpha = alpha;
        g.drawImage(off, 0, 0, W, H);
        g.globalAlpha = 1;
      }
      g.restore();
    }

    if (pal && this.set) this.weather.draw(g, t, dt, W, H, pal.fog);
    this.fx.draw(g, t, dt, W, H);
    g.restore();

    // Over everything: a storm's flash, the effects' flash, darkness, the vignette, and the old place fading out.
    const storm = this.weather.lightning;
    if (storm > 0) {
      g.fillStyle = `rgba(220,230,255,${storm * 0.5})`;
      g.fillRect(0, 0, W, H);
    }
    if (cam.flash > 0) {
      g.fillStyle = rgba(cam.flashColor, Math.min(0.95, cam.flash));
      g.fillRect(0, 0, W, H);
    }
    if (cam.dark > 0) {
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.05, W / 2, H / 2, Math.max(W, H) * (1.1 - cam.dark * 0.8));
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, `rgba(5,0,10,${cam.dark})`);
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
    }
    const vignette = g.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.8);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.55)");
    g.fillStyle = vignette;
    g.fillRect(0, 0, W, H);
    if (this.set?.look.tint) {
      g.fillStyle = rgba(this.set.look.tint.rgb, this.set.look.tint.amount * 0.6);
      g.fillRect(0, 0, W, H);
    }
    if (this.prev) {
      const a = 1 - clamp01((t - this.prevAt) / 1.2);
      if (a <= 0) this.prev = undefined;
      else {
        g.globalAlpha = a;
        g.drawImage(this.prev, 0, 0, W, H);
        g.globalAlpha = 1;
      }
    }
  }

  private drawSkyClouds(t: number, fog: [number, number, number], light: [number, number, number]): void {
    const { g, W, H } = this;
    for (let i = 0; i < 5; i++) {
      const x = ((t * (4 + i * 1.5) + i * 523) % (W * 1.6)) - W * 0.3;
      const y = H * (0.12 + ((i * 37) % 30) / 100);
      const r = W * (0.18 + (i % 3) * 0.06);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgba(mix(fog, light, 0.4), 0.28));
      grad.addColorStop(1, rgba(fog, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(x, y, r, r * 0.25, 0, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawDynamic(t: number, _dt: number, bd: Backdrop, drift: number): void {
    const { g, W, H } = this;
    const d = bd.dynamic;
    const pal = bd.palette;
    const shift = (depth: number) => drift * bd.margin * depth * 0.9;
    if (d.water) {
      const y = d.water.y * H;
      const grad = g.createLinearGradient(0, y, 0, H);
      grad.addColorStop(0, rgba(mix(pal.sky[2], pal.fog, 0.3), 0.95));
      grad.addColorStop(1, rgba(mix(pal.sky[0], pal.ink, 0.4), 0.98));
      g.fillStyle = grad;
      g.fillRect(0, y, W, H - y);
      // The orb's path on the water, and shimmer.
      if (pal.orb) {
        const ox = pal.orb.x * W;
        for (let i = 0; i < 24; i++) {
          const ly = y + ((i + ((t * 0.3) % 1)) / 24) * (H - y);
          const w = (W * 0.04 + (ly - y) * 0.15) * (0.6 + 0.4 * Math.sin(t * 2 + i));
          g.fillStyle = rgba(pal.orb.color, 0.25 * (1 - (ly - y) / (H - y)));
          g.fillRect(ox - w / 2 + Math.sin(t + i) * 4, ly, w, 1.5);
        }
      }
      g.fillStyle = rgba(pal.light, 0.07);
      for (let i = 0; i < 30; i++) {
        const ly = y + ((i * 53) % 100) / 100 * (H - y);
        const lx = (((i * 97 + t * 12) % (W * 1.2)) - W * 0.1);
        g.fillRect(lx, ly, W * 0.08, 1);
      }
    }
    if (d.river) {
      g.strokeStyle = rgba(mix(pal.sky[2], pal.light, 0.3), 0.7);
      g.lineCap = "round";
      g.lineWidth = H * 0.05;
      g.beginPath();
      d.river.points.forEach(([x, y], i) => {
        const px = x * W + shift(0.8);
        const py = y * H;
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      });
      g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = rgba(pal.light, 0.4);
      g.setLineDash([6, 14]);
      g.lineDashOffset = -t * 30;
      g.stroke();
      g.setLineDash([]);
    }
    if (d.waterfall) {
      const wf = d.waterfall;
      const x = wf.x * W + shift(0.6);
      const w = wf.width * W;
      const top = wf.top * H;
      const bottom = wf.bottom * H;
      const grad = g.createLinearGradient(x - w, 0, x + w, 0);
      grad.addColorStop(0, rgba(pal.light, 0));
      grad.addColorStop(0.5, rgba(mix(pal.light, [255, 255, 255], 0.5), 0.75));
      grad.addColorStop(1, rgba(pal.light, 0));
      g.fillStyle = grad;
      g.fillRect(x - w, top, w * 2, bottom - top);
      g.strokeStyle = "rgba(255,255,255,0.5)";
      g.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const lx = x + ((i / 14) - 0.5) * w * 1.4;
        const ly = top + (((t * 220 + i * 47) % (bottom - top)) || 0);
        g.beginPath();
        g.moveTo(lx, ly);
        g.lineTo(lx, ly + 18);
        g.stroke();
      }
      const mist = g.createRadialGradient(x, bottom, 0, x, bottom, w * 5);
      mist.addColorStop(0, "rgba(255,255,255,0.45)");
      mist.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = mist;
      g.fillRect(x - w * 5, bottom - w * 5, w * 10, w * 10);
    }
    if (d.cloudsBelow) {
      const y = d.cloudsBelow.y * H;
      for (let i = 0; i < 9; i++) {
        const x = ((t * (6 + (i % 3) * 3) + i * 211) % (W * 1.5)) - W * 0.25;
        const r = W * (0.25 + (i % 4) * 0.06);
        const grad = g.createRadialGradient(x, y + (i % 3) * H * 0.05, 0, x, y, r);
        grad.addColorStop(0, rgba(mix(pal.fog, pal.light, 0.5), 0.75));
        grad.addColorStop(1, rgba(pal.fog, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(x, y + (i % 3) * H * 0.05, r, r * 0.3, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = rgba(mix(pal.fog, pal.light, 0.3), 0.85);
      g.fillRect(0, y + H * 0.12, W, H);
    }
    if (d.shafts) {
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const s of d.shafts) {
        const x = s.x * W;
        const a = 0.08 + 0.03 * Math.sin(t * 0.7 + s.x * 10);
        g.fillStyle = `rgba(255,220,160,${a})`;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + s.w * W, 0);
        g.lineTo(x + s.w * W * 3, H);
        g.lineTo(x + s.w * W, H);
        g.fill();
      }
      g.restore();
    }
    g.save();
    g.globalCompositeOperation = "lighter";
    for (const l of d.lanterns) {
      const x = l.x * W + shift(0.6);
      const y = l.y * H;
      const r = l.r * H * 6 * (0.9 + 0.1 * Math.sin(t * 7 + l.x * 40));
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,190,110,0.9)");
      grad.addColorStop(0.15, "rgba(255,120,50,0.45)");
      grad.addColorStop(1, "rgba(255,80,30,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (const c of d.crystals ?? []) {
      const x = c.x * W;
      const y = c.y * H;
      const r = c.r * H * 5 * (0.8 + 0.2 * Math.sin(t * 1.5 + c.x * 30));
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(150,230,255,0.8)");
      grad.addColorStop(1, "rgba(80,160,255,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.restore();
  }
}
