import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { WORKSPACE_APP_VERSION } from '../../src/session/card-contract.js';

for (const legacy of [
  { env: 'QUAYMESH_TEST_LEGACY_CARD', version: undefined, name: '真实旧发行卡片' },
  { env: 'QUAYMESH_TEST_LEGACY_V9_CARD', version: 'task-card-v9', name: '真实已发布的旧 v9 卡片' },
]) test(`${legacy.name}读取新服务，命令和文件差异均不发生格式拒收`, async ({page}) => {
  const legacyPath = process.env[legacy.env];
  test.skip(!legacyPath, '需要实际保留的旧发行卡片，不使用模拟压缩脚本');
  const html = await readFile(legacyPath!, 'utf8');
  expect(html.includes(WORKSPACE_APP_VERSION),'必须使用升级前实际保留的 HTML').toBe(false);
  expect(html.includes('file_recorded_at'),'旧 HTML 尚不支持显式文件时间协商').toBe(false);
  const versions=[...new Set(html.match(/task-card-v\d+/g)??[])];
  expect(versions.length).toBeGreaterThan(0);
  if (legacy.version) expect(versions).toContain(legacy.version);
  await test.info().attach('legacy-card-provenance',{contentType:'application/json',body:JSON.stringify({path:legacyPath,
    sha256:createHash('sha256').update(html).digest('hex'),versions})});
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
  const result = await page.evaluate(command => window.__quaymeshHost.runCommand(command), process.platform==='win32'?'cmd /c echo '+marker:"printf '%s\\n' "+marker);
  expect(result.isError).not.toBe(true);
  await card.locator('#toggle').click();
  await card.locator('#t-commands').click();
  await expect(card.locator('#p-commands')).toContainText(marker, {timeout: 25000});
  const file = `legacy-diff-${Date.now()}.txt`;
  const patch = ['*** Begin Patch', `*** Add File: ${file}`, '+legacy diff evidence', '*** End Patch'].join('\n');
  const changed = await page.evaluate(text => window.__quaymeshHost.runPatch(text), patch);
  expect(changed.isError, JSON.stringify(changed)).not.toBe(true);
  await card.locator('#t-changes').click();
  const row = card.locator('[data-x^="f:"]', {hasText: file}).first();
  await expect(row).toBeVisible({timeout: 25000});
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  // The old renderer displays the addition marker in its diff gutter, separately
  // from the line text. Assert the rendered evidence without coupling it to that markup.
  await expect(card.locator('#p-changes')).toContainText('legacy diff evidence', {timeout: 25000});
  await expect(row).toHaveAttribute('aria-expanded', 'true');
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
