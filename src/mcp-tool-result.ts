type ResultRecord = Record<string, unknown>;
const TEXT_NOTES = "_quaymesh_text_notes";
const TEXT_MIRROR = "quaymesh/structured-text";

function record(value: unknown): ResultRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ResultRecord : undefined;
}

/** 单个 JSON 文本块兼容只取首段、末段或合并文本的 MCP 宿主。 */
export function toolResultForTextClients<T>(result: T): T {
  const envelope = record(result);
  if (!envelope || envelope.structuredContent === undefined || !Array.isArray(envelope.content)) return result;

  const serialized = JSON.stringify(envelope.structuredContent);
  const structured = record(envelope.structuredContent);
  const textBody = structured ?? { structuredContent: envelope.structuredContent };
  let notesKey = TEXT_NOTES;
  for (let suffix = 2; Object.hasOwn(textBody, notesKey); suffix++) notesKey = `${TEXT_NOTES}_${suffix}`;
  const values = typeof envelope.structuredContent === "string"
    ? [envelope.structuredContent] : Object.values(structured ?? {});
  const notes = new Set<string>();
  const content: unknown[] = [];
  let mirrored: ResultRecord | undefined;
  const remember = (text: string) => { if (!values.includes(text)) notes.add(text); };
  for (const item of envelope.content) {
    const block = record(item);
    if (block?.type !== "text" || typeof block.text !== "string") { content.push(item); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(block.text); } catch { /* 普通说明原样放入 notes。 */ }
    const priorNotesKey = record(block._meta)?.[TEXT_MIRROR];
    if (typeof priorNotesKey === "string" && parsed !== undefined) {
      // 路由层可改写 workspace_id；旧镜像正文不能作为独有说明再复制。
      const priorNotes = record(parsed)?.[priorNotesKey];
      if (Array.isArray(priorNotes) && priorNotes.every(value => typeof value === "string")) priorNotes.forEach(remember);
      mirrored ??= block;
      continue;
    }
    if (block.text === serialized || parsed !== undefined && JSON.stringify(parsed) === serialized) continue;
    const parsedBody = record(parsed);
    const parsedNotes = parsedBody?.[notesKey];
    if (parsedBody && Array.isArray(parsedNotes) && parsedNotes.every(value => typeof value === "string")) {
      const { [notesKey]: priorNotes, ...body } = parsedBody;
      if (JSON.stringify(body) === JSON.stringify(textBody)) {
        (priorNotes as string[]).forEach(remember);
        continue;
      }
    }
    remember(block.text);
  }
  const text = notes.size ? JSON.stringify({ ...textBody, [notesKey]: [...notes] }) : serialized;
  return { ...envelope, content: [{ ...mirrored, type: "text", text,
    _meta: { ...record(mirrored?._meta), [TEXT_MIRROR]: notesKey } }, ...content] } as T;
}

export function toolResultBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(toolResultForTextClients(result)), "utf8");
}
