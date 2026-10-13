/** Browser fixture for the real fleet UI. These records are TEST DATA, not a live cluster. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const base = fileURLToPath(new URL('../../src/ui/fleet/', import.meta.url));
const requests = [];
const nodes = [
  { id: 'campus-s1', nickname: '计算服务器 1', role: 'gateway', priority: 200, platform: 'linux', roots: [{ id: 'vla-main', nickname: 'VLA 主代码', path: '/data/projects/vla', description: '核心代码、Todo 与当前实验', tags: ['vla', 'code'], enabled: true }, { id: 'results', nickname: '实验结果', path: '/data/results', description: '分析结果与可视化输出', tags: ['results'], enabled: true }] },
  { id: 'campus-s2', nickname: '计算服务器 2', role: 'worker', priority: 0, platform: 'linux', roots: [{ id: 'raw', nickname: '轨迹数据', path: '/raid/trajectories', description: '原始轨迹，就地处理大数据', tags: ['dataset', 'raw'], enabled: true }, { id: 'runs', nickname: '实验运行', path: '/raid/runs', description: 'GPU 实验与运行配置', tags: ['runs', 'gpu'], enabled: true }] },
  { id: 'desktop', nickname: '我的电脑', role: 'controller', priority: 100, platform: 'win32', roots: [{ id: 'game', nickname: 'Unity 游戏', path: 'D:\\Projects\\HearthStation', description: '场景、交互与视觉资产', tags: ['unity', 'game'], enabled: true }] },
].map((node, index) => ({ ...node, online: true, tools: ['read', 'apply_patch', 'exec_command', 'agent_task'], providers: [{ id: 'codex' }], updatedAt: Date.now(), lastSeen: Date.now(), latencyMs: [7.3, 11.8, 0][index],
  health: { cpuCount: [32, 48, 16][index], load: [2.5, 2.1, 1.8], memoryTotal: 128 * 1024 ** 3, memoryFree: [78, 65, 103][index] * 1024 ** 3, activeCalls: [1, 2, 0][index], uptime: 12600,
    gpus: index < 2 ? [{ name: 'RTX 4090', utilization: [34, 97][index], memoryUsedMiB: [19456, 41500][index], memoryTotalMiB: 49152 }, { name: 'RTX 4090', utilization: [3, 91][index], memoryUsedMiB: [2300, 40000][index], memoryTotalMiB: 49152 }] : [] },
  egress: { enabled: true, healthy: true, healthySince: Date.now() - 60000 } }));
const settings = Object.fromEntries(nodes.map((node) => [node.id, { nodeId: node.id, nickname: node.nickname, role: node.role, priority: node.priority, roots: node.roots,
  peers: nodes.filter((peer) => peer.id !== node.id).map((peer) => ({ id: peer.id, nickname: peer.nickname, url: peer.id === 'desktop' ? '' : `https://${peer.id}:7680` })),
  egress: { enabled: true, listenPort: 17890, proxyUrl: 'http://127.0.0.1:7890', mihomoConfig: '/home/user/.config/mihomo/config.yaml', probeUrl: 'https://www.gstatic.com/generate_204', probeIntervalMs: 15000, recoveryDelayMs: 30000, inheritProxy: true, controllerSecretEnv: 'MIHOMO_SECRET' } }]));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/fixture-requests') return json(requests);
  if (url.pathname.startsWith('/console/api/')) {
    let text = ''; for await (const chunk of req) text += chunk; const body = text ? JSON.parse(text) : undefined;
    if (body) requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/login')) { if (body.password !== 'test-owner') return json({ code: 'LOGIN_REJECTED' }, 401); res.setHeader('Set-Cookie', 'fixture=1; Path=/; HttpOnly'); return json({ csrf: 'fixture-csrf' }); }
    if (!req.headers.cookie?.includes('fixture=1')) return json({ code: 'CONSOLE_LOGIN_REQUIRED' }, 401);
    if (url.pathname.endsWith('/session')) return json({ csrf: 'fixture-csrf' });
    if (url.pathname.endsWith('/logout')) return json({ authenticated: false });
    if (url.pathname.endsWith('/status')) return json({ enabled: true, localNodeId: 'desktop', role: 'controller', gatewayId: 'campus-s1', publicMcpUrl: 'https://quaymesh.example.com/mcp', nodes, events: [{ time: new Date().toISOString(), kind: 'gateway', nodeId: 'campus-s1', message: '发信端切换至计算服务器 1' }], transfers: [] });
    if (url.pathname.endsWith('/overview')) return json({ nodes: nodes.map((node, index) => ({ nodeId: node.id, online: true, projects: [{ id: 'project-' + index, name: node.roots[0]?.nickname, root: node.roots[0]?.path }], recent: [{ projectId: 'project-' + index, projectName: node.roots[0]?.nickname, entries: [{ id: 'run-' + index, title: ['检查反馈实验与代码', '轨迹统计分析', '更新交互场景'][index], status: index === 2 ? 'completed' : 'running', created_at: new Date().toISOString() }] }], transfers: [] })) });
    if (url.pathname.endsWith('/settings/get')) return json(settings[body.nodeId]);
    if (url.pathname.endsWith('/settings/update')) { Object.assign(settings[body.nodeId], body.settings); const node = nodes.find((entry) => entry.id === body.nodeId); for (const key of ['nickname', 'roots', 'role', 'priority']) if (key in body.settings) node[key] = body.settings[key]; return json(settings[body.nodeId]); }
    if (url.pathname.endsWith('/mihomo/sync')) return json({ results: body.nodeIds.map((nodeId) => ({ nodeId, saved: true, reloaded: body.reload })) });
    return json({ message: 'Unknown fixture route' }, 404);
  }
  const relative = decodeURIComponent(url.pathname.replace(/^\/console\/fleet\/?/, '')) || 'index.html';
  const path = resolve(base, relative);
  if (!path.startsWith(base)) { res.writeHead(403); res.end(); return; }
  try { const content = await readFile(path); res.setHeader('Content-Type', { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[extname(path)] ?? 'application/octet-stream'); res.end(content); } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
