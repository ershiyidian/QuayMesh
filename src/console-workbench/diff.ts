import { parsePatch } from "diff";
import { WorkbenchError } from "./types.js";

export interface DiffRow {
  type: "added" | "removed" | "context";
  old: number | null;
  new: number | null;
  text: string;
}

export function diffPage(patch: string, cursor = "0") {
  const rows: DiffRow[] = [];
  for (const file of parsePatch(patch)) for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const type = line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context";
      rows.push({ type, old: type === "added" ? null : oldLine++, new: type === "removed" ? null : newLine++, text: line.slice(1) });
    }
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw new WorkbenchError("差异游标无效", 400, "invalid_cursor");
  const page: DiffRow[] = [];
  let bytes = 0;
  for (let index = offset; index < rows.length && page.length < 400; index++) {
    const row = rows[index];
    const length = Buffer.byteLength(JSON.stringify(row), "utf8");
    // 分页保持完整代码行，避免把补丁片段当作完整补丁再次解析。
    if (page.length && bytes + length > 64 * 1024) break;
    page.push(row); bytes += length;
  }
  const next = offset + page.length;
  return { rows: page, totalRows: rows.length, nextCursor: next < rows.length ? String(next) : null };
}
