import { defineConfig } from '@playwright/test';
import experience from './experience.playwright.js';

export default defineConfig({
  ...experience,
  testMatch: 'task-handoff.browser.spec.ts',
  timeout: 90_000,
  outputDir: '../../releases/console-experience/task-handoff',
});
