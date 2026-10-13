import type { UsageTotals } from "../../console-workbench/query.js";

export function cacheRatio(value: UsageTotals): number | null {
  if (value.input === null || value.cached === null || value.fieldMissing.input || value.fieldMissing.cached) return null;
  return value.input > 0 ? value.cached / value.input * 100 : 0;
}

export function noncachedInput(value: UsageTotals): number | null {
  if (value.input === null || value.cached === null || value.fieldMissing.input || value.fieldMissing.cached) return null;
  return value.input - value.cached;
}

export function usageParts(value: UsageTotals): { output: number; input: number; cache: number; complete: boolean } {
  const input = noncachedInput(value);
  const complete = input !== null && value.output !== null && !value.fieldMissing.output;
  if (!complete || !value.total) return { output: 0, input: 0, cache: 0, complete };
  return { output: value.output! / value.total * 100, input: input! / value.total * 100, cache: value.cached! / value.total * 100, complete };
}
