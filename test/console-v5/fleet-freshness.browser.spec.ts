import { test, expect, type Page } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRealTestServer, freePort, type RealTestServer } from '../session-card/server-fixture.js';

let server: RealTestServer;
let statusFile: string;
const previousToken = process.env.QUAYMESH_CLUSTER_TOKEN;
const screenshots = 'releases/console-experience';
const publicUrl = 'https://gemini.example/mcp';

function nodeStatus() {
  return {
    discovery: { ready: true, lastSuccessAt: Date.now(), lastError: null },
    publicMcp: { url: publicUrl, ready: true, state: 'ready', lastReadyAt: Date.now(),
      lastRequestAt: null as number | null, lastSuccessAt: null as number | null,
      lastStatus: null as number | null, lastError: null as string | null,
      lastTokenRequestAt: null as number | null, lastTokenSuccessAt: null as number | null,
      lastTokenFailureAt: null as number | null, lastTokenStatus: null as number | null,
      lastTokenError: null as string | null },
    components: [{ id: 'discovery', state: 'ready', observedAt: Date.now() },
      { id: 'public-mcp', state: 'ready', observedAt: Date.now() },
      { id: 'funnel', state: 'ready', observedAt: Date.now() }],
  };
}

test.beforeAll(async () => {
  process.env.QUAYMESH_CLUSTER_TOKEN = 'console-fleet-local-test-cluster-token';
  server = await createRealTestServer({
    git: false, uiEnabled: true,
    federation: {
      nodeId: 'fleet-test', nickname: '回归节点', priority: 100,
      capabilities: { coordinator: true, worker: true, discovery: true, egress: true,
        meshRelay: false, desktopUi: false, consoleRelay: false },
      port: await freePort(), ingressPort: await freePort(), peers: [],
    },
    configure: async config => {
      statusFile = join(config.stateDir, 'fleet-test-status.json');
      await writeFile(statusFile, JSON.stringify(nodeStatus()));
      return { ...config, federation: { ...config.federation, statusFile } };
    },
  });
  await mkdir(screenshots, { recursive: true });
});

