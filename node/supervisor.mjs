import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";

class RollingLog extends Writable {
  constructor(file, limit = 4 * 1024 * 1024) {
    super({ highWaterMark: 64 * 1024 });
    this.file = file; this.limit = limit; this.size = 0;
  }
  _construct(done) {
    void (async () => {
      this.handle = await open(this.file, "a", 0o600);
      this.size = (await this.handle.stat()).size;
    })().then(() => done(), done);
  }
  _write(chunk, _encoding, done) {
    void this.append(chunk).then(() => done(), done);
  }
  async append(chunk) {
    for (let offset = 0; offset < chunk.length;) {
      if (this.size >= this.limit) {
        await this.handle.close(); this.handle = null;
        await rm(`${this.file}.3`, { force: true });
        for (let index = 2; index >= 1; index--) {
          await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch(error => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        await rename(this.file, `${this.file}.1`);
        this.handle = await open(this.file, "a", 0o600); this.size = 0;
      }
      const size = Math.min(chunk.length - offset, this.limit - this.size);
      await this.handle.writeFile(chunk.subarray(offset, offset + size));
      this.size += size; offset += size;
    }
  }
  _destroy(error, done) {
    const handle = this.handle; this.handle = null;
    Promise.resolve(handle?.close()).then(() => done(error), done);
  }
}

export function planIdentity(plan) {
  return plan.effective ?? { command:plan.command, args:plan.args, cwd:plan.cwd, env:plan.env,
    requires:plan.requires, configuration:plan.configuration };
}
function component(plan) {
  return { plan, state:"stopped", restarts:0, failures:0, nextStartAt:0, nextProbeAt:0,
    child:null, startedAt:null, lastReadyAt:null, stableSince:null, probeError:null,
    lastExitCode:null, lastExitSignal:null, lastExitAt:null, error:null, stopping:false, log:null };
}
function validatePlans(plans) {
  const definitions = new Map(plans.map(plan => [plan.id, plan]));
  if (definitions.size !== plans.length) throw new Error("组件 ID 重复");
  const visited = new Set(), visiting = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error(`组件依赖形成循环：${id}`);
    if (visited.has(id)) return;
    const plan = definitions.get(id);
    if (!plan) throw new Error(`缺少依赖组件 ${id}`);
    visiting.add(id);
    for (const dependency of plan.requires || []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of definitions.keys()) visit(id);
  return [...visited];
}

export class ComponentSupervisor extends EventEmitter {
  constructor({ logDir, intervalMs = 1000, shutdownMs = 20000 }) {
    super(); this.logDir = logDir; this.intervalMs = intervalMs; this.shutdownMs = shutdownMs;
    this.components = new Map(); this.stopped = true; this.paused = false;
    this.checks = new Map();
  }
  define(plans) {
    if (!this.stopped) throw new Error("组件清单需要在启动前设置");
    validatePlans(plans);
    this.components = new Map(plans.map(plan => [plan.id, component(plan)]));
  }
  snapshot() {
    return [...this.components.values()].map(value => ({
      id:value.plan.id, state:value.state, processState:value.child ? "running" : "stopped",
      pid:value.child?.pid || null, restarts:value.restarts, startedAt:value.startedAt,
      lastReadyAt:value.lastReadyAt, observedAt:value.observedAt || null, error:value.error,
      stableSince:value.stableSince, crashLoop:value.failures>=3,
      probeError:value.probeError, lastExitCode:value.lastExitCode,
      lastExitSignal:value.lastExitSignal, lastExitAt:value.lastExitAt,
    }));
  }
  async start() {
    await mkdir(this.logDir, { recursive:true, mode:0o700 });
    this.stopped = false;
    await this.reconcile();
    this.timer = setInterval(() => { void this.reconcile().catch(error => this.emit("fault", error)); }, this.intervalMs);
    return this;
  }
  reconcile() {
    if (this.stopped || this.paused) return Promise.resolve();
    for (const value of this.components.values()) {
      if (this.checks.has(value.plan.id)) continue;
      const pending = this.check(value)
        .then(() => this.emit("change", this.snapshot()))
        .finally(() => this.checks.delete(value.plan.id));
      this.checks.set(value.plan.id, pending);
    }
    return Promise.all([...this.checks.values()]);
  }
  async check(value) {
    if (!value.child && !value.stopping && Date.now() >= value.nextStartAt) {
      if ((value.plan.requires || []).some(id => this.components.get(id)?.state !== "ready")) {
        value.state = "waiting"; return;
      }
      try { await value.plan.beforeStart?.(); }
      catch (error) { value.state = "waiting"; value.error = error.message; return; }
      if (this.stopped || this.paused) return;
      this.spawnComponent(value);
    }
    if (!value.child || !value.spawned || value.stopping || Date.now() < value.nextProbeAt) return;
    const child = value.child;
    value.nextProbeAt = Date.now() + this.intervalMs;
    try {
      await value.plan.ready?.(child);
      if (value.child !== child) return;
      value.stableSince ??= Date.now();
      if (Date.now()-value.stableSince>=60000) value.failures=0;
      value.state = value.failures>=3 ? "degraded" : "ready";
      value.probeError=null; value.lastReadyAt=Date.now();
      value.error=value.failures>=3 ? "组件近期反复退出，等待连续稳定运行 60 秒" : null;
    } catch (error) {
      if (value.child !== child) return;
      value.stableSince=null; value.probeError=error.message;
      value.state = value.lastReadyAt ? "degraded" : "starting"; value.error = error.message;
    } finally { if (value.child === child) value.observedAt = Date.now(); }
  }
  spawnComponent(value) {
    const { plan } = value;
    value.state = "starting"; value.error = null; value.startedAt = Date.now(); value.lastReadyAt = null;
    value.stableSince=null; value.probeError=null;
    // A surviving descendant can keep an exited generation's stdio open.
    // Share one rolling writer until all generations using it have closed.
    let log = value.log;
    if (!log || log.destroyed || log.writableEnded) {
      log = new RollingLog(join(this.logDir, `${plan.id}.log`));
      log.users = 0; value.log = log; value.logClosed = undefined;
      log.on("error", error => {
        if (value.log === log) value.error = `日志写入失败：${error.message}`;
        this.emit("fault", error);
      });
    }
    log.users++;
    const child = spawn(plan.command, plan.args || [], { cwd:plan.cwd, env:plan.env,
      stdio:["ignore","pipe","pipe"], shell:false, windowsHide:true, detached:process.platform !== "win32" });
    value.child = child; value.spawned = false;
    child.once("spawn", () => { if (value.child === child) value.spawned = true; });
    child.stdout.pipe(log, { end:false }); child.stderr.pipe(log, { end:false });
    let exited = false, resolveExit;
    value.exited = new Promise(resolve => { resolveExit = resolve; });
    const recordExit = (code, signal) => {
      if (exited) return;
      exited = true;
      if (value.child === child) {
        value.child = null; value.spawned = false;
        value.lastExitCode=code; value.lastExitSignal=signal; value.lastExitAt=Date.now(); value.stableSince=null;
        if (value.stopping || this.stopped) value.state = "stopped";
        else {
          value.failures = Date.now() - value.startedAt >= 60000 ? 1 : value.failures + 1;
          value.restarts++;
          value.error = `${plan.id} 已退出，code=${code} signal=${signal || "none"}${value.error ? `；此前：${value.error}` : ""}`;
          value.state = "backoff";
          value.nextStartAt = Date.now() + Math.min(30000, 500 * 2 ** Math.min(value.failures - 1, 6));
        }
        this.emit("change", this.snapshot());
      }
      resolveExit();
    };
    child.once("exit", recordExit);
    child.once("error", error => {
      if (value.child === child) value.error = error.message;
      // Failed spawn has no OS process and emits error/close, but no exit.
      if (!child.pid) recordExit(null, null);
    });
    value.closed = new Promise(resolve => child.once("close", () => {
      if (--log.users === 0 && (this.stopped || value.removed)) this.finishLog(value, log);
      resolve();
    }));
  }
  finishLog(value, log) {
    if (log.drained) return log.drained;
    log.end();
    log.drained = finished(log).catch(error => {
      if (value.log === log) value.error = error.message;
      this.emit("fault", error);
    });
    if (value.log === log) value.logClosed = log.drained;
    return log.drained;
  }
  async drainLog(log, closed) {
    if (!log) return;
    let timer;
    try {
      await Promise.race([Promise.resolve(closed).then(() => log.drained ?? new Promise(resolve => {
        // A zero-byte write is a barrier behind all already-piped output. Keep
        // the writer open across replacements, including inherited old pipes.
        if (log.destroyed) resolve(); else log.write(Buffer.alloc(0), () => resolve());
      })), new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
    } finally { clearTimeout(timer); }
  }
  async stopComponent(id) {
    const value = this.components.get(id);
    if (!value) throw new Error(`未知组件 ${id}`);
    value.stopping = true;
    const child = value.child;
    const log = value.log, closed = value.closed;
    if (!child) {
      if (log?.users === 0 && (this.stopped || value.removed)) this.finishLog(value, log);
      await this.drainLog(log, closed);
      value.state = "stopped"; value.stopping = false; return;
    }
    const exited = value.exited;
    let timer;
    try {
      if (value.plan.stop) await value.plan.stop(child);
      else child.kill("SIGTERM");
      timer = setTimeout(() => {
        if (value.child !== child || child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID",String(child.pid),"/T","/F"], { windowsHide:true, stdio:"ignore" });
          killer.once("error", error => this.emit("fault", error));
        } else {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") this.emit("fault", error); }
        }
      }, this.shutdownMs);
      timer.unref();
      // OS exit ends supervision of this process. Waiting for inherited stdio
      // here would later kill live descendants even though the parent is gone.
      await exited;
      clearTimeout(timer);
      await this.drainLog(log, closed);
    } finally { clearTimeout(timer); value.stopping = false; }
    value.state = "stopped";
  }
  changedIds(plans) {
    validatePlans(plans);
    const next = new Map(plans.map(plan => [plan.id, plan]));
    const changed = new Set([...this.components].filter(([id,current]) =>
      !next.has(id) || !isDeepStrictEqual(planIdentity(current.plan), planIdentity(next.get(id)))).map(([id]) => id));
    for (const id of next.keys()) if (!this.components.has(id)) changed.add(id);
    let added = true;
    while (added) {
      added = false;
      for (const plan of [...plans, ...[...this.components.values()].map(value => value.plan)]) {
        if (!changed.has(plan.id) && (plan.requires || []).some(id => changed.has(id))) { changed.add(plan.id); added = true; }
      }
    }
    return changed;
  }
  async restart(id, newPlan) {
    if (!this.components.has(id)) throw new Error(`未知组件 ${id}`);
    return this.replacePlans([...this.components.values()].map(value => value.plan.id === id ? newPlan || value.plan : value.plan), new Set([id]));
  }
  async replacePlans(plans, forced = new Set()) {
    const changed = this.changedIds(plans);
    for (const id of forced) changed.add(id);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const value of this.components.values()) if (!changed.has(value.plan.id) &&
        (value.plan.requires || []).some(id => changed.has(id))) { changed.add(value.plan.id); expanded = true; }
    }
    this.paused = true;
    try {
      await Promise.all([...this.checks.values()]);
      const order = validatePlans([...this.components.values()].map(value => value.plan)).reverse();
      for (const id of order) if (changed.has(id)) await this.stopComponent(id);
      for (const id of this.components.keys()) if (!plans.some(plan => plan.id === id)) {
        const value = this.components.get(id); value.removed = true;
        if (value.log?.users === 0) this.finishLog(value, value.log);
        this.components.delete(id);
      }
      for (const plan of plans) {
        const current = this.components.get(plan.id);
        if (!current) this.components.set(plan.id, component(plan));
        else if (changed.has(plan.id)) { current.plan = plan; current.nextStartAt = 0; current.nextProbeAt = 0; }
      }
    } finally { this.paused = false; }
    await this.reconcile();
    return changed;
  }
  async waitReady(ids, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped) {
      await this.reconcile();
      const pending = [...ids].map(id => this.components.get(id)).filter(value => value && value.state !== "ready");
      if (!pending.length) return;
      if (Date.now() >= deadline) throw new Error(pending.map(value => `${value.plan.id}: ${value.error || value.state}`).join("; "));
      await new Promise(resolve => setTimeout(resolve, Math.min(this.intervalMs,100)));
    }
    throw new Error("组件管理器已经停止");
  }
  close() {
    this.closing ||= this.closeNow();
    return this.closing;
  }
  async closeNow() {
    this.stopped = true; clearInterval(this.timer); await Promise.all([...this.checks.values()]);
    const errors = [];
    for (const id of validatePlans([...this.components.values()].map(value => value.plan)).reverse()) {
      try { await this.stopComponent(id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors,"组件退出失败");
  }
}
