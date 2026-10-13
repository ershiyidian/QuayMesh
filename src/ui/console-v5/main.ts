import { notifyDesktop,desktopActions } from './desktop.js';
import { taskStages } from '../../console-task-state.js';
import { brand,workspaceSummary,conversationCards } from './workspace-presentation.js';
import { Resources } from "./resources.js";
import { $, $$, updateHTML } from "./dom.js";
import { dialog, formObject } from "./dialogs.js";
import { consoleError, type ConsoleError, type ConsoleSession } from "./client.js";
import { icon } from './icons.js';
import { setDisplayTimeZone, timeZone, tm, fullTime, day, smartTime, ago, duration, fmt, compact, bytes, csvCell } from './format.js';
import { esc, clamp, stages, stage, status, btn, ib, badge, meter, smallTime, spark, usageText, diffStat, elapsed, QUALITY } from './presentation.js';
import type { Run, RunDetail, RunPage, Overview, Fleet, Machine, ChangeFile, Command, FileDiff, PatchPage, Project, Root, ListResponse, Sessions, Thread, SourceState, UsageReport, ActivityPage, EventRow, TransferRow, AuditRow, RevertPreview, RevertReceipt, ArchivePreview, ReviewReceipt, Preferences, Route, CacheEntry } from './contracts.js';
import Prism from "prismjs";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-python.js";
import { createApi, ApiError } from "./client.js";
import { cacheRatio, noncachedInput, usageParts } from "./usage.js";
import { CommandOutputs } from "./command-output.js";
import { workspaceHandle } from "../../federation/routing.js";
import "./styles.css";
import './experience.css';
Prism.manual = true;



const enc = (value: string | number | boolean | null | undefined) => encodeURIComponent(value ?? '');
const clone = <T>(v: T): T => structuredClone(v);

