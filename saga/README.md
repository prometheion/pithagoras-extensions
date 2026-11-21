# Saga

`@pithagoras/saga` turns a chat into a story you play. In a chat started in **Saga mode** the agent is the game
master of a cultivation saga, like the Chinese cultivation novels: you are the hero, and the story plays like a film in
a panel beside the chat. It has places drawn in ink, figures lit against the sky, lightning tribulations and
breakthroughs. You choose what the hero does, the dice decide whether it works, and you fight and solve puzzles in
the panel itself.

It is built so that a small model can run it. The model never draws, animates or counts. It fills in a scene as a
short form (a place from a list, who is there, a few lines of narration and dialogue, effects from a list, two to four
choices), and the extension plays it. The server keeps the hero's numbers, rolls every check and every blow, and
makes and checks every puzzle. The model is only told what came of it.

## Playing

1. Start a new chat and choose **Saga mode** above the message box.
2. The Saga panel opens beside the chat. Make your hero there: a name, an origin (last of a fallen clan, outer
   disciple, reincarnated soul…), a talent and the colour of your aura. The game master starts the story at once.
3. A scene plays beat by beat. Click or press Enter for the next line, ▶ in the head plays it by itself, and » skips
   to the choices. A choice with a check shows its stat, its difficulty and its chance (the server works the chance
   out from your stats). You can also write an action of your own.
4. Between scenes the panel shows the dice and what you gained or lost, while the game master writes the next scene.
   The scroll in the head opens your character sheet: realm, cultivation, stats, techniques, belongings, bonds and
   the chronicle of what the story remembers.

You can always write in the chat too: ask for a different kind of story, describe your hero, or say what you do.

## What the panel plays

- **Places**: 28 of them, among them mountain peaks, sect gates, halls and caves, bamboo forests, waterfalls, lakes,
  night markets, the imperial palace, ruins, battlefields, the demonic and the heavenly realm. Each comes at dawn, by
  day, at dusk or at night, in any of nine kinds of weather. A new place fades in over the old one, and the camera
  drifts slowly over the layers.
- **Figures**: 15 looks (hero, heroine, young master, maiden, elder, monk, demon, beast, dragon, spirit…), drawn as
  silhouettes lit from behind in their own colour. The one speaking stands forward and glows.
- **Effects**: 15 of them, among them lightning, aura, slash, impact, shockwave, breakthrough, fire, ice, sword rain
  and golden light, each with its light, particles and camera shake.
- **Puzzles**: a formation (light every node of an array), a rune trial (repeat the runes as they lit up), a
  breakthrough (strike when the qi passes the gate), and riddles the game master writes, answered by choosing or by
  writing.
- **Fights**: turn by turn against up to four foes. You strike, use a technique (it costs qi), guard, swallow a pill
  or flee. The server plays each round, and the panel plays it back blow by blow.
- **Pictures**: where the agent has a way to make pictures, a scene can show one from the chat's folder in place of
  the drawn place, slowly zooming, with the weather and the effects over it.

Animations follow the system's "reduce motion" setting: no camera shake, fewer particles.

## The mode, and the agent's tools

In a chat in Saga mode the agent has the game's tools and no others: no shell, no files, no browser. Its prompt is
the game master's, in place of the coding agent's. It is short and plain, and says how to play, the style, the
words each tool takes, the hero as they are now and what the story must remember. Chats in other modes have nothing
of Saga.

| Tool | | |
| --- | --- | --- |
| `saga_scene` | `location`, `time`, `weather`, `cast`, `beats`, `choices`, `changes`, `remember`, `title`, `picture` | Plays a scene and waits for the player's choice. Returns the choice, the roll of its check and the hero now |
| `saga_puzzle` | `kind`, `difficulty`, `title`, `intro` (riddle: `question`, `answer`, `options`) | A puzzle. Waits until it is solved, failed or given up. A breakthrough that succeeds advances the realm by itself |
| `saga_combat` | `enemies` (`name`, `look`, `rank`, `element`), `location`, `canFlee` | A fight, played by the player. Waits until it is won, lost or fled |
| `saga_roll` | `stat`, `difficulty`, `reason` | A check for an action the player wrote themself |
| `saga_change` | `changes` | Rewards and costs outside a scene |
| `saga_begin` | `name`, `gender`, `origin`, `focus`, `color`, `language` | Makes the hero, when the player describes them in the chat |
| `saga_status` | | The hero and the chronicle |

