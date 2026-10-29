import assert from "node:assert/strict";
import test from "node:test";
import { sessionToolRoute } from "./tool-routing.js";

test("Task actions and member details have explicit shared routing categories", () => {
  for (const tool of ["start_session", "finish_task", "qm_widget_stage", "qm_session", "qm_session_continue",
    "qm_task_messages", "qm_task_message_enqueue", "task_messages"]) assert.equal(sessionToolRoute(tool), "task", tool);
  for (const tool of ["qm_file_diff", "qm_command_output", "qm_command_outputs", "qm_instruction", "qm_patch", "qm_revert", "qm_file_url"])
    assert.equal(sessionToolRoute(tool), "member", tool);
  assert.equal(sessionToolRoute("qm_new_task_action"), "none", "new Task APIs cannot accidentally inherit member routing from qm_");
  assert.equal(sessionToolRoute("read"), "none", "workspace tools retain their separate workspace-handle routing");
});
