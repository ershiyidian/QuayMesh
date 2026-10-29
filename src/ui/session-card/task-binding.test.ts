import assert from "node:assert/strict";
import test from "node:test";
import type { TaskBindingState, TaskBindingView } from "../../tasks/task-binding.js";
import { createPreviewSource, previewSnapshot } from "./preview.js";
import { applySnapshot, createCardState } from "./state.js";
import { canContinueTask } from "./task-binding.js";
import { createTaskResumeController } from "./task-resume-controller.js";

test("a superseded receipt requires explicit inspection even if a background read later shows the same Task selected", async () => {
  const state = createCardState(), taskId = previewSnapshot.taskId!;
  applySnapshot(state, { ...previewSnapshot, taskState: "active", finalization: null });
  state.connection = "live";
  const unbound: TaskBindingView = { task_id: taskId, entry_available: true, binding_revision: 0,
    selected_task_id: null, status: "unbound", can_resume: true, can_continue: false };
  let observed: TaskBindingState | null = unbound, inspections = 0;
  const source = { ...createPreviewSource(), live: true, get taskBinding() { return observed; },
    inspectTaskBinding: async () => { inspections++; return observed as TaskBindingView; },
    resumeTask: async () => { observed = null; throw new Error("TASK_BINDING_REPLAY_SUPERSEDED: The old request no longer selects this Task."); },
  };
  const controller = createTaskResumeController(state, source, () => {}, () => {}, () => {});
  controller.sync(); await controller.resume();
  assert.equal(state.taskResume.requiresInspection, true);
  observed = { ...unbound, binding_revision: 3, selected_task_id: taskId, status: "selected", can_continue: true };
  controller.sync();
  assert.equal(canContinueTask(state), false);
  assert.equal(inspections, 0);
  await controller.inspect();
  assert.equal(inspections, 1);
  assert.equal(state.taskResume.requiresInspection, false);
  assert.equal(canContinueTask(state), true);
  controller.dispose();
});
