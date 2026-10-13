import { readFile } from "node:fs/promises";
import process from "node:process";

const files = process.argv.slice(2);
if (!files.length) throw new Error("用法：node scripts/analyze-failures.mjs <log.jsonl> [...]");
const events = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push({ file, event: JSON.parse(line) }); }
    catch { events.push({ file, raw: line }); }
  }
}
const counts = Object.create(null);
for (const entry of events) {
  const text = JSON.stringify(entry.event ?? entry.raw).toLowerCase();
  for (const kind of ["timeout", "reset", "worker", "provider", "resource", "unknown"]) if (text.includes(kind)) counts[kind] = (counts[kind] ?? 0) + 1;
}
console.log(JSON.stringify({ analyzedAt: new Date().toISOString(), files, eventCount: events.length, counts, clientOutcome: "unknown unless supplied by browser evidence" }, null, 2));
