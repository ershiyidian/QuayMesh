import { readFile } from "node:fs/promises";
import { isAbsolute, dirname, resolve, join, extname } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { parseEnv } from "node:util";
import { readOptionalJson } from "./files.mjs";

export const CAPABILITIES = Object.freeze(["coordinator", "worker", "discovery", "egress", "meshRelay", "desktopUi", "consoleRelay"]);
export const DEFAULT_PORTS = Object.freeze({ core: 7676, peer: 7680, registry: 7681, relay: 17676, admin: 17677, socks: 17690, egress: 17890, tunnelHealth: 8080 });

export function check(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, name) {
  check(value && typeof value === "object" && !Array.isArray(value), `${name} 必须是对象`);
  return value;
}
function keys(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) check(allowed.includes(key), `${name}.${key} 不是有效配置项`);
}
function identifier(value, name) {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value), `${name} 格式无效`);
  return value;
}
function port(value, name) {
  check(Number.isInteger(value) && value >= 1 && value <= 65535, `${name} 必须是 1–65535 的整数`);
  return value;
}
function text(value, name) {
  check(typeof value === "string" && value.trim().length > 0, `${name} 不能为空`);
  return value;
}
function optionalText(value, name) {
  check(value === undefined || typeof value === "string", `${name} 必须是字符串`);
  return value;
}
function tags(value, name) {
  check(value === undefined || (Array.isArray(value) && value.every((tag) => typeof tag === "string" && tag.trim().length > 0)),
    `${name} 必须是字符串数组`);
  return value;
}
function envName(value, name) {
  check(typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value), `${name} 必须是环境变量名`);
  return value;
}
export function httpUrl(value, name) {
  const url = new URL(text(value, name));
  check(["http:", "https:"].includes(url.protocol), `${name} 必须使用 http 或 https`);
  check(!url.username && !url.password && !url.hash, `${name} 不能包含认证信息或片段`);
  return url;
}
export function hostUrl(host, portValue) {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${portValue}`;
}
export function expandPath(value, directory = process.cwd()) {
  text(value, "路径");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(directory, value);
}
export function defaultStateDir(platform = process.platform, env = process.env) {
  return platform === "win32" ? join(env.LOCALAPPDATA || homedir(), "QuayMesh", "state")
    : join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quaymesh");
}
export function defaultConfigDir(platform = process.platform, env = process.env) {
  return platform === "win32" ? join(env.LOCALAPPDATA || homedir(), "QuayMesh", "config")
    : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "quaymesh");
}
export async function readConfigDocument(path) {
  const source = await readFile(path, "utf8");
  if ([".yaml", ".yml"].includes(extname(path).toLowerCase())) {
    const { parse } = await import("yaml");
    return parse(source);
  }
  return JSON.parse(source);
}

export function validateCluster(input) {
  const value = structuredClone(input);
  keys(value, ["schemaVersion","id","coordinator","mesh","discovery","egress","tokenEnv"], "cluster");
  check(value.schemaVersion === 1, "cluster.schemaVersion 必须是 1");
  identifier(value.id, "cluster.id");
  value.tokenEnv ??= "QUAYMESH_CLUSTER_TOKEN";
  envName(value.tokenEnv, "cluster.tokenEnv");
  keys(value.coordinator, ["id","address","apiPort","mcpPort","peerPort"], "coordinator");
  identifier(value.coordinator.id, "coordinator.id");
  check(isIP(value.coordinator.address) !== 0, "coordinator.address 必须是固定虚拟 IP");
  value.coordinator.apiPort ??= DEFAULT_PORTS.registry;
  value.coordinator.mcpPort ??= DEFAULT_PORTS.core;
  value.coordinator.peerPort ??= DEFAULT_PORTS.peer;
  for (const key of ["apiPort","mcpPort","peerPort"]) port(value.coordinator[key], `coordinator.${key}`);
  keys(value.mesh, ["networkName","secretEnv","peers"], "mesh");
  text(value.mesh.networkName, "mesh.networkName");
  value.mesh.secretEnv ??= "QUAYMESH_MESH_SECRET";
  envName(value.mesh.secretEnv, "mesh.secretEnv");
  check(Array.isArray(value.mesh.peers) && value.mesh.peers.length > 0, "mesh.peers 至少需要一个会合地址");
  for (const address of value.mesh.peers) {
    const url = new URL(address);
    check(["udp:","tcp:","quic:","ws:","wss:"].includes(url.protocol), `不支持的 EasyTier peer：${address}`);
    check(!!url.hostname && !!url.port, "mesh.peers 必须包含主机和端口");
  }
  value.discovery ??= {};
  keys(value.discovery, ["tunnelIdEnv","apiKeyEnv","resourceUrl","apiBaseUrl","channels","localPort","healthPort"], "discovery");
  value.discovery.tunnelIdEnv ??= "QUAYMESH_TUNNEL_ID";
  value.discovery.apiKeyEnv ??= "QUAYMESH_TUNNEL_API_KEY";
  envName(value.discovery.tunnelIdEnv, "discovery.tunnelIdEnv");
  envName(value.discovery.apiKeyEnv, "discovery.apiKeyEnv");
  value.discovery.channels ??= ["main","harpoon"];
  check(Array.isArray(value.discovery.channels) && value.discovery.channels.includes("main")
    && value.discovery.channels.every(channel => ["main","harpoon"].includes(channel)), "discovery.channels 支持 main 与 harpoon");
  value.discovery.localPort ??= DEFAULT_PORTS.relay;
  value.discovery.healthPort ??= DEFAULT_PORTS.tunnelHealth;
  port(value.discovery.localPort, "discovery.localPort");
  port(value.discovery.healthPort, "discovery.healthPort");
  if (value.discovery.resourceUrl) httpUrl(value.discovery.resourceUrl, "discovery.resourceUrl");
  if (value.discovery.apiBaseUrl) {
    const base = httpUrl(value.discovery.apiBaseUrl, "discovery.apiBaseUrl");
    check(base.protocol === "https:", "OpenAI 控制面地址必须使用 https");
  }
  value.egress ??= {};
  keys(value.egress, ["priorities","probeUrl","recoveryDelayMs"], "egress");
  value.egress.priorities ??= {};
  object(value.egress.priorities, "egress.priorities");
  for (const [id, priority] of Object.entries(value.egress.priorities)) {
    identifier(id, "egress 节点");
    check(Number.isInteger(priority) && priority >= 0 && priority <= 1000, `egress.priorities.${id} 必须为 0–1000`);
  }
  value.egress.probeUrl ??= "https://www.gstatic.com/generate_204";
  httpUrl(value.egress.probeUrl, "egress.probeUrl");
  value.egress.recoveryDelayMs ??= 10000;
  check(Number.isInteger(value.egress.recoveryDelayMs) && value.egress.recoveryDelayMs >= 0 && value.egress.recoveryDelayMs <= 300000,
    "egress.recoveryDelayMs 超出范围");
  return value;
}

export function validateNode(input, cluster, directory = process.cwd()) {
  const value = structuredClone(input);
  keys(value, ["schemaVersion","id","nickname","settingsRevision","consoleSettings","clusterFile","secretsFile","stateDir","capabilities","network","mesh",
    "components","roots","core","adminPort","peerPort","corePort","nodeRuntime"], "node");
  check(value.schemaVersion === 1, "node.schemaVersion 必须是 1");
  identifier(value.id, "node.id");
  value.nickname ??= value.id;
  text(value.nickname, "node.nickname");
  value.settingsRevision ??= 1;
  check(Number.isInteger(value.settingsRevision) && value.settingsRevision >= 1, "node.settingsRevision 必须是正整数");
  value.consoleSettings ??= {};
  keys(value.consoleSettings,["priority","egress"],"node.consoleSettings");
  if(value.consoleSettings.priority!==undefined)check(Number.isInteger(value.consoleSettings.priority)&&value.consoleSettings.priority>=0&&value.consoleSettings.priority<=1000,"node.consoleSettings.priority 必须是0–1000");
  if(value.consoleSettings.egress!==undefined){
    const e=value.consoleSettings.egress;
    keys(e,["enabled","listenPort","mihomoConfig","proxyUrl","controllerUrl","probeUrl","probeIntervalMs","recoveryDelayMs","inheritProxy"],"node.consoleSettings.egress");
    if(e.enabled!==undefined)check(typeof e.enabled==="boolean","egress.enabled 必须是布尔值");
    if(e.inheritProxy!==undefined)check(typeof e.inheritProxy==="boolean","egress.inheritProxy 必须是布尔值");
    if(e.listenPort!==undefined)port(e.listenPort,"egress.listenPort");
    for(const key of ["proxyUrl","controllerUrl","probeUrl"])if(e[key]!==undefined)httpUrl(e[key],`egress.${key}`);
    if(e.mihomoConfig!==undefined)e.mihomoConfig=expandPath(e.mihomoConfig,directory);
    if(e.probeIntervalMs!==undefined)check(Number.isInteger(e.probeIntervalMs)&&e.probeIntervalMs>=3000&&e.probeIntervalMs<=300000,"egress.probeIntervalMs 范围无效");
    if(e.recoveryDelayMs!==undefined)check(Number.isInteger(e.recoveryDelayMs)&&e.recoveryDelayMs>=0&&e.recoveryDelayMs<=300000,"egress.recoveryDelayMs 范围无效");
  }
  value.capabilities ??= {};
  keys(value.capabilities, CAPABILITIES, "capabilities");
  for (const name of CAPABILITIES) {
    value.capabilities[name] ??= false;
    check(typeof value.capabilities[name] === "boolean", `capabilities.${name} 必须是布尔值`);
  }
  check(CAPABILITIES.some(name => value.capabilities[name]), "节点至少需要一项能力");
  check(value.capabilities.coordinator === (value.id === cluster.coordinator.id), "Coordinator 能力与 cluster.coordinator.id 必须一致");
  value.network ??= {};
  keys(value.network, ["externalAccess","inheritProxy","proxyUrl"], "network");
  value.network.externalAccess ??= !value.capabilities.coordinator;
  value.network.inheritProxy ??= false;
  check(typeof value.network.externalAccess === "boolean" && typeof value.network.inheritProxy === "boolean", "network 开关必须是布尔值");
  if (!value.network.externalAccess) {
    check(!value.capabilities.discovery && !value.capabilities.egress,
      "关闭外网访问的节点不能开启 discovery 或 egress");
    check(value.consoleSettings.egress?.enabled !== true,"禁止无外网节点通过 Console 启用出口");
  }
  if (value.network.proxyUrl) httpUrl(value.network.proxyUrl, "network.proxyUrl");
  value.mesh ??= {};
  keys(value.mesh, ["enabled","mode","address","listeners","rpcPort","socksPort"], "node.mesh");
  value.mesh.enabled ??= true;
  check(typeof value.mesh.enabled === "boolean", "mesh.enabled 必须是布尔值");
  value.mesh.mode ??= "tun";
  check(["tun","no-tun"].includes(value.mesh.mode), "mesh.mode 必须是 tun 或 no-tun");
  check(isIP(value.mesh.address) !== 0, "node.mesh.address 必须是固定虚拟 IP");
  if (value.capabilities.coordinator) check(value.mesh.address === cluster.coordinator.address, "Coordinator 虚拟 IP 与集群配置不一致");
  value.mesh.listeners ??= [];
  check(Array.isArray(value.mesh.listeners), "mesh.listeners 必须是数组");
  for (const item of value.mesh.listeners) new URL(item);
  if (value.capabilities.meshRelay) check(value.mesh.listeners.length > 0, "meshRelay 需要配置监听地址");
  value.mesh.rpcPort ??= 15888;
  value.mesh.socksPort ??= DEFAULT_PORTS.socks;
  port(value.mesh.rpcPort, "mesh.rpcPort");
  port(value.mesh.socksPort, "mesh.socksPort");
  value.corePort ??= value.capabilities.coordinator ? cluster.coordinator.mcpPort : DEFAULT_PORTS.core;
  value.peerPort ??= value.capabilities.coordinator ? cluster.coordinator.peerPort : DEFAULT_PORTS.peer;
  value.adminPort ??= DEFAULT_PORTS.admin;
  for (const field of ["corePort","peerPort","adminPort"]) port(value[field], field);
  value.stateDir = expandPath(value.stateDir || defaultStateDir(), directory);
  value.clusterFile = expandPath(value.clusterFile || "./cluster.json", directory);
  if (value.secretsFile) value.secretsFile = expandPath(value.secretsFile, directory);
  value.components ??= {};
  keys(value.components, ["easytier","tunnel","egress"], "components");
  for (const [name, component] of Object.entries(value.components)) {
    keys(component, ["executable","args","configFile","environment"], `components.${name}`);
    if (component.executable) component.executable = expandPath(component.executable, directory);
    component.args ??= [];
    check(Array.isArray(component.args) && component.args.every(arg => typeof arg === "string"), `${name}.args 必须是字符串数组`);
    if (component.configFile) component.configFile = expandPath(component.configFile, directory);
    if (component.environment) {
      object(component.environment, `${name}.environment`);
      for (const [key, val] of Object.entries(component.environment)) {
        check(typeof val === "string", `${name}.environment.${key} 必须是字符串`);
      }
    }
  }
  value.roots ??= [];
  check(Array.isArray(value.roots), "roots 必须是数组");
  const roots = new Set();
  value.roots = value.roots.map((root) => {
    keys(root, ["id","nickname","path","description","tags","enabled"], "root");
    identifier(root.id, "root.id");
    check(!roots.has(root.id), `根目录 ID 重复：${root.id}`); roots.add(root.id);
    const enabled = root.enabled ?? true;
    check(typeof enabled === "boolean", `root.${root.id}.enabled 必须是布尔值`);
    optionalText(root.nickname, `root.${root.id}.nickname`);
    optionalText(root.description, `root.${root.id}.description`);
    tags(root.tags, `root.${root.id}.tags`);
    return { id: root.id, nickname: root.nickname || root.id, path: expandPath(root.path, directory),
      description: root.description || "", tags: root.tags || [], enabled };
  });
  check(value.capabilities.worker || value.roots.length === 0, "执行目录需要 worker 能力");
  value.core ??= {};
  keys(value.core, ["tools","subagents","skills","artifacts","logging"], "core");
  if (value.nodeRuntime) value.nodeRuntime = expandPath(value.nodeRuntime, directory);
  if (value.capabilities.discovery) check(!!cluster.discovery.resourceUrl, "discovery 需要配置 tunnel 的 resourceUrl");
  const ports = [value.corePort,value.peerPort,value.adminPort];
  if (value.capabilities.coordinator) ports.push(cluster.coordinator.apiPort);
  if (value.capabilities.discovery || value.capabilities.desktopUi || value.capabilities.consoleRelay) ports.push(cluster.discovery.localPort);
  if (value.capabilities.discovery) ports.push(cluster.discovery.healthPort);
  if (value.mesh.enabled) ports.push(value.mesh.rpcPort);
  if (value.mesh.enabled && value.mesh.mode === "no-tun") ports.push(value.mesh.socksPort);
  check(new Set(ports).size === ports.length, "本机监听端口发生冲突");
  return value;
}

export function secret(env, name, minimum = 1) {
  const value = env[name];
  check(typeof value === "string" && value.trim().length >= minimum, `缺少环境变量 ${name}`);
  return value.trim();
}

export async function loadNodeConfig(file, inherited = process.env) {
  const configFile = resolve(file);
  const rawNode = await readConfigDocument(configFile);
  const directory = dirname(configFile);
  const clusterFile = expandPath(rawNode.clusterFile || "./cluster.json", directory);
  const seedCluster = validateCluster(await readConfigDocument(clusterFile));
  let cluster = seedCluster;
  let node = validateNode(rawNode, cluster, directory);
  const cached = await readOptionalJson(join(node.stateDir, "cluster.snapshot.json"));
  if (cached?.cluster?.id === cluster.id && Number.isInteger(cached.revision)) {
    cluster = validateCluster(cached.cluster);
    check(cluster.coordinator.id === seedCluster.coordinator.id, "缓存中的 Coordinator 身份不匹配");
    node = validateNode(rawNode, cluster, directory);
  }
  const fileEnv = node.secretsFile ? parseEnv(await readFile(node.secretsFile, "utf8")) : {};
  const env = { ...inherited, ...fileEnv };
  secret(env, cluster.tokenEnv, 24);
  if (node.mesh.enabled) secret(env, cluster.mesh.secretEnv, 16);
  if (node.capabilities.discovery) {
    secret(env, cluster.discovery.tunnelIdEnv);
    secret(env, cluster.discovery.apiKeyEnv, 16);
  }
  return { configFile, rawNode, node, cluster, seedCluster, revision: cached?.revision || 1, env };
}
