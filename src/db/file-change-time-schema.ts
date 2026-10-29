// Old created_at values describe captures, not proven changes. Keep them intact;
// the new nullable columns are populated only by evidence-aware captures.
export const fileChangeTimeSchema = `
ALTER TABLE qm_file_changes ADD COLUMN recorded_at INTEGER;
ALTER TABLE qm_task_file_changes ADD COLUMN recorded_at INTEGER;
`;
