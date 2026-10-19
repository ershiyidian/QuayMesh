import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixture.js';

test('发现工具输出 schema 后，真实文件错误保留 isError，后续读取仍可恢复', {timeout: 30_000}, async t => {
  const f = await fixture(t, {git: false});
  const tools = await f.client.listTools();
  assert.ok(tools.tools.find(tool => tool.name === 'read')?.outputSchema);
  const result = await f.raw('read', {...f.scope, path: 'missing-for-error-contract.txt'});
  assert.equal(result.isError, true);
  assert.ok(result.content.some(item => item.type === 'text' && item.text.length > 0));
  const recovered = await f.raw('read', {...f.scope, path: 'README.md'});
  assert.notEqual(recovered.isError, true);
  assert.equal(typeof recovered.structuredContent?.result, 'string');
});
