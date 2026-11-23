import type { Look } from "../../game/pack";
import { mix, rgba, type RGB } from "./util";

/**
 * The figures on the stage: silhouettes in ink, lit from behind in their colour, as a film shows people against the
 * light. A silhouette never looks wrong the way a drawn face can, and a look (an elder, a young master, a demon) reads
 * from its outline: hair, sleeves, a beard, a sword, horns. Made as paths in a box one unit tall, feet at 0.
 */

interface Humanoid {
  shoulder: number;
  hem: number;
  sleeves: number;
  head: number;
  hair: "topknot" | "bun" | "long" | "crown" | "bald" | "horns" | "hat" | "twin";
  beard?: boolean;
  prop?: "sword" | "staff" | "fan" | "spear" | "cane" | "beads";
  scale?: number;
  hunch?: number;
}

const HUMANOIDS: Partial<Record<Look, Humanoid>> = {
  hero: { shoulder: 0.15, hem: 0.2, sleeves: 0.05, head: 0.075, hair: "topknot", prop: "sword" },
  heroine: { shoulder: 0.12, hem: 0.22, sleeves: 0.06, head: 0.07, hair: "long", prop: "sword" },
  young_master: { shoulder: 0.15, hem: 0.24, sleeves: 0.09, head: 0.075, hair: "crown", prop: "fan" },
  maiden: { shoulder: 0.115, hem: 0.24, sleeves: 0.08, head: 0.068, hair: "twin" },
  elder: { shoulder: 0.16, hem: 0.27, sleeves: 0.1, head: 0.075, hair: "bun", beard: true, prop: "staff" },
  old_woman: { shoulder: 0.13, hem: 0.22, sleeves: 0.07, head: 0.07, hair: "bun", prop: "cane", hunch: 0.08, scale: 0.9 },
  disciple: { shoulder: 0.13, hem: 0.17, sleeves: 0.04, head: 0.072, hair: "topknot" },
  warrior: { shoulder: 0.2, hem: 0.19, sleeves: 0.05, head: 0.074, hair: "topknot", prop: "spear", scale: 1.05 },
  monk: { shoulder: 0.16, hem: 0.22, sleeves: 0.07, head: 0.078, hair: "bald", prop: "beads" },
  merchant: { shoulder: 0.17, hem: 0.24, sleeves: 0.07, head: 0.078, hair: "hat" },
  child: { shoulder: 0.11, hem: 0.15, sleeves: 0.04, head: 0.09, hair: "twin", scale: 0.62 },
  demon: { shoulder: 0.19, hem: 0.3, sleeves: 0.09, head: 0.075, hair: "horns", scale: 1.08 },
};

