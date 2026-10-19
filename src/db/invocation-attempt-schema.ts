export const invocationAttemptSchema = `
ALTER TABLE qm_invocations ADD COLUMN task_id TEXT REFERENCES qm_tasks(id);
ALTER TABLE qm_invocations ADD COLUMN retry_of_invocation_id TEXT REFERENCES qm_invocations(id);
CREATE UNIQUE INDEX qm_invocations_retry_of ON qm_invocations(retry_of_invocation_id)
  WHERE retry_of_invocation_id IS NOT NULL;
-- 仅依据已有运行关联补全原任务；证据不足的历史回执不能被新任务继承。
UPDATE qm_invocations AS i SET task_id=(
  SELECT l.task_id FROM console_operations o JOIN qm_run_links l ON l.run_id=o.run_id
    JOIN qm_tasks t ON t.id=l.task_id AND t.session_id=l.session_id
  WHERE o.id=i.operation_id AND l.session_id=i.session_id AND l.member_id=i.member_id
  LIMIT 1
) WHERE EXISTS(
  SELECT 1 FROM console_operations o JOIN qm_run_links l ON l.run_id=o.run_id
    JOIN qm_tasks t ON t.id=l.task_id AND t.session_id=l.session_id
  WHERE o.id=i.operation_id AND l.session_id=i.session_id AND l.member_id=i.member_id
);
`;
