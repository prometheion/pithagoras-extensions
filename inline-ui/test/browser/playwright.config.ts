import { defineConfig } from "@playwright/test";

/** The card in a browser, in Chromium and in Firefox: test/browser/card.spec.mts. */
export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.mts$/,
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  outputDir: "../../test-results",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
