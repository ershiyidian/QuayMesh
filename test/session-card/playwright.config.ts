import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: ["browser.spec.ts", "reliability-card.spec.ts", "preview.spec.ts", "lifecycle-card.spec.ts", "activity-card.spec.ts", "task-messages-card.spec.ts", "task-resume-card.spec.ts", "contract-upgrade.spec.ts", "historical-card.spec.ts"],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  outputDir: "../../releases/session-acceptance/browser",
  use: {
    baseURL: "http://127.0.0.1:4179",
    headless: true,
    ...(process.env.QUAYMESH_BROWSER_EXECUTABLE ? {launchOptions:{executablePath:process.env.QUAYMESH_BROWSER_EXECUTABLE}} : {}),
    ...(process.env.QUAYMESH_BROWSER_CHANNEL ? {channel:process.env.QUAYMESH_BROWSER_CHANNEL} : {}),
    viewport: { width: 980, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `"${process.execPath}" --import tsx test/session-card/host.ts`,
    cwd:fileURLToPath(new URL("../..",import.meta.url)),
    url: "http://127.0.0.1:4179/api/state",
    reuseExistingServer: false,
    timeout: 45_000,
  },
});
