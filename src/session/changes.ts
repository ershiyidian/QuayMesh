import { createHash, randomUUID } from "node:crypto";
import { CaptureReadClock, type CaptureReadFence, type CaptureReadObservation, type CaptureReadScope } from "./capture-read-observation.js";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createPatch } from "diff";
import { git, getGitEligibility } from "../git.js";
import { createWorkingTreeSnapshot } from "../review-checkpoints.js";
import { isPathInsideRoot } from "../roots.js";
import { resolvePhysicalPath, samePhysicalPath } from "../physical-paths.js";
import { textPage } from "../bounded-reply.js";
import type { FileSummary, SessionId, SessionMember } from "./types.js";
import type { SessionStore } from "./store.js";
import { beginWrite, finishWrite, memberFile, ownershipPath, readFileState, readOwnedFiles, sameFileState, type WriteEvidence } from "./write-evidence.js";

interface GitNumstat {
  additions: number | null;
  removals: number | null;
  path: string;
  from: string | null;
  status: "A" | "M" | "D" | "R";
}

interface OrdinaryBaselineFile {
  path: string;
  existed: boolean;
  binary: boolean;
  contentRef: string;
}

interface OrdinaryBaseline {
  version: 1;
  files: OrdinaryBaselineFile[];
}

type CapturedFile = FileSummary & { patchRef: string; versionRef: string };

export interface CaptureObservation {
  /** idle means this process currently observes no capture work or failure. */
  state: "idle" | "pending" | "failed";
  error: string | null;
}

export class SessionChangeCollector {
  private readonly readClock = new CaptureReadClock();
  private readonly metadataWrites = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly captures = new Map<string, Set<Promise<void>>>();
  private readonly captureTokens = new Map<string, symbol>();
  private readonly dirty = new Map<string, Set<string> | null>();
  private onCaptured?: (sessionId: string, memberId: string, taskId?: string) => Promise<void> | void;
  private closed = false;
  private readonly captureErrors = new Map<string, Error>();

  constructor(
    private readonly store: SessionStore,
    private readonly stateDir: string,
  ) {}

  setCaptureListener(listener: (sessionId: string, memberId: string, taskId?: string) => Promise<void> | void): void {
    this.onCaptured = listener;
  }

  async prepareWrite(member: SessionMember, paths: string[], cwd = member.root, taskId?: string): Promise<WriteEvidence[]> {
    await this.ensureBaseline(member, paths, cwd, taskId);
    return beginWrite(member.root, paths, cwd);
  }

  async recordWrite(member: SessionMember, evidence: WriteEvidence[], taskId?: string): Promise<void> {
    const path=ownershipPath(this.stateDir,this.sessionIdFor(member.id),member.id,taskId);
    await this.writeMetadata(path,()=>finishWrite(member.root,path,evidence),member.id,taskId);
  }

  private writeMetadata(key: string, write: () => Promise<void>, memberId: string, taskId?: string): Promise<void> {
    this.readClock.touch(memberId, taskId);
    const previous=this.metadataWrites.get(key);
    const next=(previous ? previous.then(write,write) : write()).finally(()=>{
      if(this.metadataWrites.get(key)===next)this.metadataWrites.delete(key);
      this.readClock.touch(memberId, taskId);
    });
    this.metadataWrites.set(key,next);
    return next;
  }

  private metadataKeys(memberId: string, taskId?: string, sessionId?: string): string[] {
    return [JSON.stringify([memberId, taskId ?? null, "baseline"]),
      ownershipPath(this.stateDir, sessionId ?? this.sessionIdFor(memberId), memberId, taskId)];
  }

  captureObservation(memberId: string, taskId?: string): CaptureObservation {
    const key = JSON.stringify([memberId, taskId ?? null]);
    const pending = this.pending.has(key) || Boolean(this.captures.get(key)?.size)
      || this.metadataKeys(memberId, taskId).some(value => this.metadataWrites.has(value));
    const error = this.captureErrors.get(key);
    return { state: pending ? "pending" : error ? "failed" : "idle", error: error?.message ?? null };
  }

