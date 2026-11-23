import type { Pack, Place, PlaceLook } from "./pack";

const out = (ridges: number, roughness: number, height: number, features: PlaceLook["features"], tint?: PlaceLook["tint"]): PlaceLook => ({
  kind: "outdoor",
  ridges,
  roughness,
  height,
  features,
  ...(tint ? { tint } : {}),
});
const inside = (features: PlaceLook["features"], tint?: PlaceLook["tint"]): PlaceLook => ({ kind: "interior", ridges: 0, roughness: 0, height: 0, features, ...(tint ? { tint } : {}) });

const PLACES: Place[] = [
  { id: "mountain_peak", label: "Mountain peak", look: out(5, 0.55, 0.42, ["pines", "clouds_below", "cliff"]) },
  { id: "sect_gate", label: "Sect gate", look: out(4, 0.45, 0.5, ["gate", "pagodas", "pines", "lanterns"]) },
  { id: "sect_courtyard", label: "Sect courtyard", look: out(3, 0.4, 0.55, ["pagodas", "lanterns", "walls", "pines"]) },
  { id: "sect_hall", label: "Sect hall", look: inside(["pillars", "lanterns"]) },
  { id: "elder_chamber", label: "Elder's chamber", look: inside(["pillars", "lanterns"], { rgb: [120, 80, 40], amount: 0.12 }) },
  { id: "cultivation_cave", label: "Cultivation cave", look: inside(["cave"], { rgb: [40, 90, 120], amount: 0.15 }) },
  { id: "bamboo_forest", label: "Bamboo forest", look: out(2, 0.3, 0.35, ["bamboo"], { rgb: [40, 120, 70], amount: 0.12 }) },
  { id: "pine_forest", label: "Pine forest", look: out(3, 0.4, 0.4, ["pines"]) },
  { id: "waterfall", label: "Waterfall", look: out(4, 0.6, 0.6, ["waterfall", "pines", "cliff"]) },
  { id: "lake", label: "Lake", look: out(4, 0.35, 0.3, ["lake", "pagodas"]) },
  { id: "river", label: "River valley", look: out(4, 0.5, 0.45, ["river", "pines"]) },
  { id: "mortal_town", label: "Mortal town", look: out(2, 0.3, 0.3, ["walls", "stalls", "lanterns"]) },
  { id: "market", label: "Night market", look: out(1, 0.3, 0.25, ["stalls", "lanterns"]) },
  { id: "imperial_palace", label: "Imperial palace", look: out(2, 0.3, 0.3, ["palace", "walls", "lanterns"]) },
  { id: "ancient_ruins", label: "Ancient ruins", look: out(3, 0.5, 0.4, ["ruins", "pillars"], { rgb: [110, 90, 60], amount: 0.1 }) },
  { id: "graveyard", label: "Burial ground", look: out(3, 0.5, 0.35, ["graves", "pines"], { rgb: [60, 70, 90], amount: 0.2 }) },
  { id: "demon_realm", label: "Demonic realm", look: out(5, 0.8, 0.5, ["blood_sky", "ruins"], { rgb: [140, 20, 30], amount: 0.3 }) },
  { id: "heavenly_realm", label: "Heavenly realm", look: out(2, 0.3, 0.2, ["clouds_below", "palace", "stars_dense"], { rgb: [255, 220, 150], amount: 0.12 }) },
  { id: "battlefield", label: "Battlefield", look: out(3, 0.6, 0.35, ["ruins", "graves"], { rgb: [120, 60, 40], amount: 0.15 }) },
  { id: "moonlit_cliff", label: "Moonlit cliff", look: out(4, 0.6, 0.5, ["cliff", "big_moon", "pines"]) },
  { id: "secret_realm", label: "Secret realm", look: out(4, 0.7, 0.45, ["ruins", "stars_dense", "waterfall"], { rgb: [120, 80, 200], amount: 0.2 }) },
  { id: "inn", label: "Inn", look: inside(["lanterns", "pillars"], { rgb: [160, 100, 40], amount: 0.12 }) },
  { id: "alchemy_room", label: "Alchemy room", look: inside(["lanterns"], { rgb: [200, 90, 30], amount: 0.15 }) },
  { id: "library", label: "Scripture library", look: inside(["pillars", "lanterns"], { rgb: [140, 110, 70], amount: 0.1 }) },
  { id: "arena", label: "Tournament arena", look: out(3, 0.4, 0.4, ["pagodas", "lanterns", "walls"]) },
  { id: "desert", label: "Desert", look: out(2, 0.2, 0.2, ["ruins"], { rgb: [210, 150, 70], amount: 0.2 }) },
  { id: "snow_mountain", label: "Snow mountain", look: out(5, 0.6, 0.5, ["pines", "cliff"], { rgb: [200, 220, 255], amount: 0.2 }) },
  { id: "sea", label: "Eastern sea", look: out(0, 0, 0, ["lake", "big_moon"]) },
];

