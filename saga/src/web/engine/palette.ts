import type { Time } from "../../game/pack";
import { hex, type RGB } from "./util";

/** The colours of a time of day: the sky from top to horizon, the haze far ridges fade into, the ink of near ones, the light. */
export interface Palette {
  sky: [RGB, RGB, RGB];
  fog: RGB;
  ink: RGB;
  light: RGB;
  /** Where the sun or the moon stands, as a share of width and height, or none. */
  orb?: { x: number; y: number; r: number; color: RGB; moon: boolean };
  stars: number;
}

export const PALETTES: Record<Time, Palette> = {
  dawn: {
    sky: [hex("#2b3566"), hex("#d98c7a"), hex("#f7d9ae")],
    fog: hex("#efc7a8"),
    ink: hex("#2a2436"),
    light: hex("#ffd9a0"),
    orb: { x: 0.72, y: 0.62, r: 0.06, color: hex("#fff1c9"), moon: false },
    stars: 0.15,
  },
  day: {
    sky: [hex("#5f9bd3"), hex("#a9d3ec"), hex("#e9f4f6")],
    fog: hex("#dcebf0"),
    ink: hex("#2c3b47"),
    light: hex("#fff8e6"),
    orb: { x: 0.78, y: 0.16, r: 0.05, color: hex("#fffdf2"), moon: false },
    stars: 0,
  },
  dusk: {
    sky: [hex("#1d1a3a"), hex("#a8436a"), hex("#f2a35a")],
    fog: hex("#d4876a"),
    ink: hex("#24182a"),
    light: hex("#ffb070"),
    orb: { x: 0.3, y: 0.6, r: 0.07, color: hex("#ffd28a"), moon: false },
    stars: 0.25,
  },
  night: {
    sky: [hex("#04060e"), hex("#0e1832"), hex("#22335a")],
    fog: hex("#273a5e"),
    ink: hex("#060912"),
    light: hex("#b9d0ff"),
    orb: { x: 0.74, y: 0.2, r: 0.045, color: hex("#eef3ff"), moon: true },
    stars: 1,
  },
};

export const BLOOD_SKY: Palette = {
  sky: [hex("#12030a"), hex("#5e0d1c"), hex("#c2342a")],
  fog: hex("#7a2028"),
  ink: hex("#0d0306"),
  light: hex("#ff6a4a"),
  orb: { x: 0.5, y: 0.32, r: 0.08, color: hex("#ff5a3a"), moon: true },
  stars: 0.2,
};