/** A humanoid as separate parts: filled one by one, so that where they overlap nothing cuts a hole in another. */
function humanoid(h: Humanoid, facing: number): Path2D[] {
  const parts: Path2D[] = [];
  const part = () => {
    const p = new Path2D();
    parts.push(p);
    return p;
  };
  const sh = h.shoulder * 0.85;
  const hem = h.hem * 0.85;
  const hunch = (h.hunch ?? 0) * facing;
  const neckY = -0.8;
  // The robe: round shoulders, drawn in at the waist, flaring to a hem that sweeps.
  const robe = part();
  robe.moveTo(hunch - 0.03, neckY - 0.01);
  robe.quadraticCurveTo(-sh * 0.6 + hunch, neckY, -sh + hunch, neckY + 0.06);
  robe.bezierCurveTo(-sh * 1.05 + hunch, -0.62, -sh * 0.72, -0.5, -sh * 0.78, -0.42);
  robe.bezierCurveTo(-hem * 0.8, -0.25, -hem * 1.05, -0.08, -hem, 0);
  robe.quadraticCurveTo(0, 0.025, hem, 0);
  robe.bezierCurveTo(hem * 1.05, -0.08, hem * 0.8, -0.25, sh * 0.78, -0.42);
  robe.bezierCurveTo(sh * 0.72, -0.5, sh * 1.05 + hunch, -0.62, sh + hunch, neckY + 0.06);
  robe.quadraticCurveTo(sh * 0.6 + hunch, neckY, hunch + 0.03, neckY - 0.01);
  robe.closePath();
  // Sleeves, hanging long from the shoulders.
  for (const side of [-1, 1]) {
    const s = part();
    const x0 = side * sh + hunch;
    s.moveTo(x0, neckY + 0.05);
    s.bezierCurveTo(x0 + side * h.sleeves * 1.2, -0.66, x0 + side * h.sleeves * 1.1, -0.42, x0 + side * h.sleeves * 0.6, -0.33);
    s.quadraticCurveTo(x0 - side * 0.02, -0.34, x0 - side * 0.05, -0.42);
    s.quadraticCurveTo(x0 - side * 0.02, -0.6, x0, neckY + 0.05);
    s.closePath();
  }
  // Neck and head.
  const hx = hunch * 1.3;
  const hr = h.head * 0.92;
  const hy = neckY - hr * 0.95;
  const neck = part();
  neck.rect(hx - 0.022, neckY - 0.04, 0.044, 0.06);
  const head = part();
  head.ellipse(hx, hy, hr * 0.9, hr, 0, 0, Math.PI * 2);
  const top = hy - hr;
  const hair = part();
  switch (h.hair) {
    case "topknot":
      hair.ellipse(hx, top - 0.012, 0.028, 0.03, 0, 0, Math.PI * 2);
      hair.moveTo(hx - 0.055, top - 0.016);
      hair.lineTo(hx + 0.055, top - 0.02);
      hair.lineTo(hx + 0.055, top - 0.01);
      hair.lineTo(hx - 0.055, top - 0.006);
      hair.closePath();
      break;
    case "bun":
      hair.ellipse(hx, top + 0.008, 0.045, 0.04, 0, 0, Math.PI * 2);
      break;
    case "crown":
      hair.moveTo(hx - 0.035, top + 0.02);
      hair.lineTo(hx - 0.04, top - 0.045);
      hair.quadraticCurveTo(hx, top - 0.065, hx + 0.04, top - 0.045);
      hair.lineTo(hx + 0.035, top + 0.02);
      hair.closePath();
      break;
    case "long":
      hair.moveTo(hx - hr * 0.85, hy - hr * 0.3);
      hair.bezierCurveTo(hx - hr * 1.5, hy + 0.1, hx - hr * 1.2 - 0.02 * facing, -0.55, hx - hr * 0.6 - 0.04 * facing, -0.42);
      hair.lineTo(hx + hr * 0.6 - 0.02 * facing, -0.46);
      hair.bezierCurveTo(hx + hr * 1.2, -0.6, hx + hr * 1.4, hy + 0.08, hx + hr * 0.85, hy - hr * 0.3);
      hair.quadraticCurveTo(hx, top - 0.02, hx - hr * 0.85, hy - hr * 0.3);
      hair.closePath();
      break;
    case "twin":
      for (const s of [-1, 1]) {
        hair.moveTo(hx + s * hr * 0.9 + 0.03, top + 0.03);
        hair.ellipse(hx + s * hr * 0.9, top + 0.03, 0.03, 0.03, 0, 0, Math.PI * 2);
      }
      break;
    case "horns":
      for (const s of [-1, 1]) {
        hair.moveTo(hx + s * hr * 0.45, top + 0.035);
        hair.quadraticCurveTo(hx + s * hr * 1.9, top - 0.01, hx + s * hr * 1.4, top - 0.14);
        hair.quadraticCurveTo(hx + s * hr * 1.25, top - 0.03, hx + s * hr * 0.15, top + 0.06);
        hair.closePath();
      }
      // A mane down the back.
      hair.moveTo(hx - hr * 0.9, hy);
      hair.bezierCurveTo(hx - hr * 2.2, -0.6, hx - sh * 1.4, -0.35, hx - sh * 1.1, -0.2);
      hair.lineTo(hx + sh * 1.1, -0.2);
      hair.bezierCurveTo(hx + sh * 1.4, -0.35, hx + hr * 2.2, -0.6, hx + hr * 0.9, hy);
      hair.closePath();
      break;
    case "hat":
      hair.ellipse(hx, top + 0.035, hr * 2, 0.016, 0, 0, Math.PI * 2);
      hair.moveTo(hx + hr * 0.75, top + 0.035);
      hair.arc(hx, top + 0.035, hr * 0.75, 0, Math.PI, true);
      hair.closePath();
      break;
    case "bald":
      break;
  }
  if (h.beard) {
    const beard = part();
    beard.moveTo(hx - hr * 0.55, hy + hr * 0.45);
    beard.bezierCurveTo(hx - hr * 0.5, hy + hr * 2.2, hx - 0.01, hy + hr * 3.2, hx + 0.005 * facing, hy + hr * 3.4);
    beard.bezierCurveTo(hx + 0.01, hy + hr * 3.2, hx + hr * 0.5, hy + hr * 2.2, hx + hr * 0.55, hy + hr * 0.45);
    beard.closePath();
  }
  const f = facing;
  const prop = part();
  switch (h.prop) {
    case "sword":
      // Over the shoulder, behind the back: a blade and its guard.
      prop.moveTo(-f * (sh + 0.05), neckY - 0.13);
      prop.lineTo(-f * (sh + 0.068), neckY - 0.115);
      prop.lineTo(f * sh * 0.45, -0.32);
      prop.lineTo(f * sh * 0.45 - f * 0.014, -0.335);
      prop.closePath();
      prop.moveTo(-f * (sh + 0.02) - 0.028, neckY - 0.085);
      prop.lineTo(-f * (sh + 0.02) + 0.028, neckY - 0.105);
      prop.lineTo(-f * (sh + 0.02) + 0.032, neckY - 0.095);
      prop.lineTo(-f * (sh + 0.02) - 0.024, neckY - 0.075);
      prop.closePath();
      break;
    case "staff":
      prop.rect(f * (sh + 0.1) - 0.008, -1.08, 0.016, 1.08);
      prop.ellipse(f * (sh + 0.1), -1.1, 0.032, 0.036, 0, 0, Math.PI * 2);
      break;
    case "spear":
      prop.rect(f * (sh + 0.09) - 0.007, -1.25, 0.014, 1.25);
      prop.moveTo(f * (sh + 0.09), -1.38);
      prop.quadraticCurveTo(f * (sh + 0.09) + 0.03, -1.3, f * (sh + 0.09) + 0.018, -1.25);
      prop.lineTo(f * (sh + 0.09) - 0.018, -1.25);
      prop.quadraticCurveTo(f * (sh + 0.09) - 0.03, -1.3, f * (sh + 0.09), -1.38);
      break;
    case "fan":
      prop.moveTo(f * (sh + 0.05), -0.42);
      prop.arc(f * (sh + 0.05), -0.42, 0.08, -Math.PI * 0.85, -Math.PI * 0.4);
      prop.closePath();
      break;
    case "cane":
      prop.rect(f * (sh + 0.05) - 0.006, -0.48, 0.012, 0.48);
      break;
    case "beads":
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * 0.15 + (i / 8) * Math.PI * 0.7;
        const bx = Math.cos(a) * 0.07;
        const by = neckY + 0.02 + Math.sin(a) * 0.1;
        prop.moveTo(bx + 0.011, by);
        prop.arc(bx, by, 0.011, 0, Math.PI * 2);
      }
      break;
  }
  return parts;
}

