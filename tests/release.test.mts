/** The release workflows promise that "Re-run failed jobs" repeats a release. The GitHub release is made before the
 * package goes to npm, so a re-run after npm failed finds the release made already: its step has to go on, not fail. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKFLOWS = path.resolve(import.meta.dirname, "../.github/workflows");

/** The shell text of the step named "GitHub release" in a workflow file. */
function releaseStep(file: string): string {
  const lines = fs.readFileSync(path.join(WORKFLOWS, file), "utf8").split("\n");
  const at = lines.findIndex((l) => /^\s+- name: (The )?GitHub release\s*$/.test(l));
  assert.ok(at >= 0, `${file} has a GitHub release step`);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run + 1].match(/^\s*/)![0].length;
  const body: string[] = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === "" || lines[i].match(/^\s*/)![0].length >= indent); i++) body.push(lines[i].slice(indent));
  return body.join("\n");
}

/** Runs the step with a `gh` that says whether the release exists, and reports what was asked of it. It runs in a
 * folder with a sources/ folder, as the image releases have one. */
function runStep(script: string, exists: boolean): { exit: number; asked: string[] } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "release-step-"));
  try {
    const log = path.join(dir, "asked");
    fs.mkdirSync(path.join(dir, "work/sources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "work/sources/a.txt"), "x");
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/bash\necho "$1 $2" >> "${log}"\nif [ "$1 $2" = "release view" ]; then exit ${exists ? 0 : 1}; fi\nexit 0\n`, { mode: 0o755 });
    let exit = 0;
    try {
      execFileSync("bash", ["-e", "-c", script], { cwd: path.join(dir, "work"), env: { PATH: `${dir}:${process.env.PATH}`, TAG: "nextcloud-v1.2.3", VERSION: "1.2.3" }, stdio: "pipe" });
    } catch (error) {
      exit = (error as { status: number }).status;
    }
    return { exit, asked: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The workflows that attach the sources the GPL asks for: a re-run makes sure they are on the release. */
const WITH_SOURCES = ["blender-release.yml", "godot-release.yml"];

for (const file of ["nextcloud-release.yml", "office-release.yml", "inline-ui-release.yml", ...WITH_SOURCES]) {
  test(`${file}: a re-run finds the release made already and goes on; a first run makes it`, () => {
    const script = releaseStep(file);
    const again = runStep(script, true);
    assert.equal(again.exit, 0, "the step passes");
    assert.ok(!again.asked.includes("release create"), "and makes no second release");
    if (WITH_SOURCES.includes(file)) assert.ok(again.asked.includes("release upload"), "but makes sure the sources are on it");
    const first = runStep(script, false);
    assert.equal(first.exit, 0);
    assert.ok(first.asked.includes("release create"), "a tag without a release gets one");
  });
}