const uid = () => globalThis.crypto?.randomUUID?.() || `tq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const storage = { get<T>(k: string, d: T): T { try {
        return JSON.parse(localStorage.getItem(k) ?? 'null') as T | null ?? d;
    }
    catch {
        return d;
    } }, set(k: string, v: unknown) { try {
        localStorage.setItem(k, JSON.stringify(v));
    }
    catch { } }, del(k: string) { try {
        localStorage.removeItem(k);
    }
    catch { } } };
const DEFAULTS = { theme: 'dark', density: 'compact', sidebar: 'expanded', poll: 8, listWidth: 320, base: '/console/api/v4/', wrap: true, notifications: false, timeZone: 'local' };
const savedPreferences = storage.get('quaymesh.workbench.v5', {});
let pref: Preferences = { ...DEFAULTS, ...Object.fromEntries(Object.entries(savedPreferences).filter(([key]) => key in DEFAULTS && key !== 'base')) };
if (!['dark', 'light', 'system'].includes(pref.theme))
    pref.theme = 'dark';
pref.poll = clamp(pref.poll, 0, 60);
pref.listWidth = clamp(pref.listWidth, 270, 520);
const systemTheme = matchMedia('(prefers-color-scheme: light)');
function applyPrefs() { setDisplayTimeZone(pref.timeZone); const d = document.documentElement; d.dataset.theme = pref.theme === 'system' ? (systemTheme.matches ? 'light' : 'dark') : pref.theme; notifyDesktop('theme',d.dataset.theme); d.dataset.density = pref.density; d.dataset.sidebar = pref.sidebar; d.style.setProperty('--list-width', pref.listWidth + 'px'); $<HTMLMetaElement>('meta[name=theme-color]')!.content = d.dataset.theme === 'light' ? '#f6f7f9' : '#111214'; }
function savePref(p: Partial<Preferences>) { pref = { ...pref, ...p }; storage.set('quaymesh.workbench.v5', pref); applyPrefs(); }






























const API = createApi(() => { authRequired = true; schedulePaint(); });
const resources = new Resources(API, { freshness, paint: schedulePaint, observe: observeStages, loaded(path) { if (path === 'projects' || path.startsWith('runs')) ensureRoute(); } });
const CACHE = resources.entries, selectedRuns = new Set<string>(), selectedThreads = new Set<string>(), expandedRoots = new Set<string>(), loadedBigFiles = new Set<string>(), expandedGroups = new Set<string>();
let route: Route = parseRoute(), authRequired = false, booting = true, paintQueued = false, refreshTimer: ReturnType<typeof setTimeout> | undefined = undefined, failures = 0, refreshInFlight = false, backgroundPaused = false, activityPaused = false, activePaths = new Set<string>(), lastFocus: HTMLElement | null = null, paletteState: { close: () => void } | null = null;
const diffLimits = new Map<string, number>();
let pageSearch = '', sessionSearch = '', groupEvents = true, sortLayout = 'list', machineLayout = 'cards', diffMode = 'unified', writePending = new Set<string>();
const NAV = [['overview', '运行总览', 'overview'], ['tasks', '任务', 'tasks'], ['changes', '改动审查', 'changes'], ['sessions', '会话', 'sessions'], ['machines', '机器', 'machines'], ['workspaces', '工作空间', 'workspaces'], ['activity', '活动', 'activity'], ['usage', '用量分析', 'usage'], ['settings', '设置', 'settings']];
const titleOf = (v: string) => NAV.find(n => n[0] === v)?.[1] || '运行总览';
function parseRoute() { const [v, q] = location.hash.replace(/^#\/?/, '').split('?'); return { view: ['overview', 'tasks', 'changes', 'sessions', 'machines', 'workspaces', 'activity', 'usage', 'settings'].includes(v) ? v : 'overview', p: Object.fromEntries(new URLSearchParams(q || '')) }; }
function currentQuery(extra: Record<string, string | number | boolean | null | undefined> = {}): string {
  const p = route.p;
  return queryString({ tz: timeZone() || deviceTimeZone, days: p.days ?? '0', node: p.node, project: p.project, q: p.q, status: p.status, sort: p.sort,
    cursor: p.cursor, limit: p.limit || '25', changed: route.view === 'changes' ? '1' : p.changed, date: p.date, finishedDay: p.finishedDay,
    execution: p.execution, attention: p.attention, ...extra });
}
function queryString(parameters: Record<string, string | number | boolean | null | undefined>): string {
  return new URLSearchParams(Object.entries(parameters).flatMap(([key, value]): Array<[string,string]> => value === undefined || value === null || value === '' ? [] : [[key,String(value)]])).toString();
}
const runPath = () => 'runs?' + currentQuery();
const activityPath = () => 'activity?' + new URLSearchParams(Object.fromEntries(Object.entries({ kind: route.p.kind || 'events', q: route.p.q || '', node: route.p.node || '', level: route.p.level || '', cursor: route.p.cursor || '', hour: route.p.hour || '' }).filter(([, v]) => v)));
const usagePath = () => 'usage?' + currentQuery({ days: route.p.days || '14', cursor: null, limit: null, status: null });
const data = <T = unknown>(path: string): T | undefined => CACHE.get(path)?.data as T | undefined;
const fleet = () => data<Fleet>('fleet/status');
const overviewPath = () => 'overview?tz=' + enc(timeZone() || deviceTimeZone);
const overview = () => data<Overview>(overviewPath());
const projects = () => data<ListResponse<Project>>('projects')?.items || [];
const node = (id: string | null | undefined) => fleet()?.nodes?.find(n => n.id === id);
const nodeTag = (id: string | null | undefined, short = false) => { const n = node(id); return `<span class="node-label"><span class="node-mark ${n?.online === false ? 'offline' : ''}">${esc(n?.short || id?.slice(0, 3) || '?')}</span>${short ? '' : `<span class="ellipsis">${esc(n?.name || id || '未知节点')}</span>`}</span>`; };
const taskScope = (run: Run, short = true) => run.nodeIds && run.nodeIds.length > 1
  ? `<span class="node-label" title="${esc(run.nodeIds.map(id => node(id)?.name || id).join('、'))}"><span class="node-mark">${run.nodeIds.length}</span>${short ? '' : `<span class="ellipsis">${run.nodeIds.length} 个节点</span>`}</span>`
  : nodeTag(run.nodeId, short);
const canWrite = (cap = 'write') => !!API.session?.capabilities?.write && API.session.capabilities[cap] !== false;
const writeAttrs = (cap = 'write') => canWrite(cap) ? '' : 'disabled title="当前接口或凭据不允许此操作"';
const selectedRun = () => data<RunDetail>('runs/' + enc(route.p.run || ''))?.run;
function routePaths() {
    const list = ['fleet/status', overviewPath(), 'projects'];
    if (['tasks', 'changes'].includes(route.view)) {
        list.push(runPath());
        if (route.p.run) {
            const path = 'runs/' + enc(route.p.run);
            list.push(path);
            const detail = data<RunDetail>(path);
            if ((route.p.tab || (route.view === 'changes' ? 'diff' : 'summary')) === 'diff' && detail?.files?.length)
                for (const f of visibleFiles(detail))
                    if (openFiles(detail).has(f.id) && (!f.generated || loadedBigFiles.has(route.p.run + ':' + f.id)))
                        list.push(path + '/files/' + enc(f.id));
        }
    }
    else if (route.view === 'sessions' && route.p.project)
        list.push('projects/' + enc(route.p.project) + '/sessions');
    else if (route.view === 'workspaces')
        list.push('roots');
    else if (route.view === 'activity' && !activityPaused)
        list.push(activityPath());
    else if (route.view === 'usage')
        list.push(usagePath());
    return list;
}
function freshness(path: string) {
    if (path === 'projects')
        return 60000;
    if (path === 'roots' || path.startsWith('usage?'))
        return 30000;
    if (path.startsWith('overview') && !['overview', 'machines'].includes(route.view))
        return 30000;
    if (path.includes('/files/'))
        return Infinity;
    if (/^runs\/[^/?]+$/.test(path)) {
        const r = data<RunDetail>(path)?.run;
        if (r && !['running', 'queued', 'stopping', 'waiting'].includes(r.executionStatus))
            return Math.max(30000, (pref.poll || 8) * 1000);
    }
    return Math.max(1000, (pref.poll || 8) * 1000);
}

async function load(path: string, force = false): Promise<unknown> { return resources.load(path, force); }
function ensureRoute() {
    if (authRequired || booting)
        return;
    if (route.view === 'sessions' && !route.p.project && route.p.picker !== '1' && projects().length) {
        const saved = storage.get('quaymesh.last-project', null);
        const chosen = projects().find(p => p.id === saved) || projects().slice().sort((a, b) => b.active - a.active || b.updatedAt - a.updatedAt)[0];
        navigate('sessions', { project: chosen.id }, true);
        return;
    }
    if (route.view === 'changes' && !route.p.run && route.p.browse !== '1' && data<RunPage>(runPath())?.items.length) {
        navigate('changes', { run: data<RunPage>(runPath())!.items[0].id, tab: 'diff' }, true, true);
        return;
    }
    const next = new Set(routePaths());
    activePaths.forEach(path => { if (!next.has(path)) {
        const e = CACHE.get(path);
        if (e?.loading)
            e.ctl?.abort();
    } });
    activePaths = next;
    next.forEach(path => load(path));
    if (CACHE.size > 120) {
        for (const [path, e] of CACHE) {
            if (!next.has(path) && !e.loading)
                CACHE.delete(path);
            if (CACHE.size <= 90)
                break;
        }
    }
}
function navigate(view: string, patch: Record<string, string | number | boolean | null | undefined> = {}, replace = false, keep = false) { const oldView = route.view, p = keep ? { ...route.p } : {}; Object.entries(patch).forEach(([k, v]) => v == null || v === '' ? delete p[k] : p[k] = String(v)); route = { view, p }; const qs = queryString(p), hash = '#/' + view + (qs ? '?' + qs : ''); try {
    history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
catch {
    location.hash = hash;
} if (oldView !== view) {
    selectedRuns.clear();
    selectedThreads.clear();
    pageSearch = '';
    $('#view')!.scrollTop = 0;
} ensureRoute(); schedulePaint(); if (p.run) {
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTimeout(() => { if (innerWidth <= 1000)
        $('#inspector-close')?.focus(); }, 30);
} }
function param(p: Record<string, string | number | boolean | null | undefined>) { if ('q' in p || 'status' in p || 'node' in p || 'project' in p || 'days' in p || 'sort' in p)
    p.cursor = null; selectedRuns.clear(); navigate(route.view, p, true, true); }
function schedulePaint() { if (paintQueued)
    return; paintQueued = true; requestAnimationFrame(() => { paintQueued = false; paint(); }); }
async function refresh(manual = false) { if (refreshInFlight || booting || authRequired)
    return; refreshInFlight = true; schedulePaint(); try {
    const paths = routePaths().filter(p => !activityPaused || !p.startsWith('activity?'));
    activePaths = new Set(routePaths());
    await Promise.all([...paths.map(p => load(p, manual)), ...visibleCommandPaths().map(path => loadCommand(path, manual))]);
    const errors = paths.filter(p => CACHE.get(p)?.error);
    failures = errors.length ? Math.min(failures + 1, 4) : 0;
    if (manual)
        toast(errors.length ? `${errors.length} 个资源刷新失败，其余数据可用` : '已刷新当前视图', errors.length ? 'warn' : 'good');
}
finally {
    refreshInFlight = false;
    schedulePaint();
    schedulePoll();
} }
function schedulePoll() { clearTimeout(refreshTimer); if (!pref.poll || document.hidden || backgroundPaused || booting || authRequired)
    return; const interval = Math.min(60000, pref.poll * 1000 * 2 ** failures); refreshTimer = setTimeout(() => refresh(), interval + (failures ? Math.random() * 1000 : 0)); }
function resourceState(path: string) { const e = CACHE.get(path); if (e?.data)
    return ''; if (e?.error)
    return `<div class="panel">${empty('读取失败', e.error.message, btn('重试', 'retry', `data-path="${esc(path)}"`))}</div>`; return `<div class="panel loading" aria-busy="true" aria-label="正在读取数据"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`; }
function staleNotice(path: string) {
  const entry = CACHE.get(path);
  const sources = (entry?.data as { sources?: SourceState[] } | null)?.sources?.filter(source => source.state === "error" || source.state === "offline" || (source.state === "loading" && !source.observedAt)) || [];
  const warnings = (entry?.data as { warnings?: string[] } | null)?.warnings || [];
  const messages = [entry?.error?.message, ...sources.map(source => (source.name || source.nodeId) + '：' + (source.error || '尚未取得数据')), ...warnings].filter(Boolean);
  if (!messages.length) return '';
  return '<div class="notice warn visually-spaced">' + icon('alert') + '<div>' + messages.map(esc).join('<br>') + '</div>' + btn('重试', 'retry', 'data-path="' + esc(path) + '"', 'small') + '</div>';
}
function empty(title: string, text = '', action = '') { return `<div class="empty">${icon('workspaces', 26)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`; }
const pageHead = (title: string, subtitle = '', actions = '') => `<header class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
const panel = (title: string, body: string, right = '', foot = '') => `<section class="panel"><div class="panel-head"><h3>${title}</h3>${right ? `<div class="right">${right}</div>` : ''}</div>${body}${foot ? `<div class="panel-foot">${foot}</div>` : ''}</section>`;
function tabs(items: Array<[string, string, (number | null | undefined)?]>, value: string, action = 'tab', attr = 'data-value') { return `<div class="tabs" aria-label="视图筛选">${items.map(([id, text, count]) => `<button class="tab ${id === value ? 'active' : ''}" data-action="${action}" ${attr}="${esc(id)}" aria-pressed="${id === value}">${text}${count != null ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</div>`; }
function segmented(items: Array<[string, string]>, value: string | number, action: string, extra = '') { return `<div class="segmented">${items.map(([id, label]) => `<button type="button" class="${String(id) === String(value) ? 'active' : ''}" data-action="${action}" data-value="${esc(id)}" aria-pressed="${String(id) === String(value)}" ${extra}>${label}</button>`).join('')}</div>`; }
function searchField(value: string | undefined, placeholder = '搜索标题、ID 或项目…', kind = 'query') { return `<label class="search-field">${icon('search', 15)}<span class="sr-only">${esc(placeholder)}</span><input class="input" id="${kind}-search" data-search="${kind}" type="search" value="${esc(value || '')}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`; }
const opt = (v: string | number, t: string, current: string | number | null | undefined) => `<option value="${esc(v)}" ${String(v) === String(current || '') ? 'selected' : ''}>${esc(t)}</option>`;
function scopes(project = true) { return `<select class="select" data-param="node" aria-label="机器范围">${opt('', '全部机器', route.p.node)}${(fleet()?.nodes || []).map(n => opt(n.id, n.short + ' · ' + n.name, route.p.node)).join('')}</select>${project ? `<select class="select" data-param="project" aria-label="项目范围">${opt('', '全部项目', route.p.project)}${projects().filter(p => !route.p.node || p.nodeId === route.p.node).map(p => opt(p.id, p.name, route.p.project)).join('')}</select>` : ''}`; }
function rangeSelect(value = '7', all = true) { return `<select class="select" data-param="days" aria-label="时间范围">${[['1', '近 24 小时'], ['7', '近 7 天'], ['14', '近 14 天'], ['30', '近 30 天'], ['0', '全部历史']].filter(([v]) => all || v !== '0').map(([v, t]) => opt(v, t, value)).join('')}</select>`; }
function pagination(d: RunPage | ActivityPage<unknown>) {
  const previous = 'previousCursor' in d ? d.previousCursor : String(Math.max(0, d.offset - d.limit));
  return '<div class="pagination"><span>' + (d.total ? (d.offset + 1) + '–' + Math.min(d.offset + d.items.length, d.total) + ' / ' + fmt(d.total) + ' 条' : '0 条')
    + '</span><div class="actions">' + btn(icon('back', 14) + '上一页', 'page', 'data-value="' + esc(previous || '') + '" ' + (d.offset === 0 ? 'disabled' : ''), 'small')
    + btn('下一页' + icon('chevron', 14), 'page', 'data-value="' + esc(d.nextCursor || '') + '" ' + (d.nextCursor == null ? 'disabled' : ''), 'small') + '</div></div>';
}




const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function chrome() {
    const ov = overview(), f = fleet(), fails = [...activePaths].filter(p => CACHE.get(p)?.error);
    const nav = NAV.map(([v, t, i], index) => `${index === 4 ? '<div class="nav-label">基础设施</div>' : ''}${index === 8 ? '<div class="nav-divider"></div>' : ''}<button type="button" class="nav-item ${route.view === v ? 'active' : ''}" data-action="nav" data-view="${v}" ${route.view === v ? 'aria-current="page"' : ''} title="${t}">${icon(i, 16)}<span class="label">${t}</span>${v === 'tasks' && ov?.runningCount ? `<span class="nav-count" title="${ov.runningCount} 项运行中">${ov.runningCount}</span>` : ''}</button>`).join('');
    updateHTML($('#sidebar'), `<div class="brand">${brand()}<span class="brand-text">QuayMesh</span>${ib('panel', 'sidebar', '折叠侧栏')}</div><div class="nav-label">工作台</div><nav aria-label="主导航">${nav}</nav><div class="sidebar-bottom"><button class="nav-item" data-action="palette" title="搜索与命令">${icon('terminal')}<span class="label">命令面板</span><kbd class="nav-count">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button><div class="profile"><span class="avatar">W</span><div class="profile-text"><b>${esc(API.session?.user?.name || 'Owner')}</b><small>${canWrite() ? '管理员' : '只读'}</small></div>${ib('settings', 'nav', '设置', 'data-view="settings"')}</div></div>`);
    updateHTML($('#topbar'), `<button class="collapsed-toggle icon-btn" data-action="sidebar" aria-label="展开侧栏">${icon('panel')}</button><div class="breadcrumb"><span class="workspace-label">个人工作区</span><span class="slash">/</span><b>${esc(titleOf(route.view))}</b></div><button class="top-search" data-action="palette" aria-label="搜索与命令面板">${icon('search', 14)}<span>搜索任务或命令</span><kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button><button class="demo-tag" data-action="api-settings">API</button>${desktopActions()}${ib('refresh', 'refresh', '刷新当前页面', refreshInFlight ? 'disabled' : '')}${ib(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 'theme', '切换主题', '', 'theme-top')}`);
    updateHTML($('#global-notice'), failureSummary());
    updateHTML($('#statusbar'), `<span class="inline ${fails.length ? 'amber' : booting ? 'muted' : 'green'}"><i class="dot"></i>${booting ? '连接中' : authRequired ? '请登录' : bootstrapError ? '未连接' : fails.length ? '读取异常' : '已连接'}</span><button data-action="nav" data-view="machines">${f ? f.nodes.filter(n => n.online).length + '/' + f.nodes.length + ' 节点在线' : '读取节点'}</button><span>出网 ${esc(node(f?.gatewayId)?.short || '—')}</span><span class="spacer"></span><span>${document.hidden || backgroundPaused ? '已暂停' : pref.poll ? pref.poll + ' 秒刷新' : '手动刷新'}</span><span>${timeZone() || deviceTimeZone}</span><button data-action="shortcuts">快捷键</button>`);
    updateHTML($('#bottom-nav'), [['overview', '总览', 'overview'], ['tasks', '任务', 'tasks'], ['sessions', '会话', 'sessions'], ['machines', '机器', 'machines'], ['more', '更多', 'more']].map(([v, t, i]) => `<button class="${v === route.view || v === 'more' && !['overview', 'tasks', 'sessions', 'machines'].includes(route.view) ? 'active' : ''}" data-action="${v === 'more' ? 'more' : 'nav'}" data-view="${v}" aria-label="${t}">${icon(i, 19)}<span>${t}</span></button>`).join(''));
}
function failureSummary() {
  if (authRequired) return '<div class="notice global-notice warn">' + icon('lock', 14) + '登录已过期</div>';
  const failed = [...activePaths].filter(path => CACHE.get(path)?.error);
  const sources = new Map();
  for (const path of activePaths) for (const source of data<{ sources?: SourceState[] }>(path)?.sources || []) if (source.state === "error" || source.state === "offline") sources.set(source.nodeId, source);
  const notices = [];
  if (failed.length) notices.push(failed.length + ' 项读取失败');
  if (sources.size) notices.push([...sources.values()].map(source => source.name || source.nodeId).join('、') + '数据未更新，统计仅包含已读取记录');
  return notices.length ? '<div class="notice global-notice warn">' + icon('alert', 14) + '<span>' + esc(notices.join(' · ')) + '</span>' + btn('重试', 'refresh', '', 'small') + '</div>' : '';
}
let bootstrapError:ConsoleError|null=null;
let bootstrapRetryTimer:ReturnType<typeof setTimeout>|undefined;
let bootstrapAttempts=0;
function paint() {
    chrome();
    const root = $('#view')!;
    root.classList.toggle('split-view', ['tasks', 'changes', 'sessions'].includes(route.view));
    let html;
    if (authRequired)
        html = loginPage();
    else if (bootstrapError)
        html = `<div class="page"><section class="login-panel">${brand(48)}<h1>控制台暂未连接</h1><p>${esc(bootstrapError.message)}</p>${btn('重新连接','reconnect','','primary')}</section></div>`;
    else if (booting)
        html = `<div class="page">${pageHead('正在建立连接', '读取会话与接口能力')}${resourceState('session')}</div>`;
    else
        html = renderView();
    updateHTML(root, `<div data-key="view-${route.view}-${authRequired ? 'login' : 'app'}" style="${['tasks', 'changes', 'sessions'].includes(route.view) && !authRequired ? 'height:100%;min-height:0' : ''}">${html}</div>`);
    const overlay = !!route.p.run && ['tasks', 'changes'].includes(route.view) && innerWidth <= 1000;
    ['#sidebar', '#topbar', '#bottom-nav', '#statusbar'].forEach(sel => { const el = $(sel); if (el)
        el.inert = overlay; });
    const list = $('.list-pane');
    if (list)
        list.inert = overlay;
    const ins = $('.inspector');
    if (ins) {
        ins.setAttribute('role', overlay ? 'dialog' : 'region');
        if (overlay)
            ins.setAttribute('aria-modal', 'true');
        else
            ins.removeAttribute('aria-modal');
    }
    attachClock();
}
async function loadCommand(path: string, force = false) {
  await commandReader.load(path, new Set(visibleCommandPaths()), force);
}
function visibleCommandPaths() {
  if (!route.p.run || route.p.tab !== 'commands') return [];
  const detail = data<RunDetail>('runs/' + enc(route.p.run));
  return (detail?.commands || []).filter(command => command.outputAvailable && (document.getElementById('command-' + command.id) as HTMLDetailsElement | null)?.open)
    .map(command => 'runs/' + enc(route.p.run) + '/commands/' + enc(command.id));
}
function commandOutputText(command: Command, runId: string) {
  if (!command.outputAvailable) return command.output || '此命令没有保存可读取的输出';
  const entry = commandOutputs.get('runs/' + enc(runId) + '/commands/' + enc(command.id));
  if (!entry) return '展开后读取命令输出';
  return (entry.truncated ? '较早输出已截断，以下为最近内容。\n' : '') + entry.text
    + (entry.hasMore ? '\n还有已保存的输出，可以继续读取。' : '')
    + (entry.error ? '\n读取失败：' + entry.error : '') || '等待输出';
}
async function loadMoreFile(path: string): Promise<void> {
  const count = await resources.moreFile(path);
  const file = data<FileDiff>(path)?.file;
  if (count !== null && file) diffLimits.set(route.p.run + ':' + file.id, count);
}
document.addEventListener('toggle', event => {
  const target = (event.target as HTMLElement);
  if (target instanceof HTMLDetailsElement && target.open && target.id.startsWith('command-') && route.p.run) {
    const commandId = target.id.slice('command-'.length);
    const command = data<RunDetail>('runs/' + enc(route.p.run))?.commands.find(command => command.id === commandId);
    if (command?.outputAvailable) void loadCommand('runs/' + enc(route.p.run) + '/commands/' + enc(commandId));
  }
}, true);
function renderView() { return ({ overview: overviewPage, tasks: tasksPage, changes: tasksPage, sessions: sessionsPage, machines: machinesPage, workspaces: workspacesPage, activity: activityPage, usage: usagePage, settings: settingsPage } as Record<string, () => string>)[route.view](); }
function overviewRunCard(r: Run) {
    const state = stage(r);
    return `<article class="run-card" data-key="active-${esc(r.id)}"><header><span class="session-symbol">${icon('changes', 16)}<i class="session-dot ${state}"></i></span><div class="run-card-title"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)}">${esc(r.title)}</button><div class="run-sub">${taskScope(r, true)}${workspaceSummary(r)}</div></div>${ib('chevron', 'open-run', '打开任务', `data-id="${esc(r.id)}"`)}</header>${r.command ? `<button class="session-live" data-action="card-command" data-id="${esc(r.id)}"><span class="spinner"></span><span class="agent-label">${esc(r.agent)}</span><code title="${esc(r.command)}">${esc(r.command)}</code></button>` : ''}<footer>${status(state)}<span class="spacer"></span>${elapsed(r)}<span class="divider"></span>${usageText(r)}</footer></article>`;
}
function overviewPage() {
    const o = overview(), f = fleet();
    if (!o)
        return `<div class="page">${pageHead('运行总览')}${resourceState(overviewPath())}</div>`;
    const shown = (value: number | null | undefined) => value == null ? '未取得' : value;
    const detail = (value: number | null | undefined, suffix: string) => value == null ? '数据未完整取得' : value + suffix;
    const metric = (label: string, value: string | number | null, sub: string, action: string, tone = '') => `<button class="metric metric-button" data-action="${action}"><span class="metric-label">${label}</span><span class="metric-main"><b class="${tone}">${value}</b><small>${sub}</small></span></button>`;
    const active = o.active.filter(r => ['running','stopping'].includes(stage(r))), queue = o.active.filter(r => stage(r) === 'queued');
    const running = `<section class="overview-active"><div class="section-line"><h3>当前工作 <span class="muted small">${o.runningCount ?? active.length}</span></h3><button class="link-btn" data-action="nav" data-view="tasks">全部任务 ${icon('arrow', 13)}</button></div><div class="active-card-grid">${active.map(overviewRunCard).join('') || empty('暂无当前工作')}</div>${queue.length ? `<div class="queue-strip">${icon('queued', 14)}<b>${o.queuedCount ?? queue.length} 项排队</b><span class="ellipsis">${esc(queue.map(r => r.title).join('、'))}</span>${btn('查看', 'queued-queue', '', 'small ghost')}</div>` : ''}</section>`;
    const waiting = o.waiting.length ? panel('等待下一步', o.waiting.map(r=>`<div class="recent-row"><span>${icon('waiting',14)}</span><div class="recent-name"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}">${esc(r.title)}</button>${workspaceSummary(r)}</div>${smallTime(r.lastActivityAt)}</div>`).join(''), btn('查看全部 '+(o.waitingCount ?? ''),'waiting-queue','','ghost small')) : '';
    const recent = panel('最近结束', o.recent.map(r => `<div class="recent-row" data-key="recent-${esc(r.id)}"><span>${icon(stage(r), 14)}</span><div class="recent-name"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}">${esc(r.title)}</button>${workspaceSummary(r)}</div>${status(stage(r))}${smallTime(r.finishedAt || r.startedAt)}</div>`).join('') || empty('暂无执行记录'), btn('查看全部', 'nav', 'data-view="tasks"', 'ghost small'));
    const attention = panel('需要处理', o.attention.slice(0, 3).map(a => `<div class="attention-row" data-key="attention-${esc(a.id)}"><span class="${a.kind === 'failed' ? 'red' : 'amber'}">${icon(a.kind, 16)}</span><div><button class="run-title" data-action="open-run" data-id="${esc(a.id)}">${esc(a.title)}</button><p title="${esc(a.detail)}">${esc(a.detail)}</p></div>${ib('chevron', 'open-run', '查看异常', `data-id="${esc(a.id)}"`)}</div>`).join('') || empty('没有执行异常'), o.attentionCount == null ? badge('数据未完整取得') : badge(o.attentionCount + ' 项', o.attentionCount ? 'warn' : ''), o.attentionCount != null && o.attentionCount > 3 ? `<button class="link-btn" data-action="attention-queue">全部 ${o.attentionCount} 项 ${icon('arrow', 13)}</button>` : '');
    const fleetBody = f ? `<div class="fleet-labels"><span>节点</span><span>CPU</span><span>内存</span></div>${f.nodes.map(n => `<div class="fleet-row" data-key="fleet-${esc(n.id)}"><button class="run-title" data-action="node" data-id="${esc(n.id)}">${nodeTag(n.id)}<span class="small muted fleet-description">${n.id === f.gatewayId ? '当前出口' : n.online ? n.gpus.length + ' GPU' : '离线'}</span></button><div class="reading">${n.online && n.cpu != null ? fmt(n.cpu) + '%' : '—'}${meter(n.online ? n.cpu : 0)}</div><div class="reading">${n.online ? Math.round(n.memoryUsed / n.memoryTotal * 100) + '%' : '—'}${meter(n.online ? n.memoryUsed / n.memoryTotal * 100 : 0)}</div></div>`).join('')}` : resourceState('fleet/status');
    const machines = panel('机器', fleetBody, f ? `<button class="link-btn small" data-action="nav" data-view="machines">${f.nodes.filter(n => n.online).length}/${f.nodes.length} 在线 ${icon('chevron', 12)}</button>` : '');
    const gateway = f ? panel('连接', `<div class="connection-grid"><span class="muted">入口</span><span>${esc(node(f.ingressNodeId)?.short || '尚未配置')}</span>${f.ingressNodeId ? badge(node(f.ingressNodeId)?.online ? '在线' : '未连接', node(f.ingressNodeId)?.online ? 'good' : 'warn') : badge('入口未配置')}<span class="muted">出网</span><span>${esc(node(f.gatewayId)?.short || '—')} · ${esc(node(f.gatewayId)?.egress?.region || '—')}</span><span class="num small">${node(f.gatewayId)?.egress?.latency ?? '—'} ms</span></div><div class="endpoint"><code>${esc(f.mcpUrl || f.ingressLabel || (f.ingressNodeId ? '由该节点的托管 MCP 隧道提供' : '尚未配置 MCP 入口'))}</code>${ib('copy', 'copy', '复制 MCP 地址', `data-text="${esc(f.mcpUrl || '')}" ${f.mcpUrl ? '' : 'disabled'}`)}</div>`) : '';
    const usage = panel('今日项目用量', o.projects.filter(p => (p.usage ?? 0) > 0).map(p => `<div class="usage-project-line"><button class="run-title ellipsis" data-action="project-tasks" data-id="${esc(p.id)}">${esc(p.name)}</button>${meter(o.todayUsage.total ? (p.usage ?? 0) / o.todayUsage.total * 100 : 0)}<span class="num">${compact(p.usage)}</span></div>`).join('') || empty('暂无用量'), btn('用量分析', 'usage-nav', '', 'small ghost'));
    return `<div class="page overview-page">${pageHead('运行总览', `<span class="live-indicator"></span>${day(Date.now())}`, btn('待验收 ' + (o.reviewCount == null ? '数据未完整取得' : o.reviewCount), 'review-queue', '', 'small') + btn(icon('tasks', 14) + '全部任务', 'nav', 'data-view="tasks"', 'small'))}${staleNotice(overviewPath())}<section class="summary-grid">${metric('正在运行', shown(o.runningCount), detail(o.queuedCount, ' 项排队'), 'running-queue', 'accent')}${metric('待验收', shown(o.reviewCount), o.complete ? '' : '数据未完整取得', 'review-queue')}${metric('今日完成', shown(o.completedToday), detail(o.failedToday, ' 项失败'), 'completed-queue')}${metric('今日 Token', (o.todayUsage.partial || o.todayUsage.missing ? '≥ ' : '') + compact(o.todayUsage.total), o.todayUsage.missing ? o.todayUsage.missing + ' 项未知' : '', 'usage-nav')}</section><div class="overview-grid"><div class="stack">${running}${waiting}${recent}${usage}</div><div class="stack">${attention}${machines}${gateway}</div></div></div>`;
}
function taskRow(r: Run) {
    const selected = selectedRuns.has(r.id), active = route.p.run === r.id;
    return `<tr class="${active ? 'selected' : ''}" data-key="row-${esc(r.id)}">
  <td class="check-cell"><label class="check-label"><input type="checkbox" data-select-run="${esc(r.id)}" ${selected ? 'checked' : ''} aria-label="选择任务 ${esc(r.title)}"></label></td>
  <td class="task-main"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)}">${esc(r.title)}</button><div class="run-sub">${workspaceSummary(r)}${r.command ? `<code class="list-command ellipsis" title="${esc(r.command)}">${esc(r.command)}</code>` : ''}</div></td>
  <td class="task-state">${status(stage(r))}</td><td class="task-node">${taskScope(r, true)}</td>
  <td class="task-diff">${r.diff ? diffStat(r) : '<span class="muted">—</span>'}</td>
  <td class="task-time align-right">${elapsed(r)}</td><td class="task-usage align-right">${usageText(r)}</td>
  <td class="task-start align-right">${smallTime(r.startedAt)}</td>
  <td class="task-open">${ib('chevron', 'open-run', '打开详情', `data-id="${esc(r.id)}"`, 'row-extra')}</td>
 </tr>`;
}
function tasksPage() {
    const path = runPath(), d = data<RunPage>(path), review = route.view === 'changes', sel = route.p.run, counts = d?.counts || {};
    const chosen = (d?.items || []).filter(r => selectedRuns.has(r.id)), eligible = chosen.filter(r => r.actions.review || r.actions.complete);
    const states: Array<[string,string,number?]> = [['', '全部', counts.all], ...taskStages.map(([key,label]):[string,string,number?]=>[key,label,counts[key] ?? 0])];
    const bulk = selectedRuns.size ? `<div class="bulkbar"><span>${selectedRuns.size} 项已选</span><span class="spacer"></span>${btn('验收' + (eligible.length ? ' ' + eligible.length : ''), 'bulk-accept', !eligible.length || !canWrite() ? 'disabled' : '', 'small')}${btn('驳回', 'bulk-reject', !eligible.length || !canWrite() ? 'disabled' : '', 'small')}${ib('copy', 'bulk-copy', '复制所选任务引用')}${ib('close', 'clear-selection', '取消选择')}</div>` : '';
    const stateControls = sel ? `<select class="select queue-state" data-param="status" aria-label="任务状态">${states.map(([v, t, n]) => opt(v, t + (n == null ? '' : ' · ' + n), route.p.status || '')).join('')}</select>` : tabs(states, route.p.status || '', 'status');
    const filters = `<div class="task-filters">${stateControls}<div class="toolbar list-search">${searchField(route.p.q, '搜索任务…')}${sel ? ib('filter', 'toggle-filters', '筛选任务', `aria-expanded="${route.p.filters === '1'}"`, route.p.filters === '1' ? 'active' : '') : ''}</div><div class="toolbar extended-filters ${sel && route.p.filters !== '1' ? 'hidden' : ''}">${scopes()}${rangeSelect(route.p.days ?? '0')}<select class="select" aria-label="任务排序" data-param="sort">${[['newest', '最新开始'], ['oldest', '最早开始'], ['tokens', '用量最高'], ['duration', '耗时最长']].map(([v, t]) => opt(v, t, route.p.sort || 'newest')).join('')}</select></div>${route.p.finishedDay ? `<div class="filter-chip">完成于 ${esc(route.p.finishedDay)} ${ib('close', 'clear-finished', '清除完成日期')}</div>` : ''}${route.p.attention ? `<div class="filter-chip">执行异常 ${ib('close', 'clear-attention', '清除异常筛选')}</div>` : ''}${route.p.date ? `<div class="filter-chip">${esc(route.p.date)} ${ib('close', 'clear-date', '清除日期筛选')}</div>` : ''}</div>`;
    let list = !d ? resourceState(path) : !d.items.length ? `<div class="panel">${empty('没有匹配任务', '', btn('清除筛选', 'reset-filters'))}</div>` : sortLayout === 'timeline' && !sel ? timelineView(d) : `<div class="panel task-list-panel"><div class="table-wrap"><table class="data-table run-table"><colgroup><col style="width:34px"><col><col style="width:105px"><col style="width:58px"><col style="width:105px"><col style="width:86px"><col style="width:90px"><col style="width:94px"><col style="width:32px"></colgroup><thead><tr><th><label class="check-label"><input type="checkbox" data-select-all="runs" aria-label="选择本页全部任务" ${d.items.every(r => selectedRuns.has(r.id)) ? 'checked' : ''}></label></th><th>任务 / 项目</th><th>状态</th><th>节点</th><th>改动</th><th class="align-right">耗时</th><th class="align-right">Token</th><th class="align-right">开始</th><th></th></tr></thead><tbody>${d.items.map(taskRow).join('')}</tbody></table></div>${pagination(d)}</div>`;
    const actions = sel ? ib('download', 'export-runs', '导出本页') : segmented([['list', icon('tasks', 14)], ['timeline', icon('activity', 14)]], sortLayout, 'layout') + btn(icon('download', 14) + '导出', 'export-runs', d?.items.length ? '' : 'disabled');
    return `<div class="split ${sel ? 'has-detail' : 'no-detail'} ${review ? 'review-mode' : ''} ${route.p.focus === '1' ? 'detail-focus' : ''}"><section class="list-pane" aria-label="任务列表"><div class="page">${pageHead(review ? '改动审查' : '任务', '', actions)}${filters}${bulk}${staleNotice(path)}${list}</div></section>${sel ? '<button class="inspector-mask" data-action="close-inspector" aria-label="关闭详情"></button>' + inspector() : ''}</div>`;
}
function timelineView(d: RunPage) {
    const now = Date.now(), start = now - 864e5, pct = (t: number) => clamp((t - start) / 864e5 * 100, 0, 100);
    const tracks = (fleet()?.nodes || []).map(n => {
        const rows = d.items.filter(r => r.nodeId === n.id && r.startedAt < now && (r.finishedAt ?? now) >= start && r.executionStatus !== 'queued').sort((a, b) => a.startedAt - b.startedAt);
        const ends: number[] = [], placed = rows.map(r => {
            const left = pct(r.startedAt), right = pct(r.finishedAt ?? now), width = Math.min(100 - left, Math.max(1, right - left));
            let lane = ends.findIndex(end => end <= left);
            if (lane === -1) {
                lane = ends.length;
                ends.push(0);
            }
            ends[lane] = left + width + .4;
            return { r, left, width, lane };
        });
        return `<div class="timeline-track"><div class="timeline-track-name">${nodeTag(n.id)}</div><div class="timeline-track-body" style="height:${Math.max(1, ends.length) * 28 + 12}px">${placed.map(({ r, left, width, lane }) => `<button class="timeline-run ${stage(r)}" style="left:${left}%;width:${width}%;top:${lane * 28 + 6}px" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)} · ${fullTime(r.startedAt)}">${esc(r.title)}</button>`).join('')}</div></div>`;
    }).join('');
    return `<div class="panel"><div class="panel-head"><h3>执行时间轴</h3><span class="meta">近 24 小时 · 本页 ${d.items.length} 项</span></div><div class="timeline-board">${tracks}</div><div class="chart-axis"><span>${tm(start)} 昨天</span><span>${tm(now)} 今天</span></div>${pagination(d)}</div>`;
}
function commandStatus(c: Command, r: Run) {
    if (c.status)
        return c.status;
    if (c.exit === 0)
        return 'done';
    if (c.exit != null)
        return 'failed';
    return ['running', 'stopping'].includes(r.executionStatus) ? 'running' : 'interrupted';
}
function inspector() {
    const id = route.p.run, path = 'runs/' + enc(id), d = data<RunDetail>(path), tab = route.p.tab || (route.view === 'changes' ? 'diff' : 'summary');
    if (!d)
        return `<aside class="inspector" id="inspector" aria-label="执行详情"><header class="session-card-head"><span class="spacer"></span>${ib('close', 'close-inspector', '关闭详情', 'id="inspector-close"')}</header><div class="inspector-body">${resourceState(path)}</div></aside>`;
    const r = d.run;
    const state = stage(r), running = d.commands.find(c => commandStatus(c, r) === 'running'), failed = [...d.commands].reverse().find(c => commandStatus(c, r) === 'failed'), live = running || failed;
    const head = `<header class="session-card-head"><span class="session-symbol">${icon('changes', 17)}<i class="session-dot ${state}"></i></span><div class="session-heading"><h2 title="${esc(r.title)}">${esc(r.title)}</h2><div class="session-meta">${nodeTag(r.nodeId, true)}<span class="project-name">${esc(r.projectName)}</span><span class="branch-meta">${icon('changes', 12)}<code title="${esc(r.branch)}">${esc(r.branch)}</code></span></div></div><div class="session-stats">${r.diff ? diffStat(r) : ''}<span class="card-elapsed">${elapsed(r)}</span></div>${ib('external', 'focus-detail', route.p.focus === '1' ? '恢复分栏' : '展开详情', '', 'desktop-only')}${ib('close', 'close-inspector', '关闭详情（Esc）', 'id="inspector-close"')}</header>`;
    const strip = live ? `<button class="session-live ${running ? '' : 'failed'}" data-action="live-command" data-id="${esc(live.id)}">${running ? '<span class="spinner"></span>' : icon('failed', 14)}<span class="agent-label">${esc(live.agent)}</span><code>${esc(live.command)}</code><span class="live-meta">${running ? '运行中' : '退出码 ' + live.exit}</span>${icon('chevron', 12)}</button>` : '';
    const tabsHTML = tabs([['summary', icon('file', 14) + '概要'], ['diff', icon('changes', 14) + '改动', d.files.length], ['commands', icon('terminal', 14) + '命令', d.commands.length], ['agents', icon('bot', 14) + '代理', d.agents.length], ['context', icon('workspaces', 14) + '上下文']], tab, 'detail-tab');
    let body = '';
    if (tab === 'summary') {
        body = `<section class="detail-section result-section"><div class="result-heading">${status(state)}<span class="spacer"></span><span class="small muted">${smallTime(r.startedAt)}</span></div><p class="execution-summary">${esc(d.summary)}</p>${r.reviewNote ? `<p class="review-note">验收记录：${esc(r.reviewNote)}</p>` : ''}</section>`;
        if (d.evidence.length)
            body += `<section class="detail-section"><h3>执行结果</h3><div class="evidence-list">${d.evidence.map(e => `<div class="evidence-row"><span class="${e.ok === true ? 'green' : e.ok === false ? 'red' : 'muted'}">${icon(e.ok === true ? 'accepted' : e.ok === false ? 'failed' : 'queued', 15)}</span><b>${esc(e.name)}</b><span>${esc(e.detail)}</span>${e.time ? smallTime(e.time) : ''}</div>`).join('')}</div></section>`;
        if (r.usage?.quality !== 'not_used')
            body += `<section class="detail-section"><div class="section-line"><h3>Token 用量</h3>${badge(QUALITY[r.usage?.quality] || '未知', r.usage?.quality === 'partial' ? 'warn' : '')}</div><dl class="usage-mini">${([['总量', r.usage?.total], ['输入', r.usage?.input], ['输出', r.usage?.output]] as Array<[string, number | null | undefined]>).map(([k, v]) => `<div><dt>${k}</dt><dd>${v == null ? '未知' : compact(v)}</dd></div>`).join('')}</dl><div class="usage-breakdown"><span>输入含缓存 <b>${compact(r.usage?.cached)}</b></span><span>输出含推理 <b>${compact(r.usage?.reasoning)}</b></span></div></section>`;
        if (d.timeline.length)
            body += `<section class="detail-section"><h3>活动记录</h3><div class="timeline">${d.timeline.map(e => `<div class="timeline-entry"><time title="${fullTime(e.time)}">${tm(e.time)}</time><span class="timeline-line"><i class="dot ${e.tone}"></i></span><span>${esc(e.text)}</span></div>`).join('')}</div></section>`;
    }
    else if (tab === 'diff')
        body = diffView(d);
    else if (tab === 'commands')
        body = d.commands.length ? `<div class="command-list">${d.commands.map(c => { const cs = commandStatus(c, r); return `<details class="command command-card" data-key="${esc(c.id)}" id="command-${esc(c.id)}"><summary><span class="command-chevron">${icon('chevron', 12)}</span><span class="${cs === 'done' ? 'green' : cs === 'failed' ? 'red' : cs === 'running' ? 'accent' : 'muted'}">${cs === 'running' ? '<span class="spinner"></span>' : icon(cs === 'done' ? 'accepted' : cs, 14)}</span><code title="${esc(c.command)}">${esc(c.command)}</code><span class="agent-label">${esc(c.agent)}</span><span class="command-result">${c.exit == null ? esc(stages[cs] || '等待回执') : 'exit ' + c.exit}</span></summary><pre>${esc(commandOutputText(c, r.id))}</pre><div class="command-footer"><span>${c.ms == null ? '' : duration(c.ms)}</span>${commandOutputs.get('runs/' + enc(id) + '/commands/' + enc(c.id))?.hasMore ? btn('继续读取输出', 'more-command-output', 'data-id="' + esc(c.id) + '"', 'small') : ''}${ib('copy', 'copy', '复制命令', `data-text="${esc(c.command)}"`)}</div></details>`; }).join('')}</div>` : empty('暂无命令');
    else if (tab === 'agents')
        body = d.agents.length ? `<div class="agent-list">${d.agents.map(a => `<article class="agent-card"><span class="agent-avatar">${icon('bot', 17)}</span><div class="agent-main"><div class="section-line"><h3>${esc(a.name)}</h3>${status(a.status)}</div><p>${esc(a.role)}</p><div class="small muted">${a.tokens == null ? '用量未上报' : compact(a.tokens) + ' Token'}</div></div></article>`).join('')}</div>` : empty('暂无代理');
    else
        body = `<section class="detail-section"><h3>工作区</h3><dl class="context-table">${[['项目', r.projectName], ['路径', r.root], ['节点', node(r.nodeId)?.name || r.nodeId], ['分支', r.branch], ['基线', r.baseSha], ['执行 ID', r.id], ['来源', r.origin], ['开始', fullTime(r.startedAt)], ['结束', r.finishedAt ? fullTime(r.finishedAt) : '—'], ['执行状态', r.executionStatus], ['验收状态', r.acceptanceStatus]].map(([k, v]) => `<div><dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('')}</dl></section><section class="detail-section"><h3>项目指令</h3><dl class="context-table">${(d.instructions || []).map(item => '<div><dt>' + esc(item.status === 'loaded' ? '已读取' : '可读取') + '</dt><dd>' + esc(item.path) + '</dd></div>').join('') || '<div class="muted">未发现项目指令</div>'}</dl><h3 class="section-gap">技能</h3><dl class="context-table">${(d.skills || []).map(item => '<div><dt>' + esc(item.state === 'read' ? '已使用' : '可使用') + '</dt><dd>' + esc(item.name) + '</dd></div>').join('') || '<div class="muted">未发现技能</div>'}</dl></section>`;
    const footer = `<span class="card-footer-state">${status(state)}<span class="revision" title="回执版本">r${r.revision}</span></span><span class="spacer"></span>${['running', 'queued'].includes(state) ? btn(icon('stopping', 13) + (state === 'queued' ? '取消排队' : '中断'), 'run-control', `data-id="${esc(id)}" data-value="interrupt" ${r.actions?.interrupt ? writeAttrs() : 'disabled title="没有可控制的受管代理"'}`, 'danger small') : state === 'interrupted' ? btn(icon('running', 13) + '恢复', 'run-control', `data-id="${esc(id)}" data-value="resume" ${r.actions?.resume ? writeAttrs() : 'disabled title="需要从原工作入口继续"'}`, 'primary small') : ''}${state === 'waiting' && r.actions.complete ? btn('结束并验收', 'single-accept', `data-id="${esc(id)}" ${writeAttrs()}`, 'primary small') : ''}${state === 'review' ? btn('驳回', 'single-reject', `data-id="${esc(id)}" ${writeAttrs()}`, 'small') + btn(icon('check', 13) + '验收', 'single-accept', `data-id="${esc(id)}" ${writeAttrs()}`, 'primary small') : ''}${d.files.length && r.actions?.patch !== false ? btn(icon('download', 13) + '补丁', 'patch', `data-id="${esc(id)}"`, 'small') : ''}${d.files.length && r.actions?.revert && !['running', 'queued', 'stopping'].includes(state) ? ib('undo', 'revert', '还原文件', `data-id="${esc(id)}" ${writeAttrs('revert')}`) : ''}`;
    return `<aside class="inspector" id="inspector" aria-label="执行详情" tabindex="-1"><button class="resize-handle" role="separator" aria-label="调整列表宽度" aria-orientation="vertical" aria-valuemin="270" aria-valuemax="520" aria-valuenow="${pref.listWidth}" title="拖动调整列表宽度"></button>${head}${strip}${tabsHTML}<div class="inspector-body" data-key="body-${esc(id)}-${tab}">${staleNotice(path)}${body}</div><footer class="inspector-footer">${footer}</footer></aside>`;
}

const highlightCache = new Map<string, string>(), diffOpen = new Map<string, Set<string>>();
const commandReader = new CommandOutputs(path => API.get<import('./command-output.js').CommandOutputPage>(path), schedulePaint);
const commandOutputs = commandReader.entries;
let fileSearch = '';
function visibleFiles(d: RunDetail) { const q = fileSearch.trim().toLowerCase(); return d.files.filter(f => !q || f.path.toLowerCase().includes(q)); }
function openFiles(d: RunDetail) {
    if (!diffOpen.has(d.run.id))
        diffOpen.set(d.run.id, new Set([route.p.file || d.files[0]?.id].filter((id): id is string => typeof id === 'string')));
    return diffOpen.get(d.run.id)!;
}
function cachedDiff(payload: FileDiff) { return payload.file.rows; }
function codeHighlight(text: string, path: string) {
    const language = /\.[cm]?tsx?$/.test(path) ? 'typescript' : /\.[cm]?jsx?$/.test(path) ? 'javascript' : /\.py$/.test(path) ? 'python' : null;
    if (!language || text.length > 8192)
        return esc(text) || ' ';
    const key = language + '\0' + text;
    if (highlightCache.has(key))
        return highlightCache.get(key);
    const value = Prism.highlight(text, Prism.languages[language], language) || ' ';
    if (highlightCache.size > 2400)
        highlightCache.clear();
    highlightCache.set(key, value);
    return value;
}
function pairDiffRows(rows: FileDiff['file']['rows']) {
    const pairs: Array<[FileDiff['file']['rows'][number] | null, FileDiff['file']['rows'][number] | null]> = [];
    let removed: FileDiff['file']['rows'] = [], added: FileDiff['file']['rows'] = [];
    const flush = () => { for (let i = 0; i < Math.max(removed.length, added.length); i++)
        pairs.push([removed[i] || null, added[i] || null]); removed = []; added = []; };
    for (const row of rows) {
        if (row.type === 'context') {
            flush();
            pairs.push([row, row]);
        }
        else if (row.type === 'removed')
            removed.push(row);
        else
            added.push(row);
    }
    flush();
    return pairs;
}
function diffFile(d: RunDetail, f: ChangeFile) {
    const path = 'runs/' + enc(d.run.id) + '/files/' + enc(f.id), payload = data<FileDiff>(path), key = d.run.id + ':' + f.id;
    if (f.generated && !loadedBigFiles.has(key))
        return `<div class="large-file"><span class="muted">生成文件 · ${fmt((f.add ?? 0) + (f.del ?? 0))} 行变化</span>${btn('加载文件', 'load-big', `data-run="${esc(d.run.id)}" data-id="${esc(f.id)}"`, 'small')}</div>`;
    if (!payload)
        return resourceState(path);
    if (payload.file.binary) return '<div class="large-file muted">二进制文件，无法显示文本差异</div>';
    const all = cachedDiff(payload), limit = diffLimits.get(key) || 400, rows = all.slice(0, limit);
    let table;
    if (diffMode === 'split' && innerWidth > 760) {
        const cell = (row: FileDiff['file']['rows'][number] | null, side: 'old' | 'new') => row ? `<td class="line-number ${row.type}">${side === 'old' ? row.old ?? '' : row.new ?? ''}</td><td class="code ${row.type}">${codeHighlight(row.text, f.path)}</td>` : '<td class="line-number blank"></td><td class="code blank"></td>';
        table = `<table class="diff-table side-by-side ${pref.wrap ? 'wrap' : ''}" aria-label="${esc(f.path)} 并排差异"><colgroup><col style="width:36px"><col><col style="width:36px"><col></colgroup><thead><tr><th colspan="2">修改前</th><th colspan="2">修改后</th></tr></thead><tbody>${pairDiffRows(rows).map(([old, next]) => `<tr>${cell(old, 'old')}${cell(next, 'new')}</tr>`).join('')}</tbody></table>`;
    }
    else
        table = `<table class="diff-table ${pref.wrap ? 'wrap' : ''}" aria-label="${esc(f.path)} 差异"><colgroup><col style="width:34px"><col style="width:34px"><col style="width:18px"><col></colgroup><tbody>${rows.map(x => `<tr class="${x.type}"><td class="line-number">${x.old ?? ''}</td><td class="line-number">${x.new ?? ''}</td><td class="sign">${x.type === 'added' ? '+' : x.type === 'removed' ? '−' : ''}</td><td class="code">${codeHighlight(x.text, f.path)}</td></tr>`).join('')}</tbody></table>`;
    return `${staleNotice(path)}${payload.complete ? '' : '<div class="panel-foot">差异尚未读取完毕 ' + btn('读取后续差异', 'more-file', 'data-path="' + esc(path) + '"', 'small') + '</div>'}<div class="diff-scroll">${table}</div>${all.length > rows.length ? `<div class="panel-foot"><span>${rows.length} / ${all.length} 行</span><span class="spacer"></span>${btn('继续显示', 'more-diff', `data-run="${esc(d.run.id)}" data-id="${esc(f.id)}"`, 'small')}</div>` : ''}`;
}
function diffView(d: RunDetail) {
    if (!d.files.length)
        return empty('暂无文件改动');
    const files = visibleFiles(d), opened = openFiles(d);
    const toolbar = `<div class="diff-toolbar">${searchField(fileSearch, '查找文件…', 'files')}<span class="spacer"></span><label class="switch"><input type="checkbox" data-diff-wrap ${pref.wrap ? 'checked' : ''} aria-label="代码自动换行">换行</label><span class="desktop-only">${segmented([['unified', '统一'], ['split', '并排']], diffMode, 'diff-mode')}</span>${ib('panel', 'files-toggle-all', '展开或收起文件', `aria-label="展开或收起文件"`)}</div>`;
    return `<div class="session-diff">${toolbar}${files.map(f => { const on = opened.has(f.id), parts = f.path.split('/'), name = parts.pop(), dir = parts.join('/'); return `<section class="file-section ${on ? 'expanded' : ''}" data-key="file-${esc(d.run.id)}-${esc(f.id)}"><header class="file-header"><button class="file-toggle" data-action="toggle-file" data-id="${esc(f.id)}" aria-expanded="${on}" title="${esc(f.path)}">${icon(on ? 'down' : 'chevron', 13)}<span class="file-status ${f.kind}">${f.kind}</span><span class="file-path">${dir ? `<span>${esc(dir)}/</span>` : ''}<b>${esc(name)}</b></span><span class="diff-summary"><span class="green">+${fmt(f.add)}</span><span class="red">−${fmt(f.del)}</span></span></button>${ib('copy', 'copy-path', '复制文件路径', `data-text="${esc(f.path)}"`, 'file-copy')}</header>${on ? diffFile(d, f) : ''}</section>`; }).join('') || empty('没有匹配文件')}</div>`;
}
function machinesPage() {
    const f = fleet();
    if (!f)
        return `<div class="page">${pageHead('机器')}${resourceState('fleet/status')}</div>`;
    const q = (route.p.q || '').toLowerCase(), nodes = f.nodes.filter(n => [n.name, n.id, n.role].join(' ').toLowerCase().includes(q)), candidates = f.nodes.filter(n => n.capabilities.egress && n.priority > 0).sort((a, b) => b.priority - a.priority);
    const discoveryNodes = f.nodes.filter(n => n.capabilities.discovery);
    const discoveryReady = discoveryNodes.filter(n => n.online && n.discovery?.ready).length;
    const discovery = panel('发现端', `<div class="panel-body"><div class="inline">${badge(`${discoveryReady} / ${discoveryNodes.length} 就绪`, discoveryReady ? 'good' : 'warn')}<span class="spacer"></span></div><div class="discovery-grid">${discoveryNodes.map(n => {
      const component=n.components.find(item=>item.id==='discovery');
      const ready=n.online && n.discovery?.ready;
      return `<div class="discovery-node" data-key="discovery-${esc(n.id)}"><div class="inline">${nodeTag(n.id,true)}<span class="spacer"></span>${badge(!n.online ? '离线' : ready ? '就绪' : component?.state==='backoff' ? '等待重启' : '正在连接', ready ? 'good' : 'warn')}</div><div class="small muted">版本 ${esc(n.version ?? '未上报')}${component?.pid ? ` · PID ${component.pid}` : ''}</div>${n.discovery?.lastError ? `<div class="small amber">${esc(n.discovery.lastError)}</div>` : ''}</div>`;
    }).join('') || empty('尚未启用发现端')}</div></div>`);
    const egress = panel('连接与出网链路', `<div class="panel-body route-grid"><div><p class="small muted" style="margin-bottom:12px">MCP 入口连接</p><div class="endpoint">${nodeTag(f.ingressNodeId, true)}<code>${esc(f.mcpUrl || f.ingressLabel || (f.ingressNodeId ? '托管 MCP 隧道' : '尚未配置 MCP 入口'))}</code>${ib('copy', 'copy', '复制 MCP 地址', `data-text="${esc(f.mcpUrl || '')}" ${f.mcpUrl ? '' : 'disabled'}`)}</div></div><div><p class="small muted" style="margin-bottom:12px">出网候选 · 按优先级排序</p><div class="route-candidates">${candidates.map(n => `<div class="route-candidate ${n.id === f.gatewayId ? 'current' : ''}"><div class="inline">${nodeTag(n.id, true)}<span class="small muted">P${n.priority}</span></div>${n.id === f.gatewayId ? badge('当前出网', 'good') : !n.online ? badge('离线', 'bad') : n.egress?.healthy === false ? badge('探测失败', 'warn') : badge('待命')}<small class="muted">${n.egress?.region ? esc(n.egress.region) + ' · ' : ''}${n.egress?.latency != null ? Math.round(n.egress.latency) + ' ms' : n.egress?.healthy ? '探测正常' : '未探测'}</small></div>`).join('')}</div></div></div>`, '', '');
    let inventory = machineLayout === 'table' ? `<div class="panel table-wrap"><table class="data-table matrix"><thead><tr><th style="width:25%">机器</th><th>状态</th><th>CPU</th><th>内存</th><th>GPU</th><th>延迟</th><th>版本</th><th></th></tr></thead><tbody>${nodes.map(n => `<tr data-key="node-table-${n.id}"><td><button class="run-title" data-action="node" data-id="${n.id}">${nodeTag(n.id)}</button></td><td>${status(n.online ? 'online' : 'offline')}</td><td class="num">${n.online && n.cpu != null ? Math.round(n.cpu) + '%' : '—'}</td><td class="num">${n.online ? Math.round(n.memoryUsed / n.memoryTotal * 100) + '%' : '—'}</td><td>${n.gpuSampled === false ? '未取得' : n.gpus.length || '无'}</td><td class="num">${n.online && n.latency != null ? Math.round(n.latency) + ' ms' : '—'}</td><td class="mono">${esc(n.version ?? '未上报')}</td><td>${ib('chevron', 'node', '查看节点', `data-id="${n.id}"`)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="node-grid">${nodes.map(nodeCard).join('')}</div>`;
    if (!nodes.length)
        inventory = `<div class="panel">${empty('没有匹配的机器', '', btn('清除搜索', 'reset-filters'))}</div>`;
    return `<div class="page">${pageHead('机器', `${f.nodes.filter(n => n.online).length} / ${f.nodes.length} 在线`, btn(icon('settings', 14) + '统一出口配置', 'egress-settings'))}${staleNotice('fleet/status')}${discovery}${egress}<div class="toolbar section-gap">${searchField(route.p.q, '搜索机器、能力或 ID…')}<span class="spacer"></span>${segmented([['cards', icon('overview', 14) + ' 卡片'], ['table', icon('tasks', 14) + ' 对比表']], machineLayout, 'machine-layout')}</div>${inventory}</div>`;
}
function nodeCard(n: Machine) {
    const tasks = overview()?.active || [];
    const stateOnNode = (r: Run) => r.nodeStates?.[n.id] ?? (r.nodeId === n.id ? r.executionStatus : null);
    const active = tasks.filter(r => ['running','queued','stopping'].includes(stateOnNode(r) || ''));
    const waiting = tasks.filter(r => stateOnNode(r) === 'waiting');
    const disk = [...(n.disks || [])].sort((a,b) => b.used/b.total-a.used/a.total)[0];
    const resources: Array<[string, number | null | undefined, number | null | undefined, string]> = [
      ['CPU', n.cpu, 100, '%'],
      ['内存', n.memoryUsed, n.memoryTotal, 'GiB'],
      [disk ? '磁盘 ' + disk.mount : '磁盘', disk?.used, disk?.total, 'GiB'],
    ];
    const resourceRows = resources.map(([label, value, total, unit]) => {
      const hasValue = n.online && value != null && total != null;
      const percent = hasValue ? value / total * 100 : 0;
      const capacity = unit === '%'
        ? '采样 ' + tm(CACHE.get('fleet/status')?.time)
        : hasValue ? fmt(value) + ' / ' + fmt(total) + ' ' + unit : n.online ? '尚未采集' : '节点离线';
      return `<div><span class="resource-name">${esc(label)}</span><span class="resource-value">${hasValue ? (unit === '%' ? fmt(value) : Math.round(percent)) + '%' : '—'}</span>${meter(percent, unit !== '%' && percent > 85 ? 'amber' : '')}<small class="muted" style="display:block;margin-top:6px">${capacity}</small></div>`;
    }).join('');
    const gpuRows = n.gpuSampled === false
      ? '<div class="small muted" style="padding:12px 0">GPU 数据未取得</div>'
      : n.gpus.length
      ? `<div class="gpu-labels"><span>GPU</span><span>负载</span><span>显存 / GiB</span><span>温度</span></div>${n.gpus.map(g => `<div class="gpu-line"><span class="ellipsis" title="${esc(g.name)}">${esc(g.name)}</span><span>${n.online ? Math.round(g.util) + '%' : '—'}</span><span>${n.online ? g.used.toFixed(1) + ' / ' + g.total.toFixed(1) : '—'}</span><span class="${g.temp != null && g.temp >= 78 ? 'amber' : ''}">${n.online && g.temp != null ? Math.round(g.temp) + '°' : '—'}</span></div>`).join('')}`
      : '<div class="small muted" style="padding:12px 0">无 GPU</div>';
    const running = active.slice(0, 1).map(r => `<div class="panel-foot"><span class="accent">${icon('running', 13)}</span><button class="run-title ellipsis small" data-action="open-run" data-id="${esc(r.id)}">${esc(r.title)}</button></div>`).join('');
    return `<article class="panel node-card" data-key="node-${esc(n.id)}"><header class="node-card-head"><span class="node-mark big ${n.online ? '' : 'offline'}">${esc(n.short)}</span><div style="min-width:0"><button class="run-title" data-action="node" data-id="${esc(n.id)}"><h3>${esc(n.name)}</h3></button><p>${esc(n.role)}</p></div><span class="spacer"></span>${status(n.online ? 'online' : 'offline')}${ib('more', 'node', '节点详情与设置', `data-id="${esc(n.id)}"`)}</header>${!n.online ? `<div class="notice warn" style="margin:12px">${icon('alert', 15)}最后在线 ${esc(fullTime(n.lastSeen))}</div>` : ''}<div class="node-resources">${resourceRows}</div><div class="gpu-list">${gpuRows}</div><div class="panel-foot"><span class="${active.length ? 'accent' : 'muted'}">${active.length} 项执行 / 排队${waiting.length ? ` · ${waiting.length} 项等待` : ''}</span><span class="spacer"></span><span>${n.online ? (n.latency != null ? Math.round(n.latency) : '—') + ' ms' : '最后心跳 ' + ago(n.lastSeen)}</span><span class="mono">v${esc(n.version ?? '未上报')}</span></div>${running}</article>`;
}
function sessionsPage() {
    const ps = projects().filter(p => !sessionSearch || [p.name, p.path, p.nodeId].join(' ').toLowerCase().includes(sessionSearch.toLowerCase()));
    const p = projects().find(p => p.id === route.p.project), key = p ? 'projects/' + enc(p.id) + '/sessions' : '', d = p ? data<Sessions>(key) : null;
    const left = `<aside class="project-list" aria-label="项目列表"><div class="project-list-head"><h3>项目 <span class="count">${projects().length}</span></h3>${searchField(sessionSearch, '查找项目…', 'session-project')}</div>${ps.map(x => `<button class="project-item ${p?.id === x.id ? 'active' : ''}" data-action="session-project" data-id="${esc(x.id)}" data-key="project-${esc(x.id)}"><span class="project-item-icon">${icon('workspaces', 16)}</span><span><b class="ellipsis">${esc(x.name)}</b><span class="project-item-sub">${nodeTag(x.nodeId, true)}<span>${x.sessionCount ?? 0} 个会话</span>${x.active ? `<span class="accent">${x.active} 项运行</span>` : ''}${x.review ? `<span>${x.review} 待验收</span>` : ''}</span></span>${icon('chevron', 12)}</button>`).join('') || empty('没有匹配项目')}</aside>`;
    if (!p)
        return `<div class="session-layout">${left}<section class="session-content">${route.p.project ? empty('项目不存在', '', btn('选择项目', 'session-back')) : resourceState('projects')}</section></div>`;
    const filter = route.p.state || 'active', items = d?.items.filter(t => filter === 'all' ? true : filter === 'protected' ? t.protected : t.archiveState === filter) || [], tab = route.p.tab || 'sessions';
    let body;
    if (!d)
        body = resourceState(key);
    else if (tab === 'sessions')
        body = conversationCards(d.conversations);
    else if (tab === 'batches')
        body = `<div class="panel">${d.batches.map(b => `<div class="recent-row"><span>${icon('archive', 16)}</span><div class="recent-name"><b>${b.mode === 'archive' ? '归档' : '恢复'}批次</b><span class="mono small muted">${esc(b.id)}</span></div>${badge(b.status === 'completed' ? '已完成' : b.status === 'partial' ? '部分失败' : '待确认', b.status === 'completed' ? 'good' : b.status === 'partial' ? 'warn' : '')}${smallTime(b.createdAt)}</div>`).join('') || empty('暂无归档批次')}</div>`;
    else if (tab === 'claims')
        body = '<div class="panel">'+d.executionClaims.map(c=>`<div class="claim-row"><b>${esc(c.title || c.kind)}</b><span>${c.state==='queued'?'排队':'执行中'}</span><code>${esc(c.operationId || c.id)}</code><div>${c.scopes.map(s=>`<div class="resource-path"><span>${s.access==='write'?'写入':'读取'}</span><code>${esc(s.kind==='named'?s.key:s.path)}</code></div>`).join('')}</div></div>`).join('')+'</div>';

    else
        body = `<div class="toolbar">${segmented([['active', '未归档'], ['archived', '已归档'], ['protected', '已保留'], ['all', '全部']], filter, 'session-filter')}<span class="spacer"></span>${btn(icon('archive', 14) + (filter === 'archived' ? '恢复' : '归档'), 'archive-preview', `data-value="${filter === 'archived' ? 'restore' : 'archive'}" ${writeAttrs('archive')}`)}</div>${selectedThreads.size ? `<div class="bulkbar">${selectedThreads.size} 个会话已选<span class="spacer"></span>${btn('取消选择', 'clear-threads', '', 'small')}</div>` : ''}<div class="session-card-grid">${items.map((t, i) => `<article class="session-card" data-key="session-${esc(t.id)}"><label class="check-label session-selection"><input type="checkbox" data-select-thread="${esc(t.id)}" ${selectedThreads.has(t.id) ? 'checked' : ''} aria-label="选择会话 ${esc(t.title)}"></label><details open data-key="session-details-${esc(t.id)}"><summary class="session-summary"><span class="session-symbol">${icon('changes', 16)}<i class="session-dot ${t.control === 'quaymesh' ? 'running' : t.control === 'desktop' ? 'review' : 'done'}"></i></span><span class="session-heading"><b title="${esc(t.title)}">${esc(t.title)}</b><span class="session-meta"><code>${esc(t.turnId)}</code><span>·</span><span>${t.runIds.length} 次执行</span>${t.protected ? badge('保留') : ''}</span></span><span class="summary-chevron">${icon('chevron', 13)}</span></summary><div class="session-runs">${t.runs.map(r => `<button class="session-run-link" data-action="open-run" data-id="${esc(r.id)}"><span class="${r.status === 'failed' ? 'red' : r.status === 'running' ? 'accent' : 'muted'}">${icon(r.status, 14)}</span><span class="ellipsis">${esc(r.title || r.id)}</span><span class="small muted">${esc(stages[r.status] || r.status)}</span>${icon('chevron', 12)}</button>`).join('')}</div></details><footer><span class="session-owner ${t.control === 'quaymesh' ? 'accent' : 'muted'}">${icon(t.control === 'idle' ? 'unlock' : 'lock', 12)}${t.control === 'quaymesh' ? 'QuayMesh' : t.control === 'desktop' ? 'Desktop' : '空闲'}</span>${!t.verified ? badge('归属待确认', 'warn') : t.external ? badge('外部续写', 'warn') : ''}<span class="spacer"></span>${t.control === 'quaymesh' ? btn('转向', 'session-control', `data-value="steer" data-id="${esc(t.id)}" ${writeAttrs()}`, 'small ghost') + btn('接管', 'session-control', `data-value="takeover" data-id="${esc(t.id)}" ${writeAttrs()}`, 'small') : t.control === 'desktop' ? btn('归还', 'session-control', `data-value="return" data-id="${esc(t.id)}" ${writeAttrs()}`, 'small') : ''}${ib('pin', 'protect', t.protected ? '取消保留' : '保留会话', `data-id="${esc(t.id)}" ${writeAttrs()}`, t.protected ? 'accent' : '')}${ib('more', 'session-info', '会话详情', `data-id="${esc(t.id)}"`)}</footer></article>`).join('') || empty('暂无会话')}</div>`;
    return `<div class="session-layout has-project">${left}<section class="session-content"><div class="page"><div class="mobile-only">${btn(icon('back', 14) + '项目', 'session-back', '', 'ghost')}</div>${pageHead(p.name, `${nodeTag(p.nodeId, true)} <code title="${esc(p.path)}">${esc(p.path)}</code>`)}${tabs([['sessions', '会话', d?.conversations.length], ['threads', '代理会话', d?.items.length], ['batches', '代理归档', d?.batches.length], ['claims', '资源占用', d?.executionClaims.length]], tab, 'session-tab')}${staleNotice(key)}<div class="section-gap">${body}</div></div></section></div>`;
}
function workspacesPage() {
    const d = data<ListResponse<Root>>('roots'), q = (route.p.q || '').toLowerCase(), roots = (d?.items || []).filter(r => (!route.p.node || r.nodeId === route.p.node) && (!q || [r.name, r.id, r.path, r.description, ...r.tags].join(' ').toLowerCase().includes(q))), orphans = projects().filter(p => !p.rootId && (!route.p.node || p.nodeId === route.p.node));
    const content = !d ? resourceState('roots') : `<div class="panel root-panel"><div class="root-labels"><span></span><span>根目录</span><span>路径</span><span>状态</span><span></span></div>${roots.map(r => { const ps = projects().filter(p => p.rootId === r.id), open = expandedRoots.has(r.id), online = node(r.nodeId)?.online; return `<section data-key="root-${esc(r.id)}"><div class="root-row">${ib(open ? 'down' : 'chevron', 'root-expand', (open ? '收起' : '展开') + '项目', `data-id="${esc(r.id)}" aria-expanded="${open}" ${ps.length ? '' : 'disabled'}`)}<div class="root-name"><h3>${esc(r.name)}</h3><p>${nodeTag(r.nodeId, true)}<span>${ps.length} 项目</span>${r.readOnly ? badge('只读') : ''}${r.tags.slice(0, 2).map(t => badge(t)).join('')}</p></div><div class="root-path"><code title="${esc(r.path)}">${esc(r.path)}</code><span class="mono muted">${esc(r.id)}</span></div><span class="root-status">${badge(!r.enabled ? '已停用' : online ? '可用' : '离线', !r.enabled ? '' : online ? 'good' : 'warn')}</span><div class="root-actions">${ib('copy', 'copy', '复制根目录引用', `data-text="${esc(r.reference)}"`)}${ib('settings', 'root-edit', '编辑根目录', `data-id="${esc(r.id)}" ${writeAttrs('settings')}`)}</div></div>${open ? `<div class="root-projects">${ps.map(p => `<div class="root-project">${icon('workspaces', 14)}<button class="run-title" data-action="project-tasks" data-id="${esc(p.id)}">${esc(p.name)}</button><span class="small muted ellipsis">${esc(p.path)}</span><span class="spacer"></span><span class="small muted">${p.total} 次执行</span>${p.active ? badge(p.active + ' 活跃') : ''}</div>`).join('')}</div>` : ''}</section>`; }).join('') || empty('没有匹配根目录', '', btn('清除筛选', 'reset-filters'))}</div>`;
    return `<div class="page">${pageHead('工作空间', `${roots.length} 个根目录 · ${projects().length} 个项目`, btn(icon('plus', 14) + '添加根目录', 'root-edit', writeAttrs('settings'), 'primary'))}<div class="toolbar">${searchField(route.p.q, '搜索目录、路径或标签…')}${scopes(false)}</div>${staleNotice('roots')}${content}${orphans.length ? `<section class="section-gap">${panel('未分配根目录', orphans.map(p => `<div class="recent-row"><span class="amber">${icon('workspaces', 16)}</span><div class="recent-name"><h3>${esc(p.name)}</h3><code class="small muted">${esc(p.path)}</code></div>${nodeTag(p.nodeId, true)}${btn('查看任务', 'project-tasks', `data-id="${esc(p.id)}"`, 'small')}</div>`).join(''), badge(orphans.length + ' 项', 'warn'))}</section>` : ''}</div>`;
}
function activityPage() {
    const path = activityPath(), d = data<ActivityPage>(path), kind = route.p.kind || 'events';
    const tabsHTML = tabs([['events', '系统事件'], ['calls', 'MCP 调用'], ['transfers', '文件传输'], ['audit', '配置审计']], kind, 'activity-kind');
    let body;
    if (!d)
        body = resourceState(path);
    else if (!d.items.length)
        body = `<div class="panel">${empty('没有匹配记录', '当前筛选范围为空；可清除筛选后查看其他活动。', btn('清除筛选', 'reset-filters'))}</div>`;
    else if (kind === 'events') {
        const groups: Array<{ item: EventRow; items: EventRow[] }> = [];
        d.items.forEach(e => { const last = groups.at(-1); if (groupEvents && last && last.item.message === e.message && last.item.nodeId === e.nodeId && last.item.level === e.level && Math.abs(last.item.time - e.time) < 300000)
            last.items.push(e);
        else
            groups.push({ item: e, items: [e] }); });
        const max = Math.max(1, ...d.bins.map(b => b.count));
        body = `<div class="panel"><div class="histogram" aria-label="近 24 小时事件分布">${d.bins.map(b => `<button class="${b.errors ? 'bad' : b.warnings ? 'warn' : ''}" style="height:${Math.max(3, b.count / max * 52)}px" data-action="event-hour" data-value="${Math.floor(b.start / 3600000)}" title="${fullTime(b.start)} · ${b.count} 条 · ${b.errors} 错误" aria-label="筛选 ${tm(b.start)} 的 ${b.count} 条事件"></button>`).join('')}</div><div class="chart-axis"><span>24 小时前</span><span>现在</span></div>${groups.map(({ item: e, items }) => `<div class="event-row" data-key="event-${esc(e.id)}"><time title="${fullTime(e.time)}">${tm(e.time)}</time><span class="${e.level === 'error' ? 'red' : e.level === 'warn' ? 'amber' : 'muted'}">${icon(e.level === 'error' ? 'failed' : e.level === 'warn' ? 'alert' : 'info', 15)}</span><span class="node-mark">${esc(node(e.nodeId)?.short || e.nodeId)}</span><details><summary>${esc(e.message)}</summary><p>${esc(node(e.nodeId)?.name || e.nodeId)} · ${esc(e.level)} · ${items.length} 条原始记录</p><pre>${esc(JSON.stringify(items, null, 2))}</pre></details>${items.length > 1 ? badge('×' + items.length) : '<span></span>'}</div>`).join('')}${pagination(d)}</div>`;
    }
    else if (kind === 'calls')
        body = `<div class="panel">${d.items.map(c => `<div class="event-row" data-key="call-${esc(c.id)}"><time title="${fullTime(c.time)}">${tm(c.time)}</time><span class="${c.ok === true ? 'green' : c.ok === false ? 'red' : 'muted'}">${icon(c.ok === true ? 'check' : c.ok === false ? 'failed' : 'queued', 14)}</span><span class="node-mark">${esc(node(c.nodeId)?.short || '?')}</span><details><summary><code>${esc(c.tool)}</code> <span class="small muted">${esc(c.summary)}</span></summary><p>路由 ${esc(c.nodeId)} / ${esc(c.rootId)} · request ${esc(c.id)}</p><pre>${esc(JSON.stringify(c, null, 2))}</pre></details><span class="mono small ${c.ok === false ? 'red' : 'muted'}">${c.ok === true ? (c.duration == null ? '未记录时长' : c.duration + ' ms') : c.ok === false ? esc(c.error) : c.state === 'running' ? '运行中' : '状态待核对'}</span></div>`).join('')}${pagination(d)}</div>`;
    else if (kind === 'transfers')
        body = `<div class="panel">${(d.items as unknown as TransferRow[]).map(t => `<article class="transfer" data-key="transfer-${esc(t.id)}"><div class="inline"><h3>${t.source.split(/[\\/]/).pop()}</h3><span class="spacer"></span>${status(t.status === 'completed' ? 'done' : t.status)}</div><div class="transfer-path" style="margin-top:11px"><span class="muted">来源</span><span class="break">${esc(t.source)}</span><span class="muted">目标</span><span class="break">${esc(t.destination)}</span></div>${meter(t.bytes / t.total * 100, t.status === 'failed' ? 'red' : '')}<div class="inline"><span class="small muted num">${bytes(t.bytes)} / ${bytes(t.total)} · ${(t.bytes / t.total * 100).toFixed(1)}%</span><span class="spacer"></span>${t.status === 'running' ? `<span class="small muted">${bytes(t.speed)}/s</span>${btn('取消传输', 'cancel-transfer', `data-id="${esc(t.id)}" ${writeAttrs()}`, 'small danger')}` : t.error ? `<span class="small red">${esc(t.error)}</span>` : ''}</div></article>`).join('')}${pagination(d)}</div>`;
    else
        body = `<div class="panel">${(d.items as unknown as AuditRow[]).map(a => `<div class="event-row" data-key="audit-${esc(a.id)}"><time title="${fullTime(a.time)}">${tm(a.time)}</time><span class="muted">${icon('shield', 15)}</span><span class="node-mark">AUD</span><details><summary><code>${esc(a.action)}</code> · ${esc(a.target)}</summary><p>${esc(a.actor)} · request ${esc(a.requestKey)}</p><pre>${esc(JSON.stringify({ before: a.before, after: a.after }, null, 2))}</pre></details><span></span></div>`).join('')}${pagination(d)}</div>`;
    return `<div class="page">${pageHead('活动', '', btn(icon(activityPaused ? 'running' : 'interrupted', 14) + (activityPaused ? '恢复刷新' : '暂停刷新'), 'activity-pause') + btn(icon('download', 14) + '导出本页', 'export-activity', d?.items.length ? '' : 'disabled'))}${tabsHTML}<div class="toolbar">${searchField(route.p.q, '搜索消息、工具、目标或 ID…')}${kind === 'events' || kind === 'calls' ? scopes(false) : ''}${kind === 'events' ? `<select class="select" data-param="level" aria-label="事件级别">${[['', '全部级别'], ['error', '错误'], ['warn', '警告'], ['info', '信息']].map(([v, t]) => opt(v, t, route.p.level)).join('')}</select><label class="switch"><input type="checkbox" data-merge-events ${groupEvents ? 'checked' : ''}>合并连续重复</label>` : ''}<span class="spacer"></span><span class="small ${activityPaused ? 'amber' : 'muted'}">${activityPaused ? '当前列表已暂停' : '自动更新'}${d ? ' · ' + d.total + ' 条' : ''}</span></div>${route.p.hour ? `<div class="inline visually-spaced">${badge('小时过滤：' + tm(Number(route.p.hour) * 3600000), 'warn')}${btn('清除小时过滤', 'clear-hour', '', 'small')}</div>` : ''}${staleNotice(path)}${body}</div>`;
}
function usagePage() {
    const path = usagePath(), u = data<UsageReport>(path);
    if (!u)
        return `<div class="page">${pageHead('用量分析')}${resourceState(path)}</div>`;
    const mx = Math.max(1, ...u.daily.map(x => x.total ?? 0)), ratio = cacheRatio(u);
    const metric = (label: string, value: string, hint: string) => `<div class="metric"><span class="metric-label">${label}</span><div class="metric-main"><b>${value}</b><small>${hint}</small></div></div>`;
    const chart = panel('每日用量', `<div class="chart-topline"><span>${compact(mx)}</span><span>Token</span></div><div class="usage-chart" aria-label="每日 Token">${u.daily.map(d => `<div class="usage-column"><button class="usage-bar" style="height:${Math.max(1, (d.total ?? 0) / mx * 140)}px" data-action="usage-date" data-value="${esc(d.day)}" title="${d.day}\n总量 ${fmt(d.total)}\n非缓存输入 ${fmt(noncachedInput(d))}\n缓存输入 ${fmt(d.cached)}\n输出 ${fmt(d.output)}" aria-label="${d.day} 用量 ${fmt(d.total)}，查看任务"><i class="part output" style="height:${usageParts(d).output}%"></i><i class="part input" style="height:${usageParts(d).input}%"></i><i class="part cache" style="height:${usageParts(d).cache}%"></i></button><span class="day">${d.day.slice(5)}</span></div>`).join('')}</div>`, `<div class="legend"><span><i></i>非缓存输入</span><span><i class="cache"></i>缓存</span><span><i class="output"></i>输出</span></div>`);
    const quality = panel('统计明细', `<div class="usage-summary"><div class="section-line"><span class="muted">输入缓存占比</span><b class="ratio">${ratio === null ? '未知' : ratio.toFixed(1) + '%'}</b></div>${meter(ratio)}<div class="usage-breakdown"><span>${compact(u.cached)} / ${compact(u.input)}</span></div><dl class="quality-list"><div><dt>完整记录</dt><dd>${u.records - u.missing - u.partial - u.notUsed}</dd></div><div><dt>部分记录</dt><dd class="${u.partial ? 'amber' : ''}">${u.partial}</dd></div><div><dt>用量未知</dt><dd class="${u.missing ? 'amber' : ''}">${u.missing}</dd></div><div><dt>未调用模型</dt><dd>${u.notUsed}</dd></div></dl></div>`);
    const byProject = panel('项目用量', `<div class="usage-ranking table-wrap"><table class="data-table"><colgroup><col><col style="width:116px"><col style="width:116px"><col style="width:66px"></colgroup><thead><tr><th>项目</th><th class="align-right">Token</th><th>占比</th><th class="align-right">执行</th></tr></thead><tbody>${u.projects.map(p => `<tr><td><button class="run-title" data-action="project-tasks" data-id="${esc(p.id)}">${esc(p.name)}</button><div class="run-sub">${nodeTag(p.nodeId, true)}${p.missing || p.partial ? badge('部分记录') : ''}</div></td><td class="align-right num">${p.partial || p.missing ? '≥ ' : ''}${compact(p.total)}</td><td><div class="share-cell">${meter(u.total ? (p.total ?? 0) / u.total * 100 : 0)}<span class="muted num">${(u.total ? (p.total ?? 0) / u.total * 100 : 0).toFixed(1)}%</span></div></td><td class="align-right num">${p.records}</td></tr>`).join('')}</tbody></table></div>`);
    const top = panel('高用量任务', `<div class="panel-body">${u.top.map((r, i) => `<div class="rank-row"><span class="rank-number">${String(i + 1).padStart(2, '0')}</span><div style="min-width:0"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)}">${esc(r.title)}</button><p class="small muted">${esc(r.projectName)}</p></div>${usageText(r)}</div>`).join('') || empty('暂无用量')}</div>`);
    return `<div class="page">${pageHead('用量分析', '', btn(icon('download', 14) + '导出统计', 'export-usage'))}<div class="toolbar">${scopes()}${rangeSelect(route.p.days || '14', false)}<span class="spacer"></span><span class="small muted">${u.records} 次执行</span></div>${staleNotice(path)}<section class="summary-grid">${metric('已记录 Token', (u.partial || u.missing ? '≥ ' : '') + compact(u.total), '')}${metric('输入', compact(u.input), '缓存 ' + compact(u.cached))}${metric('输出', compact(u.output), '推理 ' + compact(u.reasoning))}${metric('执行记录', fmt(u.records), u.notUsed + ' 次未调用模型')}</section><div class="usage-grid">${chart}${quality}</div><div class="usage-grid">${byProject}${top}</div></div>`;
}
const SETTINGS = [['appearance', '外观'], ['data', '刷新与通知'], ['connection', '数据连接'], ['egress', '统一出口'], ['security', '登录与权限'], ['shortcuts', '快捷键']];
const settingRow = (title: string, desc: string, control: string) => `<div class="setting-row"><div><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}</div><div class="control">${control}</div></div>`;
function settingsPage() {
    const sec = route.p.section || 'appearance';
    let body = '';
    if (sec === 'appearance')
        body = `<div class="section-heading"><h2>外观</h2></div><div class="panel">${settingRow('主题', '', segmented([['system', '系统'], ['light', '浅色'], ['dark', '深色']], pref.theme, 'preference', 'data-key="theme"'))}${settingRow('行密度', '', segmented([['compact', '紧凑'], ['comfortable', '舒适']], pref.density, 'preference', 'data-key="density"'))}${settingRow('侧栏', '', segmented([['expanded', '展开'], ['collapsed', '折叠']], pref.sidebar, 'preference', 'data-key="sidebar"'))}${settingRow('时区', '', `<select class="select" data-pref-select="timeZone" aria-label="时区">${[['local', '跟随设备'], ['Asia/Shanghai', '北京时间'], ['America/New_York', '纽约时间'], ['UTC', '协调世界时 UTC']].map(([v, t]) => opt(v, t, pref.timeZone)).join('')}</select>`)}${settingRow('代码换行', '', `<label class="switch"><input type="checkbox" data-pref-check="wrap" ${pref.wrap ? 'checked' : ''}>自动换行</label>`)}</div>`;
    else if (sec === 'data')
        body = `<div class="section-heading"><h2>刷新与通知</h2></div><div class="panel">${settingRow('刷新频率', '', segmented([['0', '手动'], ['8', '8 秒'], ['15', '15 秒'], ['30', '30 秒'], ['60', '1 分钟']], pref.poll, 'preference', 'data-key="poll"'))}${settingRow('任务失败通知', '', `<label class="switch"><input type="checkbox" data-notifications ${pref.notifications ? 'checked' : ''}>浏览器通知</label>`)}${settingRow('缓存资源', '', `<span class="mono muted">${CACHE.size} 项</span>`)}${settingRow('本机偏好', '', btn('恢复默认', 'reset-preferences', '', 'danger'))}</div>`;
    else if (sec === 'connection')
        body = `<div class="section-heading"><h2>数据连接</h2></div><div class="panel">${settingRow('当前接口', 'quaymesh.console.v4', `<code>${esc(API.base())}</code>`)}${settingRow('任务来源', '各节点已保存的 QuayMesh 工作记录', badge('实时数据', 'good'))}${settingRow('刷新状态', '', btn('重新读取', 'refresh'))}</div>`;
    else if (sec === 'egress')
        body = `<div class="section-heading"><h2>统一出口</h2></div><form id="egress-form" data-preserve="egress-settings" class="panel"><div class="panel-body field-grid"><label class="field">来源节点<select class="select" name="sourceNodeId">${(fleet()?.nodes || []).map(n => opt(n.id, n.name, fleet()?.gatewayId)).join('')}</select></label><label class="field">上传配置<input type="file" name="config" accept=".yaml,.yml,text/yaml"><small>上传后使用文件配置 · 最大 256 KiB</small></label><div class="field full"><span>目标节点</span><div class="target-grid">${(fleet()?.nodes || []).map(n => `<label class="switch"><input type="checkbox" name="targets" value="${esc(n.id)}" ${n.online && n.egress.enabled ? 'checked' : ''} ${!n.online ? 'disabled' : ''}>${esc(n.name)} ${n.online ? '' : '（离线）'}</label>`).join('')}</div></div><label class="switch"><input type="checkbox" name="reload" checked>校验后热加载</label><div class="error-text full" data-form-error></div></div><div class="dialog-footer">${btn('同步配置', 'egress-sync', writeAttrs('settings'), 'primary')}</div></form><div class="section-gap panel">${(fleet()?.nodes || []).map(n => settingRow(esc(n.name), `优先级 ${n.priority} · 端口 ${n.egress.port}`, btn('节点设置', 'node', `data-id="${esc(n.id)}" data-tab="settings"`, 'small'))).join('')}</div>`;
    else if (sec === 'security')
        body = `<div class="section-heading"><h2>登录与权限</h2></div><div class="panel">${settingRow('当前账号', `${esc(API.session?.user?.name || '未登录')}`, badge(canWrite() ? '管理员' : '只读', canWrite() ? 'good' : 'warn'))}${settingRow('操作确认', '', badge('已启用'))}${settingRow('当前设备', API.session?.expiresAt ? '保持登录至 '+fullTime(API.session.expiresAt) : '保持登录', btn('退出登录', 'logout', writeAttrs(), 'danger'))}${settingRow('全部设备', '', btn('撤销登录', 'revoke-all', writeAttrs(), 'danger'))}</div>`;
    else
        body = `<div class="section-heading"><h2>快捷键</h2></div><div class="panel panel-body"><div class="key-grid">${KEYS.map(([k, t]) => `<div><span>${t}</span><kbd>${k}</kbd></div>`).join('')}</div></div>`;
    return `<div class="page settings-page">${pageHead('设置')}<div class="settings-layout"><nav class="settings-nav" aria-label="设置分区">${SETTINGS.map(([id, text]) => `<button class="${id === sec ? 'active' : ''}" data-action="settings-section" data-value="${id}" ${id === sec ? 'aria-current="page"' : ''}>${text}</button>`).join('')}</nav><div class="settings-content">${body}</div></div></div>`;
}
const KEYS = [['⌘ / Ctrl K', '搜索与命令面板'], ['/', '聚焦当前页搜索'], ['G → O / T / C', '总览 / 任务 / 改动'], ['G → S / M / W', '会话 / 机器 / 工作空间'], ['G → A / U / ,', '活动 / 用量 / 设置'], ['J / K', '下一项 / 上一项任务'], ['Esc', '关闭详情或对话框'], ['[', '折叠 / 展开侧栏'], ['R', '刷新当前视图'], ['T', '切换深浅主题'], ['← / →', '聚焦分隔线时调整宽度'], ['?', '显示快捷键']];
const CONTRACT = `quaymesh.console.v4 · base /console/api/v4/
GET  session → {contract, user, csrf, capabilities}
POST login {password} → session
GET  fleet/status → {nodes[], gatewayId, ingressNodeId, observedAt}
GET  overview → {active[], recent[], attention[], reviewCount, ...}
GET  projects / roots → {items[]}
GET  runs?node=&project=&q=&status=&days=&sort=&cursor=&limit=
     → {items[], total, counts, nextCursor, offset, limit}
GET  runs/:id → {run, summary, evidence[], files[], commands[], ...}
GET  runs/:id/files/:file → {file:{rows,totalRows,revision,...}, complete,nextCursor}
GET  runs/:id/patch → {patch, complete:true}
POST runs/review {refs:[{id,expectedRevision}],verdict,note,requestKey}
POST runs/:id/control {action,expectedRevision,requestKey}
POST runs/revert/preview {id,files[],expectedRevision,requestKey}
POST runs/revert/commit {previewId,confirmationHash,requestKey}
GET  projects/:id/sessions → {items[],batches[],claims[]}
POST sessions/:id/control {action,expectedRevision,expectedTurnId,prompt?,requestKey}
POST sessions/:id/protect {protected,expectedRevision,requestKey}
POST archive/preview {projectId,ids[],mode,requestKey}
POST archive/commit {previewId,confirmationHash,externalIdleConfirmed,requestKey}
POST nodes/:id/settings {settings,expectedRevision,requestKey}
POST roots/save {root,expectedRevision,requestKey}
GET  activity?kind=&q=&node=&level=&hour=&cursor= → paged items
GET  usage?days=&node=&project= → totals, daily[], projects[], top[]
POST transfers/cancel {id,expectedRevision,requestKey}
POST egress/sync {sourceNodeId|text,nodeIds[],reload,requestKey}
POST logout / sessions/revoke-all {requestKey}

Writes: Cookie + X-QuayMesh-CSRF + requestKey.
Errors: {message,code}, HTTP 401 / 403 / 409 / 422 / 5xx.
Control/revert results must distinguish accepted vs completed.
Read failures preserve the last confirmed data and report affected nodes.`;
function loginPage() { return `<div class="page"><form id="login-form" class="login-panel" data-preserve="login">${brand(48)}<h1>连接 QuayMesh</h1><p>请输入管理口令</p><label class="field">管理口令<input class="input" type="password" name="password" autocomplete="current-password" required maxlength="2048"></label><div class="error-text" data-form-error></div><button type="submit" class="btn primary">验证并进入</button></form></div>`; }
function toast(message: string, tone = 'info') { if (tone !== 'bad') { for (const current of $$('#toasts .toast')) { if ((current as HTMLElement).dataset.message === message) current.remove(); } } const el = document.createElement('div'); el.className = 'toast'; el.dataset.message = message; el.setAttribute('role', tone === 'bad' ? 'alert' : 'status'); el.innerHTML = `<span class="${tone === 'bad' ? 'red' : tone === 'warn' ? 'amber' : tone === 'good' ? 'green' : 'accent'}">${icon(tone === 'bad' ? 'alert' : tone === 'good' ? 'check' : 'info', 17)}</span><span>${esc(message)}</span>`; $('#toasts')!.append(el); while ($('#toasts')!.children.length > 4)
    $('#toasts')!.firstElementChild?.remove(); setTimeout(() => el.remove(), tone === 'bad' ? 9000 : 5000); }
function download(name: string, contents: string, type = 'text/plain;charset=utf-8') { const blob = new Blob([contents], { type }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); toast('已生成 ' + name, 'good'); }
async function copy(text: string) { try {
    if (!navigator.clipboard?.writeText)
        throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    toast('已复制', 'good');
}
catch {
    dialog({ title: '复制内容', body: `<p>当前浏览器不允许直接访问剪贴板，可在下方选择并复制。</p><textarea class="input mono" readonly rows="5">${esc(text)}</textarea>`, confirm: null });
    setTimeout(() => $<HTMLTextAreaElement>('dialog textarea')?.select(), 30);
} }


const confirmAction = (title: string, body: string, confirm = '确认', danger = true) => dialog({ title, body, confirm, danger });
function ensureWritable(cap = 'write') { if (!canWrite(cap))
    throw new ApiError('当前凭据或接口能力不允许执行此操作。', 403, 'forbidden'); }
async function invalidateAfterWrite() { for (const [path, e] of CACHE) {
    if (path !== 'projects') {
        e.time = 0;
    }
    else
        e.time = 0;
} await refresh(true); ensureRoute(); }
async function withLock(key: string, fn: () => unknown | Promise<unknown>) { if (writePending.has(key))
    return; writePending.add(key); try {
    return await fn();
}
finally {
    writePending.delete(key);
} }
function findLoadedRun(id: string) { return data<RunDetail>('runs/' + enc(id))?.run || data<RunPage>(runPath())?.items?.find(r => r.id === id) || overview()?.active.find(r => r.id === id) || overview()?.recent.find(r => r.id === id); }
async function reviewRuns(ids: string[], verdict: 'accept' | 'reject') {
    ensureWritable();
    const rs = ids.map(findLoadedRun).filter((r): r is Run => Boolean(r && (r.actions.review || r.actions.complete)));
    if (!rs.length)
        return toast('所选任务没有可验收的结果', 'warn');
    let requestKey = uid();
    const refs = rs.map(r => ({ id: r.id, expectedRevision: r.revision, completeExecution: r.actions.complete === true }));
    const result = await dialog({ title: verdict === 'accept' ? `结束并验收 ${rs.length} 项结果` : `结束并驳回 ${rs.length} 项结果`, danger: verdict === 'reject', confirm: verdict === 'accept' ? '确认验收' : '确认驳回', body: `<div class="panel" style="margin-bottom:16px">${rs.map(r => `<div class="panel-foot"><span class="ellipsis">${esc(r.title)}</span><span class="spacer"></span><span class="mono">rev ${r.revision}</span></div>`).join('')}</div><label class="field">${verdict === 'reject' ? '驳回原因（必填）' : '验收说明（可选）'}<textarea name="note" ${verdict === 'reject' ? 'required' : ''} placeholder="记录你核对过的证据与结论…" maxlength="4000"></textarea></label>`, onSubmit: form => API.post<ReviewReceipt>('runs/review', { refs, verdict, note: formObject(form).note?.trim() || '' }, requestKey) });
    if (!result)
        return;
    if (!Array.isArray(result.results))
        throw new ApiError('验收回执不完整。', 0, 'invalid_response');
    const ok = result.results.filter(r => r.ok), failed = result.results.filter(r => !r.ok);
    ok.forEach(r => selectedRuns.delete(r.id));
    await invalidateAfterWrite();
    toast(`${ok.length} 项已${verdict === 'accept' ? '验收' : '驳回'}${failed.length ? '，' + failed.length + ' 项失败：' + failed.map(r => r.error).join('；') : ''}`, failed.length ? 'warn' : 'good');
}
async function runControl(id: string, action: string) {
    ensureWritable();
    let r = findLoadedRun(id);
    if (!r)
        r = (await API.get<RunDetail>('runs/' + enc(id))).run;
    const queued = stage(r) === 'queued', label = action === 'resume' ? '恢复执行' : queued ? '取消排队' : '中断执行', key = uid();
    const result = await dialog({ title: label + '？', confirm: label, danger: action === 'interrupt', body: `<p><b>${esc(r.title)}</b></p><p>${action === 'resume' ? '继续从检查点执行，工作区可能产生修改。' : queued ? '从等待队列移除这个任务。' : '停止当前执行，保留工作区和执行记录。'}</p>`, onSubmit: () => API.post<{ status: string }>('runs/' + enc(id) + '/control', { action, expectedRevision: r.revision }, key) });
    if (!result)
        return;
    await invalidateAfterWrite();
    toast(result.status === 'completed' ? (queued ? '已取消排队' : action === 'resume' ? '已恢复执行' : '已中断执行') : '请求已接收，等待回执', result.status === 'completed' ? 'good' : 'info');
}
async function getPatch(id: string) {
  let cursor = null, revision = null;
  const chunks = [];
  do {
    const payload: PatchPage = await API.get<PatchPage>('runs/' + enc(id) + '/patch' + (cursor ? '?cursor=' + enc(cursor) : ''));
    if (typeof payload.patch !== 'string') throw new ApiError('补丁读取失败', 0, 'invalid_patch');
    if (revision !== null && revision !== payload.revision) throw new ApiError('下载期间文件发生变化，请重新下载', 409, 'revision_conflict');
    revision = payload.revision;
    chunks.push(payload.patch);
    if (payload.complete) break;
    if (!payload.nextCursor || payload.nextCursor === cursor) throw new ApiError('补丁分页缺少下一页', 0, 'invalid_cursor');
    cursor = payload.nextCursor;
  } while (cursor);
  download(id.replaceAll(':', '-') + '.patch', chunks.join(''), 'text/x-diff;charset=utf-8');
}
async function revertRun(id: string) { ensureWritable('revert'); const d = data<RunDetail>('runs/' + enc(id)) || await API.get<RunDetail>('runs/' + enc(id)), r = d.run; const pkey = uid(); const preview = await dialog({ title: '选择要还原的文件', wide: true, confirm: '检查还原计划', body: `<div class="panel">${d.files.map(f => `<label class="panel-foot" style="cursor:pointer"><input type="checkbox" name="files" value="${esc(f.id)}" ${f.revertible ? 'checked' : 'disabled'}><code class="break">${esc(f.path)}</code><span class="spacer"></span><span class="green">+${f.add}</span><span class="red">−${f.del}</span></label>`).join('')}</div>`, onSubmit: form => { const files = new FormData(form).getAll('files'); if (!files.length)
        throw new Error('至少选择一个文件'); return API.post<RevertPreview>('runs/revert/preview', { id, files, expectedRevision: r.revision }, pkey); } }); if (!preview)
    return; const key = uid(); const result = await dialog({ title: '确认还原计划', danger: true, confirm: '确认还原所选文件', body: `<p>将还原 <b>${preview.files.length}</b> 个文件。预览有效期至 ${esc(fullTime(preview.expiresAt))}。</p><pre class="code-block">执行：${esc(id)}\n文件：${preview.files.length}</pre>`, onSubmit: () => API.post<RevertReceipt>('runs/revert/commit', { previewId: preview.id, confirmationHash: preview.hash }, key) }); if (result) {
    await invalidateAfterWrite();
    toast(result.status === 'completed' ? '还原回执已确认，文件已恢复' : '还原请求已接收，等待结果', 'info');
} }
function currentSessions() { return data<Sessions>('projects/' + enc(route.p.project || '') + '/sessions'); }
async function sessionControl(id: string, action: string) { ensureWritable(); const t = currentSessions()?.items.find(t => t.id === id); if (!t)
    throw new Error('会话未加载'); const key = uid(); const result = await dialog({ title: action === 'steer' ? '向当前轮次补充指令' : action === 'takeover' ? '接管到 Codex Desktop？' : '归还会话控制权？', confirm: action === 'steer' ? '发送指令' : action === 'takeover' ? '确认接管' : '确认归还', danger: action === 'takeover', body: `<p>${esc(t.title)}</p><p>${action === 'steer' ? '指令将发送给当前执行中的代理。' : action === 'takeover' ? '当前任务将中断，随后交由 Codex Desktop 控制。' : '会话将返回空闲状态。'}</p>${action === 'steer' ? '<label class="field">补充指令<textarea name="prompt" required maxlength="12000" placeholder="例如：先修复失败测试，保留现有工作区改动。"></textarea></label>' : ''}`, onSubmit: form => API.post<{ status: string }>('sessions/' + enc(id) + '/control', { action, expectedRevision: t.revision, expectedTurnId: t.turnId, ...(action === 'steer' ? { prompt: formObject(form).prompt.trim() } : {}) }, key) }); if (result) {
    await invalidateAfterWrite();
    toast(result.status === 'completed' ? '已收到会话控制回执' : '请求已接收，等待控制权回执', result.status === 'completed' ? 'good' : 'info');
} }
async function archivePreview(mode: string) { ensureWritable('archive'); const projectId = route.p.project; if (!projectId)
    throw new Error('请先选择项目'); const preview = await API.post<ArchivePreview>('archive/preview', { projectId, mode, ids: [...selectedThreads] }); const ready = preview.entries.filter(e => e.ready), confirmationHash = preview.confirmationHash, key = uid(); if (ready.length && !confirmationHash) throw new ApiError('归档预览缺少确认凭据。', 0, 'invalid_response'); const result = await dialog({ title: mode === 'restore' ? '恢复会话预览' : '归档会话预览', wide: true, confirm: ready.length ? `确认${mode === 'restore' ? '恢复' : '归档'} ${ready.length} 项` : null, cancel: '关闭', body: `<p>可执行 ${ready.length} 项，跳过 ${preview.entries.length - ready.length} 项。预览有效期 ${esc(fullTime(preview.expiresAt))}。归档不删除任务、文件或用量历史。</p><div class="panel">${preview.entries.map(e => `<div class="panel-foot"><span style="flex:1;min-width:0">${esc(e.title)}</span>${e.ready ? badge('可执行', 'good') : badge(e.reason ?? '不可执行', 'warn')}</div>`).join('') || empty('没有符合条件的会话')}</div>${ready.length ? '<label class="switch" style="margin-top:16px"><input type="checkbox" name="externalIdle" required>已暂停此项目在其他客户端中的操作</label>' : ''}`, onSubmit: async form => {
    let result;
    for (let step = 0; step < ready.length; step++) {
      result = await API.post<{ batch: ArchivePreview }>('archive/commit', { previewId: preview.id, confirmationHash: confirmationHash!,
        externalIdleConfirmed: new FormData(form).has('externalIdle') }, key + ':' + step);
      if (result.batch.status !== 'executing') break;
    }
    return result;
  } }); if (result) {
    const batch = result.batch;
    if (!batch?.results)
        throw new ApiError('未收到归档回执。', 0, 'invalid_response');
    selectedThreads.clear();
    await invalidateAfterWrite();
    const ok = batch.results.filter(r => r.ok).length;
    const pending = batch.results.filter(r => r.pending).length;
    toast(`${ok} 项已${mode === 'restore' ? '恢复' : '归档'}，${batch.results.length - ok - pending} 项跳过 / 未完成${pending ? '，' + pending + ' 项等待处理' : ''}`, batch.results.every(r => r.ok) ? 'good' : 'warn');
}
else {
    await load('projects/' + enc(projectId) + '/sessions', true);
} }
function nodeDetailsBody(n: Machine, tab: string) {
    if (tab === 'settings')
        return `<div class="field-grid"><label class="field">节点昵称<input class="input" name="name" value="${esc(n.name)}" required maxlength="100"></label><label class="field">出网优先级<input class="input" type="number" name="priority" value="${n.priority}" min="0" max="1000" step="1" required></label><label class="field full">mihomo 配置路径<input class="input mono" name="config" value="${esc(n.egress.config)}"></label><label class="field">代理端口<input class="input" type="number" name="port" value="${n.egress.port}" min="1" max="65535" required></label><label class="field">回切等待（秒）<input class="input" type="number" name="recovery" value="${n.egress.recovery}" min="0" max="300" required></label><label class="field full">探测 URL<input class="input mono" name="probe" type="url" value="${esc(n.egress.probe)}" required></label><label class="switch"><input type="checkbox" name="enabled" ${n.egress.enabled ? 'checked' : ''}>参与出网候选</label><label class="switch"><input type="checkbox" name="inherit" ${n.egress.inherit ? 'checked' : ''}>新进程继承代理</label></div><p class="form-caption">代理设置对新进程生效。</p>`;
    return `<div class="inline visually-spaced"><span class="node-mark big">${esc(n.short)}</span><div><h2>${esc(n.name)}</h2><p class="small muted">${esc(n.role)} · ${esc(n.os)}</p></div><span class="spacer"></span>${status(n.online ? 'online' : 'offline')}</div><dl class="key-values"><div><dt>CPU</dt><dd>${n.online && n.cpu != null ? n.cpu + '%' : '未上报'}</dd></div><div><dt>内存</dt><dd>${n.online ? n.memoryUsed + ' / ' + n.memoryTotal + ' GiB' : '数据过期'}</dd></div><div><dt>连接延迟</dt><dd>${n.online && n.latency != null ? n.latency + ' ms' : '未上报'}</dd></div><div><dt>版本 / 配置版本</dt><dd>${esc(n.version ?? '未上报')} · rev ${n.revision}</dd></div><div><dt>优先级</dt><dd>${n.priority}</dd></div><div><dt>出口 IP</dt><dd>${esc(n.egress.ip || '未配置')}</dd></div><div><dt>出网探测</dt><dd>${!n.egress.enabled ? '未参与' : n.egress.healthy === true ? '正常' : n.egress.healthy === false ? '失败' : '未上报'}</dd></div><div><dt>最后采样</dt><dd>${esc(fullTime(n.lastSeen))}</dd></div></dl><h3 class="section-gap">磁盘</h3>${n.disks.map(d => `<div class="section-gap"><div class="inline small"><code>${esc(d.mount)}</code><span class="spacer"></span><span>${n.online ? fmt(d.total - d.used) + ' / ' + fmt(d.total) + ' GiB 可用' : '数据过期'}</span></div>${meter(n.online ? d.used / d.total * 100 : 0, d.used / d.total > .85 ? 'amber' : '')}</div>`).join('')}<h3 class="section-gap">GPU</h3>${n.gpus.length ? n.gpus.map(g => `<div class="section-gap"><div class="inline"><b class="small">${esc(g.name)}</b><span class="spacer"></span><span class="small">${n.online ? g.util + '% · ' + g.temp + '°C' : '数据过期'}</span></div><p class="form-caption">显存 ${n.online ? g.used + ' / ' + g.total + ' GiB' : '未更新'}</p>${meter(n.online ? g.used / g.total * 100 : 0)}</div>`).join('') : '<p class="form-caption">无 GPU，正常。</p>'}<h3 class="section-gap">统一出口</h3><pre class="code-block">配置：${esc(n.egress.config)}\n端口：${n.egress.port}\n探测：${esc(n.egress.probe)}\n回切等待：${n.egress.recovery}s</pre>`;
}
async function openNode(id: string, tab = 'overview') { let n = node(id); if (!n)
    throw new Error('节点数据未加载'); n = clone(n); if (tab === 'settings') {
    ensureWritable('settings');
    if (!n.online)
        throw new ApiError('节点离线，暂时无法修改。', 503, 'node_offline');
    let revision = n.revision, key = uid();
    const result = await dialog({ title: n.name + ' · 节点设置', drawer: true, confirm: '保存节点设置', body: nodeDetailsBody(n, 'settings'), refresh: async () => { const next = await API.get<Fleet>('fleet/status'), current = next.nodes.find(x => x.id === id); if (!current)
            throw new Error('节点不存在'); revision = current.revision; key = uid(); }, onSubmit: async (form) => { const fd = new FormData(form), settings = { name: String(fd.get('name')).trim(), priority: Number(fd.get('priority')), egress: { enabled: fd.has('enabled'), inherit: fd.has('inherit'), config: String(fd.get('config')).trim(), port: Number(fd.get('port')), probe: String(fd.get('probe')).trim(), recovery: Number(fd.get('recovery')) } }; if (id === fleet()?.gatewayId && (!settings.egress.enabled || settings.priority === 0)) {
            const ok = await confirmAction('将影响当前出网节点', '<p>当前节点正在承载出网。此修改可能触发切换，并造成短暂连接中断。</p>', '仍然保存');
            if (!ok)
                throw new Error('已取消出网变更，输入保留');
        } return API.post<{ saved?: boolean; ok?: boolean }>('nodes/' + enc(id) + '/settings', { settings, expectedRevision: revision }, key); } });
    if (result) {
        await invalidateAfterWrite();
        toast('节点配置已保存', 'good');
    }
}
else {
    await dialog({ title: '节点详情', drawer: true, body: nodeDetailsBody(n, 'overview') + `<div class="form-actions">${btn(icon('settings', 14) + '编辑节点设置', 'node-edit-from-drawer', `data-id="${esc(id)}" ${writeAttrs('settings')}`)}</div>`, confirm: null, cancel: '关闭' });
} }
async function editRoot(id: string | undefined) { ensureWritable('settings'); let roots = data<ListResponse<Root>>('roots'); if (!roots) { await load('roots', true); roots = data<ListResponse<Root>>('roots'); } const existing = roots?.items.find(r => r.id === id), n = node(existing?.nodeId || fleet()?.nodes?.[0]?.id || ''); let revision = existing?.revision || 0, key = uid(); const result = await dialog({ title: existing ? '编辑根目录' : '添加根目录', wide: true, confirm: '保存根目录', body: `<div class="field-grid"><label class="field">所在机器<select class="select" name="nodeId" ${existing ? 'disabled' : ''}>${(fleet()?.nodes || []).map(n => opt(n.id, n.name, existing?.nodeId || fleet()?.nodes?.[0]?.id || '')).join('')}</select></label><label class="field">稳定 ID<input class="input mono" name="id" value="${esc(existing?.localId || '')}" pattern="[-a-zA-Z0-9_.]{1,64}" required ${existing ? 'readonly' : ''} placeholder="s1-research"></label><label class="field full">目录昵称<input class="input" name="name" value="${esc(existing?.name || '')}" required maxlength="100"></label><label class="field full">该机器上的绝对路径<input class="input mono" name="path" value="${esc(existing?.path || '')}" required placeholder="/data/projects 或 E:\\Projects"></label><label class="field full">用途说明<textarea name="description" rows="2" maxlength="1000">${esc(existing?.description || '')}</textarea></label><label class="field full">标签（逗号分隔）<input class="input" name="tags" value="${esc(existing?.tags.join(', ') || '')}" maxlength="300"></label><label class="switch"><input type="checkbox" name="enabled" ${existing?.enabled !== false ? 'checked' : ''}>向 MCP 提供</label><label class="switch"><input type="checkbox" name="readOnly" disabled title="执行节点当前不支持根目录级只读设置" ${existing?.readOnly ? 'checked' : ''}>只读访问</label></div>`, refresh: existing ? async () => { const latest = await API.get<ListResponse<Root>>('roots'), r = latest.items.find(r => r.id === id); if (!r)
        throw new Error('目录已被移除'); revision = r.revision; key = uid(); } : null, onSubmit: form => { const f = formObject(form), fd = new FormData(form), nodeId = existing?.nodeId || f.nodeId, root = { id: existing?.id || f.id.trim(), nodeId, name: f.name.trim(), path: f.path.trim(), description: f.description.trim(), tags: [...new Set(f.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))], enabled: fd.has('enabled'), readOnly: fd.has('readOnly') }; const windows = node(nodeId)?.os === 'windows'; if (windows ? !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(root.path) : !root.path.startsWith('/'))
        throw new Error(windows ? '请填写 Windows 绝对路径，例如 E:\\Projects' : '请填写 Linux 绝对路径，例如 /data/projects'); return API.post<{ saved?: boolean; ok?: boolean }>('roots/save', { root, expectedRevision: revision }, key); } }); if (result) {
    await load('roots', true);
    await invalidateAfterWrite();
    toast('根目录已保存', 'good');
} }
async function syncEgress() {
    ensureWritable('settings');
    const form = $<HTMLFormElement>('#egress-form')!;
    const fd = new FormData(form);
    const selected = fd.get('config');
    const upload = selected instanceof File && selected.size > 0 ? selected : null;
    const sourceNodeId = String(fd.get('sourceNodeId') ?? '');
    const nodeIds = fd.getAll('targets').map(String);
    if (!nodeIds.length) throw new Error('请选择至少一个目标节点');
    if (upload && upload.size > 256 * 1024) throw new Error('配置文件上限为 256 KiB');
    const text = upload ? await upload.text() : null;
    const request = { ...(text ? { text } : { sourceNodeId }), nodeIds, reload: fd.has('reload') };
    const key = uid();
    const result = await dialog({
      title: '确认同步出口配置', wide: true, danger: true, confirm: '校验并同步',
      body: `<p>来源：${text ? '上传文件 ' + esc(upload!.name) : esc(node(sourceNodeId)?.name)}。目标 ${nodeIds.length} 台；${request.reload ? '校验通过后热加载' : '仅保存，不热加载'}。</p><div class="panel">${nodeIds.map(id => `<div class="panel-foot">${nodeTag(id)}<span class="spacer"></span><code class="break">${esc(node(id)?.egress?.config)}</code></div>`).join('')}</div>`,
      onSubmit: () => API.post<{ results: Array<{ nodeId: string; ok: boolean; reloaded: boolean; error?: string }> }>('egress/sync', request, key),
    });
    if (!result) return;
    if (!Array.isArray(result.results)) throw new ApiError('缺少逐节点同步回执', 0, 'invalid_response');
    await invalidateAfterWrite();
    dialog({ title: '配置同步回执', confirm: null, cancel: '关闭', body: `<div class="panel">${result.results.map(r => `<div class="panel-foot">${nodeTag(r.nodeId)}<span class="spacer"></span>${badge(r.ok ? (r.reloaded ? '已保存并加载' : '已保存') : '失败', r.ok ? 'good' : 'bad')}<span>${esc(r.error || '')}</span></div>`).join('')}</div>` });
}
function navigationDialog() { dialog({ title: '更多页面', confirm: null, cancel: '关闭', body: `<nav class="nav-sheet">${NAV.map(([v, t, i]) => `<button type="button" data-action="nav-dialog" data-view="${v}">${icon(i, 20)}<span>${t}</span></button>`).join('')}</nav>` }); }
function paletteItems(query: string) { const q = query.trim().toLowerCase(), items = []; NAV.forEach(([v, t, i]) => { if (!q || (t + ' ' + v).toLowerCase().includes(q))
    items.push({ type: '页面', title: t, description: '打开 ' + t, icon: i, action: () => navigate(v) }); }); [['切换深浅主题', 'theme'], ['刷新当前视图', 'refresh'], ['查看待验收任务', 'review-queue']].forEach(([title, action]) => { if (!q || title.includes(q))
    items.push({ type: '命令', title, description: '工作台操作', icon: 'terminal', action: () => (ACTIONS[action as 'theme' | 'refresh' | 'review-queue'] as () => unknown)() }); }); if (q) {
    const runs = new Map<string, Run>();
    for (const [path, entry] of CACHE) {
        if (path.startsWith('runs?'))
            (entry.data as RunPage | null)?.items.forEach(r => runs.set(r.id, r));
        else if (/^runs\/[^/]+$/.test(path) && (entry.data as RunDetail | null)?.run)
            runs.set((entry.data as RunDetail).run.id, (entry.data as RunDetail).run);
    }
    overview()?.active.forEach(r => runs.set(r.id, r));
    [...runs.values()].filter(r => [r.title, r.id, r.projectName].join(' ').toLowerCase().includes(q)).slice(0, 12).forEach(r => items.push({ type: '已加载任务', title: r.title, description: r.projectName, icon: 'tasks', action: () => navigate('tasks', { run: r.id }) }));
    projects().filter(p => [p.name, p.path].join(' ').toLowerCase().includes(q)).slice(0, 8).forEach(p => items.push({ type: '项目', title: p.name, description: node(p.nodeId)?.short, icon: 'workspaces', action: () => navigate('tasks', { project: p.id }) }));
    (fleet()?.nodes || []).filter(n => (n.name + ' ' + n.id).toLowerCase().includes(q)).forEach(n => items.push({ type: '机器', title: n.name, description: n.id, icon: 'machines', action: () => openNode(n.id) }));
    items.push({ type: '完整任务搜索', title: '搜索全部任务 “' + query + '”', description: '全部历史', icon: 'search', action: () => navigate('tasks', { q: query, days: '0' }) });
} return items.slice(0, 40); }
function openPalette() { if ($<HTMLDialogElement>('dialog.palette-dialog'))
    return; const previous = document.activeElement, d = document.createElement('dialog'); d.className = 'palette-dialog'; d.setAttribute('aria-label', '搜索与命令面板'); d.innerHTML = `<div class="palette-input">${icon('search', 18)}<input type="search" placeholder="搜索页面、命令、项目或执行 ID…" role="combobox" aria-autocomplete="list" aria-controls="palette-results" aria-expanded="true" autocomplete="off" aria-label="搜索命令"><kbd>Esc</kbd></div><div class="palette-results" id="palette-results" role="listbox" aria-label="搜索结果"></div><footer class="palette-foot"><span>↑ ↓ 选择</span><span>Enter 打开</span></footer>`; document.body.append(d); let idx = 0, items: ReturnType<typeof paletteItems> = []; const input = $<HTMLInputElement>('input', d)!; const draw = () => { items = paletteItems(input.value); idx = clamp(idx, 0, Math.max(0, items.length - 1)); let group = ''; $('#palette-results', d)!.innerHTML = items.map((item, i) => { const label = group !== item.type ? `<div class="palette-group" role="presentation">${esc(item.type)}</div>` : ''; group = item.type; return label + `<button type="button" class="palette-item" role="option" id="palette-option-${i}" data-palette="${i}" aria-selected="${i === idx}" tabindex="-1">${icon(item.icon, 16)}<span class="ellipsis">${esc(item.title)}</span><small>${esc(item.description || '')}</small></button>`; }).join('') || empty('没有结果'); input.setAttribute('aria-activedescendant', 'palette-option-' + idx); $('[aria-selected=true]', d)?.scrollIntoView({ block: 'nearest' }); }; const close = () => { d.close(); d.remove(); paletteState = null; if (previous instanceof HTMLElement && previous.isConnected)
    previous.focus({ preventScroll: true }); }; const choose = () => { const item = items[idx]; close(); Promise.resolve(item?.action()).catch(e => toast(e.message, 'bad')); }; input.addEventListener('input', () => { idx = 0; draw(); }); input.addEventListener('keydown', e => { if (e.isComposing)
    return; if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx++;
    draw();
} if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx--;
    draw();
} if (e.key === 'Enter') {
    e.preventDefault();
    choose();
} }); d.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-palette]'); if (b) {
    idx = Number(b.dataset.palette);
    choose();
} }); d.addEventListener('cancel', e => { e.preventDefault(); close(); }); d.showModal(); paletteState = { close }; draw(); input.focus(); }
function closeTopDialog() { const d = $$('dialog').at(-1); if (d) {
    $('[data-dialog-close]', d)?.click();
} }
const ACTIONS = {
  'more-command-output': (el: HTMLElement) => loadCommand('runs/' + enc(route.p.run) + '/commands/' + enc(el.dataset.id!), true),
    'more-file': (element: HTMLElement) => loadMoreFile(element.dataset.path!),
    'toggle-filters': () => param({ filters: route.p.filters === '1' ? null : '1' }),
    'focus-detail': () => navigate(route.view, { focus: route.p.focus === '1' ? null : '1' }, true, true),
    'card-command': (el: HTMLElement) => navigate('tasks', { run: el.dataset.id!, tab: 'commands' }),
    'queued-queue': () => navigate('tasks', { status: 'queued' }),
    'live-command': (el: HTMLElement) => { navigate(route.view, { tab: 'commands' }, true, true); requestAnimationFrame(() => { const command = $<HTMLDetailsElement>('#command-' + CSS.escape(el.dataset.id!)); if (command) {
        command.open = true;
        command.scrollIntoView({ block: 'nearest' });
    } }); },
    'toggle-file': (el: HTMLElement) => { const d = data<RunDetail>('runs/' + enc(route.p.run))!, opened = openFiles(d); opened.has(el.dataset.id!) ? opened.delete(el.dataset.id!) : opened.add(el.dataset.id!); ensureRoute(); schedulePaint(); },
    'files-toggle-all': () => { const d = data<RunDetail>('runs/' + enc(route.p.run))!, opened = openFiles(d), files = visibleFiles(d), expand = files.some(f => !opened.has(f.id)); files.forEach(f => expand ? opened.add(f.id) : opened.delete(f.id)); ensureRoute(); schedulePaint(); },
    'skip-content': () => $('#view')!.focus(), nav: (el: HTMLElement) => navigate(el.dataset.view!), 'nav-dialog': (el: HTMLElement) => { closeTopDialog(); navigate(el.dataset.view!); }, more: navigationDialog,
    'open-run': (el: HTMLElement) => { if (route.p.run !== el.dataset.id!)
        fileSearch = ''; navigate(route.view === 'changes' ? 'changes' : 'tasks', { run: el.dataset.id!, tab: route.view === 'changes' ? 'diff' : 'summary', file: null }, false, route.view === 'tasks' || route.view === 'changes'); },
    'close-inspector': () => { navigate(route.view, { run: null, tab: null, file: null, focus: null, browse: '1' }, false, true); setTimeout(() => { if (lastFocus?.isConnected)
        lastFocus.focus({ preventScroll: true });
    else
        $('.list-pane .run-title')?.focus({ preventScroll: true }); }, 30); },
    'detail-tab': (el: HTMLElement) => navigate(route.view, { tab: el.dataset.value! }, true, true), file: (el: HTMLElement) => navigate(route.view, { file: el.dataset.id! }, true, true),
    'load-big': (el: HTMLElement) => { loadedBigFiles.add(el.dataset.run! + ':' + el.dataset.id!); ensureRoute(); schedulePaint(); }, 'copy-path': (el: HTMLElement) => copy(el.dataset.text!), 'copy-link': () => copy(location.href), copy: (el: HTMLElement) => copy(el.dataset.text!),
    'more-diff': (el: HTMLElement) => { const key = el.dataset.run! + ':' + el.dataset.id!; diffLimits.set(key, (diffLimits.get(key) || 400) + 400); schedulePaint(); }, 'diff-mode': (el: HTMLElement) => { diffMode = el.dataset.value!; schedulePaint(); }, layout: (el: HTMLElement) => { sortLayout = el.dataset.value!; schedulePaint(); }, 'machine-layout': (el: HTMLElement) => { machineLayout = el.dataset.value!; schedulePaint(); },
    'running-queue': () => navigate('tasks', { status: 'running' }), 'review-queue': () => navigate('tasks', { status: 'review', days: '0' }), 'completed-queue': () => navigate('tasks', { days: '0', execution: 'completed', finishedDay: day(Date.now()) }), 'attention-queue': () => navigate('tasks', { days: '1', attention: '1' }), 'usage-nav': () => navigate('usage'),
    status: (el: HTMLElement) => param({ status: el.dataset.value! }), 'reset-filters': () => navigate(route.view, {}, true), 'clear-date': () => param({ date: null }), 'clear-finished': () => param({ finishedDay: null, execution: null }), 'clear-attention': () => param({ attention: null }), page: (el: HTMLElement) => { selectedRuns.clear(); param({ cursor: el.dataset.value! || null }); $('.list-pane')?.scrollTo({ top: 0 }); $('#view')!.scrollTo({ top: 0 }); },
    'clear-selection': () => { selectedRuns.clear(); schedulePaint(); }, 'clear-threads': () => { selectedThreads.clear(); schedulePaint(); },
    'single-accept': (el: HTMLElement) => reviewRuns([el.dataset.id!], 'accept'), 'single-reject': (el: HTMLElement) => reviewRuns([el.dataset.id!], 'reject'), 'bulk-accept': () => reviewRuns([...selectedRuns], 'accept'), 'bulk-reject': () => reviewRuns([...selectedRuns], 'reject'),
    'bulk-copy': () => copy([...selectedRuns].map(id => { const r = findLoadedRun(id); return r ? r.nodeId + '/exec/' + r.id : id; }).join('\n')),
    'run-control': (el: HTMLElement) => runControl(el.dataset.id!, el.dataset.value!), patch: (el: HTMLElement) => getPatch(el.dataset.id!), revert: (el: HTMLElement) => revertRun(el.dataset.id!),
    refresh: () => refresh(true), retry: (el: HTMLElement) => load(el.dataset.path!, true), theme: () => { savePref({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }); schedulePaint(); }, sidebar: () => { savePref({ sidebar: pref.sidebar === 'expanded' ? 'collapsed' : 'expanded' }); schedulePaint(); }, palette: openPalette,
    node: (el: HTMLElement) => openNode(el.dataset.id!, el.dataset.tab), 'node-edit-from-drawer': (el: HTMLElement) => { const id = el.dataset.id!; closeTopDialog(); return openNode(id, 'settings'); },
    'project-tasks': (el: HTMLElement) => navigate('tasks', { project: el.dataset.id! }), 'session-project': (el: HTMLElement) => { selectedThreads.clear(); storage.set('quaymesh.last-project', el.dataset.id!); navigate('sessions', { project: el.dataset.id! }); }, 'session-back': () => navigate('sessions', { picker: '1' }),
    'session-tab': (el: HTMLElement) => param({ tab: el.dataset.value! }), 'session-filter': (el: HTMLElement) => { selectedThreads.clear(); param({ state: el.dataset.value! }); }, 'session-control': (el: HTMLElement) => sessionControl(el.dataset.id!, el.dataset.value!), 'session-info': (el: HTMLElement) => { const t = currentSessions()?.items.find(t => t.id === el.dataset.id!); if (!t)
        throw new Error('会话未加载'); return dialog({ title: '会话身份与归档条件', confirm: null, cancel: '关闭', body: `<dl class="key-values"><div><dt>会话 ID</dt><dd class="mono">${esc(t.id)}</dd></div><div><dt>当前轮次</dt><dd class="mono">${esc(t.turnId)}</dd></div><div><dt>资源版本</dt><dd>rev ${t.revision}</dd></div><div><dt>当前控制权</dt><dd>${esc(t.control)}</dd></div><div><dt>归属已核实</dt><dd>${t.verified ? '是' : '否'}</dd></div><div><dt>归档保护</dt><dd>${esc(t.skipReason || '当前无阻止条件')}</dd></div></dl>` }); },
    protect: async (el: HTMLElement) => { ensureWritable(); const t = currentSessions()?.items.find(t => t.id === el.dataset.id!); if (!t)
        throw new Error('会话未加载'); await API.post<{ saved?: boolean; ok?: boolean }>('sessions/' + enc(t.id) + '/protect', { protected: !t.protected, expectedRevision: t.protectRevision }); await invalidateAfterWrite(); toast(t.protected ? '已取消保留' : '已保留会话', 'good'); }, 'archive-preview': (el: HTMLElement) => archivePreview(el.dataset.value!),
    'root-expand': (el: HTMLElement) => { expandedRoots.has(el.dataset.id!) ? expandedRoots.delete(el.dataset.id!) : expandedRoots.add(el.dataset.id!); schedulePaint(); }, 'root-edit': (el: HTMLElement) => editRoot(el.dataset.id!),
    'activity-kind': (el: HTMLElement) => { activityPaused = false; navigate('activity', { kind: el.dataset.value! }); }, 'activity-pause': () => { activityPaused = !activityPaused; ensureRoute(); schedulePaint(); }, 'event-hour': (el: HTMLElement) => param({ hour: el.dataset.value!, cursor: null }), 'clear-hour': () => param({ hour: null, cursor: null }),
    'usage-date': (el: HTMLElement) => navigate('tasks', { date: el.dataset.value!, days: '0', node: route.p.node, project: route.p.project }),
    'settings-section': (el: HTMLElement) => navigate('settings', { section: el.dataset.value! }), 'api-settings': () => navigate('settings', { section: 'connection' }), 'egress-settings': () => navigate('settings', { section: 'egress' }),
    preference: (el: HTMLElement) => { const k = el.dataset.key!, v = k === 'poll' ? Number(el.dataset.value!) : el.dataset.value!; savePref({ [k]: v }); if (k === 'poll')
        schedulePoll(); schedulePaint(); },
    'egress-sync': syncEgress,
    'reset-preferences': async () => { if (!await confirmAction('恢复本机默认偏好？', '<p>将恢复当前浏览器的外观与刷新设置。</p>', '恢复默认'))
        return; pref = { ...DEFAULTS }; savePref(pref); CACHE.clear(); await bootstrap(); },
    reconnect: () => bootstrap(),
    'desktop-browser': () => notifyDesktop('external'),
    'desktop-settings': () => notifyDesktop('settings'),
    'waiting-queue': () => navigate('tasks', { status:'waiting', days:'0' }),
    logout: async () => { if (!await confirmAction('退出当前浏览器？', '<p>不会退出托盘、停止隧道或取消任务。</p>', '退出登录'))
        return; await API.post<{ saved?: boolean; ok?: boolean }>('logout'); API.session = null; API.csrf = null; authRequired = true; API.abortAll(); clearTimeout(refreshTimer); schedulePaint(); },
    'revoke-all': async () => { ensureWritable(); const key = uid(); const result = await dialog({ title: '撤销所有 Console 会话？', danger: true, confirm: '撤销所有会话', body: '<p>所有浏览器和 Console 客户端需要重新登录，包括当前页面。已有执行进程与网关服务不受影响。</p><label class="field">输入 REVOKE 确认<input class="input mono" name="confirm" required pattern="REVOKE" autocomplete="off"></label>', onSubmit: () => API.post<{ saved?: boolean; ok?: boolean }>('sessions/revoke-all', {}, key) }); if (result) {
        API.session = null;
        API.csrf = null;
        authRequired = true;
        clearTimeout(refreshTimer);
        schedulePaint();
    } },
    'cancel-transfer': async (el: HTMLElement) => { ensureWritable(); const t = data<ActivityPage<TransferRow>>(activityPath())?.items.find(x => x.id === el.dataset.id!); if (!t)
        throw new Error('传输记录未加载'); const key = uid(); const result = await dialog({ title: '取消文件传输？', danger: true, confirm: '取消传输', body: `<p>${esc(t.source)} → ${esc(t.destination)}</p><p>已传输的文件将保留。</p>`, onSubmit: () => API.post<{ transfer?: { status: string } }>('transfers/cancel', { id: t.id, expectedRevision: t.revision }, key) }); if (result) {
        await invalidateAfterWrite();
        toast(result.transfer?.status === 'cancelled' ? '已收到取消回执' : '取消已请求，等待回执', 'info');
    } },
    'export-runs': () => { const d = data<RunPage>(runPath()); if (!d)
        return; const rows = [['id', 'title', 'node', 'project', 'executionStatus', 'acceptanceStatus', 'tokens', 'usageQuality', 'startedAt'], ...d.items.map(r => [r.id, r.title, r.nodeId, r.projectId, r.executionStatus, r.acceptanceStatus, r.usage?.total ?? '', r.usage?.quality, new Date(r.startedAt).toISOString()])]; download('quaymesh-runs-page.csv', '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8'); },
    'export-activity': () => { const d = data<ActivityPage>(activityPath()); if (d)
        download('quaymesh-activity-page.json', JSON.stringify(d, null, 2), 'application/json'); },
    'export-usage': () => { const u = data<UsageReport>(usagePath()); if (u)
        download('quaymesh-usage.csv', '\ufeff' + [['project', 'node', 'knownTokens', 'records', 'partial', 'unknown'], ...u.projects.map(p => [p.name, p.nodeId, p.total, p.records, p.partial, p.missing])].map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8'); },
    'export-contract': () => download('quaymesh-v4-api-contract.txt', CONTRACT), shortcuts: () => dialog({ title: '工作台快捷键', wide: true, confirm: null, cancel: '关闭', body: `<div class="key-grid">${KEYS.map(([k, t]) => `<div><span>${t}</span><kbd>${k}</kbd></div>`).join('')}</div>` })
};
document.addEventListener('click', e => { const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]'); if (!el || (el instanceof HTMLButtonElement && el.disabled))
    return; const action = ACTIONS[el.dataset.action! as keyof typeof ACTIONS]; if (!action)
    return; e.preventDefault(); Promise.resolve(withLock(el.dataset.action! + ':' + (el.dataset.id! || ''), () => action(el))).catch(err => { if (err.name !== 'AbortError')
    toast(err.message || '操作失败', 'bad'); }); });
let inputTimer: ReturnType<typeof setTimeout> | undefined;
function handleSearch(el: HTMLInputElement | HTMLTextAreaElement) {
    if (!el.dataset.search)
        return;
    clearTimeout(inputTimer);
    const value = el.value, view = route.view, kind = el.dataset.search;
    inputTimer = setTimeout(() => {
        if (route.view !== view || !el.isConnected)
            return;
        if (kind === 'session-project') {
            sessionSearch = value;
            schedulePaint();
        }
        else if (kind === 'files') {
            fileSearch = value;
            ensureRoute();
            schedulePaint();
        }
        else
            param({ q: value });
    }, kind === 'query' ? 200 : 100);
}
document.addEventListener('input', e => { if (!(e as InputEvent).isComposing)
    handleSearch((e.target as HTMLInputElement)); });
document.addEventListener('compositionend', e => handleSearch((e.target as HTMLInputElement)));
document.addEventListener('change', async (e) => {
    const el = (e.target as HTMLInputElement);
    try {
        if (el.dataset.param) {
            const key = el.dataset.param;
            param({ [key]: el.value, ...(key === 'node' ? { project: null } : {}) });
        }
        else if (el.dataset.selectRun) {
            el.checked ? selectedRuns.add(el.dataset.selectRun) : selectedRuns.delete(el.dataset.selectRun);
            schedulePaint();
        }
        else if (el.dataset.selectAll === 'runs') {
            const rows = data<RunPage>(runPath())?.items || [];
            rows.forEach(r => el.checked ? selectedRuns.add(r.id) : selectedRuns.delete(r.id));
            schedulePaint();
        }
        else if (el.dataset.selectThread) {
            el.checked ? selectedThreads.add(el.dataset.selectThread) : selectedThreads.delete(el.dataset.selectThread);
            schedulePaint();
        }
        else if (el.hasAttribute('data-file-select'))
            navigate(route.view, { file: el.value }, true, true);
        else if (el.hasAttribute('data-diff-wrap')) {
            savePref({ wrap: el.checked });
            schedulePaint();
        }
        else if (el.hasAttribute('data-merge-events')) {
            groupEvents = el.checked;
            schedulePaint();
        }
        else if (el.dataset.prefSelect) {
            savePref({ [el.dataset.prefSelect]: el.value });
            if (el.dataset.prefSelect === 'timeZone') {
                CACHE.clear();
                ensureRoute();
            }
            schedulePaint();
        }
        else if (el.dataset.prefCheck) {
            savePref({ [el.dataset.prefCheck]: el.checked });
            schedulePaint();
        }
        else if (el.hasAttribute('data-notifications')) {
            if (el.checked) {
                if (!('Notification' in window) || !isSecureContext)
                    throw new Error('通知需要 HTTPS 或 localhost，且浏览器支持 Notification');
                const permission = await Notification.requestPermission();
                if (permission !== 'granted')
                    throw new Error('浏览器没有授予通知权限');
            }
            savePref({ notifications: el.checked });
            schedulePaint();
        }
    }
    catch (err) {
        toast(consoleError(err).message, 'bad');
        if (el.hasAttribute('data-notifications'))
            el.checked = !!pref.notifications;
    }
});
document.addEventListener('submit', async (e) => {
    const form = e.target as HTMLFormElement;
    if (form.id !== 'login-form') return;
    e.preventDefault();
    const button = $<HTMLButtonElement>('[type=submit]', form);
    const error = $<HTMLElement>('[data-form-error]', form);
    if (!button || !error) throw new Error('登录表单结构不完整');
    button.disabled = true;
    error.textContent = '';
    try {
      const password = new FormData(form).get('password');
      const session = await API.request<ConsoleSession>('POST', 'login', { password });
      if (session.contract !== 'quaymesh.console.v4') throw new Error('会话响应缺少 v4 契约声明');
      API.session = session;
      API.csrf = session.csrf;
      authRequired = false;
      CACHE.clear();
      await bootstrap(false);
    } catch (failure) {
      error.textContent = consoleError(failure).message;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
});
let prefixAt = 0;
document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229)
        return;
    const input = (e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]'), topDialog = $$('dialog[open]').at(-1);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (topDialog && !topDialog.classList.contains('palette-dialog'))
            return;
        e.preventDefault();
        paletteState ? paletteState.close() : openPalette();
        return;
    }
    if (topDialog)
        return;
    if (e.key === 'Tab' && route.p.run && innerWidth <= 1000) {
        const focusables = $$('#inspector button:not(:disabled), #inspector input, #inspector select, #inspector a[href], #inspector [tabindex="0"]').filter(n => n.getClientRects().length), first = focusables[0], last = focusables.at(-1);
        if (e.shiftKey && (document.activeElement === first || !$('#inspector')?.contains(document.activeElement))) {
            e.preventDefault();
            last?.focus();
        }
        else if (!e.shiftKey && (document.activeElement === last || !$('#inspector')?.contains(document.activeElement))) {
            e.preventDefault();
            first?.focus();
        }
    }
    if (e.key === 'Escape' && route.p.run) {
        e.preventDefault();
        ACTIONS['close-inspector']();
        return;
    }
    if (input || e.metaKey || e.ctrlKey || e.altKey)
        return;
    if ((e.target as HTMLElement).classList.contains('resize-handle') && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        savePref({ listWidth: clamp(pref.listWidth + (e.key === 'ArrowLeft' ? -16 : 16), 270, 520) });
        (e.target as HTMLElement).setAttribute('aria-valuenow', String(pref.listWidth));
        return;
    }
    if (prefixAt && Date.now() - prefixAt < 1100) {
        prefixAt = 0;
        const target = { o: 'overview', t: 'tasks', c: 'changes', s: 'sessions', m: 'machines', w: 'workspaces', a: 'activity', u: 'usage', ',': 'settings' }[e.key];
        if (target) {
            e.preventDefault();
            navigate(target);
        }
        return;
    }
    if (e.key === 'g') {
        prefixAt = Date.now();
        return;
    }
    if (e.key === '/') {
        const el = $('[data-search]');
        if (el) {
            e.preventDefault();
            el.focus();
        }
        return;
    }
    if (e.key === '[') {
        ACTIONS.sidebar();
        return;
    }
    if (e.key === 't') {
        ACTIONS.theme();
        return;
    }
    if (e.key === 'r') {
        refresh(true);
        return;
    }
    if (e.key === '?') {
        ACTIONS.shortcuts();
        return;
    }
    if (['j', 'k'].includes(e.key) && ['tasks', 'changes'].includes(route.view)) {
        const rows = data<RunPage>(runPath())?.items || [], idx = rows.findIndex(r => r.id === route.p.run), r = rows[clamp(idx + (e.key === 'j' ? 1 : -1), 0, rows.length - 1)];
        if (r) {
            e.preventDefault();
            navigate(route.view, { run: r.id }, true, true);
        }
    }
});
document.addEventListener('pointerdown', e => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.resize-handle');
    if (!handle || innerWidth <= 1000)
        return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = e.clientX, initial = pref.listWidth;
    const move = (ev: PointerEvent) => { pref.listWidth = clamp(initial + ev.clientX - start, 270, 520); document.documentElement.style.setProperty('--list-width', pref.listWidth + 'px'); handle.setAttribute('aria-valuenow', String(Math.round(pref.listWidth))); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); savePref({ listWidth: pref.listWidth }); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
});
addEventListener('popstate', () => { route = parseRoute(); selectedRuns.clear(); selectedThreads.clear(); ensureRoute(); schedulePaint(); });
addEventListener('hashchange', () => { route = parseRoute(); ensureRoute(); schedulePaint(); });
addEventListener('resize', () => schedulePaint());
systemTheme.addEventListener('change', () => { if (pref.theme === 'system') {
    applyPrefs();
    schedulePaint();
} });
document.addEventListener('visibilitychange', () => {
    document.documentElement.dataset.visibility = document.hidden ? 'hidden' : 'visible';
    if (document.hidden) {
        clearTimeout(refreshTimer);
        clearTimeout(clockTimer);
        for (const path of activePaths)
            CACHE.get(path)?.ctl?.abort();
    }
    else {
        attachClock();
        ensureRoute();
        refresh();
        schedulePoll();
    }
});
addEventListener('pagehide', () => { clearTimeout(refreshTimer); clearTimeout(clockTimer); for (const path of activePaths)
    CACHE.get(path)?.ctl?.abort(); });
