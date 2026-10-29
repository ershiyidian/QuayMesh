import { createHash } from 'node:crypto';

export const jsonBytes = value => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
const textBytes = value => Buffer.byteLength(value, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

export function toolVisibility(tool) {
  const visibility = tool._meta?.ui?.visibility;
  if (visibility === undefined) return { model: true, app: true, explicit: false };
  if (!Array.isArray(visibility) || visibility.some(value => value !== 'model' && value !== 'app'))
    throw new Error('INVALID_TOOL_VISIBILITY');
  return { model: visibility.includes('model'), app: visibility.includes('app'), explicit: true };
}

function descriptions(tools, instructions) {
  const values = instructions ? [{ path: 'initialize.instructions', tool: null, text: instructions }] : [];
  function visit(value, path, tool) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.description === 'string' && value.description.trim())
      values.push({ path: path + '.description', tool, text: value.description });
    for (const [key, child] of Object.entries(value)) if (key !== 'description') visit(child, path + '.' + key, tool);
  }
  for (const tool of tools) visit(tool, 'tools.' + tool.name, tool.name);
  return values;
}

function repeated(values, split) {
  const occurrences = new Map();
  for (const value of values) for (const part of split(value.text)) {
    const text = part.trim().replace(/\s+/gu, ' ');
    if (textBytes(text) < 32) continue;
    const entries = occurrences.get(text) ?? [];
    entries.push({ path: value.path, tool: value.tool });
    occurrences.set(text, entries);
  }
  return [...occurrences].filter(([, entries]) => entries.length > 1).map(([text, entries]) => ({
    text, utf8_bytes: textBytes(text), occurrences: entries.length,
    repeated_utf8_bytes: textBytes(text) * (entries.length - 1),
    paths: sorted(new Set(entries.map(entry => entry.path))),
    tools: sorted(new Set(entries.flatMap(entry => entry.tool ? [entry.tool] : []))),
  })).sort((a, b) => b.repeated_utf8_bytes - a.repeated_utf8_bytes || a.text.localeCompare(b.text)).slice(0, 20);
}

export function summarizeSurface(pages, instructions, replacements = []) {
  const all = pages.flatMap(page => page.tools).sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(all.map(tool => tool.name)).size !== all.length) throw new Error('DUPLICATE_TOOL_NAME');
  const model = all.filter(tool => toolVisibility(tool).model);
  const normalize = text => replacements.reduce((value, [from, to]) => value.replaceAll(from, to), text);
  const parts = model.map(tool => ({
    name: tool.name,
    definition_json_utf8_bytes: jsonBytes(tool),
    description_utf8_bytes: textBytes(tool.description ?? ''),
    description_json_utf8_bytes: jsonBytes(tool.description),
    input_schema_json_utf8_bytes: jsonBytes(tool.inputSchema),
    output_schema_json_utf8_bytes: jsonBytes(tool.outputSchema),
    annotations_json_utf8_bytes: jsonBytes(tool.annotations), metadata_json_utf8_bytes: jsonBytes(tool._meta),
    definition_sha256: hash(JSON.stringify(tool)),
    normalized_definition_sha256: hash(normalize(JSON.stringify(tool))),
  })).sort((a, b) => b.definition_json_utf8_bytes - a.definition_json_utf8_bytes || a.name.localeCompare(b.name));
  const visibleBoth = all.filter(tool => { const v = toolVisibility(tool); return v.explicit && v.model && v.app; });
  const docs = descriptions(model, instructions), sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
  return {
    tools: {
      raw_count: all.length, model_visible_count: model.length,
      app_only_count: all.filter(tool => { const v = toolVisibility(tool); return v.app && !v.model; }).length,
      model_visible_names: sorted(model.map(tool => tool.name)),
      explicit_model_and_app_names: sorted(visibleBoth.map(tool => tool.name)),
      old_measurement_filter_omitted_names: sorted(visibleBoth.map(tool => tool.name)),
      old_measurement_filter_count: all.filter(tool => !tool._meta?.ui?.visibility?.includes('app')).length,
      list_pages: pages.length,
      sdk_decoded_page_json_utf8_bytes: pages.map(jsonBytes),
      raw_tools_envelope_json_utf8_bytes: jsonBytes({ tools: all }),
      model_tools_envelope_json_utf8_bytes: jsonBytes({ tools: model }),
      definitions_json_utf8_bytes_sum: parts.reduce((sum, part) => sum + part.definition_json_utf8_bytes, 0),
      parts,
    },
    initialization: {
      instructions_utf8_bytes: textBytes(instructions),
      instructions_json_utf8_bytes: jsonBytes(instructions),
      instructions_unicode_code_points: [...instructions].length,
      instructions_sha256: hash(instructions),
    },
    repetition: {
      analyzed_description_fields: docs.length,
      exact_descriptions: repeated(docs, text => [text]),
      exact_sentences: repeated(docs, text => [...sentences.segment(text)].map(part => part.segment)),
      note: 'Exact normalized repetitions are inspection candidates, not proven removable bytes. The two tables overlap; do not add them together.',
    },
    definitions: { tools: model },
  };
}

export function compareSurfaces(control, candidate) {
  const before = new Map(control.tools.parts.map(tool => [tool.name, tool]));
  const after = new Map(candidate.tools.parts.map(tool => [tool.name, tool]));
  return {
    model_visible_count_delta: candidate.tools.model_visible_count - control.tools.model_visible_count,
    model_tools_envelope_json_utf8_bytes_delta: candidate.tools.model_tools_envelope_json_utf8_bytes - control.tools.model_tools_envelope_json_utf8_bytes,
    instructions_utf8_bytes_delta: candidate.initialization.instructions_utf8_bytes - control.initialization.instructions_utf8_bytes,
    added: sorted([...after.keys()].filter(name => !before.has(name))),
    removed: sorted([...before.keys()].filter(name => !after.has(name))),
    changed: [...after].flatMap(([name, current]) => {
      const previous = before.get(name);
      return previous && previous.normalized_definition_sha256 !== current.normalized_definition_sha256
        ? [{ name, definition_json_utf8_bytes_delta: current.definition_json_utf8_bytes - previous.definition_json_utf8_bytes,
          before: previous.definition_json_utf8_bytes, after: current.definition_json_utf8_bytes }] : [];
    }).sort((a, b) => Math.abs(b.definition_json_utf8_bytes_delta) - Math.abs(a.definition_json_utf8_bytes_delta)),
  };
}