function beast(facing: number): Path2D[] {
  const f = facing;
  const body = new Path2D();
  // A wolf, or a tiger: a deep chest, a lean flank, a heavy head held low.
  body.moveTo(-f * 0.36, -0.42);
  body.bezierCurveTo(-f * 0.1, -0.5, f * 0.15, -0.58, f * 0.32, -0.56);
  body.bezierCurveTo(f * 0.4, -0.5, f * 0.36, -0.3, f * 0.3, -0.24);
  body.bezierCurveTo(f * 0.1, -0.22, -f * 0.2, -0.26, -f * 0.36, -0.3);
  body.closePath();
  const head = new Path2D();
  head.moveTo(f * 0.26, -0.56);
  head.bezierCurveTo(f * 0.36, -0.7, f * 0.5, -0.66, f * 0.56, -0.56);
  head.lineTo(f * 0.68, -0.5);
  head.quadraticCurveTo(f * 0.68, -0.44, f * 0.58, -0.43);
  head.quadraticCurveTo(f * 0.45, -0.4, f * 0.36, -0.42);
  head.closePath();
  head.moveTo(f * 0.38, -0.66);
  head.lineTo(f * 0.4, -0.78);
  head.lineTo(f * 0.47, -0.67);
  head.closePath();
  const legs = new Path2D();
  for (const [lx, back] of [
    [-0.3, true],
    [-0.2, true],
    [0.2, false],
    [0.3, false],
  ] as const) {
    const x = f * lx;
    legs.moveTo(x - 0.035, -0.32);
    legs.quadraticCurveTo(x + (back ? -f * 0.04 : 0), -0.15, x - 0.015, 0);
    legs.lineTo(x + 0.02, 0);
    legs.quadraticCurveTo(x + 0.03, -0.18, x + 0.035, -0.32);
    legs.closePath();
  }
  const tail = new Path2D();
  tail.moveTo(-f * 0.34, -0.42);
  tail.bezierCurveTo(-f * 0.55, -0.5, -f * 0.62, -0.62, -f * 0.58, -0.78);
  tail.bezierCurveTo(-f * 0.54, -0.6, -f * 0.48, -0.46, -f * 0.33, -0.34);
  tail.closePath();
  return [tail, legs, body, head];
}

