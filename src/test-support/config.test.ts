import {
  defaultQuayMeshConfig,
  type QuayMeshConfig,
} from "../config-schema.js";
import { writeQuayMeshConfig } from "../user-config.js";

type SectionOverrides = {
  server?: Partial<QuayMeshConfig["server"]>;
  workspaces?: Partial<QuayMeshConfig["workspaces"]>;
  storage?: Partial<QuayMeshConfig["storage"]>;
  tools?: Partial<QuayMeshConfig["tools"]>;
  ui?: Partial<QuayMeshConfig["ui"]>;
  artifacts?: Partial<QuayMeshConfig["artifacts"]>;
  skills?: Partial<QuayMeshConfig["skills"]>;
  subagents?: QuayMeshConfig["subagents"];
  logging?: Partial<QuayMeshConfig["logging"]>;
  oauth?: Partial<QuayMeshConfig["oauth"]>;
};

export function writeTestQuayMeshConfig(
  configDir: string,
  overrides: SectionOverrides = {},
): NodeJS.ProcessEnv {
  const defaults = defaultQuayMeshConfig();
  const env = { QUAYMESH_CONFIG_DIR: configDir };
  writeQuayMeshConfig({
    ...defaults,
    server: { ...defaults.server, ...overrides.server },
    workspaces: { ...defaults.workspaces, ...overrides.workspaces },
    storage: { ...defaults.storage, ...overrides.storage },
    tools: { ...defaults.tools, ...overrides.tools },
    ui: { ...defaults.ui, ...overrides.ui },
    artifacts: { ...defaults.artifacts, ...overrides.artifacts },
    skills: { ...defaults.skills, ...overrides.skills },
    subagents: overrides.subagents ?? defaults.subagents,
    logging: { ...defaults.logging, ...overrides.logging },
    oauth: { ...defaults.oauth, ...overrides.oauth },
  }, env);
  return {
    ...env,
    QUAYMESH_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
}
