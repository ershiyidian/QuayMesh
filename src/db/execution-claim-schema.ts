/** A claim belongs to one execution attempt, independently of the Task lifetime. */
export const executionClaimSchema = `
ALTER TABLE execution_claims ADD COLUMN execution_id TEXT;
ALTER TABLE execution_claims ADD COLUMN execution_generation TEXT;
ALTER TABLE execution_claims ADD COLUMN owner_process_start TEXT;
ALTER TABLE execution_waiters ADD COLUMN execution_id TEXT;
ALTER TABLE execution_waiters ADD COLUMN execution_generation TEXT;
ALTER TABLE execution_waiters ADD COLUMN owner_process_start TEXT;
CREATE INDEX execution_claims_execution ON execution_claims(execution_id);
`;
