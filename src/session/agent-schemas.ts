import * as z from "zod/v4";

const idSchema = z.string().min(1).max(256);
const resourcesSchema = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)).max(16);
const contextSchema = z.object({
  summary: z.string().max(12_000),
  files: z.array(z.object({
    path: z.string().min(1).max(1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).max(24),
}).strict();

export const spawnAgentSchema = z.object({
  workspace_id: idSchema,
  message: z.string().min(1),
  name: z.string().trim().min(1).max(160).optional(),
  target: idSchema.optional(),
  read_only: z.boolean().optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  resources: resourcesSchema.optional(),
  context: contextSchema.optional(),
}).strict();

export const followupAgentSchema = z.object({
  workspace_id: idSchema,
  agent_id: idSchema,
  message: z.string().min(1),
  read_only: z.boolean().optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  resources: resourcesSchema.optional(),
  context: contextSchema.optional(),
}).strict();

export const sendMessageSchema = z.object({
  workspace_id: idSchema,
  agent_id: idSchema,
  message: z.string().min(1),
}).strict();

export const waitAgentSchema = z.object({
  workspace_id: idSchema,
  agent_ids: z.array(idSchema).min(1).max(50),
  timeout_ms: z.number().int().min(0).max(10_000).default(5_000),
  result_cursor: z.string().max(4096).optional(),
}).strict();

export const interruptAgentSchema = z.object({
  workspace_id: idSchema,
  agent_id: idSchema,
}).strict();

export const listAgentsSchema = z.object({
  workspace_id: idSchema,
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(50).default(10),
}).strict();
