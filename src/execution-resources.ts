import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPathIdentity } from "./roots.js";

export type ResourceAccess = "read" | "write";
export type ExecutionResource =
  | { kind: "file" | "tree"; path: string; access: ResourceAccess }
  | { kind: "named"; key: string; access: ResourceAccess };

export function containsResource(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}

export function canonicalResourcePath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`资源所在文件系统不可访问：${path}`);
    missing.unshift(basename(ancestor)); ancestor = parent;
  }
  return canonicalPathIdentity(resolve(realpathSync(ancestor), ...missing));
}

export function normalizeExecutionResources(input: readonly ExecutionResource[]): ExecutionResource[] {
  if (input.length > 128) throw new Error("单次操作最多声明 128 个资源范围");
  const values = new Map<string, ExecutionResource>();
  for (const raw of input) {
    if (raw.access !== "read" && raw.access !== "write") throw new Error("资源访问方式无效");
    let value: ExecutionResource;
    if (raw.kind === "named") {
      if (!raw.key || raw.key.length > 512 || /[\r\n\0]/.test(raw.key)) throw new Error("命名资源无效");
      value = { kind: "named", key: raw.key, access: raw.access };
    } else if (raw.kind === "file" || raw.kind === "tree") {
      if (!raw.path || !isAbsolute(raw.path)) throw new Error("执行资源需要绝对路径");
      value = { kind: raw.kind, path: canonicalResourcePath(raw.path), access: raw.access };
    } else throw new Error("资源类型无效");
    const key = JSON.stringify(value.kind === "named" ? [value.kind,value.key] : [value.kind,value.path]);
    const previous = values.get(key);
    if (!previous || value.access === "write") values.set(key,value);
  }
  return [...values.values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function resourcesIntersect(a: ExecutionResource, b: ExecutionResource): boolean {
  if (a.kind === "named" || b.kind === "named") return a.kind === "named" && b.kind === "named" && a.key === b.key;
  if (a.path === b.path) return true;
  return (a.kind === "tree" && containsResource(a.path,b.path)) || (b.kind === "tree" && containsResource(b.path,a.path));
}

export function resourcesConflict(a: ExecutionResource, b: ExecutionResource): boolean {
  return (a.access === "write" || b.access === "write") && resourcesIntersect(a,b);
}

export function resourceContains(owner: ExecutionResource, requested: ExecutionResource): boolean {
  if (requested.access === "write" && owner.access !== "write") return false;
  if (owner.kind === "named" || requested.kind === "named") return owner.kind === "named" && requested.kind === "named" && owner.key === requested.key;
  return owner.kind === "tree" ? containsResource(owner.path,requested.path) : requested.kind === "file" && owner.path === requested.path;
}
