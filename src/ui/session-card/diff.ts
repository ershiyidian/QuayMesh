import { parsePatch } from "diff";

export type DiffRowKind = "header" | "context" | "add" | "delete" | "note" | "fold";

export interface DiffRow {
  kind: DiffRowKind;
  oldLine?: number;
  newLine?: number;
  text: string;
  rows?: DiffRow[];
}

export function parseFilePatch(patchText: string): DiffRow[] {
  const documents = parsePatch(patchText);
  const rows: DiffRow[] = [];
  for (const document of documents) {
    for (const hunk of document.hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const context: DiffRow[] = [];
      const flushContext = () => {
        if (context.length > 7) {
          rows.push(...context.slice(0, 3));
          rows.push({
            kind: "fold",
            text: `Show ${context.length - 6} unchanged lines`,
            rows: context.slice(3, -3),
          });
          rows.push(...context.slice(-3));
        } else {
          rows.push(...context);
        }
        context.length = 0;
      };

      rows.push({ kind: "header", text: hunkHeader(hunk) });
      for (const rawLine of hunk.lines) {
        const prefix = rawLine.slice(0, 1);
        const text = rawLine.slice(1);
        if (prefix === " ") {
          context.push({ kind: "context", oldLine, newLine, text });
          oldLine += 1;
          newLine += 1;
          continue;
        }
        flushContext();
        if (prefix === "+") {
          rows.push({ kind: "add", newLine, text });
          newLine += 1;
          continue;
        }
        if (prefix === "-") {
          rows.push({ kind: "delete", oldLine, text });
          oldLine += 1;
          continue;
        }
        if (prefix === "\\") {
          rows.push({ kind: "note", text: rawLine });
          continue;
        }
        throw new Error(`UNSUPPORTED_PATCH_LINE: ${prefix}`);
      }
      flushContext();
    }
  }
  return rows;
}

export function expandFolder(rows: DiffRow[], index: number): DiffRow[] {
  const row = rows[index];
  if (!row || row.kind !== "fold" || !row.rows) {
    throw new Error("DIFF_FOLD_ROW_REQUIRED");
  }
  return [...rows.slice(0, index), ...row.rows, ...rows.slice(index + 1)];
}

export function escapeCode(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

const TOKEN_PATTERN = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|`[^`]*`)|\b(import|from|export|const|let|return|async|await|function|if|else|new|throw|class|private|type|extends|null|this|describe|it|expect)\b|\b([A-Z][A-Za-z0-9]+)\b/g;

export function highlightCode(value: string): string {
  let output = "";
  let previous = 0;
  value.replace(
    TOKEN_PATTERN,
    (match: string, comment?: string, string?: string, keyword?: string, type?: string, offset?: number) => {
      const index = offset ?? 0;
      output += escapeCode(value.slice(previous, index));
      const className = comment ? "tc" : string ? "ts" : keyword ? "tk" : type ? "tt" : "";
      output += className
        ? `<span class="${className}">${escapeCode(match)}</span>`
        : escapeCode(match);
      previous = index + match.length;
      return match;
    },
  );
  return output + escapeCode(value.slice(previous));
}

function hunkHeader(hunk: {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}
