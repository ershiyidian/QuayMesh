type ResultRecord = Record<string, unknown>;

function record(value: unknown): ResultRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ResultRecord : undefined;
}

/** 在最终 MCP 出口镜像结构化结果，兼容只读取文本块的客户端。 */
export function toolResultForTextClients<T>(result: T): T {
  const envelope = record(result);
  if (!envelope || envelope.structuredContent === undefined || !Array.isArray(envelope.content)) return result;

  const serialized = JSON.stringify(envelope.structuredContent);
  const values = typeof envelope.structuredContent === "string"
    ? [envelope.structuredContent] : Object.values(record(envelope.structuredContent) ?? {});
  let mirrored: unknown;
  const content = envelope.content.filter((item: unknown) => {
    const block = record(item);
    if (block?.type !== "text" || typeof block.text !== "string") return true;
    if (block.text === serialized) {
      mirrored ??= item;
      return false;
    }
    // 保留独有说明和错误原文；结构化结果已有的正文无需再复制一份。
    if (values.includes(block.text)) return false;
    if (/^[\[{]/u.test(block.text.trim())) {
      try { if (JSON.stringify(JSON.parse(block.text)) === serialized) return false; }
      catch { /* 普通文本也可能以括号开头。 */ }
    }
    return true;
  });
  return { ...envelope, content: [mirrored ?? { type: "text", text: serialized }, ...content] } as T;
}

export function toolResultBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(toolResultForTextClients(result)), "utf8");
}