test.afterAll(async () => {
  try { await server?.dispose(); }
  finally {
    if (previousToken === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN;
    else process.env.QUAYMESH_CLUSTER_TOKEN = previousToken;
  }
});

async function openMachines(page: Page) {
  await page.addInitScript(() => localStorage.setItem('quaymesh.workbench.v5', JSON.stringify({ poll: 0 })));
  await page.goto(server.baseUrl + '/console/');
  await page.locator('#login-form input[name=password]').fill(server.config.oauth.ownerToken!);
  const login = page.waitForResponse(response => response.url() === server.baseUrl + '/console/api/login');
  await page.locator('#login-form [type=submit]').click();
  expect((await login).status()).toBe(200);
  await expect(page.locator('.overview-summary')).toBeVisible();
  await page.locator('#sidebar [data-action=nav][data-view=machines]').click();
  await expect(page.locator('.node-card')).toHaveCount(1);
}

async function expectCurrent(page: Page) {
  await expect(page.locator('.page-head')).toContainText('1 / 1 在线');
  await expect(page.locator('.page-head')).not.toContainText('上次确认');
  await expect(page.locator('.node-card-head .state.online')).toHaveCount(1);
  await expect(page.locator('.discovery-node .badge.good')).toHaveText('就绪');
  await expect(page.locator('.public-mcp-node .badge.good')).toHaveText('隧道就绪');
  await expect(page.locator('.route-candidate.current .badge.good')).toHaveText('当前出网');
  await expect(page.locator('#statusbar [data-view=machines]')).toHaveText('1 / 1 节点在线');
}

async function expectHistorical(page: Page) {
  await expect(page.locator('.page-head')).toContainText('上次确认 1 / 1 在线');
  await expect(page.locator('.page-head')).toContainText('当前状态待确认');
  await expect(page.locator('.page-head')).toContainText('最后确认');
  await expect(page.locator('.node-card-head .badge').filter({ hasText: '上次确认在线' })).toHaveCount(1);
  await expect(page.locator('.node-card-head .state.online')).toHaveCount(0);
  await expect(page.locator('.discovery-node .badge.warn')).toHaveText('上次确认就绪');
  await expect(page.locator('.panel-head').filter({ hasText: 'OpenAI 发现端' }).locator('..')).toContainText('上次确认 1 / 1 就绪');
  await expect(page.locator('.discovery-node .badge.good')).toHaveCount(0);
  await expect(page.locator('.public-mcp-node .badge.warn')).toHaveText('上次确认 隧道就绪');
  await expect(page.locator('.public-mcp-node .badge.good')).toHaveCount(0);
  await expect(page.locator('.route-candidate .badge.warn')).toHaveText('上次出网');
  await expect(page.locator('.route-candidate.current')).toHaveCount(0);
  await expect(page.locator('#statusbar [data-view=machines]')).toHaveText('上次确认 1 / 1 节点在线');
  await expect(page.locator('#statusbar')).toContainText('上次出网');
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const isFleet = (url: URL) => url.pathname.endsWith('/api/v4/fleet/status');

test('真实机器快照在读取失败和重试期间标明历史，成功后恢复；普通刷新保持有效观测', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let mode: 'pass' | 'fail' | 'hold' = 'pass';
  let pending = gate(), started = gate();
  await page.route(isFleet, async route => {
    if (mode === 'fail') {
      await route.fulfill({ status: 502, json: { code: 'CONSOLE_REQUEST_FAILED', message: '节点 cloud 当前离线' } });
      return;
    }
    if (mode === 'hold') { started.release(); await pending.promise; }
    await route.continue();
  });
  await openMachines(page);
  await expectCurrent(page);

  // A normal background read is not evidence that the confirmed node is offline.
  mode = 'hold';
  await page.locator('#topbar [data-action=refresh]').click();
  await started.promise;
  try {
    await expectCurrent(page);
    await expect(page.locator('#global-notice')).not.toContainText('读取失败');
  } finally { mode = 'pass'; pending.release(); }
  await expect.poll(() => page.evaluate(() => (window as any).QuayMesh.getState().cache
    .find((entry: any) => entry.path === 'fleet/status')?.loading)).toBe(false);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const values = await page.locator('.node-resources .resource-value').allTextContents();

  mode = 'fail';
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('[data-key="resource-status-fleet/status"] .resource-update')).toContainText('更新失败');
  await expectHistorical(page);
  await expect(page.locator('.node-resources .resource-value')).toHaveText(values);
  await page.screenshot({ path: screenshots + '/fleet-read-failed.png', fullPage: true });

  await page.locator('[data-action=machine-layout][data-value=table]').click();
  await expect(page.locator('.matrix tbody tr .badge').filter({ hasText: '上次确认在线' })).toHaveCount(1);
  await expect(page.locator('.matrix .state.online')).toHaveCount(0);
  await page.locator('.matrix [data-action=node]').first().click();
  await expect(page.locator('dialog .badge').filter({ hasText: '上次确认在线' })).toHaveCount(1);
  await expect(page.locator('dialog .state.online')).toHaveCount(0);
  await page.locator('dialog [data-dialog-close]').first().click();
  await page.locator('#sidebar [data-action=nav][data-view=overview]').click();
  await expect(page.locator('.panel-head').filter({ hasText: '机器' })).toContainText('上次确认 1 / 1 在线');
  await page.locator('#sidebar [data-action=nav][data-view=machines]').click();
  await page.locator('[data-action=machine-layout][data-value=cards]').click();

  // Resources temporarily clears error at retry start. The failed observation
  // must stay historical until the new response succeeds, without a green flash.
  pending = gate(); started = gate(); mode = 'hold';
  await page.locator('#topbar [data-action=refresh]').click();
  await started.promise;
  try {
    await expectHistorical(page);
    await expect(page.locator('.node-resources .resource-value')).toHaveText(values);
    await page.screenshot({ path: screenshots + '/fleet-retry-pending.png', fullPage: true });
  } finally { mode = 'pass'; pending.release(); }
  await expectCurrent(page);
  await expect(page.locator('#global-notice')).not.toContainText('读取失败');
  await page.screenshot({ path: screenshots + '/fleet-read-recovered.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('手动模式下旧机器观测到期自动标记历史；新的成功读取不受服务器时钟差影响', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await openMachines(page);
  await expectCurrent(page);
  const values = await page.locator('.node-resources .resource-value').allTextContents();
  await page.clock.fastForward(30_001);
  await expectHistorical(page);
  await expect(page.locator('#global-notice')).not.toContainText('读取失败');
  await expect(page.locator('.node-resources .resource-value')).toHaveText(values);
  await page.locator('#topbar [data-action=refresh]').click();
  await expectCurrent(page);
});

test('Gemini 入口独立展示健康、真实请求和重连记录，节点离线时不显示绿色', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openMachines(page);
  await expectCurrent(page);
  const card = page.locator('.public-mcp-node');
  await expect(page.locator('.panel-head')).toContainText(['OpenAI 发现端', 'Gemini 公网入口', '连接与出网链路']);
  await expect(card.locator('.endpoint code')).toHaveText(publicUrl);
  await expect(card.locator('[data-public-mcp-time=request]')).toContainText('尚未收到请求');
  await expect(card.locator('[data-public-mcp-time=success]')).toContainText('尚无成功请求');
  await expect(card.locator('[data-public-mcp-time=health] time')).toHaveAttribute('datetime', /.+/);
  await expect(card.locator('[data-public-mcp-time=recovery]')).toHaveCount(0);
  const response = await page.request.get(server.baseUrl + '/console/api/v4/fleet/status');
  expect(response.status()).toBe(200);
  expect((await response.json()).nodes[0].publicMcp).toMatchObject({ url: publicUrl, ready: true,
    lastRequestAt: null, lastSuccessAt: null });

  const tokenFailureAt=Date.now()-1_000;
  const authorization=nodeStatus();
  Object.assign(authorization.publicMcp, { lastTokenRequestAt: tokenFailureAt,
    lastTokenSuccessAt: tokenFailureAt-60_000, lastTokenFailureAt: tokenFailureAt,
    lastTokenStatus: 400, lastTokenError: 'invalid_grant' });
  await writeFile(statusFile, JSON.stringify(authorization));
  await expect.poll(async () => {
    await page.locator('#topbar [data-action=refresh]').click();
    return card.locator('.badge.warn').textContent();
  }).toBe('授权续期失败');
  await expect(card.locator('.badge.good')).toHaveCount(0);
  await expect(card.locator('[data-public-mcp-time=authorization] time')).toHaveAttribute('datetime', new Date(tokenFailureAt).toISOString());
  await expect(card.locator('[data-public-mcp-auth-error]')).toContainText('invalid_grant');
  await expect(card.locator('[data-public-mcp-auth-error]')).toContainText('请在 Gemini 中重新连接 QuayMesh');
  const authResponse=await page.request.get(server.baseUrl + '/console/api/v4/fleet/status');
  expect((await authResponse.json()).nodes[0].publicMcp).toMatchObject({ ready: true,
    lastTokenRequestAt: tokenFailureAt, lastTokenFailureAt: tokenFailureAt,
    lastTokenStatus: 400, lastTokenError: 'invalid_grant' });
  await page.screenshot({ path: screenshots + '/fleet-gemini-authorization-failed.png', fullPage: true });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: screenshots + '/fleet-gemini-authorization-narrow.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1400, height: 950 });

  Object.assign(authorization.publicMcp, { lastTokenRequestAt: Date.now(),
    lastTokenSuccessAt: Date.now(), lastTokenStatus: 200, lastTokenError: null });
  await writeFile(statusFile, JSON.stringify(authorization));
  await expect.poll(async () => {
    await page.locator('#topbar [data-action=refresh]').click();
    return card.locator('.badge.good').count();
  }).toBe(1);
  await expect(card.locator('[data-public-mcp-auth-error]')).toHaveCount(0);
  await expect(card.locator('[data-public-mcp-time=authorization]')).toContainText('HTTP 200');

  const lastRequestAt = Date.now() - 5_000, lastSuccessAt = Date.now() - 60_000, lastRecoveryAt = Date.now() - 2_000;
  const degraded = nodeStatus();
  Object.assign(degraded.publicMcp, { ready: false, state: 'backoff', lastReadyAt: null,
    lastRequestAt, lastSuccessAt, lastStatus: 502, lastError: 'Tailscale 控制连接已断开' });
  Object.assign(degraded.components[2]!, { state: 'backoff', lastRecoveryAt,
    lastRecoveryReason: '控制连接未恢复，已重新连接当前出口' });
  await writeFile(statusFile, JSON.stringify(degraded));
  await expect.poll(async () => {
    await page.locator('#topbar [data-action=refresh]').click();
    return card.textContent();
  }).toContain('等待重连');
  await expect(card.locator('.badge.good')).toHaveCount(0);
  await expect(card.locator('[data-public-mcp-time=request] time')).toHaveAttribute('datetime', new Date(lastRequestAt).toISOString());
  await expect(card.locator('[data-public-mcp-time=success] time')).toHaveAttribute('datetime', new Date(lastSuccessAt).toISOString());
  await expect(card.locator('[data-public-mcp-time=recovery] time')).toHaveAttribute('datetime', new Date(lastRecoveryAt).toISOString());
  await expect(card).toContainText('控制连接未恢复，已重新连接当前出口');
  await expect(card).toContainText('HTTP 502');
  await expect(card).toContainText('Tailscale 控制连接已断开');
  await page.screenshot({ path: screenshots + '/fleet-gemini-reconnecting.png', fullPage: true });

  Object.assign(degraded.publicMcp, { ready: true, state: 'ready', lastReadyAt: Date.now(), lastError: null });
  Object.assign(degraded.components[2]!, { state: 'ready' });
  await writeFile(statusFile, JSON.stringify(degraded));
  await expect.poll(async () => {
    await page.locator('#topbar [data-action=refresh]').click();
    return card.locator('.badge.good').count();
  }).toBe(1);
  await expect(card.locator('[data-public-mcp-time=success] time')).toHaveAttribute('datetime', new Date(lastSuccessAt).toISOString());
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: screenshots + '/fleet-gemini-narrow.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.route(isFleet, async route => {
    const actual = await route.fetch(), snapshot = await actual.json();
    snapshot.nodes[0].online = false;
    snapshot.sources[0] = { ...snapshot.sources[0], online: false, state: 'offline', stale: true };
    await route.fulfill({ response: actual, json: snapshot });
  });
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(card).toContainText('节点离线');
  await expect(card.locator('.badge.good')).toHaveCount(0);
  await page.screenshot({ path: screenshots + '/fleet-gemini-offline.png', fullPage: true });
  expect(errors).toEqual([]);
});