The words a parameter takes are lists (enums) in each tool's schema. What a model writes otherwise is read leniently,
and what was taken in its place is said back to it in the result, so that it learns the words without a failed call.
A model can write "Sect Hall" for `sect_hall`, "furious" for `angry`, or `{"type": "say", "speaker": …}`. Only what
cannot be understood at all is refused, and the refusal lists the words it may use.

A call waits up to 20 minutes for the player. After that, or once the run is stopped, the call returns, and what the
player answers later goes to the agent as a message that starts its turn. A hero made in the panel goes to the agent
the same way, so the story starts without the player typing anything.

## Rules

- **Stats**: Body, Mind, Spirit and Fate, from 1 up. A check's chance is 50% when the stat equals the difficulty's
  value (trivial 0, easy 2, normal 4, hard 6, heroic 8, impossible 11), and 9% more or less for each point between
  them, held to 5..95%. The roll is 1..100, and low is good. A critical success is in the lowest tenth of the chance,
  and a critical failure is 96 and up.
- **Realms**: Mortal, Body Tempering 1–9, Qi Condensation 1–9, Foundation Establishment, Core Formation, Nascent Soul,
  Soul Transformation, Void Refinement (each early, middle and late), and Immortal Ascension. Cultivation fills to 100,
  and then a breakthrough can be attempted. Success raises the stage and refills vitality and qi. Failure costs a
  quarter of vitality and 30 cultivation.
- **Vitality and qi** grow with Body and Spirit and with the realm. A change never drops vitality below 1. A lost
  fight leaves the hero at 1, and the story decides what that means.
- **Foes** are as strong as the hero's level plus their rank (weak, equal, strong, boss). A boss has more than twice
  the vitality, and is harder to flee.

## Where it keeps things

Each chat's game is kept in the extension's own folder in the portal's data folder, one file per chat, which no agent
can write: the hero's numbers are the server's. The answer of a puzzle that waits is kept there too, and no page is
told it. A deleted chat's game goes with it.

## What it needs

- Pithagoras with its extension API 0.2, with pi running in the portal's own process (the host executor, as both of
  Pithagoras' Compose files run it). The mode and its tools are the server half's (`modes.provide`,
  `chats.extend`).
- A browser with canvas 2D and `ResizeObserver`: any current one.

It needs no container and no Docker.

## Installing

In the portal, Settings → Extensions → Discover → **Install by name**: `npm:@pithagoras/saga`. For development, build
the repository and install `saga/` by its path on the portal's machine.

## Developing

From the repository's root (see its README):

```sh
npm ci && npm run build
npm test -w saga
```

The unit tests cover the rules (checks, rolls, realms, changes), what a model writes and how it is read, fights,
puzzles and their checks, and the server half against a faked portal. That includes the mode, the tools being only in
its chats and the only ones there, the prompt, the hero made in the panel waking the agent, scenes waiting for and
returning choices with their rolls, answers that come late, puzzles, fights played through the routes, and the
routes refusing chats in other modes and writes from other pages. A test also checks that every text the panel shows
has its German.

### Adding a world

A world is a pack (`src/game/pack.ts`): its places (each a look: ridges, roughness, features such as pagodas, a lake
or lanterns, a tint), its realms, its stats' names, its origins and its words for vitality, qi and money. The stage,
the figures, the effects and the rules are the same for every pack. Xianxia (`src/game/xianxia.ts`) is the first.
