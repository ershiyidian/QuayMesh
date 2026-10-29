export const invocationPayloadSchema = `
ALTER TABLE qm_invocations ADD COLUMN response_uses_result INTEGER NOT NULL DEFAULT 0;
UPDATE qm_invocations SET response_uses_result=1,response_json=NULL
WHERE response_at IS NOT NULL AND response_json IS NOT NULL AND response_json=result_json;
`;
