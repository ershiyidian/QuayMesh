/** Public Task-card messaging contract; no server or database dependencies. */
export const MAX_TASK_MESSAGE_BYTES = 16 * 1024;
// The body is present in structuredContent and again in the JSON text block.
// Leave 4 KiB of the 48 KiB reply for message fields and the enclosing receipt.
export const MAX_TASK_MESSAGE_BODY_WIRE_BYTES = 44 * 1024;
const encoder = new TextEncoder();

export function taskMessageBodyFits(body: string): boolean {
  const encoded = JSON.stringify(body);
  const encodedBytes = encoder.encode(encoded).byteLength;
  return Boolean(body.trim()) && encoder.encode(body).byteLength <= MAX_TASK_MESSAGE_BYTES
    && encodedBytes <= MAX_TASK_MESSAGE_BYTES + 2
    && encodedBytes + encoder.encode(JSON.stringify(encoded)).byteLength <= MAX_TASK_MESSAGE_BODY_WIRE_BYTES;
}

export interface TaskMessageView {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  reply_to: string[];
  body: string;
  created_at: string;
  offered_at: string | null;
  acknowledged_at: string | null;
  status: "queued" | "offered" | "acknowledged" | "replied";
}

export interface TaskMessageMailbox {
  /** Last message sequence. Acknowledgement changes do not advance it. */
  sequence: number;
  pending: number;
}

export interface TaskMessageReceipt {
  task_id: string;
  message: TaskMessageView;
  replayed: boolean;
  mailbox: TaskMessageMailbox;
}

export interface TaskMessagePage {
  task_id: string;
  messages: TaskMessageView[];
  next_before_sequence: number | null;
  mailbox: TaskMessageMailbox;
}
