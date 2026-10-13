import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_TAIL_BYTES = 64 * 1024;
const MAX_LOG_FILES = 256;

export function appendOutputTail(previous: string, next: string): string {
  const bytes = Buffer.from(previous + next, "utf8");
  let start = Math.max(0, bytes.length - MAX_TAIL_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

function directory(stateDir: string): string { return join(stateDir, "logs", "processes"); }
function filename(operationId: string): string {
  if (!/^op_[A-Za-z0-9_-]+$/.test(operationId)) throw new Error("Invalid managed operation identifier.");
  return `${operationId}.log`;
}

function redactCredentialFields(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key omitted]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[credential omitted]")
    .replace(/(["']?(?:[A-Za-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[credential omitted]");
}

export function saveOutputTail(stateDir: string, operationId: string, tail: string): void {
  const root = directory(stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, filename(operationId));
  const isNew = !existsSync(path);
  const temporary = `${path}.pending`;
  writeFileSync(temporary, appendOutputTail("", redactCredentialFields(tail)), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  if (!isNew) return;
  // 保留最近的受管命令尾部，总量最多约 16 MiB。
  const files = readdirSync(root).filter(name => /^op_[A-Za-z0-9_-]+\.log$/.test(name))
    .map(name => ({ name, time: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const file of files.slice(MAX_LOG_FILES)) unlinkSync(join(root, file.name));
}

export function readOutputTail(stateDir: string, operationId: string): string | undefined {
  try { return readFileSync(join(directory(stateDir), filename(operationId)), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