export const XIANXIA: Pack = {
  id: "xianxia",
  name: "Xianxia",
  premise: [
    "A world of cultivation, as in the Chinese cultivation novels: mortals temper body and spirit, gather qi from heaven and earth, and climb from realm to realm toward immortality.",
    "Sects rule the mountains, clans rule the cities, and the strong take what they want. Face, karma, hidden masters, ancient inheritances, arrogant young masters, tribulation lightning and secret realms belong here.",
  ].join(" "),
  stats: {
    body: { label: "Body", hint: "strength, endurance, fighting up close" },
    mind: { label: "Mind", hint: "insight, comprehension, schemes, seeing through lies" },
    spirit: { label: "Spirit", hint: "qi sense, will, techniques, resisting illusions" },
    fate: { label: "Fate", hint: "luck, fortuitous encounters, escaping death" },
  },
  words: { hp: "Vitality", qi: "Qi", money: "Spirit stones", progress: "Cultivation", karma: "Karma", breakthrough: "Breakthrough" },
  realms: [
    { name: "Mortal", steps: 1 },
    { name: "Body Tempering", steps: 9 },
    { name: "Qi Condensation", steps: 9 },
    { name: "Foundation Establishment", steps: 3, stepNames: ["Early", "Middle", "Late"] },
    { name: "Core Formation", steps: 3, stepNames: ["Early", "Middle", "Late"] },
    { name: "Nascent Soul", steps: 3, stepNames: ["Early", "Middle", "Late"] },
    { name: "Soul Transformation", steps: 3, stepNames: ["Early", "Middle", "Late"] },
    { name: "Void Refinement", steps: 3, stepNames: ["Early", "Middle", "Late"] },
    { name: "Immortal Ascension", steps: 1 },
  ],
  places: PLACES,
  origins: [
    {
      id: "fallen_clan",
      label: "Last of a fallen clan",
      story: "The last survivor of a clan wiped out in one night, hiding the clan's name and a broken jade pendant.",
      stats: { body: 3, mind: 4, spirit: 4, fate: 3 },
      items: [{ name: "Broken jade pendant", kind: "token", amount: 1 }],
      stones: 3,
    },
    {
      id: "outer_disciple",
      label: "Outer disciple",
      story: "A lowly outer disciple of a mid-sized sect, doing chores, mocked for crippled meridians that nobody can explain.",
      stats: { body: 4, mind: 3, spirit: 2, fate: 5 },
      items: [{ name: "Qi Gathering Pill", kind: "pill", amount: 2 }],
      stones: 5,
    },
    {
      id: "reincarnated",
      label: "Reincarnated soul",
      story: "Wakes in the body of a sickly youth, with fragments of memories of a former life as someone far greater.",
      stats: { body: 2, mind: 5, spirit: 5, fate: 2 },
      stones: 1,
    },
    {
      id: "hunter",
      label: "Mountain hunter",
      story: "A hunter's child from a village at the foot of the sect mountains, who has never seen a cultivator up close.",
      stats: { body: 5, mind: 3, spirit: 3, fate: 3 },
      items: [{ name: "Hunting bow", kind: "weapon", amount: 1 }],
      stones: 0,
    },
    {
      id: "young_noble",
      label: "Disgraced young noble",
      story: "Heir of a rich merchant clan, cast out after a betrothal was broken off in public humiliation.",
      stats: { body: 3, mind: 4, spirit: 3, fate: 4 },
      items: [{ name: "Silver token of the clan", kind: "token", amount: 1 }],
      stones: 12,
    },
  ],
  basicTechnique: { name: "Basic Palm Strike", element: "none", power: 1 },
};

export const PACKS: Record<string, Pack> = { xianxia: XIANXIA };
export const DEFAULT_PACK = "xianxia";
export const packOf = (id: string | undefined): Pack => PACKS[id ?? DEFAULT_PACK] ?? XIANXIA;
