import { isDeepStrictEqual } from "node:util";
import type { CommandSummary, Snapshot } from "./types.js";

const aliases = ["currentCommand", "runningCommand", "lastCommand"] as const;
const key = (command: CommandSummary) => JSON.stringify([command.id, command.operation_id, command.member_id]);

function identified(command: CommandSummary): boolean {
  return Object.hasOwn(command, "invocation_id") && command.invocation_id !== undefined
    && Object.hasOwn(command, "effect") && command.effect !== undefined;
}

/** Explicit null/unknown are current evidence; only omitted fields identify the old format. */
export function hasCommandIdentity(snapshot: Snapshot): boolean {
  return snapshot.commands.every(identified)
    && aliases.every(alias => !snapshot[alias] || identified(snapshot[alias]));
}

/** Same source revision may add identity, never replace command facts or other snapshot data. */
export function upgradeCommandIdentity(previous: Snapshot, incoming: Snapshot): Snapshot | null {
  if (previous.sessionId !== incoming.sessionId || (previous.taskId ?? null) !== (incoming.taskId ?? null)
    || previous.rev !== incoming.rev || hasCommandIdentity(previous) || !hasCommandIdentity(incoming)
    || previous.commands.length === 0 || previous.commands.length !== incoming.commands.length) return null;
  const next = new Map(incoming.commands.map(command => [key(command), command]));
  if (next.size !== incoming.commands.length
    || new Set(previous.commands.map(key)).size !== previous.commands.length) return null;
  const merge = (before: CommandSummary): CommandSummary | null => {
    const after = next.get(key(before));
    if (!after) return null;
    const {invocation_id: beforeId, effect: beforeEffect, ...beforeFacts} = before;
    const {invocation_id: afterId, effect: afterEffect, ...afterFacts} = after;
    if (!isDeepStrictEqual(beforeFacts, afterFacts)
      || Object.hasOwn(before, "invocation_id") && beforeId !== afterId
      || Object.hasOwn(before, "effect") && beforeEffect !== afterEffect) return null;
    return {...before, invocation_id: afterId, effect: afterEffect};
  };
  const commands: CommandSummary[] = [];
  for (const command of previous.commands) {
    const upgraded = merge(command);
    if (!upgraded) return null;
    commands.push(upgraded);
  }
  const result = {...previous, commands};
  for (const alias of aliases) {
    const command = previous[alias];
    if (!command) continue;
    const upgraded = merge(command);
    if (!upgraded) return null;
    result[alias] = upgraded;
  }
  return result;
}
