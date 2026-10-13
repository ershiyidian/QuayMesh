export class SourceErrors {
  constructor(limit = 64) { this.limit = limit; this.current = new Map(); this.history = []; }
  fail(source, error, details = {}) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.current.get(source);
    if (previous?.message === message) { previous.lastOccurredAt = Date.now(); previous.count++; return; }
    this.recover(source);
    const record = { source, message, ...details, occurredAt:Date.now(), lastOccurredAt:Date.now(), count:1, recoveredAt:null };
    this.current.set(source, record); this.history.push(record);
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
  }
  recover(source) {
    const record = this.current.get(source);
    if (record) record.recoveredAt = Date.now();
    this.current.delete(source);
  }
  snapshot() {
    return { current:[...this.current.values()].map(value => ({...value})), history:this.history.map(value => ({...value})) };
  }
}
