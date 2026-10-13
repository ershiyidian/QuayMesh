export function rangeDays(value: string): number | null {
  return ["1", "7", "30"].includes(value) ? Number(value) : null;
}

export function pathContains(child: string, parent: string): boolean {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(parent);
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const root = normalize(parent);
  const path = normalize(child);
  return path === root || path.startsWith(`${root}/`);
}

export function safeConsoleUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
