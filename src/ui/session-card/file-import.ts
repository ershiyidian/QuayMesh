/** File-library references must be resolved by ChatGPT, never synthesized from opaque IDs. */
export interface HostFile {
  fileId: string;
  fileName?: string;
  mimeType?: string;
}
export interface HostFileLibrary {
  selectFiles?: () => Promise<HostFile[]>;
  getFileDownloadUrl?: (input: { fileId: string }) => Promise<{ downloadUrl: string }>;
}
export interface FileImportArguments {
  file: { download_url: string; file_id: string; file_name?: string; mime_type?: string };
  workspace_id: string;
  path: string;
}

export function canImportHostFiles(host: HostFileLibrary | undefined): boolean {
  return typeof host?.selectFiles === "function" && typeof host.getFileDownloadUrl === "function";
}

export async function selectAuthorizedFiles(
  host: HostFileLibrary,
  workspaceId: string,
): Promise<FileImportArguments[]> {
  if (!canImportHostFiles(host) || !workspaceId) throw new Error("FILE_IMPORT_UNAVAILABLE");
  const files = await host.selectFiles!();
  if (!Array.isArray(files) || files.length > 8) throw new Error("FILE_IMPORT_SELECTION_INVALID");
  const results: FileImportArguments[] = [];
  for (const file of files) {
    if (!file || typeof file.fileId !== "string" || !file.fileId ||
      !/^[a-zA-Z0-9._:+/-]{1,512}$/.test(file.fileId)) throw new Error("FILE_IMPORT_REFERENCE_INVALID");
    const path = file.fileName?.replaceAll("\\", "/").split("/").pop()?.trim();
    if (!path || path === "." || path === ".." || path.startsWith(".") ||
      /[<>:"|?*\x00-\x1f]/u.test(path)) throw new Error("FILE_IMPORT_NAME_INVALID");
    const { downloadUrl } = await host.getFileDownloadUrl!({ fileId: file.fileId });
    if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("https://")) {
      throw new Error("FILE_IMPORT_SIGNED_URL_REQUIRED");
    }
    results.push({
      file: { file_id: file.fileId, download_url: downloadUrl, file_name: path,
        ...(file.mimeType ? { mime_type: file.mimeType } : {}) },
      workspace_id: workspaceId, path,
    });
  }
  return results;
}
