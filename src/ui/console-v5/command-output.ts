import type { readCommandOutput } from "../../console-workbench/detail.js";

export type CommandOutputPage = Awaited<ReturnType<typeof readCommandOutput>>;
export interface CommandOutputEntry {
  text: string; cursor: number; done: boolean; hasMore: boolean; pending: boolean;
  error: string | null; time: number; truncated: boolean;
}

export class CommandOutputs {
  readonly entries = new Map<string, CommandOutputEntry>();
  constructor(private readonly read: (path: string) => Promise<CommandOutputPage>, private readonly paint: () => void) {}

  async load(path: string, visible: ReadonlySet<string>, force = false): Promise<void> {
    let entry = this.entries.get(path);
    if (entry?.pending || !force && (entry?.done || entry?.time && Date.now() - entry.time < 1000)) return;
    if (!entry) {
      entry = { text: "", cursor: 0, done: false, hasMore: false, pending: false, error: null, time: 0, truncated: false };
      this.entries.set(path, entry);
      for (const [key, value] of this.entries) {
        if (this.entries.size <= 32) break;
        if (key !== path && !value.pending && !visible.has(key)) this.entries.delete(key);
      }
    }
    entry.pending = true;
    let readBytes = 0;
    try {
      do {
        const result = await this.read(path + "?cursor=" + entry.cursor);
        entry.text += result.chunk;
        readBytes += result.cursor - entry.cursor;
        entry.cursor = result.cursor; entry.done = result.done; entry.hasMore = result.hasMore;
        entry.truncated ||= result.truncated;
        if (entry.text.length > 1024 * 1024) { entry.text = entry.text.slice(-1024 * 1024); entry.truncated = true; }
      } while (entry.hasMore && readBytes < 512 * 1024);
      entry.error = null;
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    finally { entry.pending = false; entry.time = Date.now(); this.paint(); }
  }

  clear(): void { this.entries.clear(); }
}
