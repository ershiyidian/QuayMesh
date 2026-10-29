import assert from "node:assert/strict";
import test from "node:test";
import type { TaskBindingState, TaskBindingView } from "../../tasks/task-binding.js";
import type { SessionCardSource } from "./source.js";
import { createCardController } from "./controller.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";
import { canContinueTask, canResumeTask } from "./task-binding.js";
import { createTaskResumeController } from "./task-resume-controller.js";

const taskId = previewSnapshot.taskId!;
function binding(overrides: Partial<TaskBindingView> = {}): TaskBindingView {
  return { task_id: taskId, entry_available: true, binding_revision: 0, selected_task_id: null,
    status: "unbound", can_resume: true, can_continue: false, ...overrides };
}
function selected(revision = 1) { return binding({ binding_revision: revision, selected_task_id: taskId, status: "selected", can_continue: true }); }
function stateFixture() {
  const state = createCardState();
  applySnapshot(state, { ...previewSnapshot, taskState: "active", finalization: null });
  state.connection = "live";
  state.messages.draft = "保留尚未提交的要求";
  return state;
}

test("a lost resume receipt preserves its exact key and revision; retry never wakes the host or changes Task activity", async () => {
  const state = stateFixture(), snapshot = state.snapshot, confirmed = state.lastConfirmedAt;
  let observed: TaskBindingState | null = binding(), persisted: TaskBindingView | null = null, followups = 0;
  const attempts: Array<{ revision: number; key: string }> = [];
  const source: SessionCardSource = { ...createPreviewSource(), live: true, supportsHostMessage: true,
    get taskBinding() { return observed; }, inspectTaskBinding: async () => observed as TaskBindingView,
    resumeTask: async (revision, key) => {
      attempts.push({ revision, key });
      persisted ??= selected();
      if (attempts.length === 1) { observed = null; throw new Error("response lost after saving"); }
      observed = persisted; return persisted;
    }, continueSession: async () => { followups++; }, requestHostTaskResume: async () => { followups++; },
  };
  const controller = createTaskResumeController(state, source, () => {}, () => {}, () => {});
  controller.sync();
  assert.equal(canResumeTask(state), true);
  const first = controller.resume();
  assert.equal(controller.resume(), first);
  await first;
  const pending = { ...state.taskResume.pending! };
  assert.equal(pending.expectedRevision, 0);
  assert.ok(pending.key);
  assert.equal(state.taskBinding, null);
  assert.equal(canContinueTask(state), false);
  assert.match(state.taskResume.error!, /回执未确认/);
  await controller.resume();
  assert.deepEqual(attempts, [{ revision: 0, key: pending.key }, { revision: 0, key: pending.key }]);
  assert.equal(state.taskResume.pending, null);
  assert.equal(canContinueTask(state), true);
  assert.match(state.taskResume.notice!, /尚未请求 GPT 继续/);
  assert.equal(state.snapshot, snapshot);
  assert.equal(state.lastConfirmedAt, confirmed);
  assert.equal(state.messages.draft, "保留尚未提交的要求");
  assert.equal(followups, 0);
  controller.dispose();
});

test("a rejected revision requires inspection and another explicit click; background updates do not silently retry", async () => {
  const state = stateFixture();
  const other = binding({ binding_revision: 1, selected_task_id: "another-task", status: "different_task" });
  let observed: TaskBindingState | null = binding(), reads = 0;
  const attempts: Array<{ revision: number; key: string }> = [];
  const source: SessionCardSource = { ...createPreviewSource(), live: true,
    get taskBinding() { return observed; },
    inspectTaskBinding: async () => { reads++; observed = other; return other; },
    resumeTask: async (revision, key) => {
      attempts.push({ revision, key });
      if (attempts.length === 1) { observed = null; throw Object.assign(new Error("TASK_BINDING_CHANGED: inspect again"), { code: "TASK_BINDING_CHANGED" }); }
      observed = selected(2); return observed;
    },
  };
  const controller = createTaskResumeController(state, source, () => {}, () => {}, () => {});
  controller.sync(); await controller.resume();
  assert.equal(state.taskResume.pending, null);
  assert.equal(state.taskResume.requiresInspection, true);
  observed = other; controller.sync();
  await controller.resume();
  assert.equal(attempts.length, 1);
  assert.equal(reads, 0);
  await controller.inspect();
  assert.equal(attempts.length, 1, "inspection itself never selects a Task");
  assert.equal(state.taskResume.requiresInspection, false);
  await controller.resume();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].revision, 1);
  assert.notEqual(attempts[1].key, attempts[0].key);
  assert.equal(canContinueTask(state), true);
  controller.dispose();
});

