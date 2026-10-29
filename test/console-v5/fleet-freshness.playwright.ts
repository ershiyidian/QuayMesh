import { defineConfig } from '@playwright/test';
import experience from './experience.playwright.js';

export default defineConfig({
  ...experience,
  testMatch: 'fleet-freshness.browser.spec.ts',
  outputDir: '../../releases/console-experience/fleet-freshness',
});
