import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureStore } from "../src/store";

/**
 * Where the tests' documents live: every document is in an agent's home or a project's folder (store.createDoc puts
 * it there), so a test gives it one.
 */

/** A real folder for a test's documents, standing for an agent's home: `name` in the test's own data root. */
export function homeIn(root: string, name = "home"): string {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  return fs.realpathSync(home);
}

/**
 * For tests that name agents' and projects' folders that are not there ("/f/atlas"): a document made in one is put
 * into a folder of this process's own that stands for it (a folder that is there takes it itself), as the portal's
 * files.create would put it into the real one. `made` records each, with the folder it was made for.
 */
export function fakePlaces(): { made: { folder: string; name: string; file: string }[] } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "office-places-"));
  process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
  const made: { folder: string; name: string; file: string }[] = [];
  configureStore({
    place: (folder, name, bytes) => {
      const dir = fs.existsSync(folder) ? folder : path.join(base, folder);
      fs.mkdirSync(dir, { recursive: true });
      // A name taken by a document of an earlier test in the same stand-in is numbered, as the portal does.
      const file = path.join(dir, filesCreate(dir, ".", name, bytes));
      made.push({ folder, name, file });
      return file;
    },
  });
  return { made };
}

/** The portal's files.create, as the fake portals of the tests give it: `data` as a new file `name` in `base`/`rel`,
 * never over something there (a name that is taken gets a number, "name (2).ext"); its path, from `base`. */
export function filesCreate(base: string, rel: string, name: string, data: Buffer): string {
  const dot = name.lastIndexOf(".");
  for (let n = 1; ; n++) {
    const numbered = n < 2 ? name : dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    try {
      fs.writeFileSync(path.join(base, rel, numbered), data, { flag: "wx" });
      return path.join(rel, numbered);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
