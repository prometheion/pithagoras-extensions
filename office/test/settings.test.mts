/**
 * Unit tests for src/settings.ts: defaults when missing, field-by-field merge of a partial file, corrupt JSON
 * -> defaults, and save round-trips that keep untouched fields. All roots are mkdtemp tmp dirs -- portal() is
 * never reached (every call passes an explicit root).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings, DEFAULT_SETTINGS, limitOk } from "../src/settings";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-settings-"));
}

test("loadSettings: missing file -> defaults", () => {
  const root = tmpRoot();
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
});

test("the default image is the full tag of the tested build, not one that moves to the next build", () => {
  assert.equal(DEFAULT_SETTINGS.imageTag, "onlyoffice/documentserver:10.0.0.1");
});

test("loadSettings: partial file merges field by field, unknown fields ignored", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: "some/other:9.9", nonsense: 42 }));
  assert.deepEqual(loadSettings(root), { ...DEFAULT_SETTINGS, enabled: true, imageTag: "some/other:9.9" });
});

test("loadSettings: a LEGACY file carrying the removed \"coEdit\" key loads without crashing and simply ignores it", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: "some/other:9.9", coEdit: true }));
  assert.deepEqual(loadSettings(root), { ...DEFAULT_SETTINGS, enabled: true, imageTag: "some/other:9.9" }, "legacy key tolerated and not surfaced");
  // and saving over the legacy file rewrites it clean (the removed key is dropped, never echoed back)
  const saved = saveSettings({ enabled: false }, root);
  assert.deepEqual(saved, { ...DEFAULT_SETTINGS, enabled: false, imageTag: "some/other:9.9" });
  assert.ok(!JSON.stringify(fs.readFileSync(path.join(root, "settings.json"), "utf8")).includes("coEdit"));
});

test("loadSettings: corrupt JSON -> defaults; non-object JSON -> defaults", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), "{ not json !");
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
});

test("loadSettings: wrong-type values fall back to the default for that field", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: "yes" }));
  const s = loadSettings(root);
  assert.equal(s.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(s.imageTag, DEFAULT_SETTINGS.imageTag);
});

test("saveSettings: round-trip keeps other fields and ignores unknown patch keys", () => {
  const root = tmpRoot();
  const first = saveSettings({ enabled: true }, root);
  assert.deepEqual(first, { ...DEFAULT_SETTINGS, enabled: true });
  // a later patch must not clobber the earlier one; keys outside OfficeSettings (incl. the legacy
  // "coEdit") are dropped at runtime and never persisted back
  const second = saveSettings({ imageTag: "pinned/x:2.0", bogusKey: "x" } as Partial<{ enabled: boolean; imageTag: string; coEdit?: boolean }>, root);
  assert.deepEqual(second, { ...DEFAULT_SETTINGS, enabled: true, imageTag: "pinned/x:2.0" });
  assert.deepEqual(loadSettings(root), second);
});

test("saveSettings: overwrites a corrupt file with clean defaults", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), "{{{");
  const s = saveSettings({ imageTag: "x/y:1.2" }, root);
  assert.equal(s.imageTag, "x/y:1.2");
  assert.equal(s.enabled, DEFAULT_SETTINGS.enabled);
});

test("saveSettings: only what the person set is stored, so a later version's default image reaches an install that switched Office on", () => {
  const root = tmpRoot();
  saveSettings({ enabled: true }, root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")), { enabled: true }, "the default tag is not written down");
  const before = DEFAULT_SETTINGS.imageTag;
  try {
    DEFAULT_SETTINGS.imageTag = "onlyoffice/documentserver:10.0.1.1"; // as a later version would have it
    assert.equal(loadSettings(root).imageTag, "onlyoffice/documentserver:10.0.1.1");
    saveSettings({ enabled: false }, root);
    assert.equal(loadSettings(root).imageTag, "onlyoffice/documentserver:10.0.1.1", "and saving again does not pin it either");
  } finally {
    DEFAULT_SETTINGS.imageTag = before;
  }
  // A tag the person chose stays theirs.
  saveSettings({ imageTag: "onlyoffice/documentserver:9.2.1.1" }, root);
  assert.equal(loadSettings(root).imageTag, "onlyoffice/documentserver:9.2.1.1");
});

test("loadSettings: the default an earlier version wrote down for everyone (:10.0) counts as not set, and is not written again", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: "onlyoffice/documentserver:10.0" }));
  assert.deepEqual(loadSettings(root), { ...DEFAULT_SETTINGS, enabled: true, imageTag: DEFAULT_SETTINGS.imageTag });
  saveSettings({ enabled: true }, root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")), { enabled: true });
});

test("the limits of comments and the editor's chat: defaults, kept when set, a value out of its bounds read as not set", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "office-settings-"));
  try {
    assert.deepEqual(saveSettings({ docchatRuns: 5, docchatChatEndS: 0 }, root), { ...DEFAULT_SETTINGS, docchatRuns: 5, docchatChatEndS: 0 });
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ docchatRuns: 0, docchatThreads: 3.5, docchatReplyChars: "x" }));
    assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS, "out of bounds: the defaults");
    assert.equal(limitOk("docchatRuns", 20), true);
    assert.equal(limitOk("docchatRuns", 21), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
