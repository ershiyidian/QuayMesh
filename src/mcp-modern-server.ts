import { toolDeadline, TOOL_DEADLINE_META } from "./tool-request-budget.js";
import * as z from "zod/v4";
import {
  McpServer,
  type ServerContext,
  type ServerOptions,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation as LegacyImplementation } from "@modelcontextprotocol/sdk/types.js";

export type McpRegistrationTarget = Pick<
  LegacyMcpServer,
  "registerTool" | "registerResource"
>;

export interface ModernMcpServerAdapter {
  server: McpServer;
  registrationTarget: McpRegistrationTarget;
}

export const SESSION_RECORDED_TOOL = Symbol("quaymesh.session_recorded_tool");

export interface SessionRecordedToolOptions {
  forwarded?: boolean;
}

export type SessionRecordedTool = (
  input: unknown,
  extra: Record<string, unknown>,
  operation: () => Promise<unknown>,
  options?: SessionRecordedToolOptions,
) => Promise<unknown>;

export function markSessionRecordedTool<T extends (...args: any[]) => any>(
  handler: T,
  recorder: SessionRecordedTool,
): T {
  Object.defineProperty(handler, SESSION_RECORDED_TOOL, {
    value: recorder,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return handler;
}

export function sessionRecordedTool(handler: unknown): SessionRecordedTool | undefined {
  if (typeof handler !== "function") return undefined;
  const recorder = (handler as unknown as Record<PropertyKey, unknown>)[SESSION_RECORDED_TOOL];
  return typeof recorder === "function" ? recorder as SessionRecordedTool : undefined;
}

type RegistrationReplay = (target: McpRegistrationTarget) => void;

type ModernRegisterTool = (
  name: string,
  definition: Record<string, unknown>,
  handler: (input: unknown, context: ServerContext) => unknown,
) => unknown;

type ModernRegisterResource = (...args: unknown[]) => unknown;

function wireSchema(value: unknown): StandardSchemaWithJSON {
  const schema = value && typeof value === "object" && "~standard" in value
    ? value as StandardSchemaWithJSON : z.object(value as z.ZodRawShape);
  const standard = schema["~standard"];
  const compact = (json: Record<string, unknown>) => {
    // MCP 默认采用 2020-12；省略重复方言声明，运行时验证保留原实现。
    if (json.$schema !== "https://json-schema.org/draft/2020-12/schema") return json;
    const { $schema, ...shape } = json;
    return shape;
  };
  return {"~standard": {...standard, jsonSchema: {
    input: options => compact(standard.jsonSchema.input(options)),
    output: options => compact(standard.jsonSchema.output(options)),
  }}};
}

function wireAnnotations(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const annotations=value as Record<string,unknown>;
  const defaults:Record<string,boolean>={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
  const entries=Object.entries(annotations).filter(([key,item])=>{
    if(annotations.readOnlyHint===true&&["destructiveHint","idempotentHint"].includes(key))return false;
    return defaults[key]!==item;
  });
  return entries.length?Object.fromEntries(entries):undefined;
}

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernTool = server.registerTool.bind(server) as unknown as ModernRegisterTool;
  const registerModernResource = server.registerResource.bind(server) as unknown as ModernRegisterResource;
  const registrationTarget: McpRegistrationTarget = {
    registerTool: ((
      name: string,
      definition: Record<string, unknown>,
      handler: (input: unknown, extra: Record<string, unknown>) => unknown,
    ) => registerModernTool(
      name,
      {...definition,annotations:wireAnnotations(definition.annotations),
        ...(definition.inputSchema ? {inputSchema: wireSchema(definition.inputSchema)} : {}),
        ...(definition.outputSchema ? {outputSchema: wireSchema(definition.outputSchema)} : {}),
      },
      async (input, context) => {
        const extra=legacyToolHandlerExtra(context);
        extra._meta={...recordValue(extra._meta),[TOOL_DEADLINE_META]:toolDeadline(name,input,extra._meta)};
        return handler(input,extra);
      },
    )) as LegacyMcpServer["registerTool"],
    registerResource: ((...args: unknown[]) => {
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => unknown;
      return registerModernResource(
        ...args.slice(0, -1),
        (...callbackArgs: unknown[]) => {
          const context = callbackArgs.at(-1) as ServerContext;
          return callback(
            ...callbackArgs.slice(0, -1),
            legacyToolHandlerExtra(context),
          );
        },
      );
    }) as unknown as LegacyMcpServer["registerResource"],
  };

  return {
    server,
    registrationTarget,
  };
}

export function compileMcpRegistrationSurface(
  registerSurface: (target: McpRegistrationTarget) => void,
): (target: McpRegistrationTarget) => void {
  const registrations: RegistrationReplay[] = [];
  const toolNames = new Set<string>();
  const resourceUris = new Set<string>();
  const recordingTarget: McpRegistrationTarget = {
    registerTool: ((...args: unknown[]) => {
      const name = args[0];
      const definition = args[1];
      const handler = args.at(-1);
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("INVALID_TOOL_REGISTRATION_NAME");
      }
      if (toolNames.has(name)) throw new Error(`DUPLICATE_TOOL_REGISTRATION: ${name}`);
      toolNames.add(name);
      if (isAppOnlyToolDefinition(definition)) {
        if (typeof handler !== "function") {
          throw new Error(`APP_TOOL_HANDLER_REQUIRED: ${name}`);
        }
        if (!recordValue(definition).outputSchema) {
          throw new Error(`APP_TOOL_OUTPUT_SCHEMA_REQUIRED: ${name}`);
        }
      }
      registrations.push((target) => {
        (target.registerTool as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerTool"],
    registerResource: ((...args: unknown[]) => {
      const uri = args[1];
      if (typeof uri !== "string" || uri.length === 0) {
        throw new Error("INVALID_RESOURCE_REGISTRATION_URI");
      }
      if (resourceUris.has(uri)) throw new Error(`DUPLICATE_RESOURCE_REGISTRATION: ${uri}`);
      resourceUris.add(uri);
      registrations.push((target) => {
        (target.registerResource as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerResource"],
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());
  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

function isAppOnlyToolDefinition(value: unknown): boolean {
  const definition = recordValue(value);
  const meta = recordValue(definition._meta);
  const ui = recordValue(meta.ui);
  return Array.isArray(ui.visibility) && ui.visibility.includes("app");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function modernMcpAdapterErrorLogFields(error: Error): Record<string, unknown> {
  const cause = error.cause;
  return {
    error: error.message,
    errorName: error.name,
    ...(cause === undefined ? {} : {
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : { name: typeof cause, message: String(cause) },
    }),
  };
}

function legacyToolHandlerExtra(context: ServerContext): Record<string, unknown> {
  return {
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo: context.http?.req,
    sendNotification: context.mcpReq.notify,
    sendRequest: context.mcpReq.send,
  };
}
