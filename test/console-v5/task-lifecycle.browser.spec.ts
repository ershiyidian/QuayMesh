import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { taskLifecycleFixture, recordDelayedBackground } from './task-lifecycle-fixture.js';

let f: Awaited<ReturnType<typeof taskLifecycleFixture>>;
const screenshots = 'releases/console-task-lifecycle';
test.beforeAll(async () => { f = await taskLifecycleFixture(); await mkdir(screenshots, { recursive: true }); });
test.afterAll(async () => { await f?.server.dispose(); });
test.beforeEach(async () => { await recordDelayedBackground(f); });

async function login(page: Page) {
  await page.goto(f.server.baseUrl + '/console/');
  await page.locator('#login-form input[name=password]').fill(f.server.config.oauth.ownerToken!);
  const sent = page.waitForResponse(response => response.url() === f.server.baseUrl + '/console/api/login');
  await page.locator('#login-form [type=submit]').click();
  const reply = await sent;
  expect(reply.status(), await reply.text()).toBe(200);
  await expect(page.locator('#login-form')).toHaveCount(0);
  await expect(page.locator('.summary-grid')).toBeVisible();
}
const scope = (page: Page, value: string) => page.locator(`[data-action=task-scope][data-value="${value}"]`);

test('lifecycle scopes drive real requests, survive pagination and keep execution separate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.goto(f.server.baseUrl + '/console/#/tasks?days=7&limit=1');
  await scope(page, 'open').click();
  await expect(page).toHaveURL(/requestState=active/);
  await expect(scope(page, 'open').locator('.count')).toHaveText('2');
  await expect(scope(page, 'ended').locator('.count')).toHaveText('2');
  await expect(page.locator('.task-state .state').first()).toHaveText('任务进行中');
  await expect(page.locator('.run-table')).toContainText('等待下一步的工作');
  await expect(page.locator('.task-state')).toContainText('当前无后台执行');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.run-table')).toContainText('试验失败但工作目标仍开放');
  await expect(page.locator('.task-state .state').first()).toHaveText('任务进行中');
  await expect(page.locator('.task-state')).toContainText('最近执行失败');
  await page.screenshot({ path: screenshots + '/open-failed-desktop.png', fullPage: true });

  const closedRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/v4/runs') && url.searchParams.get('requestState') === 'closed';
  });
  await scope(page, 'ended').click();
  expect((await closedRead).status()).toBe(200);
  expect(new URLSearchParams(page.url().split('?')[1]).has('cursor')).toBe(false);
  await expect(scope(page, 'open').locator('.count')).toHaveText('2');
  await expect(scope(page, 'ended').locator('.count')).toHaveText('2');
  await scope(page, 'active').click();
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.run-table')).toContainText('已经完成的改动');
  await expect(page.locator('.task-state .state').first()).toHaveText('已完成');
  await expect(page.locator('.task-state')).toContainText('后台仍在执行');
  expect(new URLSearchParams(page.url().split('?')[1]).has('requestState')).toBe(false);
  expect(errors).toEqual([]);
});

test('Task lifecycle is readable in the inspector and at a narrow viewport', async ({ page }) => {
  await login(page);
  await page.goto(f.server.baseUrl + '/console/#/tasks?days=7&requestState=active');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(2);
  const failed = page.locator('.run-table tbody tr', { hasText: '试验失败但工作目标仍开放' });
  await failed.locator('[data-action=open-run]').first().click();
  await expect(page.getByLabel('任务生命周期', { exact: true })).toHaveValue('active');
  await expect(page.locator('.result-heading .state').first()).toHaveText('任务进行中');
  await expect(page.locator('.result-heading')).toContainText('最近执行失败');
  await expect(page.locator('.card-footer-state .state').first()).toHaveText('任务进行中');
  await page.getByLabel('任务生命周期', { exact: true }).selectOption('closed');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.run-table')).not.toContainText('试验失败但工作目标仍开放');
  // Selecting another list scope does not retarget the already-open inspector.
  await expect(page.locator('.result-heading .state').first()).toHaveText('任务进行中');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots + '/open-failed-inspector-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const labels = page.locator('.result-heading .state, .card-footer-state .state');
  for (const label of await labels.all()) {
    const box = await label.boundingBox();
    expect(box?.width).toBeGreaterThan(50);
    expect(box?.height).toBeLessThan(30);
  }
  await page.goto(f.server.baseUrl + '/console/#/tasks?days=7&requestState=active');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.task-state .state')).toHaveText(['任务进行中', '任务进行中']);
  await page.screenshot({ path: screenshots + '/open-tasks-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
