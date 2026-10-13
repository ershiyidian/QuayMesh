import type { App } from "@modelcontextprotocol/ext-apps";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export type ReviewFileType =
  | "change"
  | "rename-pure"
  | "rename-changed"
  | "new"
  | "deleted";

export interface ReviewFile {
  path?: string;
  previousPath?: string;
  type?: ReviewFileType;
  additions?: number;
  removals?: number;
}

export interface ReviewPayloadData {
  files: ReviewFile[];
  patch?: string;
  summary: {
    files: number;
    additions: number;
    removals: number;
  };
}