function spiritShape(): Path2D[] {
  const p = new Path2D();
  p.moveTo(0, -0.95);
  p.bezierCurveTo(0.14, -0.95, 0.16, -0.7, 0.1, -0.5);
  p.bezierCurveTo(0.06, -0.3, 0.16, -0.12, 0.04, 0);
  p.bezierCurveTo(0, -0.12, -0.12, -0.2, -0.08, -0.4);
  p.bezierCurveTo(-0.16, -0.6, -0.14, -0.95, 0, -0.95);
  return [p];
}

/** A dragon, coiled: a line the stage strokes thick, tapering, with its head at the top. */
function serpentLine(facing: number): { body: [number, number][]; head: [number, number] } {
  const f = facing;
  return {
    body: [
      [-0.4 * f, -0.02],
      [0.15 * f, -0.12],
      [0.3 * f, -0.35],
      [-0.1 * f, -0.5],
      [-0.25 * f, -0.7],
      [0.05 * f, -0.92],
      [0.22 * f, -1.0],
    ],
    head: [0.22 * f, -1.0],
  };
}

const cache = new Map<string, Path2D[]>();
function partsOf(look: Look, facing: number): Path2D[] {
  const key = `${look}:${facing}`;
  let p = cache.get(key);
  if (!p) {
    p = look === "beast" ? beast(facing) : look === "spirit" ? spiritShape() : humanoid(HUMANOIDS[look] ?? HUMANOIDS.disciple!, facing);
    cache.set(key, p);
  }
  return p;
}

export const lookScale = (look: Look) => HUMANOIDS[look]?.scale ?? (look === "beast" ? 0.75 : look === "serpent" ? 1.15 : 1);

export interface FigureOptions {
  /** 0..1: how much it stands out (the one speaking). */
  lit: number;
  /** Seconds, for breathing and floating. */
  t: number;
  facing: 1 | -1;
  alpha: number;
  ink: RGB;
  /** A short shake, 0..1, when hit. */
  hurt?: number;
}

