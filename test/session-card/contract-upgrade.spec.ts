import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('真实旧发行卡片读取新服务，启动和后续命令均不发生格式拒收', async ({page}) => {
  const legacyPath = process.env.QUAYMESH_TEST_LEGACY_CARD;
  test.skip(!legacyPath, '需要实际保留的旧发行卡片，不使用模拟压缩脚本');
  const html = await readFile(legacyPath!, 'utf8');
  expect(html).not.toContain('executionObservation');
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({response, json: {...data, resourceHtml: html}});
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('ready');
  const card = page.frameLocator('#app-frame');
  await expect(card.locator('#title')).not.toContainText('unrecognized_keys');
  await expect(card.locator('#stats')).toContainText('命令');
  const marker = 'legacy-card-command-' + Date.now();
  const result = await page.evaluate(value => window.__quaymeshHost.runCommand('cmd /c echo ' + value), marker);
  expect(result.isError).not.toBe(true);
  await card.locator('#toggle').click();
  await card.locator('#t-commands').click();
  await expect(card.locator('#p-commands')).toContainText(marker, {timeout: 25000});
  await expect(card.locator('#title')).not.toContainText('unrecognized_keys');
  expect(errors).toEqual([]);
});

test('新卡片遇到额外展示字段仍初始化，并保持真实工具通道', async ({page}) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.openResult._meta.quaymesh.snapshot.futureDisplayBadge = 'forward-compatible';
    await route.fulfill({response, json: data});
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('ready');
  const card = page.frameLocator('#app-frame');
  await expect(card.locator('#stats')).toContainText('命令');
  await expect(card.locator('#title')).not.toContainText('Unrecognized');
  expect(errors).toEqual([]);
});
