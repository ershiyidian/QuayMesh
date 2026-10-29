// Read actual SDK initialize/tools/list results from isolated built QuayMesh instances.
// Uses the existing real test fixture's OAuth flow; never opens production config/state.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareSurfaces, jsonBytes, summarizeSurface } from './mcp-surface-report.mjs';

const self = fileURLToPath(import.meta.url);
let stage = 'arguments';
if (process.argv[2] === '--worker') {
  try {
    const result = await measure(JSON.parse(process.argv[3]));
    process.send?.({ result }, () => process.disconnect());
  } catch (error) {
    // Do not print response bodies, environment variables, OAuth codes or tokens.
    const safe = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,100}$/.test(value) ? value : 'ERROR';
    const ownCode = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(error.message) ? error.message : undefined;
    process.send?.({ error: { stage, name: safe(error?.name), code: safe(error?.code ?? ownCode) } }, () => process.disconnect());
    process.exitCode = 1;
  }
} else await main();

async function main() {
  const { values } = parseArgs({ options: {
    'candidate-dist': { type: 'string' }, 'control-dist': { type: 'string' },
    'sdk-from': { type: 'string' }, profile: { type: 'string', default: 'full' },
    out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !values['candidate-dist'] || !values.out) {
    console.log('node measure-mcp-surface.mjs --candidate-dist <build/dist> [--control-dist <control/dist>] [--sdk-from <source/package.json>] [--profile full|minimal] --out <new-report-directory>');
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (!['full', 'minimal'].includes(values.profile)) throw new Error('profile must be full or minimal');
  const output = resolve(values.out);
  await mkdir(output, { recursive: true });
  const targets = [
    ...(values['control-dist'] ? [{ label: 'control', path: values['control-dist'] }] : []),
    { label: 'candidate', path: values['candidate-dist'] },
  ];
  const measurements = {};
  for (const target of targets) {
    const dist = await realpath(resolve(target.path));
    const sdkFrom = values['sdk-from'] ? await realpath(resolve(values['sdk-from'])) : join(dist, 'server.js');
    const temporary = await mkdtemp(join(tmpdir(), 'quaymesh-mcp-surface-'));
    process.stderr.write(`Measuring isolated ${target.label} MCP surface (${values.profile})\n`);
    try {
      const measured = await runWorker({ dist, sdkFrom, profile: values.profile, temporary });
      const directory = join(output, target.label);
      await mkdir(directory, { recursive: true });
      const { pages, definitions, instructions, ...summary } = measured;
      await writeFile(join(directory, 'tools-list-pages.json'), JSON.stringify(pages, null, 2) + '\n');
      await writeFile(join(directory, 'model-tools.json'), JSON.stringify(definitions, null, 2) + '\n');
      await writeFile(join(directory, 'instructions.txt'), instructions);
      await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      measurements[target.label] = summary;
    } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  const report = { schema: 1, measured_at: new Date().toISOString(), node: process.version,
    platform: process.platform, architecture: process.arch, profile: values.profile,
    caveats: [
      'UTF-8 bytes measure compact JSON after SDK decoding, not HTTP/SSE framing or actual model input tokens.',
      'Model visibility follows MCP Apps metadata: absent means model+app; explicit visibility must include model.',
      'Hosts can transform, omit or cache schema fields. These full definitions are not a billable-token measurement.',
      'Only initialize and tools/list are sent after isolated OAuth authorization; no Tasks, tools/call, providers or external peers are invoked.',
      'Full profile advertises Coordinator, worker, subagent and artifact surfaces with providers/peers empty; minimal disables federation, subagents and artifacts.',
      'Full profile enables the external-access config flag so loadConfig retains the subagent prompt; no external endpoint/provider is configured or invoked.',
      'Temporary origin/path normalization is used only for changed-definition hashes, never byte totals.',
      'Tokenizers are only probed in existing dependencies. No packages are installed and no guessed encoding is used.',
    ], measurements,
    ...(measurements.control ? { comparison: compareSurfaces(measurements.control, measurements.candidate) } : {}),
  };
  await writeFile(join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: join(output, 'comparison.json'), profile: values.profile,
    measurements: Object.fromEntries(Object.entries(measurements).map(([label, value]) => [label, {
      raw_tools: value.tools.raw_count, model_visible_tools: value.tools.model_visible_count,
      model_tools_json_utf8_bytes: value.tools.model_tools_envelope_json_utf8_bytes,
      instructions_utf8_bytes: value.initialization.instructions_utf8_bytes,
      legacy_filter_omissions: value.tools.old_measurement_filter_omitted_names,
    }])), ...(report.comparison ? { comparison: report.comparison } : {}) }, null, 2));
}

async function measure({ dist, sdkFrom, profile, temporary }) {
  const full = profile === 'full', target = {};
  stage = 'build_identity';
  for (const name of ['server.js', 'config.js', 'config-schema.js', 'user-config.js',
    'session/prompts.js', 'federation/mcp.js', 'messaging/task-messages.js', 'tasks/task-resume.js']) {
    try {
      const data = await readFile(join(dist, name));
      target[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    } catch (error) {
      if (error.code !== 'ENOENT' || ['server.js', 'config.js', 'config-schema.js', 'user-config.js'].includes(name)) throw error;
      target[name] = null;
    }
  }
  let running, httpServer, client;
  const ownerToken = randomBytes(32).toString('hex'), clusterToken = randomBytes(32).toString('hex');
  let accessToken;
  try {
    stage = 'module_import';
    const [{ createServer }, { defaultQuayMeshConfig }, { writeQuayMeshConfig }, { loadConfig }] = await Promise.all(
      ['server.js', 'config-schema.js', 'user-config.js', 'config.js'].map(name => import(pathToFileURL(join(dist, name)).href)));
    const require = createRequire(sdkFrom);
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href),
      import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href),
    ]);
    stage = 'isolated_config';
    const project = join(temporary, 'project'), stateDir = join(temporary, 'state'), configDir = join(temporary, 'config');
    await mkdir(project, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const port = await freePort(), rpcPort = await freePort(), ingressPort = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`, tokenFile = join(temporary, 'cluster-token');
    await writeFile(tokenFile, clusterToken + '\n', { mode: 0o600 });
    const env = { ...process.env, QUAYMESH_CONFIG_DIR: configDir, QUAYMESH_OAUTH_OWNER_TOKEN: ownerToken };
    const defaults = defaultQuayMeshConfig();
    await writeQuayMeshConfig({ ...defaults,
      server: { ...defaults.server, host: '127.0.0.1', port, publicBaseUrl: baseUrl },
      storage: { ...defaults.storage, stateDir },
      workspaces: { ...defaults.workspaces, allowedRoots: [project], worktreeRoot: join(temporary, 'worktrees') },
      network: { ...defaults.network, externalAccess: full },
      federation: { ...defaults.federation, enabled: full, host: '127.0.0.1', nodeId: 'surface-measure', coordinatorId: 'surface-measure',
        nickname: 'Isolated MCP measurement', port: rpcPort, ingressPort, tokenFile, tokenEnv: 'QUAYMESH_SURFACE_UNUSED_TOKEN', peers: [],
        roots: [{ id: 'main', nickname: 'Measurement workspace', path: project, enabled: true, tags: [] }],
        capabilities: { coordinator: full, worker: true, discovery: false, egress: false, meshRelay: false, desktopUi: false, consoleRelay: false },
        egress: { ...defaults.federation.egress, enabled: false } },
      subagents: { ...defaults.subagents, enabled: full, providers: [] },
      artifacts: { ...defaults.artifacts, enabled: full },
      skills: { ...defaults.skills, enabled: false, paths: [], agentDir: join(temporary, 'agents') },
      ui: { ...defaults.ui, enabled: true }, console: { ...defaults.console, allowRemote: false },
      logging: { ...defaults.logging, level: 'silent', requests: false, assets: false, toolCalls: false },
    }, env);
    const config = loadConfig(env);
    if (config.stateDir !== stateDir || config.configDir !== configDir || config.host !== '127.0.0.1'
      || config.allowedRoots.length !== 1 || config.allowedRoots[0] !== project || config.network?.externalAccess !== full
      || config.subagents.enabled !== full || config.subagents.providers.length || config.skillsEnabled || config.federation?.peers.length
      || config.federation?.egress.enabled) throw new Error('ISOLATED_CONFIG_INVARIANT');
    stage = 'core_start';
    running = createServer(config, { incomingArtifactAdapters: [] });
    await running.ready;
    httpServer = running.app.listen(port, '127.0.0.1');
    await new Promise((yes, no) => { httpServer.once('listening', yes); httpServer.once('error', no); });
    stage = 'isolated_oauth';
    accessToken = await issueAccessToken(baseUrl, ownerToken);
    stage = 'sdk_initialize';
    client = new Client({ name: 'quaymesh-isolated-surface-measurement', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }));
    const instructions = client.getInstructions() ?? '';
    stage = 'sdk_tools_list';
    const pages = [], seen = new Set();
    let cursor, bytes = 0;
    do {
      if (pages.length >= 50) throw new Error('TOOL_PAGE_LIMIT');
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      pages.push(page); bytes += jsonBytes(page);
      if (bytes > 8 * 1024 * 1024) throw new Error('TOOL_DEFINITION_BUDGET');
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('REPEATED_TOOL_CURSOR');
      if (cursor) seen.add(cursor);
    } while (cursor);
    const surface = summarizeSurface(pages, instructions, [[baseUrl, '<fixture-origin>'], [temporary, '<fixture-directory>']]);
    stage = 'prompt_variants';
    const { buildHostPrompt } = await import(pathToFileURL(join(dist, 'session/prompts.js')).href);
    const variants = Object.fromEntries(['en', 'zh'].map(language => {
      const value = buildHostPrompt(config, { language });
      return [language, { utf8_bytes: Buffer.byteLength(value), unicode_code_points: [...value].length,
        equals_initialize_instructions: value === instructions }];
    }));
    const sdkVersion = await installedPackage(require, '@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk');
    const tokenizerProbe = [];
    for (const name of ['js-tiktoken', 'tiktoken', 'gpt-tokenizer']) {
      const info = await installedPackage(require, name, name);
      if (info) tokenizerProbe.push(info);
    }
    const result = { dist, target, sdk: sdkVersion, profile,
      settings: { federation: full, coordinator: full, worker: true, subagents: full, providers: 0,
        artifacts_requested: full, skills: false, ui: true, external_access_config: full, peers: 0 },
      ...surface, prompt_variants: variants, tokenizer_probe: { installed: tokenizerProbe, token_counts: null,
        reason: 'No model-specific tokenizer/host serialization was specified; report UTF-8 bytes without estimating tokens.' },
      pages, instructions };
    const serialized = JSON.stringify(result);
    if ([ownerToken, clusterToken, accessToken].some(secret => serialized.includes(secret))) throw new Error('SECRET_IN_REPORT');
    stage = 'cleanup';
    return result;
  } finally {
    try { await client?.close(); }
    finally {
      try { if (httpServer) { httpServer.closeAllConnections(); await new Promise(done => httpServer.close(done)); } }
      finally { await running?.close(); }
    }
  }
}

async function installedPackage(require, specifier, name) {
  let file;
  try { file = require.resolve(specifier); } catch { return null; }
  for (let directory = dirname(file), depth = 0; depth < 12; depth += 1) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === name) return { name, version: pkg.version };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  return { name, version: null };
}

async function issueAccessToken(baseUrl, ownerToken) {
  const redirect = 'http://127.0.0.1/callback', resource = baseUrl + '/mcp';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const registration = await fetch(baseUrl + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'QuayMesh isolated surface measurement', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), signal: AbortSignal.timeout(10_000) });
  if (registration.status !== 201) throw new Error('ISOLATED_REGISTRATION_FAILED');
  const { client_id } = await registration.json();
  const approval = await fetch(baseUrl + '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', scope: 'quaymesh', resource, state: 'surface', owner_token: ownerToken }), signal: AbortSignal.timeout(10_000) });
  if (approval.status !== 302) throw new Error('ISOLATED_AUTHORIZATION_FAILED');
  const code = new URL(approval.headers.get('location')).searchParams.get('code');
  if (!code) throw new Error('ISOLATED_AUTHORIZATION_CODE_MISSING');
  const exchange = await fetch(baseUrl + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier,
      redirect_uri: redirect, resource }), signal: AbortSignal.timeout(10_000) });
  if (exchange.status !== 200) throw new Error('ISOLATED_TOKEN_EXCHANGE_FAILED');
  const { access_token } = await exchange.json();
  if (typeof access_token !== 'string' || access_token.length < 8) throw new Error('ISOLATED_TOKEN_MISSING');
  return access_token;
}

async function freePort() {
  const forbidden = new Set([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const server = createNetServer();
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const { port } = server.address();
    await new Promise(done => server.close(done));
    if (port && !forbidden.has(port)) return port;
  }
  throw new Error('FREE_PORT_EXHAUSTED');
}

async function runWorker(options) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('QUAYMESH_') || ['NODE_OPTIONS', 'NODE_COMPILE_CACHE'].includes(key)) delete env[key];
  env.QUAYMESH_CONFIG_DIR = join(options.temporary, 'config'); env.NODE_DISABLE_COMPILE_CACHE = '1';
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [self, '--worker', JSON.stringify(options)], { cwd: options.temporary,
      env, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result, failure;
    const timeout = setTimeout(() => { failure = new Error('Isolated MCP measurement exceeded 50 seconds'); child.kill(); }, 50_000);
    child.on('message', message => {
      if (message.error) failure = new Error('Isolated measurement failed: ' + JSON.stringify(message.error));
      else if (message.result) result = message.result;
    });
    child.once('error', error => { clearTimeout(timeout); no(error); });
    child.once('close', code => { clearTimeout(timeout);
      if (failure || code !== 0 || !result) no(failure ?? new Error(`Isolated worker exited ${code}`)); else yes(result); });
  });
}