test("missing entry authority offers only an explicit host request; a closed Task cannot resume or continue", async () => {
  const state = stateFixture(), snapshot = state.snapshot;
  const unavailable: TaskBindingState = { task_id: taskId, entry_available: false, binding_revision: null,
    selected_task_id: null, status: "entry_unavailable", can_resume: false, can_continue: false, reason: "No host entry" };
  let writes = 0, sent = 0;
  const source: SessionCardSource = { ...createPreviewSource(), live: true, supportsHostMessage: true, taskBinding: unavailable,
    inspectTaskBinding: async () => { throw new Error("TASK_ENTRY_REQUIRED"); },
    resumeTask: async () => { writes++; return selected(); }, requestHostTaskResume: async () => { sent++; },
  };
  const controller = createTaskResumeController(state, source, () => {}, () => {}, () => {});
  controller.sync(); await controller.resume();
  assert.equal(writes, 0); assert.equal(sent, 0);
  await controller.requestHost();
  assert.equal(sent, 1);
  assert.equal(state.taskBinding, unavailable);
  assert.equal(state.snapshot, snapshot);
  assert.match(state.taskResume.notice!, /尚未确认恢复或开始执行/);
  applySnapshot(state, { ...state.snapshot!, rev: state.snapshot!.rev + 1, taskState: "closed", taskResult: "completed" });
  await controller.resume(); await controller.requestHost();
  assert.equal(writes, 0); assert.equal(sent, 1); assert.equal(canContinueTask(state), false);
  controller.dispose();
});

test("unchanged Task polls refresh binding independently through the existing timer; hidden cards add no binding requests", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.parse("2026-10-28T09:00:00Z") });
  const state = stateFixture();
  let observed: TaskBindingState | null = binding(), reads = 0, bindingReads = 0;
  const snapshot = state.snapshot!;
  const source: SessionCardSource = { ...createPreviewSource(), live: true,
    get taskBinding() { return observed; }, snapshot: async () => ++reads === 1 ? snapshot : null,
    inspectTaskBinding: async () => { bindingReads++; return observed as TaskBindingView; }, resumeTask: async () => selected(),
  };
  const doc = new class extends EventTarget { hidden = false; defaultView = null; getElementById() { return null; } }();
  const view = { render() {}, renderPanel() {}, renderFooter() {}, fillTimers() {}, dispose() {} };
  const controller = createCardController(state, view, source, doc as unknown as Document);
  t.after(() => controller.dispose());
  controller.start(); await controller.pollOnce();
  assert.equal(canContinueTask(state), false);
  const acceptedSnapshot = state.snapshot, activity = state.snapshot!.lastActivityAt;
  observed = selected(); await controller.pollOnce();
  assert.equal(canContinueTask(state), true);
  observed = binding({ binding_revision: 2, selected_task_id: "task-b", status: "different_task" });
  await controller.pollOnce();
  assert.equal(canContinueTask(state), false);
  assert.equal(state.snapshot, acceptedSnapshot);
  assert.equal(state.snapshot!.lastActivityAt, activity);
  assert.equal(state.messages.draft, "保留尚未提交的要求");
  assert.equal(bindingReads, 0);
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
  const before = reads;
  t.mock.timers.tick(60_000); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, before); assert.equal(bindingReads, 0);
});

test("disposing during a resume aborts its request and a late reply cannot claim success", async () => {
  const state = stateFixture();
  let release!: (value: TaskBindingView) => void, signal: AbortSignal | undefined, renders = 0;
  const source: SessionCardSource = { ...createPreviewSource(), live: true, taskBinding: binding(),
    inspectTaskBinding: async () => binding(), resumeTask: (_revision, _key, inputSignal) => {
      signal = inputSignal; return new Promise(resolve => { release = resolve; });
    },
  };
  const controller = createTaskResumeController(state, source, () => { renders++; }, () => {}, () => {});
  controller.sync(); const pending = controller.resume();
  const before = renders; controller.dispose();
  assert.equal(signal!.aborted, true);
  release(selected()); await pending;
  assert.equal(renders, before);
  assert.equal(state.taskResume.notice, null);
  assert.equal(state.taskBinding?.status, "unbound");
});
