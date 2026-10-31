import type {TaskPeerMailboxStore} from "../messaging/task-peer-mailbox.js";
import type {LocalAuthentication, LocalUserGrantStore} from "./grants.js";
import type {LocalObservationStore} from "./observations.js";
import {localApiParams, type LocalUserApiMethod} from "./protocol.js";

/** Only the authority constructs this dispatcher. Workers forward this exact
 * small method set; they do not operate peer inboxes on mirrored Task data. */
export class LocalUserDispatcher {
  constructor(private readonly grants: LocalUserGrantStore, private readonly observations: LocalObservationStore,
    private readonly peer: TaskPeerMailboxStore) {}
  async dispatch(peerId: string, identity: LocalAuthentication, method: LocalUserApiMethod, input: Record<string, unknown>): Promise<unknown> {
    const {params} = localApiParams(method, input);
    const grant = this.grants.authenticateForwarded(peerId, identity);
    switch (method) {
      case "status.get": return this.observations.status(grant);
      case "tasks.list": return this.observations.tasks(grant, params);
      case "tasks.get": return this.observations.task(grant, String(params.task_id));
      case "events.read": case "events.watch": return this.observations.events(grant, params);
      case "peer.send": return this.peer.send(grant, {targetTaskId: String(params.target_task_id), messageKey: String(params.message_key),
        body: String(params.body), ...(params.reply_to === undefined ? {} : {replyTo: String(params.reply_to)})});
      case "peer.receive": return this.peer.receive(grant, {requestKey: String(params.request_key),
        ...(params.after_sequence === undefined ? {} : {afterSequence: Number(params.after_sequence)}),
        ...(params.limit === undefined ? {} : {limit: Number(params.limit)})});
      case "peer.ack": return this.peer.ack(grant, {deliveryId: String(params.delivery_id), messageIds: params.message_ids as string[]});
    }
  }
}
