export const taskMemberSchema = `
ALTER TABLE qm_task_members ADD COLUMN context_inherited INTEGER NOT NULL DEFAULT 0;
UPDATE qm_task_members SET context_inherited=1;
INSERT OR IGNORE INTO qm_task_members(task_id,member_id,first_seen_at,context_inherited)
SELECT e.task_id,e.member_id,MIN(e.created_at),0
FROM qm_events e
JOIN qm_tasks t ON t.id=e.task_id AND t.session_id=e.session_id
JOIN qm_session_members m ON m.id=e.member_id AND m.session_id=e.session_id
WHERE e.task_id IS NOT NULL
GROUP BY e.task_id,e.member_id;
`;
