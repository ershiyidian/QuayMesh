import type { readCommandOutput } from "../../console-workbench/detail.js";

export type CommandOutputState = 'writing' | 'ready' | 'incomplete' | 'expired' | 'unknown';
export type CommandOutputPage = Awaited<ReturnType<typeof readCommandOutput>> & {outputState?:CommandOutputState;errorCode?:string|null};
export interface CommandOutputEntry {
  text: string; cursor: number; done: boolean; hasMore: boolean; pending: boolean;
  error: string | null; time: number; truncated: boolean;
  outputState:CommandOutputState; errorCode:string|null;
}

const unconfirmed=(state:CommandOutputState)=>['incomplete','expired','unknown'].includes(state);
export function commandOutputNeedsRetry(entry:CommandOutputEntry|undefined):boolean {
  return Boolean(entry&&(entry.error||unconfirmed(entry.outputState)));
}
export function commandOutputNotice(entry:CommandOutputEntry):string {
  if(entry.outputState==='incomplete')return '输出记录不完整；以下仅显示已经保存的内容。';
  if(entry.outputState==='expired')return '保存的输出已过保留期；当前只能显示之前已读取的内容。';
  if(entry.outputState==='unknown')return '输出记录状态尚未确认；以下仅显示已经读取的内容。';
  return '';
}

export class CommandOutputs {
  readonly entries = new Map<string, CommandOutputEntry>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly read: (path: string, signal?: AbortSignal) => Promise<CommandOutputPage>, private readonly paint: () => void) {}

  async load(path: string, visible: ReadonlySet<string>, force = false): Promise<void> {
    let entry = this.entries.get(path);
    if (entry?.pending || !force && (entry?.done || commandOutputNeedsRetry(entry) || entry?.time && Date.now() - entry.time < 1000)) return;
    if (!entry) {
      entry = { text: "", cursor: 0, done: false, hasMore: false, pending: false, error: null, time: 0, truncated: false,
        outputState:'writing',errorCode:null };
      this.entries.set(path, entry);
      for (const [key, value] of this.entries) {
        if (this.entries.size <= 32) break;
        if (key !== path && !value.pending && !visible.has(key)) this.entries.delete(key);
      }
    }
    entry.pending = true;
    const controller = new AbortController(); this.controllers.set(path, controller);
    let readBytes = 0;
    try {
      do {
        const result = await this.read(path + "?cursor=" + entry.cursor, controller.signal);
        if (controller.signal.aborted || this.entries.get(path) !== entry) return;
        if (typeof result.chunk !== 'string' || !Number.isFinite(result.cursor) || result.cursor < entry.cursor || result.hasMore && result.cursor === entry.cursor)
          throw new Error('命令输出游标无效，请重新读取');
        if(result.outputState!==undefined&&!['writing','ready','incomplete','expired','unknown'].includes(result.outputState))
          throw new Error('命令输出状态无效，请重新读取');
        entry.text += result.chunk;
        readBytes += result.cursor - entry.cursor;
        entry.cursor = result.cursor; entry.done = result.done; entry.hasMore = result.hasMore;
        entry.outputState=result.outputState??(result.done?'ready':'writing');entry.errorCode=result.errorCode??null;
        entry.truncated ||= result.truncated;
        if (entry.text.length > 1024 * 1024) { entry.text = entry.text.slice(-1024 * 1024); entry.truncated = true; }
      } while (entry.hasMore && readBytes < 512 * 1024);
      entry.error = null;
    } catch (error) { if (!controller.signal.aborted) entry.error = error instanceof Error ? error.message : String(error); }
    finally { entry.pending = false; if (!controller.signal.aborted) entry.time = Date.now(); this.controllers.delete(path); this.paint(); }
  }

  cancelAll(): void { for (const controller of this.controllers.values()) controller.abort(); }
  clear(): void { this.cancelAll(); this.entries.clear(); }
}