addEventListener('online', () => { backgroundPaused = false; refresh(); schedulePoll(); });
addEventListener('offline', () => { backgroundPaused = true; clearTimeout(refreshTimer); toast('浏览器离线，保留已读取的内容。', 'warn'); schedulePaint(); });
let previousStages = new Map<string, string>();
function observeStages(snapshot: Overview) { for (const r of [...snapshot.active, ...snapshot.recent]) {
    const prior = previousStages.get(r.id), next = stage(r);
    if (prior && next === 'failed' && prior !== 'failed' && pref.notifications) {
        toast('任务失败：' + r.title, 'bad');
        if (globalThis.Notification?.permission === 'granted')
            new Notification('QuayMesh · 执行失败', { body: r.title, tag: r.id });
    }
    previousStages.set(r.id, next);
} }
let clockTimer: ReturnType<typeof setTimeout> | undefined, clockNodes: HTMLElement[] = [];
function tickClock() {
    clearTimeout(clockTimer);
    if (document.hidden)
        return;
    const now = Date.now();
    clockNodes = clockNodes.filter((el: HTMLElement) => el.isConnected);
    for (const el of clockNodes) {
        const text = duration(now - Number(el.dataset.elapsed));
        if (el.textContent !== text)
            el.textContent = text;
    }
    if (clockNodes.length)
        clockTimer = setTimeout(tickClock, 1000 - now % 1000);
}
function attachClock() { clockNodes = $$('[data-elapsed]'); tickClock(); }
async function migrateConsoleLink() {
    if (location.hash || !location.search) return;
    const parameters = new URLSearchParams(location.search);
    if (!['view', 'project', 'run', 'exec', 'node', 'session'].some(key => parameters.has(key))) return;
    const connected = await load('fleet/status') as Fleet | null;
    const values = Object.fromEntries(parameters) as Record<string, string>;
    let nodeId = values.node || connected?.ingressNodeId;
    if (values.session && !values.run) {
        const query = new URLSearchParams({ session: values.session, days: '0', ...(values.root ? { root: values.root } : {}) });
        const matches = await API.get<RunPage>('runs?' + query);
        const current = matches.items[0];
        if (current) { nodeId = current.nodeId; values.run = current.id; values.view = 'changes'; values.tab = 'diff'; }
    }
    if (values.exec) {
        const parts = values.exec.split('/').map(decodeURIComponent);
        if (parts.length === 3) { nodeId = parts[0] || nodeId; values.project = parts[1]; values.run = parts[2]; }
    }
    if (!nodeId) return;
    const view = values.view || (values.run || values.project ? 'tasks' : 'machines');
    delete values.view;
    delete values.exec;
    if (values.run && !values.run.startsWith('qm:')) values.run = workspaceHandle(nodeId, values.run);
    if (values.project && !values.project.startsWith('qm:')) values.project = workspaceHandle(nodeId, values.project);
    if (values.run && values.file) {
        const detail = await API.get<RunDetail>('runs/' + enc(values.run));
        const selected = detail.files.find(file => file.id === values.file || file.path === values.file);
        if (selected) values.file = selected.id;
    }
    const query = new URLSearchParams(values);
    history.replaceState(null, '', location.pathname + '#/' + view + (query.size ? '?' + query : ''));
    route = parseRoute();
}
async function bootstrap(readSession = true) { clearTimeout(bootstrapRetryTimer); bootstrapError=null; booting = true; authRequired = false; API.abortAll(); clearTimeout(refreshTimer); schedulePaint(); try {
    if (readSession) {
        const session = await API.get<ConsoleSession>('session');
        if (session.contract !== 'quaymesh.console.v4' || !session.capabilities?.conversations
            || !session.capabilities.taskLifecycle || !session.capabilities.workspaceLocations)
            throw new ApiError('控制台与协调端版本不一致，请更新协调端服务。', 409, 'contract_mismatch');
        API.session = session;
        API.csrf = session.csrf;
    }
    bootstrapAttempts=0; CACHE.delete('session');
    await migrateConsoleLink();
    booting = false;
    ensureRoute();
    await Promise.all([...activePaths].map(p => load(p)));
    schedulePoll();
}
catch (failure) {
    const error = consoleError(failure);
    booting = false;
    if (error.status === 401 && error.code === 'CONSOLE_LOGIN_REQUIRED')
        authRequired = true;
    else {
        CACHE.set('session', { data: null, time: 0, error, loading: false });
        bootstrapError=error;
        if (!document.hidden && (!error.status || error.status>=500)) {
            bootstrapRetryTimer=setTimeout(()=>{void bootstrap();},Math.min(30000,1000 * 2 ** Math.min(bootstrapAttempts++,5)));
        }
    }
}
finally {
    schedulePaint();
} }
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&bootstrapError&&!booting)void bootstrap();});
window.addEventListener('pagehide',()=>clearTimeout(bootstrapRetryTimer));
applyPrefs();
bootstrap();
Object.defineProperty(window, 'QuayMesh', { value: Object.freeze({ version: '5.0.0', ready: () => !booting, getState: () => ({ route: clone(route), mode: 'live', requests: API.requestCount, cache: [...CACHE].map(([path, e]) => ({ path, time: e.time, error: e.error?.code, loading: e.loading })), capabilities: clone(API.session?.capabilities || {}) }), refresh: () => refresh(true) }), writable: false });