function strokeSerpent(g: CanvasRenderingContext2D, facing: number, color: RGB, ink: RGB, lit: number, t: number, h: number): void {
  const { body, head } = serpentLine(facing);
  const sway = (i: number) => Math.sin(t * 1.4 + i * 0.9) * 0.025;
  const path = () => {
    g.beginPath();
    body.forEach(([x, y], i) => {
      const px = x + sway(i);
      if (i === 0) g.moveTo(px, y);
      else {
        const [qx, qy] = body[i - 1];
        g.quadraticCurveTo(qx + sway(i - 1), qy, (qx + sway(i - 1) + px) / 2, (qy + y) / 2);
      }
    });
    g.lineTo(head[0] + sway(body.length - 1), head[1]);
  };
  g.lineCap = "round";
  g.lineJoin = "round";
  g.shadowColor = rgba(color, 0.9);
  g.shadowBlur = (10 + lit * 20) * (h / 300);
  path();
  g.strokeStyle = rgba(color, 0.6 + lit * 0.4);
  g.lineWidth = 0.1;
  g.stroke();
  g.shadowBlur = 0;
  path();
  g.strokeStyle = rgba(ink, 0.97);
  g.lineWidth = 0.08;
  g.stroke();
  // The head, its horns and its whiskers.
  const hx = head[0] + sway(body.length - 1);
  const hy = head[1];
  g.fillStyle = rgba(ink, 0.97);
  g.beginPath();
  g.ellipse(hx + facing * 0.05, hy, 0.09, 0.05, facing * 0.2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = rgba(color, 0.8);
  g.lineWidth = 0.008;
  for (const dy of [-0.02, 0.02]) {
    g.beginPath();
    g.moveTo(hx + facing * 0.12, hy + dy);
    g.quadraticCurveTo(hx + facing * 0.25, hy + dy * 4 + Math.sin(t * 2) * 0.02, hx + facing * 0.32, hy + dy * 6);
    g.stroke();
  }
  g.strokeStyle = rgba(ink, 0.97);
  g.lineWidth = 0.018;
  for (const dx of [-0.02, 0.03]) {
    g.beginPath();
    g.moveTo(hx + dx, hy - 0.03);
    g.quadraticCurveTo(hx + dx - facing * 0.06, hy - 0.1, hx + dx - facing * 0.12, hy - 0.13);
    g.stroke();
  }
}

/** Draws a figure, feet at (x, y), `h` pixels tall. */
export function drawFigure(g: CanvasRenderingContext2D, look: Look, x: number, y: number, h: number, color: RGB, o: FigureOptions): void {
  const s = h * lookScale(look);
  const breathe = 1 + Math.sin(o.t * 1.7 + x) * 0.006;
  const float = look === "spirit" ? Math.sin(o.t * 1.3) * h * 0.03 - h * 0.06 : 0;
  const shake = o.hurt ? Math.sin(o.t * 80) * h * 0.02 * o.hurt : 0;
  g.save();
  g.globalAlpha = o.alpha;
  g.translate(x + shake, y + float);
  // Its shadow on the ground.
  g.fillStyle = "rgba(0,0,0,0.28)";
  g.beginPath();
  g.ellipse(0, -float, s * 0.22, s * 0.025, 0, 0, Math.PI * 2);
  g.fill();
  g.scale(s, s * breathe);
  if (look === "serpent") {
    strokeSerpent(g, o.facing, color, o.ink, o.lit, o.t, h);
    g.restore();
    return;
  }
  const parts = partsOf(look, o.facing);
  if (look === "spirit") {
    // Light, not ink: a glow, a body that fades toward its tail, and eyes.
    const glow = g.createRadialGradient(0, -0.6, 0, 0, -0.6, 0.5);
    glow.addColorStop(0, rgba(color, 0.35));
    glow.addColorStop(1, rgba(color, 0));
    g.fillStyle = glow;
    g.fillRect(-0.5, -1.1, 1, 1.1);
    const grad = g.createLinearGradient(0, -0.95, 0, 0);
    grad.addColorStop(0, rgba(color, 0.75));
    grad.addColorStop(0.6, rgba(color, 0.3));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.shadowColor = rgba(color, 1);
    g.shadowBlur = 20 * (h / 300);
    for (const p of parts) g.fill(p);
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.95)";
    for (const dx of [-0.03, 0.03]) {
      g.beginPath();
      g.ellipse(dx, -0.8, 0.012, 0.018, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    return;
  }
  // The rim: the figure in its colour, glowing, a little to the side; then the ink over it.
  g.shadowColor = rgba(color, 0.9);
  g.shadowBlur = (8 + o.lit * 22) * (h / 300);
  g.fillStyle = rgba(color, 0.55 + o.lit * 0.45);
  g.save();
  g.translate(-0.01 * o.facing, -0.005);
  for (const p of parts) g.fill(p);
  g.restore();
  g.shadowBlur = 0;
  const grad = g.createLinearGradient(0, -1.1, 0, 0);
  grad.addColorStop(0, rgba(o.ink));
  grad.addColorStop(1, rgba(mix(o.ink, color, 0.06)));
  g.fillStyle = grad;
  for (const p of parts) g.fill(p);
  // Eyes that glow, for what is not quite human.
  if (look === "demon" || look === "beast") {
    g.fillStyle = rgba(look === "demon" ? [255, 60, 50] : color, 0.95);
    g.shadowColor = g.fillStyle;
    g.shadowBlur = 6;
    const eye = look === "beast" ? [o.facing * 0.5, -0.6] : [0, -0.89];
    for (const dx of look === "demon" ? [-0.022, 0.022] : [0]) {
      g.beginPath();
      g.ellipse(eye[0] + dx, eye[1], 0.012, 0.007, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}
