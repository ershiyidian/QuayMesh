import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { secret, hostUrl, check } from "./config.mjs";
import { internalEnvironment, restrictedEnvironment, proxyEnvironment } from "./environment.mjs";

export function platformName(platform = process.platform, arch = process.arch) {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}
export function componentPath(root, name, node) {
  if (node.components[name]?.executable) return node.components[name].executable;
  const base = name === "easytier" ? "easytier-core" : name === "tunnel" ? "tunnel-client" : "mihomo";
  return join(root, "components", platformName(), `${base}${process.platform === "win32" ? ".exe" : ""}`);
}
export function easyTierConfig(node, cluster) {
  const q = JSON.stringify;
  const lines = [
    `instance_name = ${q(`quaymesh-${node.id}`)}`, `hostname = ${q(node.nickname)}`,
    `ipv4 = ${q(node.mesh.address)}`, `listeners = ${JSON.stringify(node.mesh.listeners)}`,
    `rpc_portal = ${q(`127.0.0.1:${node.mesh.rpcPort}`)}`,
    ...(node.mesh.mode === "no-tun" ? [`socks5_portal = ${q(`socks5://127.0.0.1:${node.mesh.socksPort}`)}`] : []),
    "", "[network_identity]", `network_name = ${q(cluster.mesh.networkName)}`,
    `network_secret = ${q("${" + cluster.mesh.secretEnv + "}")}`,
    "", "[flags]", `no_tun = ${node.mesh.mode === "no-tun"}`, "enable_ipv6 = false",
  ];
  for (const peer of cluster.mesh.peers) lines.push("", "[[peer]]", `uri = ${q(peer)}`);
  return lines.join("\n") + "\n";
}

export function compileCore(node, cluster, { root, tokenFile, ownerToken, membershipFile, statusFile }) {
  check(ownerToken.length >= 16, "管理口令长度不足");
  const caps = node.capabilities;
  const coordinator = cluster.coordinator;
  const publicOrigin = hostUrl("127.0.0.1", cluster.discovery.localPort);
  const coordinatorEndpoint = hostUrl(coordinator.address, coordinator.peerPort);
  const proxyUrl = node.network.proxyUrl || "http://127.0.0.1:7890";
  const aliases = cluster.discovery.resourceUrl ? [cluster.discovery.resourceUrl] : [];
  const providers = caps.worker && node.network.externalAccess
    ? (node.core.subagents || { enabled:true, instructions:"on-demand", providers:[{ id:"codex", enabled:true }] })
    : { enabled:false, instructions:"on-demand", providers:[] };
  const runtime = {
    $schema: pathToFileURL(join(root, "schema", "v1", "quaymesh.schema.json")).href,
    configVersion: 1,
    server: {
      host: caps.coordinator ? "0.0.0.0" : "127.0.0.1", port:node.corePort, publicBaseUrl: publicOrigin,
      allowedHosts: ["127.0.0.1","localhost",node.mesh.address,coordinator.address], trustProxy:true,
    },
    workspaces: { allowedRoots:caps.worker ? node.roots.filter(entry=>entry.enabled).map(entry => entry.path) : [],
      worktreeRoot:join(node.stateDir,"worktrees") },
    storage:{ stateDir:join(node.stateDir,"core") },
    federation:{
      enabled:true, nodeId:node.id, nickname:node.nickname, capabilities:caps,
      priority: node.consoleSettings?.priority ?? (caps.egress ? cluster.egress.priorities[node.id] ?? 100 : 0),
      host:"0.0.0.0", port:node.peerPort, coordinatorId:coordinator.id,
      tokenEnv:cluster.tokenEnv, tokenFile,
      membershipFile, statusFile,
      socksProxy: node.mesh.enabled && node.mesh.mode === "no-tun" ? `socks5://127.0.0.1:${node.mesh.socksPort}` : undefined,
      peers: caps.coordinator ? [] : [{ id:coordinator.id, url:coordinatorEndpoint }],
      roots:caps.worker ? node.roots : [],
      heartbeatMs:5000, rpcTimeoutMs:120000,
      egress:{
        enabled:node.network.externalAccess && (caps.worker || caps.egress) && node.consoleSettings?.egress?.enabled!==false,
        listenPort:node.consoleSettings?.egress?.listenPort??17890,
        proxyUrl:node.consoleSettings?.egress?.proxyUrl??proxyUrl,
        ...(node.components.egress?.configFile ? { mihomoConfig:node.components.egress.configFile } : {}),
        ...node.consoleSettings?.egress,
        controllerSecretEnv:"QUAYMESH_PROXY_CONTROLLER_SECRET", probeUrl:node.consoleSettings?.egress?.probeUrl??cluster.egress.probeUrl,
        probeIntervalMs:node.consoleSettings?.egress?.probeIntervalMs??15000, recoveryDelayMs:node.consoleSettings?.egress?.recoveryDelayMs??cluster.egress.recoveryDelayMs,
        inheritProxy:node.consoleSettings?.egress?.inheritProxy??node.network.externalAccess,
      },
    },
    network:{ externalAccess:node.network.externalAccess },
    tools:node.core.tools || { mode:"codex", dangerouslySkipCommandReview:false },
    ui:{ enabled:caps.coordinator },
    console:{ enabled:caps.coordinator, allowRemote:true, sessionTtlSeconds:2592000,
      mcpIngress:{ nodeId:coordinator.id, label:"OpenAI 冗余发现端", ...(cluster.discovery.resourceUrl ? { url:cluster.discovery.resourceUrl } : {}) } },
    artifacts:node.core.artifacts || { enabled:true, maxFileBytes:1073741824 },
    skills:node.core.skills || { enabled:true, paths:[], agentDir:"~/.codex" },
    subagents:providers,
    logging:node.core.logging || { level:"info", format:"json", requests:true, assets:false, toolCalls:true, shellCommands:false },
    oauth:{ scopes:["quaymesh"], resourceAliases:aliases, allowedResourceUrls:aliases,
      allowedRedirectHosts:["chatgpt.com","localhost","127.0.0.1"], accessTokenTtlSeconds:3600, refreshTokenTtlSeconds:2592000 },
  };
  return { runtime, auth:{ ownerToken } };
}

export function componentPlans(node, cluster, env, { root, generatedDir, configDir, release }) {
  const base = node.network.externalAccess ? internalEnvironment(env) : restrictedEnvironment(env);
  const plans = [];
  const managedMesh = node.mesh.enabled;
  if (managedMesh) {
    const component = node.components.easytier || {};
    const configFile = component.configFile || join(generatedDir,"easytier.toml");
    plans.push({ id:"mesh", command:componentPath(root,"easytier",node),
      args:component.args?.length ? component.args.map(arg => arg.replaceAll("${config}",configFile)) : ["--config-file",configFile],
      cwd:root, env:{...restrictedEnvironment(env), [cluster.mesh.secretEnv]:secret(env,cluster.mesh.secretEnv,16), ...component.environment }, requires:[],
      configuration:component.configFile ? undefined : easyTierConfig(node,cluster) });
  }
  if (node.capabilities.egress && node.components.egress?.executable) {
    const component = node.components.egress;
    plans.push({ id:"egress", command:component.executable,
      args:component.args.map(arg => arg.replaceAll("${config}",component.configFile || "")), cwd:root,
      env:{...internalEnvironment(env),...component.environment}, requires:[] });
  }
  plans.push({ id:"core", command:node.nodeRuntime || process.execPath, args:[join(root,"dist","cli.js"),"serve"], cwd:root,
    env:{...base, QUAYMESH_CONFIG_DIR:configDir, QUAYMESH_NODE_ADMIN_URL:`http://127.0.0.1:${node.adminPort}`, QUAYMESH_RELEASE_COMMIT:release,
      QUAYMESH_EXTERNAL_ACCESS:String(node.network.externalAccess) },
    requires:managedMesh ? ["mesh"] : [] });
  if (node.capabilities.discovery) {
    const component = node.components.tunnel || {};
    const proxy = node.network.proxyUrl || (node.network.inheritProxy ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy : undefined);
    const discoveryEnv = proxyEnvironment(restrictedEnvironment(env), proxy);
    plans.push({ id:"discovery", command:componentPath(root,"tunnel",node),
      args:component.args?.length ? component.args.map(arg => arg.replaceAll("${config}",component.configFile || ""))
        : ["run", ...(component.configFile ? ["--config",component.configFile] : [])],
      cwd:root, env:{...discoveryEnv,
        CONTROL_PLANE_TUNNEL_ID:secret(env,cluster.discovery.tunnelIdEnv),
        CONTROL_PLANE_API_KEY:secret(env,cluster.discovery.apiKeyEnv,16),
        CONTROL_PLANE_POLL_CHANNELS:cluster.discovery.channels.join(","),
        ...(cluster.discovery.apiBaseUrl ? { CONTROL_PLANE_BASE_URL:cluster.discovery.apiBaseUrl } : {}),
        MCP_SERVER_URL:`http://127.0.0.1:${cluster.discovery.localPort}/mcp`,
        HEALTH_LISTEN_ADDR:`127.0.0.1:${cluster.discovery.healthPort}`,
        HARPOON_ALLOW_PLAINTEXT_HTTP:"true",
        ...component.environment,
      },
      requires:[...(managedMesh ? ["mesh"] : []), ...(plans.some(plan => plan.id === "egress") ? ["egress"] : [])] });
  }
  return plans;
}