  /** The caller supplies a scope verified by the readonly worker; this path performs no SQL. */
  captureReadFence(): CaptureReadFence { return this.readClock.fence(); }

  captureReadObservation(scope: CaptureReadScope, before: CaptureReadFence): CaptureReadObservation {
    const key = JSON.stringify([scope.memberId, scope.taskId]);
    const pending = this.pending.has(key) || Boolean(this.captures.get(key)?.size)
      || this.metadataKeys(scope.memberId, scope.taskId ?? undefined, scope.sessionId).some(value => this.metadataWrites.has(value));
    const error = this.captureErrors.get(key);
    return this.readClock.observe(scope, before, {
      state: pending ? "pending" : error ? "failed" : "idle", error: error?.message ?? null,
    });
  }

  private pendingWork(): Promise<void>[] {
    return [...this.metadataWrites.values(), ...this.pending.values(), ...[...this.captures.values()].flatMap(values => [...values])];
  }

  async flush(): Promise<void> {
    for (;;) {
      const work = this.pendingWork();
      if (!work.length) break;
      await Promise.all(work);
    }
    if (this.captureErrors.size) throw new AggregateError([...this.captureErrors.values()], "文件改动捕获失败");
  }

  async flushTask(memberId: string, taskId?: string): Promise<void> {
    const key = JSON.stringify([memberId, taskId ?? null]);
    const metadataKeys = this.metadataKeys(memberId, taskId);
    for (;;) {
      const work = [...metadataKeys.flatMap(value => this.metadataWrites.get(value) ?? []),
        ...(this.captures.get(key) ?? []), ...(this.pending.has(key) ? [this.pending.get(key)!] : [])];
      if (!work.length) break;
      await Promise.all(work);
    }
    const error = this.captureErrors.get(key);
    if (error) throw error;
  }

  async ensureBaseline(
    member: SessionMember,
    knownPaths: string[],
    workingDirectory = member.root,
    taskId?: string,
  ): Promise<void> {
    const key=JSON.stringify([member.id,taskId??null,"baseline"]);
    return this.writeMetadata(key,()=>this.ensureBaselineNow(member,knownPaths,workingDirectory,taskId),member.id,taskId);
  }

