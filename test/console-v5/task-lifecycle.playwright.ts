import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: '.', testMatch: 'task-lifecycle.browser.spec.ts', workers: 1,
  fullyParallel: false, retries: 0, timeout: 90_000, expect: { timeout: 15_000 },
  outputDir: '../../releases/console-task-lifecycle/browser',
  use: { headless: true, viewport: { width: 1400, height: 950 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    ...(process.env.QUAYMESH_BROWSER_EXECUTABLE ? { launchOptions: { executablePath: process.env.QUAYMESH_BROWSER_EXECUTABLE } } : {}) } });
