import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ToolAnnotation = Partial<Record<"readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint", boolean>>;
export type ToolAnnotationDocument = Record<string, ToolAnnotation>;

export function toolAnnotationsPath(stateDir: string): string {
  return join(stateDir, "tool-annotations.json");
}

// 由单个文件决定对外公布的工具标识；无额外缓存，新的 MCP 请求直接看到修改。
export function readToolAnnotations(stateDir: string): ToolAnnotationDocument {
  try {
    return JSON.parse(readFileSync(toolAnnotationsPath(stateDir), "utf8")) as ToolAnnotationDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeToolAnnotations(stateDir: string, document: ToolAnnotationDocument): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const destination = toolAnnotationsPath(stateDir);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", "utf8");
  await rename(temporary, destination);
}
