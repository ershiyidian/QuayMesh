import { git, getGitEligibility } from "../git.js";
import type { Workspace } from "../workspaces.js";
import type { SnapshotWorkspace } from "./types.js";

export type WorkspaceMetadata = Pick<SnapshotWorkspace, "branch" | "baseRef" | "baseSha" | "dirtySource">;

export async function describeWorkspace(workspace: Workspace): Promise<WorkspaceMetadata> {
  const eligibility = await getGitEligibility(workspace.root);
  if (!eligibility.ok || !eligibility.gitRoot) return { branch: null, baseRef: null, baseSha: null, dirtySource: null };
  const branch = (await git(eligibility.gitRoot, ["branch", "--show-current"])).stdout.trim() || null;
  const baseSha = workspace.worktree?.baseSha
    ?? (eligibility.hasHead ? (await git(eligibility.gitRoot, ["rev-parse", "HEAD"])).stdout.trim() : null);
  return {
    branch,
    baseRef: workspace.worktree?.baseRef ?? (eligibility.hasHead ? "HEAD" : null),
    baseSha,
    dirtySource: workspace.worktree?.dirtySource
      ?? Boolean((await git(eligibility.gitRoot, ["status", "--porcelain"])).stdout.trim()),
  };
}
