/** Old intents intentionally remain unknown until reconciled; never infer safety from an error string. */
export const taskFinalizationSchema = `
ALTER TABLE qm_task_finalizations ADD COLUMN finalization_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE qm_task_finalizations ADD COLUMN recovery_state TEXT
  CHECK(recovery_state IS NULL OR recovery_state IN ('safe','reconcile','superseded'));
`;
