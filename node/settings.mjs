import { dirname,resolve } from "node:path";
import { check, hostUrl, loadNodeConfig, validateNode } from "./config.mjs";
import { atomicWrite } from "./files.mjs";

export const EDITABLE_SETTINGS = Object.freeze(["nickname", "priority", "roots", "egress"]);

// Console saves may arrive simultaneously. Serialize the read/CAS/write
// sequence for one authoritative node.json instead of only checking a stale
// revision before two overlapping atomic renames.
const pendingSettingsWrites = new Map();

async function serializeSettingsWrite(configFile, operation) {
  const previous = pendingSettingsWrites.get(configFile) ?? Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  pendingSettingsWrites.set(configFile, turn);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (pendingSettingsWrites.get(configFile) === turn) pendingSettingsWrites.delete(configFile);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, name) {
  check(isObject(value), `${name} 必须是对象`);
  return value;
}

function assertPatch(patch) {
  assertObject(patch, "settings");
  for (const key of Object.keys(patch)) {
    check(EDITABLE_SETTINGS.includes(key), `settings.${key} 不是可编辑设置`);
  }
  if ("nickname" in patch) {
    check(typeof patch.nickname === "string" && patch.nickname.trim().length > 0, "nickname 不能为空");
  }
  if ("priority" in patch) {
    check(Number.isInteger(patch.priority) && patch.priority >= 0 && patch.priority <= 1000,
      "priority 必须是 0–1000 的整数");
  }
  if ("roots" in patch) check(Array.isArray(patch.roots), "roots 必须是数组");
  if ("egress" in patch) assertObject(patch.egress, "egress");
}

function currentEgress(node, cluster) {
  return {
    enabled: node.network.externalAccess && (node.capabilities.worker || node.capabilities.egress) && node.consoleSettings?.egress?.enabled !== false,
    listenPort: 17890,
    proxyUrl: node.network.proxyUrl || "http://127.0.0.1:7890",
    controllerSecretEnv: "QUAYMESH_PROXY_CONTROLLER_SECRET",
    probeUrl: cluster.egress.probeUrl,
    probeIntervalMs: 15000,
    recoveryDelayMs: cluster.egress.recoveryDelayMs,
    inheritProxy: node.network.externalAccess,
    ...(node.components.egress?.configFile ? { mihomoConfig: node.components.egress.configFile } : {}),
    ...node.consoleSettings?.egress,
  };
}

function mergeEgress(current, patch) {
  const allowed = ["enabled","listenPort","mihomoConfig","proxyUrl","controllerUrl","probeUrl","probeIntervalMs","recoveryDelayMs","inheritProxy"];
  const next = Object.fromEntries(Object.entries({ ...current, ...patch }).filter(([key]) => allowed.includes(key)));
  for (const key of ["mihomoConfig", "controllerUrl"]) if (next[key] === null) delete next[key];
  return next;
}

function editablePatch(node, cluster, input) {
  const patch = {};
  if ("nickname" in input) patch.nickname = input.nickname.trim();
  if ("priority" in input) patch.priority = input.priority;
  if ("roots" in input) patch.roots = structuredClone(input.roots);
  if ("egress" in input) patch.egress = mergeEgress(currentEgress(node, cluster), input.egress);
  return patch;
}

export function publicSettings(configuration) {
  const { node, cluster } = configuration;
  const revision = node.settingsRevision;
  return {
    nodeId: node.id,
    nickname: node.nickname,
    capabilities: node.capabilities,
    priority: node.consoleSettings?.priority ?? (node.capabilities.egress ? cluster.egress.priorities[node.id] ?? 100 : 0),
    peers: node.id===cluster.coordinator.id?[]:[{id:cluster.coordinator.id,
      url:hostUrl(cluster.coordinator.address,cluster.coordinator.peerPort)}],
    roots: node.roots,
    egress: currentEgress(node, cluster),
    federationPort: node.peerPort,
    ingressPort: 7677,
    publicBaseUrl: null,
    revision,
    savedRevision: revision,
    appliedRevision: revision,
  };
}

export async function loadSettingsAuthority(file) {
  return loadNodeConfig(resolve(file));
}

export async function applySettingsPatch(file, input, { expectedRevision } = {}) {
  const configFile=resolve(file);
  return serializeSettingsWrite(configFile,async()=>{
  assertPatch(input);
  const authority = await loadSettingsAuthority(configFile);
  check(Number.isInteger(expectedRevision), "expectedRevision 必须是整数");
  if(expectedRevision !== authority.node.settingsRevision)throw Object.assign(
    new Error(`设置修订冲突：当前为 ${authority.node.settingsRevision}`),{status:409,code:"CONFIG_REVISION_CONFLICT"});
  const patch = editablePatch(authority.node, authority.cluster, input);
  const rawNode = {
    ...authority.rawNode,
    settingsRevision: authority.node.settingsRevision + 1,
    nickname: patch.nickname ?? authority.node.nickname,
    ...( "roots" in patch ? { roots: patch.roots } : {}),
    consoleSettings: {
      ...authority.rawNode.consoleSettings,
      ...( "priority" in patch ? {priority:patch.priority} : {}),
      ...( "egress" in patch ? {egress:patch.egress} : {}),
    },
  };
  const node = validateNode(rawNode, authority.cluster, dirname(authority.configFile));
  const saved = publicSettings({ configFile: authority.configFile, rawNode, node, cluster: authority.cluster });
  saved.appliedRevision = null;
  await atomicWrite(authority.configFile, `${JSON.stringify(rawNode, null, 2)}\n`);
  return { configFile: authority.configFile, rawNode, node, cluster: authority.cluster, settings: saved };
  });
}
