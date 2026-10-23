import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'experience.browser.spec.ts',workers:1,fullyParallel:false,retries:0,
  timeout:60000,expect:{timeout:10000},outputDir:'../../releases/console-experience/browser',
  use:{headless:true,viewport:{width:1400,height:950},trace:'retain-on-failure',screenshot:'only-on-failure',
    ...(process.env.QUAYMESH_BROWSER_EXECUTABLE?{launchOptions:{executablePath:process.env.QUAYMESH_BROWSER_EXECUTABLE}}:{})}});
