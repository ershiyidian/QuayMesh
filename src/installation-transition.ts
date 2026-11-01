import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

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

/** Preserve validation keeps all historical attempts unchanged until its
 * exact transition is released. Missing, legacy and explicit prove markers
 * keep the ordinary reconciliation behavior; malformed markers fail closed. */
export function installationBackgroundMaintenanceAllowed(file: string | undefined): boolean {
  if (!file) return true;
  let fd: number | undefined;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.size > 65_536) return false;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = fstatSync(fd);
    if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino || current.size > 65_536) return false;
    const bytes = Buffer.alloc(65_537);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 65_536) return false;
    const marker = JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
    const lease = (marker as {maintenanceLease?: unknown}).maintenanceLease;
    if (lease === undefined) return true;
    if (!lease || typeof lease !== "object" || Array.isArray(lease)) return false;
    const {historyPolicy: policy, version} = lease as {historyPolicy?: unknown; version?: unknown};
    return (policy === undefined || policy === "prove") && (version === undefined || version === 1);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
