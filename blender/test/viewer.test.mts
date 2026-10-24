import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

/** The viewer page's own code, what of it runs without a browser: its look at the server's state, every second. */

const viewer = fs.readFileSync(new URL("../src/viewer.html", import.meta.url), "utf8");

/** The page's poll(), with stand-ins for the elements and helpers of the page it reaches, and `fetch` as a test says. */
function page(fetch: () => Promise<unknown>) {
  const start = viewer.indexOf("async function poll()");
  const end = viewer.indexOf("\nsetInterval(poll", start);
  const elements = new Map<string, { hidden: boolean; className: string; textContent: string }>();
  const $ = (id: string) => elements.get(id) ?? elements.set(id, { hidden: false, className: "", textContent: "" }).get(id)!;
  const poll = new Function("$", "fetch", "tr", "connected", "notConnected", `${viewer.slice(start, end)}\nreturn poll;`)($, fetch, (key: string) => key, true, () => {});
  return { poll: poll as () => Promise<void>, $ };
}

test("while the server's state cannot be had, the view does not go on saying what Blender is busy with", async () => {
  // Blender is not answering: the portal's proxy says so in text, which is no JSON.
  const view = page(async () => ({ status: 502, json: async () => JSON.parse("Bad Gateway") }));
  view.$("busyNote").hidden = false;   // as the poll before left it, while Blender was busy
  await view.poll();
  assert.equal(view.$("pilltext").textContent, "disconnected");
  assert.equal(view.$("busyNote").hidden, true);
});
