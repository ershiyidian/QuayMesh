import type {Router, Request, Response} from "express";
import * as z from "zod/v4";
import {LOCAL_OWNER_ID} from "../oauth-provider.js";
import {taskPrincipalFromAuthInfo} from "../tasks/task-access.js";
import type {LocalUserApiService} from "./service.js";
import {localApiFailure} from "./protocol.js";

const id = z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f]+$/);
const scope = z.enum(["status:read", "tasks:read", "events:read", "peer:send", "peer:read", "peer:ack"]);
const registration = z.object({nodeId: id, clientName: z.string().trim().min(1).max(128),
  capabilities: z.array(scope).min(1).max(6).optional(), taskIds: z.array(id).min(1).max(256).nullable().optional(),
  peerTaskIds: z.array(id).min(1).max(256).nullable().optional(), sourceTaskId: id.nullable().optional(), expiresAt: z.number().int()}).strict();

/** Mount only AFTER existing owner-cookie + CSRF middleware. These are direct
 * owner routes, deliberately absent from ConsoleOperations' peer dispatch. */
export function mountLocalClientOwnerRoutes(router: Router, service: LocalUserApiService): void {
  const action = (handler: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {res.json(await handler(req));}
    catch (error) {
      const value = error instanceof z.ZodError ? {code: "LOCAL_API_INVALID_GRANT"} : error;
      res.status(409).json(localApiFailure("owner", value));
    }
  };
  // This deployment has the same single verified owner as its OAuth provider.
  // A client name or registration body cannot choose another owner identity.
  const principal = () => taskPrincipalFromAuthInfo({extra: {owner_id: LOCAL_OWNER_ID}});
  router.get("/api/local-clients", action(() => ({authorityNodeId: service.authorityId, clients: service.list(principal())})));
  router.post("/api/local-clients", action(req => service.register(principal(), registration.parse(req.body))));
  router.post("/api/local-clients/:grantId/rotate", action(req => {
    z.object({}).strict().parse(req.body ?? {}); return service.rotate(principal(), id.parse(req.params.grantId));
  }));
  router.post("/api/local-clients/:grantId/revoke", action(req => {
    z.object({}).strict().parse(req.body ?? {}); return service.revoke(principal(), id.parse(req.params.grantId));
  }));
}
