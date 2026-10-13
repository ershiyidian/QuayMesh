import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";

// Read-only compatibility view of Desktop 26.901.6511.0. Desktop owns all writes.
const savedProject = z.object({ id: z.string(), name: z.string(), rootPaths: z.array(z.string()).min(1),
  createdAt: z.number(), updatedAt: z.number() }).passthrough();
const catalog = z.object({
  "local-projects": z.record(z.string(), savedProject),
  "app-server-project-id-by-legacy-project-id-by-host": z.record(z.string(), z.record(z.string(), z.string())).optional(),
  "thread-project-assignments": z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export class DesktopProjectMissingError extends Error {
  constructor() { super("Desktop client has not saved this project. App-server registration alone is insufficient; complete the Desktop client registration before starting a model."); }
}
export class DesktopMappingPendingError extends Error {
  constructor() { super("Desktop project mapping is missing or ambiguous; client migration must complete first."); }
}

function containsPath(parent: string, child: string, key: (path: string) => string): boolean {
  const outer = key(parent);
  const inner = key(child);
  if (outer === inner) return true;
  const separator = outer.includes("\\") ? "\\" : "/";
  return inner.startsWith(outer.endsWith(separator) ? outer : outer + separator);
}

export function inspectDesktopCatalog(value: unknown, roots: string[], home: string, key: (path: string) => string) {
  const state = catalog.parse(value);
  const matches = Object.values(state["local-projects"])
    .filter((project) => roots.every((root) => project.rootPaths.some((saved) => containsPath(saved, root, key))))
    .map((project) => ({ project, score: roots.reduce((sum, root) => sum + Math.max(...project.rootPaths
      .filter((saved) => containsPath(saved, root, key)).map((saved) => key(saved).length)), 0) }))
    .sort((left, right) => right.score - left.score || left.project.id.localeCompare(right.project.id));
  if (matches.length > 1 && matches[0]!.score === matches[1]!.score) throw new Error("Ambiguous Desktop saved project roots.");
  if (matches.length === 0) throw new DesktopProjectMissingError();
  const project = matches[0]!.project;
  if (state["local-projects"][project.id]?.id !== project.id) throw new Error("Desktop project key mismatch.");
  const hosts = Object.entries(state["app-server-project-id-by-legacy-project-id-by-host"] ?? {})
    .filter(([host]) => host.startsWith("local:") && key(host.slice(6)) === key(home));
  if (hosts.length > 1) throw new Error("Ambiguous Desktop provider-home mapping.");
  if (hosts.length !== 1 || !hosts[0]![1][project.id]) throw new DesktopMappingPendingError();
  const threadIds = Object.entries(state["thread-project-assignments"] ?? {}).flatMap(([id, raw]) => {
    const assignment = z.object({ projectKind: z.literal("local"), projectId: z.string() }).passthrough().safeParse(raw);
    return assignment.success && assignment.data.projectId === project.id ? [id] : [];
  });
  return { clientProjectId: project.id, projectId: hosts[0]![1][project.id]!, threadIds };
}

export async function readDesktopCatalog(roots: string[], home: string, key: (path: string) => string) {
  return inspectDesktopCatalog(JSON.parse(await readFile(join(home, ".codex-global-state.json"), "utf8")), roots, home, key);
}