  private async ensureBaselineNow(member: SessionMember, knownPaths: string[], workingDirectory: string, taskId?: string): Promise<void> {
    const eligibility = await getGitEligibility(workingDirectory);
    if (eligibility.ok && eligibility.gitRoot) {
      const existing = this.store.getChangeBaseline(this.sessionIdFor(member.id), member.id, eligibility.gitRoot, taskId);
      if (existing) return;
      const parent = eligibility.hasHead
        ? (await git(eligibility.gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim()
        : undefined;
      const snapshot = await createWorkingTreeSnapshot(
        eligibility.gitRoot,
        parent,
        quaymeshSnapshotExcludes(eligibility.gitRoot, member.root),
      );
      this.store.putChangeBaseline({
        session_id: this.sessionIdFor(member.id),
        member_id: member.id,
        repo_root: eligibility.gitRoot,
        baseline_ref: snapshot,
        latest_ref: snapshot,
        coverage: "session_owned",
      }, taskId);
      return;
    }

    const baselinePath = this.ordinaryBaselinePath(member, taskId);
    const existing = await readFile(baselinePath, "utf8").then((value) => JSON.parse(value) as OrdinaryBaseline).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const files: OrdinaryBaselineFile[] = existing?.files ?? [];
    for (const path of knownPaths) {
      const { absolute, path: relativePath } = memberFile(member.root, path, workingDirectory);
      if (files.some((file) => file.path === relativePath)) continue;
      const nested = await getGitEligibility(dirname(absolute));
      if (nested.ok && nested.gitRoot) {
        await this.ensureBaselineNow(member, [], nested.gitRoot, taskId);
        continue;
      }
      const content = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const contentRef = await this.writeEvidence(member, `baseline-${digest(absolute)}`, content, taskId);
      files.push({ path: relativePath, existed: content !== null,
        binary: content !== null && content.includes(0), contentRef });
    }
    await mkdir(dirname(baselinePath), { recursive: true, mode: 0o700 });
    const pending = `${baselinePath}.pending-${process.pid}-${Date.now()}`;
    await writeFile(pending, JSON.stringify({ version: 1, files } satisfies OrdinaryBaseline), "utf8");
    await rename(pending, baselinePath);
    this.store.putChangeBaseline({
      session_id: this.sessionIdFor(member.id),
      member_id: member.id,
      repo_root: member.root,
      baseline_ref: `ordinary:${digest(files)}`,
      latest_ref: `ordinary:${digest(files)}`,
      coverage: "partial",
    }, taskId);
  }

  markDirty(memberId: string, paths: string[] = [], taskId?: string): void {
    if (this.closed) return;
    this.readClock.touch(memberId, taskId);
    const key = JSON.stringify([memberId, taskId ?? null]);
    const previous = this.dirty.get(key);
    this.dirty.set(key, !paths.length || previous === null ? null
      : new Set([...(previous ?? []), ...paths]));
    if (this.pending.has(key)) return;
    const capture = Promise.resolve().then(async () => {
      while (this.dirty.has(key)) {
        const paths = this.dirty.get(key);
        this.dirty.delete(key);
        await this.capture(memberId, taskId, paths ? [...paths] : undefined);
      }
    }).finally(() => { this.pending.delete(key); this.readClock.touch(memberId, taskId); });
    this.pending.set(key, capture);
    void capture.catch(() => {});
  }

  capture(memberId: string, taskId?: string, changedPaths?: string[]): Promise<void> {
    this.readClock.touch(memberId, taskId);
    const key = JSON.stringify([memberId, taskId ?? null]);
    const active = this.captures.get(key) ?? new Set<Promise<void>>();
    // An older publication can settle after a newer capture. Only the newest
    // capture's result may replace the observation for this member and Task.
    const token = Symbol();
    this.captureTokens.set(key, token);
    const work = this.captureNow(memberId, taskId, changedPaths).then(() => {
      if (this.captureTokens.get(key) === token) this.captureErrors.delete(key);
    }, error => {
      if (this.captureTokens.get(key) === token) {
        this.captureErrors.set(key, error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }).finally(() => {
      this.readClock.touch(memberId, taskId);
      active.delete(work);
      if (!active.size) {
        this.captures.delete(key);
        this.captureTokens.delete(key);
      }
    });
    active.add(work);
    this.captures.set(key, active);
    return work;
  }

  private async captureNow(memberId: string, taskId?: string, changedPaths?: string[]): Promise<void> {
    const { sessionId, member } = this.store.memberOwner(memberId);
    const baselines = this.store.changeBaselines(sessionId, memberId, taskId);
    if (baselines.length === 0) return;
    const previousFiles = this.store.fileSummaries(sessionId, memberId, taskId);
    const previousByPath = new Map(previousFiles.map(file => [file.path, file]));
    const previous = JSON.stringify(previousFiles.map(({ patchRef: _patchRef, versionRef: _versionRef, ...file }) => file));
    const files: Array<FileSummary & { patchRef: string; versionRef: string }> = [];
    const memberRoot = resolvePhysicalPath(member.root);
    for (const baseline of baselines) {
      if (baseline.baseline_ref.startsWith("ordinary:") && samePhysicalPath(baseline.repo_root, member.root)) {
        files.push(...await this.captureOrdinary(sessionId, member, baseline.baseline_ref, previousByPath, taskId));
      } else {
        const repoRoot = resolvePhysicalPath(baseline.repo_root);
        const scoped = changedPaths?.map(path => resolvePhysicalPath(resolve(memberRoot, path)))
          .filter(path => isPathInsideRoot(path, repoRoot))
          .map(path => relative(repoRoot, path).replaceAll("\\", "/"));
        if (scoped && !scoped.length) continue;
        files.push(...await this.captureGit(sessionId, member, baseline.repo_root,
          baseline.baseline_ref, baseline.latest_ref, previousByPath, taskId, scoped));
      }
    }
    const versions = new Map<string, Array<FileSummary & { patchRef: string }>>();
    for (const file of files) {
      const group = versions.get(file.versionRef) ?? [];
      group.push(file);
      versions.set(file.versionRef, group);
    }
    for (const [version, group] of versions) this.store.replaceFileSummaries(sessionId, member.id, version, group, taskId);
    const current = JSON.stringify(this.readSummaries(sessionId, memberId, taskId));
    if (current === previous) return;
    this.store.appendEvent({
      session_id: sessionId,
      task_id: taskId ?? null,
      member_id: memberId,
      type: "file_changed",
      source_id: `capture-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      payload: {},
    });
    await this.onCaptured?.(sessionId, memberId, taskId);
  }

  async fileDiff(sessionId: SessionId, fileId: string, hash: string, taskId?: string): Promise<{ file: FileSummary; patch: string }> {
    const records = this.store.fileSummariesForSession(sessionId, taskId);
    const record = records.find((entry) => entry.id === fileId);
    if (!record) throw new Error(`FILE_NOT_FOUND: ${fileId}`);
    if (record.hash !== hash) throw new Error(`FILE_VERSION_STALE: ${fileId}`);
    const { patchRef: _patchRef, versionRef: _versionRef, ...file } = record;
    return { file, patch: await readFile(record.patchRef, "utf8") };
  }

  async fileDiffForTask(taskId: string, sessionId: SessionId, fileId: string, hash: string): Promise<{ file: FileSummary; patch: string }> {
    const task = this.store.getTask(taskId);
    if (task.session_id !== sessionId) throw new Error(`TASK_SESSION_MISMATCH: ${taskId}`);
    if (task.state === "active") return this.fileDiff(sessionId, fileId, hash, taskId);
    const records = this.store.taskSnapshots(taskId).flatMap((snapshot) => snapshot.files);
    const record = records.find((entry) => entry.id === fileId);
    if (!record) throw new Error(`FILE_NOT_FOUND: ${fileId}`);
    if (record.hash !== hash) throw new Error(`FILE_VERSION_STALE: ${fileId}`);
    const { patchRef: _patchRef, versionRef: _versionRef, ...file } = record;
    return { file, patch: await readFile(record.patchRef, "utf8") };
  }

  async patch(sessionId: SessionId, memberId: string, cursor?: string, taskId?: string): Promise<{ patch: string; nextCursor: string | null }> {
    const files = this.store.fileSummaries(sessionId, memberId, taskId);
    const sections = await Promise.all(files.map(async (file) => {
      const content = await readFile(file.patchRef, "utf8");
      return `# ${file.path}\n${content}`;
    }));
    const combined = sections.join("\n");
    const offset = cursor ? Number(cursor) : 0;
    const page = textPage(combined, offset);
    return { patch: page.text, nextCursor: page.nextOffset === null ? null : String(page.nextOffset) };
  }

  async patchForTask(taskId: string, sessionId: SessionId, memberId: string, cursor?: string): Promise<{ patch: string; nextCursor: string | null }> {
    const task = this.store.getTask(taskId);
    if (task.session_id !== sessionId) throw new Error(`TASK_SESSION_MISMATCH: ${taskId}`);
    if (task.state === "active") return this.patch(sessionId, memberId, cursor, taskId);
    const frozen = this.store.getTaskSnapshot(taskId, memberId);
    if (!frozen) throw new Error(`TASK_MEMBER_NOT_FOUND: ${memberId}`);
    const sections = await Promise.all(frozen.files.map(async (file) => `# ${file.path}\n${await readFile(file.patchRef, "utf8")}`));
    const page = textPage(sections.join("\n"), cursor ? Number(cursor) : 0);
    return { patch: page.text, nextCursor: page.nextOffset === null ? null : String(page.nextOffset) };
  }

  readSummaries(sessionId: SessionId, memberId: string, taskId?: string): FileSummary[] {
    return this.store.fileSummaries(sessionId, memberId, taskId).map(({ patchRef: _patchRef, versionRef: _versionRef, ...file }) => file);
  }

  async close(): Promise<void> {
    this.closed = true;
    const errors = new Set<unknown>();
    for (;;) {
      const work = this.pendingWork();
      if (!work.length) break;
      const results = await Promise.allSettled(work);
      for (const result of results) if (result.status === "rejected") errors.add(result.reason);
    }
    // 差异归档失败属于交付附加信息；关闭时保存错误并释放资源，不能留下半关闭 Core。
    for(const [key,error] of this.captureErrors){
      const [memberId,taskId]=JSON.parse(key) as [string,string|null];
      if(taskId)this.store.setTaskChangeSummary(taskId,"incomplete",error.message);
      console.error(JSON.stringify({event:"session_change_capture_failed",memberId,taskId,error:error.message}));
    }
    for(const error of errors)console.error(JSON.stringify({event:"session_change_flush_failed",error:error instanceof Error?error.message:String(error)}));
    this.captureErrors.clear();this.pending.clear();this.metadataWrites.clear();this.dirty.clear();this.onCaptured=undefined;
  }

  private async captureGit(
    sessionId: SessionId,
    member: SessionMember,
    repoRoot: string,
    baselineRef: string,
    previousRef: string,
    previousFiles: ReadonlyMap<string, CapturedFile>,
    taskId?: string,
    changedPaths?: string[],
  ): Promise<Array<FileSummary & { patchRef: string; versionRef: string }>> {
    const physicalRepoRoot = resolvePhysicalPath(repoRoot), memberRoot = resolvePhysicalPath(member.root);
    const current = await createWorkingTreeSnapshot(
      repoRoot,
      baselineRef,
      quaymeshSnapshotExcludes(repoRoot, member.root),
      changedPaths ? { previousRef, paths: changedPaths } : undefined,
    );
    const diffBase = ["diff", "--find-renames", baselineRef, current];
    const numstat = parseNumstat((await git(repoRoot, [
      ...diffBase, "--numstat", "-z",
    ], { maxBuffer: 50 * 1024 * 1024 })).stdout);
    const nameStatus = parseNameStatus((await git(repoRoot, [
      ...diffBase, "--name-status", "-z",
    ], { maxBuffer: 50 * 1024 * 1024 })).stdout);
    for (const entry of numstat) {
      const status = nameStatus.get(entry.path);
      if (status) {
        entry.status = status.status;
        entry.from = status.from;
      }
    }
    const files: Array<FileSummary & { patchRef: string; versionRef: string }> = [];
    const owned = await readOwnedFiles(ownershipPath(this.stateDir, sessionId, member.id, taskId));
    for (const entry of numstat) {
      const absolute = resolve(physicalRepoRoot, entry.path);
      if (!isPathInsideRoot(absolute, memberRoot)) continue;
      const displayPath = relative(memberRoot, absolute).replaceAll("\\", "/");
      const proof = owned[displayPath];
      const fromPath = entry.from ? relative(memberRoot, resolve(physicalRepoRoot, entry.from)).replaceAll("\\", "/") : null;
      const fromProof = fromPath ? owned[fromPath] : undefined;
      const canRevert = Boolean(proof?.safe && sameFileState(proof.after, await readFileState(absolute))
        && (!fromPath || fromProof?.safe && sameFileState(fromProof.after, await readFileState(resolve(member.root, fromPath)))));
      const patchArgs = ["diff", "--binary", "--no-color", baselineRef, current, "--", entry.path];
      if (entry.from) patchArgs.push(entry.from);
      const patch = (await git(repoRoot, patchArgs, { maxBuffer: 50 * 1024 * 1024 })).stdout;
      const binary = entry.additions === null || entry.removals === null || patch.includes("GIT binary patch");
      const patchRef = await this.writeEvidence(member, `patch-${current}-${digest(entry.path)}`, Buffer.from(patch, "utf8"), taskId);
      const file: CapturedFile = {
        id: `file_${digest([sessionId, member.id, displayPath]).slice(0, 24)}`,
        member_id: member.id,
        status: entry.status,
        path: displayPath,
        from: fromPath,
        additions: entry.additions,
        removals: entry.removals,
        hash: digest([current, entry.path, patch]),
        large: Buffer.byteLength(patch) > 1024 * 1024,
        binary,
        coverage: canRevert ? "session_owned" : "partial",
        revertible: canRevert,
        patchRef,
        versionRef: current,
      };
      const previous = previousFiles.get(displayPath);
      // The public hash deliberately includes the whole tree for version checks.
      // Recompute its old form using this file's full binary-capable patch: a
      // different file changing the tree must not reset this evidence's time.
      const unchanged = previous && sameFileIdentity(previous, file)
        && previous.hash === (previous.versionRef === current ? file.hash : digest([previous.versionRef, entry.path, patch]));
      files.push({ ...file, recordedAt: unchanged ? previous.recordedAt ?? null : Date.now() });
    }
    this.store.putChangeBaseline({
      session_id: sessionId,
      member_id: member.id,
      repo_root: repoRoot,
      baseline_ref: baselineRef,
      latest_ref: current,
      coverage: "session_owned",
    }, taskId);
    return files;
  }

  private async captureOrdinary(sessionId: SessionId, member: SessionMember, baselineRef: string, previousFiles: ReadonlyMap<string, CapturedFile>, taskId?: string): Promise<Array<FileSummary & { patchRef: string; versionRef: string }>> {
    const baseline = JSON.parse(await readFile(this.ordinaryBaselinePath(member, taskId), "utf8")) as OrdinaryBaseline;
    const files: Array<FileSummary & { patchRef: string; versionRef: string }> = [];
    const owned = await readOwnedFiles(ownershipPath(this.stateDir, sessionId, member.id, taskId));
    for (const before of baseline.files) {
      const absolute = memberFile(member.root, before.path).absolute;
      const current = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const previous = before.existed ? await readFile(before.contentRef) : null;
      if (previous === null && current === null) continue;
      if (previous !== null && current !== null && previous.equals(current)) continue;
      const version = digest([previous?.toString("base64") ?? null, current?.toString("base64") ?? null]);
      const proof = owned[before.path];
      const canRevert = Boolean(proof?.safe && sameFileState(proof.after, await readFileState(absolute)));
      const binary = before.binary || (current?.includes(0) ?? false);
      const oldText = previous?.toString("utf8") ?? "";
      const newText = current?.toString("utf8") ?? "";
      const patch = binary ? "" : createPatch(before.path, oldText, newText, "baseline", "current");
      const additions = binary ? null : countPatchLines(patch, "+");
      const removals = binary ? null : countPatchLines(patch, "-");
      const patchRef = await this.writeEvidence(member, `ordinary-patch-${digest(before.path)}-${version}`, Buffer.from(patch, "utf8"), taskId);
      const file: CapturedFile = {
        id: `file_${digest([sessionId, member.id, before.path]).slice(0, 24)}`,
        member_id: member.id,
        status: previous === null ? "A" : current === null ? "D" : "M",
        path: before.path,
        from: null,
        additions,
        removals,
        hash: version,
        large: (current?.length ?? 0) > 1024 * 1024,
        binary,
        coverage: canRevert ? "session_owned" : "partial",
        revertible: canRevert,
        patchRef,
        versionRef: `ordinary:${member.root}:${version}`,
      };
      const last = previousFiles.get(before.path);
      const unchanged = last && sameFileIdentity(last, file) && last.hash === file.hash;
      files.push({ ...file, recordedAt: unchanged ? last.recordedAt ?? null : Date.now() });
    }
    // Recording metadata is not part of the content/version identity.
    const versionRef = `ordinary:${digest(files.map(({ recordedAt: _recordedAt, ...file }) => file))}`;
    this.store.putChangeBaseline({
      session_id: sessionId,
      member_id: member.id,
      repo_root: member.root,
      baseline_ref: baselineRef,
      latest_ref: versionRef,
      coverage: "partial",
    }, taskId);
    return files.map((file) => ({ ...file, versionRef }));
  }

  private sessionIdFor(memberId: string): SessionId {
    return this.store.memberOwner(memberId).sessionId;
  }

  private ordinaryBaselinePath(member: SessionMember, taskId?: string): string {
    return join(this.stateDir, "session-file-baselines", this.sessionIdFor(member.id), member.id, ...(taskId ? [taskId] : []), "baseline.json");
  }

  private async writeEvidence(member: SessionMember, name: string, content: Buffer | null, taskId?: string): Promise<string> {
    const directory = join(this.stateDir, "session-evidence", this.sessionIdFor(member.id), member.id, ...(taskId ? [taskId] : []));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${name}.bin`);
    await writeFile(path, content ?? Buffer.alloc(0), { mode: 0o600 });
    return path;
  }
}

function parseNumstat(output: string): GitNumstat[] {
  const fields = output.split("\0").filter(Boolean);
  const files: GitNumstat[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++]!;
    const [add, remove, inlinePath] = header.split("\t");
    if (inlinePath) {
      files.push({ additions: statNumber(add), removals: statNumber(remove), path: inlinePath, from: null, status: "M" });
      continue;
    }
    const previous = fields[index++];
    const path = fields[index++];
    if (!path) continue;
    files.push({ additions: statNumber(add), removals: statNumber(remove), path, from: previous ?? null, status: "M" });
  }
  return files;
}

function parseNameStatus(output: string): Map<string, { status: "A" | "M" | "D" | "R"; from: string | null }> {
  const fields = output.split("\0").filter(Boolean);
  const files = new Map<string, { status: "A" | "M" | "D" | "R"; from: string | null }>();
  for (let index = 0; index < fields.length;) {
    const statusField = fields[index++]!;
    const statusCode = statusField[0];
    if (statusCode === "R" || statusCode === "C") {
      const from = fields[index++];
      const path = fields[index++];
      if (!path) continue;
      files.set(path, { status: "R", from: from ?? null });
      continue;
    }
    const path = fields[index++];
    if (!path) continue;
    const status = statusCode === "A" || statusCode === "D" ? statusCode : "M";
    files.set(path, { status, from: null });
  }
  return files;
}

function statNumber(value: string | undefined): number | null {
  if (!value || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countPatchLines(patch: string, prefix: string): number {
  return patch.split(/\r?\n/u).filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sameFileIdentity(previous: FileSummary, next: FileSummary): boolean {
  return previous.id === next.id && previous.member_id === next.member_id && previous.path === next.path
    && previous.status === next.status && previous.from === next.from && previous.binary === next.binary;
}
function quaymeshSnapshotExcludes(repoRoot: string, workspaceRoot: string): string[] {
  const relativePath = relative(resolvePhysicalPath(repoRoot), join(resolvePhysicalPath(workspaceRoot), ".quaymesh")).replaceAll("\\", "/");
  return relativePath && relativePath !== ".." && !relativePath.startsWith("../") ? [relativePath] : [];
}
