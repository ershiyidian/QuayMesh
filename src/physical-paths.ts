import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { AccessDeniedError, canonicalPathIdentity, expandHomePath } from "./roots.js";

/** File evidence compares physical paths, independently of persisted workspace
 * IDs. Windows' JS realpath retains 8.3 names; native realpath expands them. */
export function resolvePhysicalPath(path: string): string {
  let candidate = resolve(expandHomePath(path));
  const missing: string[] = [];
  for (;;) {
    try {
      const physical = process.platform === "win32" ? realpathSync.native(candidate) : realpathSync(candidate);
      if (missing.length && !statSync(candidate).isDirectory()) {
        throw Object.assign(new Error(`Path ancestor is not a directory: ${candidate}`), { code: "ENOTDIR" });
      }
      return resolve(physical, ...missing);
    } catch (error) {
      if (!missingPath(error)) throw error;
      // A dangling link is an unresolved boundary, never a missing leaf that
      // can be appended to an otherwise valid parent.
      try {
        const entry = lstatSync(candidate);
        if (entry.isSymbolicLink()) throw new AccessDeniedError(`Cannot resolve symbolic link: ${path}`);
        // An existing non-directory ancestor must not become a synthetic path.
        if (!entry.isDirectory()) throw error;
      } catch (inspectionError) {
        if (!missingPath(inspectionError)) throw inspectionError;
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOTDIR") throw inspectionError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

export function samePhysicalPath(left: string, right: string): boolean {
  return canonicalPathIdentity(resolvePhysicalPath(left)) === canonicalPathIdentity(resolvePhysicalPath(right));
}

function missingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
