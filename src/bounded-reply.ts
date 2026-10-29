import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolResultBytes } from "./mcp-tool-result.js";

export const REPLY_BYTES = 48 * 1024;
// Native MCP image blocks are binary media; the 48 KiB limit only applies to text/JSON.
export const IMAGE_BYTES = 8 * 1024 * 1024;

export function resultSummary(value: Record<string, unknown>): string {
  if (typeof value.error === "string") return value.error;
  if (Array.isArray(value.entries)) return `已返回 ${value.entries.length} 项；详细内容见结构化结果。`;
  if (value.unchanged === true) return "内容没有变化。";
  if (value.operation_id) return `操作 ${value.operation_id}${value.operation_state ? `：${value.operation_state}` : ""}。`;
  return "结果已返回，详细内容见结构化结果。";
}

export function jsonReply<T extends Record<string, unknown>>(value: T, summary = resultSummary(value)) {
  return {content:[{type:"text" as const,text:summary}],structuredContent:value};
}

// 旧 Worker 的展示说明迁入元数据，保持已声明的模型输出格式。
export function compatibleToolReceipt(reply: CallToolResult): CallToolResult {
  const body = reply.structuredContent;
  const error = body?.error;
  if (reply.isError && !body?.error_code && error && typeof error === 'object' && !Array.isArray(error)
    && (error as Record<string, unknown>).code === 'EXECUTION_CONFLICT') {
    const {structuredContent: _structuredContent, ...response} = reply;
    return {...response, _meta:{...reply._meta, quaymesh:{...quaymeshMetadata(reply), error}}};
  }
  if (body?.accepted !== true || typeof body.phase !== "string"
    || !["preparing", "dispatching", "running"].includes(body.phase)) return reply;
  const {phase, message: _message, ...structuredContent} = body;
  const quaymesh = quaymeshMetadata(reply);
  return {...reply, structuredContent, _meta: {...reply._meta, quaymesh: {...quaymesh, phase}}};
}

function quaymeshMetadata(reply: CallToolResult): Record<string, unknown> {
  const value = reply._meta?.quaymesh;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const replyBytes = (value: Record<string, unknown>) => toolResultBytes(jsonReply(value));

export interface TextPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCodePoints: number;
}

// 返回偏移使用 Unicode 码点，避免把一个字符分成两半。
export function textPage(text: string, offset = 0, budget = 12 * 1024,
  measure: (page: TextPage) => number = page => Buffer.byteLength(JSON.stringify(page.text))) {
  const points = Array.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length) throw new Error("Invalid response offset.");
  const page = (length: number): TextPage => ({ text: points.slice(offset, offset + length).join(""), offset,
    nextOffset: offset + length < points.length ? offset + length : null, totalCodePoints: points.length });
  let low = 0, high = Math.min(points.length - offset,budget);
  while (low < high) {
    const n = Math.ceil((low+high)/2);
    if (measure(page(n)) <= budget) low = n;
    else high = n-1;
  }
  return page(low);
}
