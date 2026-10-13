import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("QuayMesh package version is missing.");
}

export const QUAYMESH_VERSION = packageJson.version;
