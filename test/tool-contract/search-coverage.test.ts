import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { REPLY_BYTES } from "../../src/bounded-reply.js";
import { fixture } from "./fixture.js";

interface ContextPage {
  result_ref: string;
  complete: boolean;
  next_cursor: string | null;
  scope: {
    selection: "explicit" | "directory";
    total_files: number | null;
    enumeration_complete?: boolean;
    file_offset?: number;
    next_file_offset?: number | null;
  };
  entries: Array<{
    path: string;
    totalLines: number;
    start_line: number;
    max_lines: number;
    truncated: boolean;
    lines: Array<{ line: number; text: string; eol: string; matches?: number[] }>;
  }>;
}

test("a no-match first batch cannot complete a search with 93 unsearched files", { timeout: 60_000 }, async t => {
  const paths = Array.from({ length: 101 }, (_, index) => `source/file-${String(index).padStart(4, "0")}.txt`);
  const files = Object.fromEntries(paths.map((path, index) => [path, index === 100 ? "the needle is here\n" : "no matching text\n"]));
  const f = await fixture(t, { git: false, files });
  let page = await f.call("workspace_context", { ...f.scope, action: "search", directory: "source",
    patterns: ["*.txt"], query: "needle", max_files: 8 }) as ContextPage;
  assert.equal(page.scope.total_files, 101);
  assert.equal(page.scope.enumeration_complete, true);
  assert.equal(page.entries.length, 8);
  assert.ok(page.entries.every(entry => entry.lines.length === 0));
  assert.equal(page.next_cursor, null);
  assert.equal(page.scope.next_file_offset, 8);
  assert.equal(page.complete, false);

  const visited: string[] = [], matched: string[] = [];
  let batches = 0;
  while (true) {
    assert.ok(++batches <= 20, "file continuation must make bounded progress");
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= REPLY_BYTES);
    assert.equal(page.next_cursor, null, "small entries fit in one response per file batch");
    for (const entry of page.entries) {
      visited.push(entry.path);
      if (entry.lines.some(line => line.matches?.length)) matched.push(entry.path);
    }
    const nextOffset = page.scope.next_file_offset;
    if (nextOffset === null) {
      assert.equal(page.complete, true);
      break;
    }
    assert.equal(page.complete, false);
    assert.ok(typeof nextOffset === "number" && nextOffset > (page.scope.file_offset ?? 0));
    page = await f.call("workspace_context", { ...f.scope, action: "search",
      result_ref: page.result_ref, file_offset: nextOffset }) as ContextPage;
  }
  assert.deepEqual(visited, paths);
  assert.equal(new Set(visited).size, 101);
  assert.deepEqual(matched, [paths[100]]);
});

test("finishing a matching line's byte pages still leaves the next file batch incomplete", { timeout: 60_000 }, async t => {
  const long = "needle " + "中文😀".repeat(10_000) + "\n";
  const f = await fixture(t, { git: false, files: { "source/a.txt": long, "source/b.txt": "second needle\n" } });
  let page = await f.call("workspace_context", { ...f.scope, action: "search", directory: "source",
    patterns: ["*.txt"], query: "needle", max_files: 1 }) as ContextPage;
  const ref = page.result_ref;
  assert.ok(page.next_cursor);
  assert.equal(page.scope.next_file_offset, 1);
  const pieces: string[] = [];
  let pages = 0;
  while (true) {
    assert.ok(++pages < 10, "line continuation must make bounded progress");
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= REPLY_BYTES);
    assert.equal(page.complete, false, "another file remains even when this batch fits in the final byte page");
    for (const entry of page.entries) for (const line of entry.lines) pieces.push(line.text + line.eol);
    if (page.next_cursor === null) break;
    page = await f.call("workspace_context", { ...f.scope, action: "search",
      result_ref: ref, cursor: page.next_cursor }) as ContextPage;
  }
  assert.equal(pieces.join(""), long);
  const final = await f.call("workspace_context", { ...f.scope, action: "search",
    result_ref: ref, file_offset: page.scope.next_file_offset }) as ContextPage;
  assert.equal(final.entries[0]?.path, "source/b.txt");
  assert.equal(final.scope.next_file_offset, null);
  assert.equal(final.next_cursor, null);
  assert.equal(final.complete, true);
});

test("explicit line ranges, exact-size batches and empty scopes retain completion semantics", { timeout: 60_000 }, async t => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`source/${index}.txt`, "no match\n"]));
  const f = await fixture(t, { git: false, files: { ...files, "range.txt": "needle before\nselected range\nneedle after\n" } });
  const selected = await f.call("workspace_context", { ...f.scope, action: "search", query: "needle",
    files: [{ path: "range.txt", start_line: 2, max_lines: 1 }] }) as ContextPage;
  assert.equal(selected.scope.selection, "explicit");
  assert.equal(selected.complete, true, "complete covers the requested line range, not the rest of the file");
  assert.equal(selected.next_cursor, null);
  assert.equal(selected.entries[0]?.totalLines, 3);
  assert.equal(selected.entries[0]?.start_line, 2);
  assert.equal(selected.entries[0]?.max_lines, 1);
  assert.equal(selected.entries[0]?.truncated, false, "truncated describes transport pagination, not an explicit range boundary");
  assert.deepEqual(selected.entries[0]?.lines, []);

  const exact = await f.call("workspace_context", { ...f.scope, action: "search", query: "needle",
    directory: "source", patterns: ["*.txt"], max_files: 8 }) as ContextPage;
  assert.equal(exact.entries.length, 8);
  assert.ok(exact.entries.every(entry => entry.lines.length === 0));
  assert.equal(exact.scope.total_files, 8);
  assert.equal(exact.scope.next_file_offset, null);
  assert.equal(exact.complete, true);

  await mkdir(join(f.project, "empty"));
  const empty = await f.call("workspace_context", { ...f.scope, action: "search", query: "needle",
    directory: "empty", patterns: ["*.txt"], max_files: 8 }) as ContextPage;
  assert.equal(empty.scope.total_files, 0);
  assert.equal(empty.scope.enumeration_complete, true);
  assert.equal(empty.scope.next_file_offset, null);
  assert.equal(empty.next_cursor, null);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.entries, []);
});
