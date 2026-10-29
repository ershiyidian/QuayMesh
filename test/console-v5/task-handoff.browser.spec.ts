import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRealTestServer, structured } from '../session-card/server-fixture.js';
import { openDatabase } from '../../src/db/client.js';
import { SessionStore } from '../../src/session/store.js';

test('the real goal-finish dialog offers only terminal outcomes and legacy HTTP handoff cannot close the goal', async ({ page }, testInfo) => {
  const server = await createRealTestServer({ prefix: 'qm-goal-finish-browser-', git: false, uiEnabled: true });
  const database = openDatabase(server.config.stateDir), store = new SessionStore(database.sqlite);
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await server.client.callTool({ name, arguments: args, _meta: { 'openai/session': 'goal-finish-browser' } });
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      return structured(reply);
    };
    const task = await call('start_session', { title: '跨入口继续的工作目标', request_key: 'goal' });
    const opened = await call('open_workspace', { path: server.project });
    await call('read', { workspace_id: opened.workspace_id, path: 'README.md' });
    const taskId = String(task.task_id), reference = encodeURIComponent('qmtask:' + taskId);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('quaymesh.workbench.v5', JSON.stringify({ poll: 0 })));
    await page.goto(server.baseUrl + '/console/');
    await page.locator('#login-form input[name=password]').fill(server.config.oauth.ownerToken!);
    const authenticated = page.waitForResponse(response => response.url() === server.baseUrl + '/console/api/login');
    await page.locator('#login-form [type=submit]').click();
    const login = await authenticated;
    expect(login.status()).toBe(200);
    const { csrf } = await login.json() as { csrf: string };
    for (const viewport of [{ width: 1400, height: 950 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(server.baseUrl + '/console/#/tasks?days=0&run=' + reference);
      await page.locator('[data-action=finish-task]').click();
      const dialog = page.getByRole('dialog', { name: '结束工作目标' });
      await expect(dialog).toContainText('结束工作目标');
      await expect(dialog).toContainText('换对话、交接或临时离开时，保持同一目标开放');
      expect(await dialog.locator('[name=result] option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['completed', 'failed', 'cancelled']);
      await expect(dialog.locator('[name=result]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`goal-finish-${viewport.width}.png`), fullPage: true });
      await dialog.locator('[data-dialog-close]').first().click();
      await expect(dialog).toHaveCount(0);
      expect(store.getTask(taskId).state).toBe('active');
    }
    const headers = { Origin: server.baseUrl, 'X-QuayMesh-CSRF': csrf };
    const local = await page.request.post(server.baseUrl + '/console/api/workbench/tasks/finish', { headers,
      data: { taskId, expectedTaskRevision: store.getTask(taskId).revision, messageSequence: 0,
        result: 'handed_off', summary: 'continue the same goal', requestKey: 'legacy-local-handoff' } });
    expect(local.status()).toBe(409);
    expect(await local.json()).toMatchObject({ code: 'TASK_HANDOFF_NOT_TERMINAL', effect: 'none' });
    const detail = await (await page.request.get(server.baseUrl + '/console/api/v4/runs/' + reference + '?fresh=1')).json();
    const outer = await page.request.post(server.baseUrl + '/console/api/v4/runs/' + reference + '/finish', { headers,
      data: { expectedRevision: detail.run.revision, expectedTaskRevision: store.getTask(taskId).revision,
        messageSequence: 0, result: 'handed_off', summary: 'continue the same goal', requestKey: 'legacy-routed-handoff' } });
    expect(outer.status()).toBe(409);
    expect(await outer.json()).toMatchObject({ code: 'TASK_HANDOFF_NOT_TERMINAL', effect: 'none' });
    expect(store.getTask(taskId).state).toBe('active');
    expect(store.taskData.finalization(taskId)).toBeNull();
    expect(errors).toEqual([]);
  } finally { database.close(); await server.dispose(); }
});
