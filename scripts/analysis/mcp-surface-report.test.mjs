import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSurfaces, jsonBytes, summarizeSurface, toolVisibility } from './mcp-surface-report.mjs';

const tool = (name, visibility) => ({ name, description: 'Read the explicit Task without changing its selected execution target.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } },
  ...(visibility ? { _meta: { ui: { visibility } } } : {}) });

test('model plus app tools are included; only app-only tools are removed', () => {
  const pages = [{ tools: [tool('default'), tool('resume', ['model', 'app']), tool('messages-ui', ['app']), tool('model', ['model'])] }];
  const report = summarizeSurface(pages, '');
  assert.equal(report.tools.raw_count, 4);
  assert.deepEqual(report.tools.model_visible_names, ['default', 'model', 'resume']);
  assert.equal(report.tools.app_only_count, 1);
  assert.deepEqual(report.tools.old_measurement_filter_omitted_names, ['resume']);
  assert.equal(report.tools.old_measurement_filter_count, 2);
  assert.deepEqual(toolVisibility(tool('hidden', [])), { model: false, app: false, explicit: true });
});

test('UTF-8 and JSON bytes include multibyte text, escaping and complete output schemas', () => {
  const value = { ...tool('unicode'), description: '中文\n"quoted"',
    outputSchema: { type: 'object', properties: { reply: { type: 'string', description: '保存的完整回复' } } } };
  const report = summarizeSurface([{ tools: [value] }], '中文→Task');
  assert.equal(report.tools.model_tools_envelope_json_utf8_bytes, Buffer.byteLength(JSON.stringify({ tools: [value] })));
  assert.equal(report.tools.parts[0].description_utf8_bytes, Buffer.byteLength(value.description));
  assert.equal(report.tools.parts[0].description_json_utf8_bytes, Buffer.byteLength(JSON.stringify(value.description)));
  assert.equal(report.tools.parts[0].output_schema_json_utf8_bytes, jsonBytes(value.outputSchema));
  assert.equal(report.initialization.instructions_utf8_bytes, 13);
  assert.equal(report.initialization.instructions_unicode_code_points, 7);
});

test('duplicates retain exact field paths and are not claimed as guaranteed savings', () => {
  const phrase = 'Reuse the same operation key after an uncertain response.';
  const report = summarizeSurface([{ tools: [{ ...tool('a'), description: phrase }, { ...tool('b'), description: phrase }] }], phrase);
  const repeated = report.repetition.exact_descriptions[0];
  assert.equal(repeated.occurrences, 3);
  assert.deepEqual(repeated.paths, ['initialize.instructions', 'tools.a.description', 'tools.b.description']);
  assert.equal(repeated.repeated_utf8_bytes, 2 * Buffer.byteLength(phrase));
  assert.match(report.repetition.note, /not proven removable/);
});

test('page collection detects duplicate names and visibility is validated explicitly', () => {
  assert.throws(() => summarizeSurface([{ tools: [tool('same')] }, { tools: [tool('same')] }], ''), /DUPLICATE_TOOL_NAME/);
  assert.throws(() => toolVisibility(tool('bad', ['other'])), /INVALID_TOOL_VISIBILITY/);
  assert.throws(() => toolVisibility(tool('bad', 'app')), /INVALID_TOOL_VISIBILITY/);
});

test('comparison distinguishes added tools from changed definitions and ignores only declared temporary origins', () => {
  const before = summarizeSurface([{ tools: [{ ...tool('same'), _meta: { endpoint: 'http://127.0.0.1:12345' } }, tool('removed')] }], 'before',
    [['http://127.0.0.1:12345', '<fixture-origin>']]);
  const after = summarizeSurface([{ tools: [{ ...tool('same'), _meta: { endpoint: 'http://127.0.0.1:54321' } }, tool('new')] }], 'after',
    [['http://127.0.0.1:54321', '<fixture-origin>']]);
  const comparison = compareSurfaces(before, after);
  assert.deepEqual(comparison.added, ['new']);
  assert.deepEqual(comparison.removed, ['removed']);
  assert.deepEqual(comparison.changed, []);
  assert.equal(comparison.instructions_utf8_bytes_delta, -1);
});
