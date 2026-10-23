import type { EventRow } from './contracts.js';

export interface EventCursor { after: number; afterId: string }
interface NodeMemory { cursor: EventCursor; seen: string[] }
export type NotificationMemory = Record<string, NodeMemory>;
export interface NotificationPage {
  items: EventRow[]; complete: boolean; observedAt: number | null;
  nextAfter: EventCursor | null; total: number;
}

// 每个节点保留自己的进度，离线节点恢复后从原位置补读。
export class EventNotifications {
  private readonly nodes: NotificationMemory = {};
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: {
    read(nodeId: string, cursor: EventCursor | null, signal: AbortSignal): Promise<NotificationPage>;
    save(memory: NotificationMemory): void;
    emit(nodeId: string, events: EventRow[]): void;
    gap(nodeId: string, message: string | null): void;
    memory?: NotificationMemory;
  }) {
    for (const [nodeId, saved] of Object.entries(options.memory || {})) {
      if (saved && Number.isFinite(saved.cursor?.after) && typeof saved.cursor.afterId === 'string' && Array.isArray(saved.seen))
        this.nodes[nodeId] = { cursor: { ...saved.cursor }, seen: saved.seen.filter(value => typeof value === 'string').slice(-1000) };
    }
  }

  cancel(): void { for (const controller of this.active.values()) controller.abort(); }

  async poll(nodeIds: string[]): Promise<void> {
    await Promise.all([...new Set(nodeIds)].map(nodeId => this.pollNode(nodeId)));
  }

  private async pollNode(nodeId: string): Promise<void> {
    if (this.active.has(nodeId)) return;
    const controller = new AbortController(); this.active.set(nodeId, controller);
    const events: EventRow[] = [];
    try {
      for (let pageNumber = 0; pageNumber < 10 && !controller.signal.aborted; pageNumber++) {
        const previous = this.nodes[nodeId], page = await this.options.read(nodeId, previous?.cursor || null, controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(page.items) || typeof page.complete !== 'boolean') throw new Error('错误事件响应不完整');
        if (!page.complete) {
          this.options.gap(nodeId, '错误事件覆盖不完整，保留原进度，连接恢复后继续补读');
          break;
        }
        const items = page.items.filter(event => event.nodeId === nodeId && typeof event.id === 'string' && Number.isFinite(event.time));
        const next = page.nextAfter;
        if (next && (!Number.isFinite(next.after) || typeof next.afterId !== 'string')) throw new Error('错误事件游标无效');
        if (!previous) {
          // 首次启用只建立基线；空页使用来源观测时间，避免客户端时钟偏差。
          const newest = items.reduce<EventCursor | null>((cursor, event) => !cursor || event.time > cursor.after || event.time === cursor.after && event.id > cursor.afterId
            ? {after:event.time,afterId:event.id} : cursor, null);
          const cursor = newest || next || (page.observedAt !== null && Number.isFinite(page.observedAt) ? {after:page.observedAt,afterId:''} : null);
          if (!cursor) { this.options.gap(nodeId, '尚未取得错误事件来源时间，等待建立通知进度'); break; }
          this.nodes[nodeId] = {cursor,seen:items.map(event => nodeId + ':' + event.id).slice(-1000)};
          this.options.save(structuredClone(this.nodes)); this.options.gap(nodeId, null);
          break;
        }
        if (items.length && (!next || next.after < previous.cursor.after || next.after === previous.cursor.after && next.afterId <= previous.cursor.afterId))
          throw new Error('错误事件游标未推进，已保留原进度');
        const seen = new Set(previous.seen);
        for (const event of items) {
          const key = nodeId + ':' + event.id;
          if (!seen.has(key) && event.level === 'error') events.push(event);
          seen.add(key);
        }
        this.nodes[nodeId] = {cursor:next || previous.cursor,seen:[...seen].slice(-1000)};
        this.options.save(structuredClone(this.nodes)); this.options.gap(nodeId, null);
        if (!items.length || page.total <= page.items.length) break;
        if (pageNumber === 9) this.options.gap(nodeId, '仍有错误事件待补读，将从当前进度继续');
      }
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError'))
        this.options.gap(nodeId, '错误事件暂未同步，保留原进度：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      this.active.delete(nodeId);
      if (!controller.signal.aborted && events.length) this.options.emit(nodeId, events);
    }
  }
}
