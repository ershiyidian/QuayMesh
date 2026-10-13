import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import * as z from "zod/v4";
import {
  defaultQuayMeshConfig,
  quaymeshConfigSchema,
  type QuayMeshConfig,
  type QuayMeshConfigInput,
} from "./config-schema.js";
import { migrateLegacyConfig } from "./config-migration.js";
import { expandHomePath } from "./roots.js";

const quaymeshAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
}).passthrough();

export type QuayMeshUserConfig = QuayMeshConfig;
export type QuayMeshAuthConfig = z.infer<typeof quaymeshAuthConfigSchema>;

export interface QuayMeshFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: QuayMeshConfig;
  auth: QuayMeshAuthConfig;
  migratedLegacyConfig: boolean;
}

export interface QuayMeshConfigEdit {
  path: (string | number)[];
  value: unknown;
}

export function quaymeshConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.QUAYMESH_CONFIG_DIR ?? join(homedir(), ".quaymesh")));
}

export function quaymeshConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(quaymeshConfigDir(env), "config.jsonc");
}

export function quaymeshAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(quaymeshConfigDir(env), "auth.json");
}

export function quaymeshSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(quaymeshConfigDir(env), "skills");
}

export function quaymeshAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(quaymeshConfigDir(env), "agents");
}

export function quaymeshLegacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(quaymeshConfigDir(env), "config.json");
}

export function quaymeshLegacyConfigBackupPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(quaymeshConfigDir(env), "config.json.v1.0.bak");
}

export function loadQuayMeshFiles(env: NodeJS.ProcessEnv = process.env): QuayMeshFiles {
  const dir = quaymeshConfigDir(env);
  const configPath = quaymeshConfigPath(env);
  const legacyConfigPath = quaymeshLegacyConfigPath(env);
  const authPath = quaymeshAuthPath(env);
  // 旧 config.json 只在 config.jsonc 不存在时迁移一次；备份文件已存在则明确报错。
  const migratedLegacyConfig = !existsSync(configPath) && existsSync(legacyConfigPath)
    ? migrateLegacyConfigFile(legacyConfigPath, configPath, quaymeshLegacyConfigBackupPath(env))
    : false;
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsoncConfig(configPath) : defaultQuayMeshConfig(),
    auth: authExists ? readJsonFile(authPath, quaymeshAuthConfigSchema) : {},
    migratedLegacyConfig,
  };
}

function migrateLegacyConfigFile(
  legacyPath: string,
  configPath: string,
  backupPath: string,
): boolean {
  if (existsSync(backupPath)) {
    throw new Error(
      `Unable to migrate ${legacyPath}: backup already exists at ${backupPath}. `
      + `Move ${backupPath} out of the way, then run QuayMesh again.`,
    );
  }

  let migrated: QuayMeshConfig;
  try {
    migrated = migrateLegacyConfig(JSON.parse(readFileSync(legacyPath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("migrate", legacyPath, error);
  }

  const temporaryPath = temporaryFilePath(configPath);
  let published = false;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(temporaryPath, serializeConfig(migrated), { mode: 0o600, flag: "wx" });
    readJsoncConfig(temporaryPath);
    try {
      // 先把完整临时文件发布到目标路径，另一个并发首次启动会看到 EEXIST 并复用已有配置。
      linkSync(temporaryPath, configPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      readJsoncConfig(configPath);
      return false;
    }
    published = true;
    renameSync(legacyPath, backupPath);
  } catch (error) {
    if (published && existsSync(legacyPath)) {
      rmSync(configPath, { force: true });
    }
    throw fileError("migrate", legacyPath, error);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return true;
}

export function writeQuayMeshConfig(
  config: QuayMeshConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = quaymeshConfigPath(env);
  const parsed = quaymeshConfigSchema.parse(config);
  atomicWrite(filePath, serializeConfig(parsed), 0o600);
  return filePath;
}

export function setQuayMeshConfigValue(
  path: (string | number)[],
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return setQuayMeshConfigValues([{ path, value }], env);
}

export function setQuayMeshConfigValues(
  edits: QuayMeshConfigEdit[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const files = loadQuayMeshFiles(env);
  const source = files.configExists
    ? readFileSync(files.configPath, "utf8")
    : serializeConfig(files.config);
  const updated = edits.reduce(
    (document, edit) => applyEdits(document, modify(document, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })),
    source,
  );
  parseJsoncConfig(updated, files.configPath);
  atomicWrite(files.configPath, updated.endsWith("\n") ? updated : `${updated}\n`, 0o600);
  return files.configPath;
}

export function writeQuayMeshAuth(
  auth: QuayMeshAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = quaymeshAuthPath(env);
  mkdirSync(quaymeshConfigDir(env), { recursive: true });
  writeJsonFile(filePath, quaymeshAuthConfigSchema.parse(auth), 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsoncConfig(filePath: string): QuayMeshConfig {
  try {
    return parseJsoncConfig(readFileSync(filePath, "utf8"), filePath);
  } catch (error) {
    if (error instanceof QuayMeshConfigFileError) throw error;
    throw fileError("read", filePath, error);
  }
}

function parseJsoncConfig(source: string, filePath: string): QuayMeshConfig {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new QuayMeshConfigFileError(
      `Unable to read ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  try {
    return quaymeshConfigSchema.parse(value);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function serializeConfig(config: QuayMeshConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function atomicWrite(filePath: string, source: string, mode: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = temporaryFilePath(filePath);
  try {
    writeFileSync(temporaryPath, source, { mode, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function temporaryFilePath(filePath: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function fileError(action: "read" | "migrate", filePath: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new QuayMeshConfigFileError(`Unable to ${action} ${filePath}: ${reason}`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class QuayMeshConfigFileError extends Error {}

