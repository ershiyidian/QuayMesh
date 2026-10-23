import { lstatSync } from "node:fs";

/** Only a confirmed missing marker permits the managed Core to resume. */
export function installationTransitionPending(file: string | undefined): boolean {
  if (!file) return false;
  try {
    // lstat keeps a dangling marker symlink closed, unlike existsSync. A
    // directory or any other unexpected entry also needs operator recovery.
    lstatSync(file);
    return true;
  } catch (error) {
    // A failed permission/path check is not evidence that validation finished.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
