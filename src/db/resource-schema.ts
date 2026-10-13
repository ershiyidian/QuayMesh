export const resourceSchema = `
ALTER TABLE execution_claims ADD COLUMN scopes_json TEXT;
ALTER TABLE execution_claims ADD COLUMN operation_id TEXT;
ALTER TABLE execution_claims ADD COLUMN task_id TEXT;
ALTER TABLE execution_claims ADD COLUMN title TEXT;
ALTER TABLE execution_waiters ADD COLUMN scopes_json TEXT;
ALTER TABLE execution_waiters ADD COLUMN operation_id TEXT;
ALTER TABLE execution_waiters ADD COLUMN task_id TEXT;
ALTER TABLE execution_waiters ADD COLUMN title TEXT;
CREATE INDEX execution_claims_operation ON execution_claims(operation_id);
`;
