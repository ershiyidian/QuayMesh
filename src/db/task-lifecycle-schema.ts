export const taskLifecycleSchema = `
ALTER TABLE qm_tasks ADD COLUMN closure_reason TEXT;
ALTER TABLE qm_tasks ADD COLUMN archived_at TEXT;
ALTER TABLE qm_tasks ADD COLUMN delivery_ended_at TEXT;
ALTER TABLE qm_tasks ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE qm_tasks ADD COLUMN change_summary_state TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE qm_tasks ADD COLUMN change_summary_error TEXT;
UPDATE qm_tasks SET closure_reason='explicit',delivery_ended_at=finished_at,archived_at=finished_at
  WHERE state='closed' AND result_status IS NOT NULL;
UPDATE qm_tasks SET closure_reason='legacy_archive',archived_at=finished_at
  WHERE state='closed' AND result_status IS NULL;
CREATE INDEX qm_tasks_source_state ON qm_tasks(source_kind,state,created_at DESC);
CREATE TABLE qm_widget_stages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('mount','initialized','first_snapshot','visible','hidden','teardown','error')),
  resource_version TEXT NOT NULL,
  mount_id TEXT,
  display_mode TEXT,
  visible INTEGER,
  observed_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES qm_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES qm_sessions(id) ON DELETE CASCADE
);
CREATE INDEX qm_widget_stages_task_time ON qm_widget_stages(task_id,observed_at DESC);
CREATE INDEX qm_widget_stages_mount_stage ON qm_widget_stages(task_id,mount_id,id DESC);
`;
