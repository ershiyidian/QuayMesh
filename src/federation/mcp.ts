import * as z from "zod/v4";
import {jsonReply} from "../bounded-reply.js";
import { sessionRecordedTool, type McpRegistrationTarget } from "../mcp-modern-server.js";
import type { FederationRuntime } from "./runtime.js";
import type { JsonRecord, ToolHandler } from "./types.js";
import { toolErrorResult } from "../session/outcome.js";

/** Adapt the registration boundary once; existing file, shell and provider tools stay unchanged. */
export function federatedTools(target: McpRegistrationTarget, runtime: FederationRuntime): McpRegistrationTarget {
  return {
    registerResource: target.registerResource.bind(target),
    registerTool: ((name: string, definition: Record<string, any>, handler: ToolHandler) => {
      const originalShape = definition.inputSchema;
      const appOnly = Array.isArray((definition._meta as any)?.ui?.visibility)
        && (definition._meta as any).ui.visibility.includes("app");
      if (!appOnly) runtime.addModelTool(name);
      runtime.handlers.set(name, async (input, extra) => {
        const schema = originalShape?.parse ? originalShape : z.object(originalShape ?? {});
        return handler(schema.parse(input) as JsonRecord, extra);
      });
      const wrapped = name === "open_workspace" || name === "attach_workspace" ? { ...definition,
        description: "Open root_id/subdirectory or an absolute path. Reuse the returned workspace_id.",
        inputSchema: { ...originalShape, path: z.string().optional(), root_id: z.string().optional().describe("Exported root from workspace_catalog."),
          subdirectory: z.string().optional().describe("Path within root_id.") },
      } : definition;
      const recorded = sessionRecordedTool(handler);
      return (target.registerTool as any)(name, wrapped, async (input: JsonRecord, extra: JsonRecord) => {
        try {
          const registeredShape = wrapped.inputSchema;
          const schema = registeredShape?.parse ? registeredShape : z.object(registeredShape ?? {});
          const parsed = schema.parse(input) as JsonRecord;
          const trustedInvocation = recorded ? runtime.trustedInvocation(name, parsed, extra) : undefined;
          const forwardedExtra = trustedInvocation ? { ...extra, trustedInvocation } : extra;
          if (recorded && runtime.routeNode(name, parsed) !== runtime.localId) {
            return await recorded(parsed, forwardedExtra, () => runtime.tool(name, parsed, forwardedExtra), { forwarded: true });
          }
          return await runtime.tool(name, parsed, forwardedExtra);
        } catch (error) { return toolErrorResult(error,{sideEffecting:definition.annotations?.readOnlyHint !== true,forwarded:true}); }
      });
    }) as McpRegistrationTarget["registerTool"],
  };
}
export function registerFederationTools(target: McpRegistrationTarget, runtime: FederationRuntime): void {
  runtime.addModelTool("workspace_catalog");
  runtime.addModelTool("copy_artifact");
  target.registerTool("workspace_catalog", {
    title: "Choose a workspace", description: "List exported roots and node capabilities. Select root_id for open_workspace.",
    inputSchema: { query: z.string().optional(), include_offline: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => await runtime.tool("workspace_catalog", input) as any);
  target.registerTool("copy_artifact", {
    title: "Copy an artifact between workspaces", description: "Copy a file between workers. start returns copy_id; observe reads progress; cancel stops it.",
    inputSchema: z.object({
      action:z.enum(["start","observe","cancel"]),request_key:z.string().min(1).max(128).optional(),
      source_workspace_id:z.string().min(1).optional(),destination_workspace_id:z.string().min(1).optional(),
      source_path:z.string().min(1).optional(),destination_path:z.string().min(1).optional(),
      overwrite:z.boolean().optional(),copy_id:z.string().min(1).optional(),
    }).strict().superRefine((input,context)=>{
      const required=input.action==="start"?["request_key","source_workspace_id","destination_workspace_id","source_path","destination_path"]:["copy_id"];
      const allowed=["action",...required,...(input.action==="start"?["overwrite"]:[])];
      for(const key of required)if(!(input as Record<string,unknown>)[key])context.addIssue({code:"custom",path:[key],message:"缺少当前操作的必要参数"});
      for(const key of Object.keys(input))if(!allowed.includes(key))context.addIssue({code:"custom",path:[key],message:"参数不适用于当前操作"});
    }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    try { const result = await runtime.copyArtifact(input, extra as unknown as JsonRecord); return jsonReply(result as Record<string,unknown>); }
    catch (error) { return toolErrorResult(error,{sideEffecting:input.action!=="observe",forwarded:true}); }
  });
}
