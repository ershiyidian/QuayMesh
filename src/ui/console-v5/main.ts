import { notifyDesktop,desktopActions } from './desktop.js';
import { taskStages } from '../../console-task-state.js';
import { taskActivityView, TASK_EXECUTION_FRESHNESS_MS, TASK_SILENCE_MS } from '../../task-view.js';
import { brand,workspaceSummary,conversationCards } from './workspace-presentation.js';
import { Resources } from "./resources.js";
import {retainedDetailView,pendingDetailRead,detailRecordsComplete,type DetailRecordKey} from './retained-detail.js';
import { $, $$, updateHTML } from "./dom.js";
import { dialog, formObject } from "./dialogs.js";
import { consoleError, validateSession, WriteIntent, type ConsoleError, type ConsoleSession } from "./client.js";
import { icon } from './icons.js';
import { setDisplayTimeZone, timeZone, tm, fullTime, day, smartTime, ago, duration, fmt, compact, bytes, csvCell, timestamp } from './format.js';
import { esc, clamp, stages, stage, status, btn, ib, badge, meter, smallTime, spark, usageText, diffStat, resultExplanation, changeCaptureBlockReason, changeCaptureNotice, dedupeCaptureWarnings, transferPercent, percent, QUALITY } from './presentation.js';
import type { Run, RunDetail, RunPage, Overview, Fleet, Machine, NodeSettingsSnapshot, ChangeFile, Command, FileDiff, PatchPage, Project, Root, ListResponse, Sessions, Thread, SourceState, UsageReport, ActivityPage, EventRow, TransferRow, AuditRow, RevertPreview, RevertReceipt, ArchivePreview, ReviewReceipt, ActionReceipt, ControlReceipt, Preferences, Route, CacheEntry } from './contracts.js';
import Prism from "prismjs";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-python.js";
import { createApi, ApiError } from "./client.js";
import { cacheRatio, noncachedInput, usageParts } from "./usage.js";
import { CommandOutputs,commandOutputNotice,commandOutputNeedsRetry } from "./command-output.js";
import { sourceWarning, sourceWarnings, sourceNeedsAttention, resourceHealth, resourceObservation, hasPendingSourceRead } from './source-state.js';
import { readFailureMessage, readWarningMessage } from './read-state.js';
import { readFields, fieldsFromHTML, refreshFields, type FieldValues } from './settings-form.js';
import { EventNotifications, type NotificationMemory, type NotificationPage } from './notifications.js';
import { receiptLabel, canQueryReceipt } from './receipt-presentation.js';
import { workspaceHandle } from "../../federation/routing.js";
import "./styles.css";
import './experience.css';
import './overview.css';
import './read-state.css';
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
const DEFAULTS = { theme: 'dark', density: 'compact', sidebar: 'expanded', poll: 8, listWidth: 320, base: '/console/api/v4/', wrap: true, notifications: false, timeZone: 'local', taskLayout: 'list', machineLayout: 'cards', diffMode: 'unified' };
const savedPreferences = storage.get('quaymesh.workbench.v5', {});
let pref: Preferences = { ...DEFAULTS, ...Object.fromEntries(Object.entries(savedPreferences).filter(([key]) => key in DEFAULTS && key !== 'base')) };
if (!['dark', 'light', 'system'].includes(pref.theme))
    pref.theme = 'dark';
pref.poll = clamp(pref.poll, 0, 60);
pref.listWidth = clamp(pref.listWidth, 270, 520);
const systemTheme = matchMedia('(prefers-color-scheme: light)');
function applyPrefs() { setDisplayTimeZone(pref.timeZone); const d = document.documentElement; d.dataset.theme = pref.theme === 'system' ? (systemTheme.matches ? 'light' : 'dark') : pref.theme; notifyDesktop('theme',d.dataset.theme); d.dataset.density = pref.density; d.dataset.sidebar = pref.sidebar; d.style.setProperty('--list-width', pref.listWidth + 'px'); $<HTMLMetaElement>('meta[name=theme-color]')!.content = d.dataset.theme === 'light' ? '#f6f7f9' : '#111214'; }
function savePref(p: Partial<Preferences>) { pref = { ...pref, ...p }; storage.set('quaymesh.workbench.v5', pref); applyPrefs(); }






























const API = createApi(() => { authRequired = true; pausePendingReads(); schedulePaint(); }, () => { resources.invalidate(); ensureRoute(); schedulePaint(); });
const resources = new Resources(API, { freshness, paint: schedulePaint, loaded(path) {
    if (path === runPath() && route.p.cursor && CACHE.get(path)?.error?.code === 'cursor_expired') {
        toast('列表快照已到期，已重新读取第一页。','warn'); param({cursor:null}); return;
    }
    if(path===detailPath()&&route.p.phaseCursor&&CACHE.get(path)?.error?.code==='phase_cursor_expired'){
        toast('阶段记录已变化，已重新读取第一页。','warn');navigate(route.view,{phaseCursor:null,file:null},true,true);return;
    }
    if (path === 'projects' || path.startsWith('runs')) ensureRoute();
    if (path === 'fleet/status') pollNotifications();
    schedulePendingRead(path);
} });
const CACHE = resources.entries, selectedRuns = new Set<string>(), selectedThreads = new Set<string>(), expandedRoots = new Set<string>(), loadedBigFiles = new Set<string>(), expandedGroups = new Set<string>();
const localReadFailures = new Set<string>();
let routeFocusPending = false;
const pendingReads = new Map<string,{deadline:number;delay:number;exhausted:boolean;timer?:ReturnType<typeof setTimeout>}>();
let route: Route = parseRoute(), authRequired = false, booting = true, paintQueued = false, refreshTimer: ReturnType<typeof setTimeout> | undefined = undefined, failures = 0, refreshInFlight = false, backgroundPaused = false, activityPaused = false, activePaths = new Set<string>(), lastFocus: HTMLElement | null = null, paletteState: { close: () => void; pause: () => void; resume: () => void } | null = null;
const diffLimits = new Map<string, number>();
let pageSearch = '', sessionSearch = '', groupEvents = true, sortLayout = pref.taskLayout, machineLayout = pref.machineLayout, diffMode = pref.diffMode, writePending = new Set<string>();
const NAV = [['overview', '任务总览', 'overview'], ['tasks', '任务', 'tasks'], ['changes', '改动审查', 'changes'], ['sessions', '会话', 'sessions'], ['machines', '机器', 'machines'], ['workspaces', '工作空间', 'workspaces'], ['activity', '活动', 'activity'], ['usage', '用量分析', 'usage'], ['settings', '设置', 'settings']];
const titleOf = (v: string) => NAV.find(n => n[0] === v)?.[1] || '任务总览';
function taskRouteDefaults(view: string, p: Record<string,string | undefined>) {
    if (view === 'tasks' && !['scope','run','overviewGroup','requestState','resultStatus','status','stage','attention','q','project','node','date','finishedDay','usageDate','usageDays'].some(key => Boolean(p[key]))) {
        p.overviewGroup = 'current'; p.requestState = 'active';
    }
    return p;
}
function parseRoute() { const [v, q] = location.hash.replace(/^#\/?/, '').split('?'); const view = ['overview', 'tasks', 'changes', 'sessions', 'machines', 'workspaces', 'activity', 'usage', 'settings'].includes(v) ? v : 'overview'; return {view,p:taskRouteDefaults(view,Object.fromEntries(new URLSearchParams(q || '')))}; }
function currentQuery(extra: Record<string, string | number | boolean | null | undefined> = {}): string {
  const p = route.p;
  return queryString({ tz: timeZone() || deviceTimeZone, days: p.days ?? '0', node: p.node, project: p.project, q: p.q, status: p.status || (route.view === 'changes' && p.reviewMode !== 'all' ? 'review' : undefined), stage: p.stage, sort: p.sort,
    cursor: p.cursor, limit: p.limit || '25', changed: route.view === 'changes' ? '1' : p.changed, date: p.date, finishedDay: p.finishedDay,
    execution: p.execution, requestState: p.requestState, resultStatus: p.resultStatus, overviewGroup: p.overviewGroup, attention: p.attention, usageDate:p.usageDate, usageDays:p.usageDays, ...extra });
}
function queryString(parameters: Record<string, string | number | boolean | null | undefined>): string {
  return new URLSearchParams(Object.entries(parameters).flatMap(([key, value]): Array<[string,string]> => value === undefined || value === null || value === '' ? [] : [[key,String(value)]])).toString();
}
const runPath = () => 'runs?' + currentQuery();
const detailPath = (id=route.p.run) => {
    const query=id===route.p.run?queryString({phaseCursor:route.p.phaseCursor,phaseLimit:route.p.phaseLimit}):'';
    return 'runs/'+enc(id)+(query?'?'+query:'');
};
const activityPath = () => route.p.kind === 'receipts' ? 'receipts?limit=50' : 'activity?' + new URLSearchParams(Object.fromEntries(Object.entries({ kind: route.p.kind || 'events', q: route.p.q || '', node: route.p.node || '', level: route.p.level || '', cursor: route.p.cursor || '', hour: route.p.hour || '' }).filter(([, v]) => v)));
const conversationPath = () => 'conversations?' + queryString({q:route.p.q,node:route.p.node});
const usagePath = () => 'usage?' + currentQuery({ days: route.p.days || '14', cursor: null, limit: null, status: null });
const data = <T = unknown>(path: string): T | undefined => CACHE.get(path)?.data as T | undefined;
const fleet = () => data<Fleet>('fleet/status');
function fleetObservation() {
    const observation = resourceObservation(CACHE.get('fleet/status'));
    return { ...observation, current: observation.current && !backgroundPaused && !authRequired && !bootstrapError };
}
function fleetOnlineLabel(label = '在线') {
    const f = fleet();
    return f ? `${fleetObservation().current ? '' : '上次确认 '}${f.nodes.filter(n => n.online).length} / ${f.nodes.length} ${label}` : '读取节点';
}
function machineStatus(n: Machine) {
    return fleetObservation().current ? status(n.online ? 'online' : 'offline') : badge(n.online ? '上次确认在线' : '上次确认离线');
}
const overviewPath = () => 'overview?tz=' + enc(timeZone() || deviceTimeZone);
const overview = () => data<Overview>(overviewPath());
function renderedResourceEntry(path: string): CacheEntry | undefined {
    const entry = CACHE.get(path);
    if (!path.startsWith('overview') || !entry?.data) return entry;
    const snapshot = entry.data as {sources?: SourceState[]; taskSources?: SourceState[]};
    return {...entry, data:{...snapshot, sources:snapshot.taskSources ?? snapshot.sources}};
}
function observedResourceEntry(path: string): CacheEntry | undefined {
    const entry = renderedResourceEntry(path);
    if (!path.startsWith('overview') || !entry?.data) return entry;
    const snapshot = entry.data as {sources?: SourceState[]}, now = Date.now();
    // 观察到期影响任务状态与数量；自然老化不升级为读取故障。
    const sources = snapshot.sources?.map(source => source.observedAt !== null && now - source.observedAt > 30_000
        ? {...source, stale:true} : source);
    return {...entry, data:{...snapshot, sources}};
}
function overviewObservation() {
    const observation = resourceObservation(renderedResourceEntry(overviewPath()));
    return {...observation, current:observation.current && !backgroundPaused && !authRequired && !bootstrapError};
}
const projects = () => data<ListResponse<Project>>('projects')?.items || [];
const node = (id: string | null | undefined) => fleet()?.nodes?.find(n => n.id === id);
const nodeTag = (id: string | null | undefined, short = false) => { const n = node(id); return `<span class="node-label"><span class="node-mark ${n?.online === false ? 'offline' : ''}">${esc(n?.short || id?.slice(0, 3) || '?')}</span>${short ? '' : `<span class="ellipsis">${esc(n?.name || id || '未知节点')}</span>`}</span>`; };
const taskScope = (run: Run, short = true) => run.nodeIds && run.nodeIds.length > 1
  ? `<span class="node-label" title="${esc(run.nodeIds.map(id => node(id)?.name || id).join('、'))}"><span class="node-mark">${run.nodeIds.length}</span>${short ? '' : `<span class="ellipsis">${run.nodeIds.length} 个节点</span>`}</span>`
  : nodeTag(run.nodeId, short);
const canWrite = (cap = 'write') => !booting && !bootstrapError && !!API.session?.capabilities?.write && API.session.capabilities[cap] !== false;
const writeAttrs = (cap = 'write') => canWrite(cap) ? '' : 'disabled title="当前接口或凭据不允许此操作"';
const selectedRun = () => data<RunDetail>(detailPath())?.run;
function resourceName(path: string) {
    return path.startsWith('overview') ? '任务数据' : path === 'fleet/status' ? '节点状态' : path === 'projects' ? '工作区目录' : path.startsWith('runs?') ? '任务列表' : path.startsWith('runs/') ? '任务详情' : path.includes('/sessions') ? '会话' : path.startsWith('usage') ? '用量' : path.startsWith('activity') ? '活动' : path === 'roots' ? '工作空间' : '数据';
}
function sourceReadMessage(source: SourceState): string {
    return source.error ? readFailureMessage(new Error(source.error)) : sourceWarning(source) || '状态待更新';
}
function runObservation(run: Run) {
    const matching = [...activePaths].map(observedResourceEntry).filter((entry): entry is CacheEntry => {
        if (!entry?.data) return false;
        const value = entry.data as { run?: Run; items?: Run[]; current?: Run[]; olderOpen?: Run[]; active?: Run[]; waiting?: Run[]; recent?: Run[] };
        return value.run?.id === run.id || [value.items, value.current, value.olderOpen, value.active, value.waiting, value.recent].some(rows => rows?.some(row => row.id === run.id));
    }).sort((a, b) => b.time - a.time);
    const entry = matching[0], sources = (entry?.data as { sources?: SourceState[] } | undefined)?.sources?.filter(source => (run.nodeIds || [run.nodeId]).includes(source.nodeId)) || [];
    const observed = sources.map(source => source.observedAt).filter((at): at is number => at !== null);
    const observedAt = run.observedAt !== undefined ? run.observedAt : (observed.length ? Math.min(...observed) : entry?.time || null);
    return { stale: Boolean(run.stale || entry?.error) || sources.some(source => Boolean(sourceWarning(source))) || Boolean(observedAt && Date.now()-observedAt > 30_000 && ['running','stopping','queued'].includes(run.executionStatus)), observedAt, sources };
}
function activityForRun(run: Run) {
    const observation = runObservation(run);
    return taskActivityView({requestState:run.requestState,result:run.resultStatus,execution:run.executionStatus,
        stale:observation.stale,lastProgressAt:run.lastProgressAt ?? run.lastActivityAt,
        executionObservedAt:run.executionObservedAt,now:Date.now()});
}
function taskActivityTime(run: Run): string {
    const at = activityForRun(run).lastProgressAt;
    return '<span class="small muted">上次活动</span><br>' + (at === null ? '<span class="muted">尚未确认</span>' : smallTime(at));
}
function taskActivityTone(run: Run): string {
    const activity = activityForRun(run);
    return activity.state === 'executing' ? 'running' : activity.state === 'ended' ? run.resultStatus === 'completed' ? 'accepted' : run.resultStatus === 'failed' ? 'failed' : '' : '';
}
function overviewTaskGroups(value: Overview) {
    const rows = new Map<string, Overview['current'][number]>();
    for (const run of [...value.current, ...value.olderOpen]) rows.set(run.id, run);
    const known = [...rows.values()].filter(run => run.requestState === 'active').map(run => ({run, activity:activityForRun(run)}));
    const byActivity = (a: typeof known[number], b: typeof known[number]) => (b.activity.lastProgressAt ?? 0) - (a.activity.lastProgressAt ?? 0) || a.run.id.localeCompare(b.run.id);
    const current = known.filter(row => row.activity.current).sort((a,b) => Number(b.activity.state === 'executing') - Number(a.activity.state === 'executing') || byActivity(a,b)).map(row => row.run);
    const olderOpen = known.filter(row => !row.activity.current).sort(byActivity).map(row => row.run);
    // The overview arrays are capped. Recount only when the entire open set was read.
    const complete = Boolean(value.coverage.tasks && value.currentCount === value.current.length
        && value.olderOpenCount === value.olderOpen.length && rows.size === value.current.length + value.olderOpen.length);
    return {current, olderOpen, complete, currentCount:complete ? current.length : value.currentCount,
        olderOpenCount:complete ? olderOpen.length : value.olderOpenCount};
}
function taskPageProjection(page?: RunPage) {
    const group = route.p.overviewGroup, grouped = group === 'current' || group === 'olderOpen';
    const rows = page?.items || [], items = !grouped ? rows : rows.filter(run => run.requestState === 'active'
        && activityForRun(run).current === (group === 'current'));
    const moved = group === 'current' ? rows.filter(run => run.requestState === 'active' && !activityForRun(run).current) : [];
    // A complete current page can only lose members as its activity evidence ages.
    // An older page cannot account for unseen current tasks aging into that group.
    const complete = Boolean(page && taskCountsComplete(page) && group === 'current' && page.offset === 0
        && page.nextCursor == null && new Set(rows.map(run => run.id)).size === page.total);
    const total = !grouped ? taskCountsComplete(page) ? page?.total : undefined : complete ? items.length : undefined;
    const snapshot = page && taskCountsComplete(page) ? '上次读取共 ' + fmt(page.total) + ' 项；' : '';
    const countLabel = !grouped ? undefined : complete ? fmt(items.length) + ' 条'
        : '本页当前符合 ' + items.length + ' 项 · ' + snapshot + '完整数量待更新';
    return {items, moved, grouped, complete, total, countLabel};
}
function routePaths() {
    const list = ['fleet/status'];
    if (['overview', 'machines'].includes(route.view)) list.push(overviewPath());
    if (['tasks', 'changes', 'sessions', 'workspaces', 'usage'].includes(route.view)) list.push('projects');
    if (['tasks', 'changes'].includes(route.view)) {
        list.push(runPath());
        if (route.p.run) {
            const path = detailPath();
            list.push(path);
            const detail = data<RunDetail>(path);
            if ((route.p.tab || (route.view === 'changes' ? 'diff' : 'summary')) === 'diff' && detail?.files?.length)
                for (const f of visibleFiles(detail))
                    if (openFiles(detail).has(f.id) && (!f.generated || loadedBigFiles.has(route.p.run + ':' + f.id)))
                        list.push('runs/'+enc(route.p.run)+'/files/' + enc(f.id));
        }
    }
    else if (route.view === 'sessions')
        list.push(route.p.project ? 'projects/' + enc(route.p.project) + '/sessions' : conversationPath());
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
    if (/^runs\/[^/]+$/.test(path.split('?')[0]!)) {
        const detail = data<RunDetail>(path), r = detail?.run;
        if (r && !changeCaptureBlockReason(detail?.changeCaptures) && !['running', 'queued', 'stopping', 'waiting'].includes(r.executionStatus))
            return Math.max(30000, (pref.poll || 8) * 1000);
    }
    return Math.max(1000, (pref.poll || 8) * 1000);
}

function pausePendingReads() {
    for (const pending of pendingReads.values()) clearTimeout(pending.timer);
    pendingReads.clear();
}
function schedulePendingRead(path: string) {
    const entry = renderedResourceEntry(path), sources = (entry?.data as {sources?:SourceState[]} | undefined)?.sources || [];
    const pending = pendingReads.get(path);
    const awaitingResult = !entry?.error && (hasPendingSourceRead(sources) || pendingDetailRead(entry?.data));
    if (!activePaths.has(path) || !awaitingResult) {
        clearTimeout(pending?.timer); pendingReads.delete(path); return;
    }
    if (document.hidden || backgroundPaused || authRequired || booting || pending?.timer || pending?.exhausted) return;
    const current = pending ?? {deadline:Date.now()+45_000,delay:1_000,exhausted:false};
    pendingReads.set(path,current);
    if (Date.now() >= current.deadline) { current.exhausted=true;schedulePaint();return; }
    current.timer = setTimeout(() => {
        current.timer=undefined;
        if (document.hidden || backgroundPaused || authRequired || !activePaths.has(path) || pendingReads.get(path) !== current) return;
        if (Date.now() >= current.deadline) { current.exhausted=true;schedulePaint();return; }
        current.delay=Math.min(5_000,current.delay*2);
        void load(path).finally(() => {if(pendingReads.get(path)===current)schedulePendingRead(path);});
    },Math.min(current.delay,current.deadline-Date.now()));
}
async function load(path: string, force = false): Promise<unknown> {
    if(force){clearTimeout(pendingReads.get(path)?.timer);pendingReads.delete(path);}
    return resources.load(path, force);
}
function ensureRoute() {
    if (authRequired || booting || document.hidden || backgroundPaused)
        return;
    if (route.view === 'changes' && !route.p.run && route.p.browse !== '1' && data<RunPage>(runPath())?.items.length) {
        navigate('changes', { run: data<RunPage>(runPath())!.items[0].id, tab: 'diff' }, true, true);
        return;
    }
    const next = new Set(routePaths());
    activePaths.forEach(path => { if (!next.has(path)) {
        clearTimeout(pendingReads.get(path)?.timer); pendingReads.delete(path);
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
function navigate(view: string, patch: Record<string, string | number | boolean | null | undefined> = {}, replace = false, keep = false) { const oldView = route.view, oldRun = route.p.run, p = keep ? { ...route.p } : {}; Object.entries(patch).forEach(([k, v]) => v == null || v === '' ? delete p[k] : p[k] = String(v)); if(p.run!==oldRun){delete p.phaseCursor;delete p.phaseLimit;} taskRouteDefaults(view,p); route = { view, p }; const qs = queryString(p), hash = '#/' + view + (qs ? '?' + qs : ''); try {
    history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
catch {
    location.hash = hash;
} if (oldView !== view) {
    routeFocusPending = document.documentElement.dataset.inputMethod === 'keyboard';
    selectedRuns.clear();
    selectedThreads.clear();
    pageSearch = '';
    $('#view')!.scrollTop = 0;
} ensureRoute(); schedulePaint(); if (p.run && p.run !== oldRun) {
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTimeout(() => { if (innerWidth <= 1000)
        $('#inspector-close')?.focus(); }, 30);
} }
function param(p: Record<string, string | number | boolean | null | undefined>) { if ('q' in p || 'status' in p || 'stage' in p || 'requestState' in p || 'resultStatus' in p || 'overviewGroup' in p || 'attention' in p || 'node' in p || 'project' in p || 'days' in p || 'usageDate' in p || 'usageDays' in p || 'sort' in p)
    p.cursor = null; selectedRuns.clear(); navigate(route.view, p, true, true); }
function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
        paintQueued = false;
        try { paint(); }
        catch (error) {
            console.error('Console render failed', error);
            const view = $('#view');
            const retained = Boolean(view?.childElementCount);
            if (!retained) updateHTML(view, `<div class="page">${pageHead('当前页面暂时无法显示')}${empty('页面暂时无法显示', '可以重新读取，或查看诊断。', btn('重新读取', 'refresh') + btn('查看诊断', 'diagnostics'))}</div>`);
            updateHTML($('#global-notice'), '<div class="notice warn">' + (retained ? '当前内容暂未更新，仍保留上次可显示的内容。' : '当前页面暂时无法显示。') + btn('重新读取', 'refresh', '', 'small') + '</div>');
            updateHTML($('#statusbar'), '<span class="amber">页面显示失败</span>');
        }
    });
}
let refreshCount = 0;
async function refresh(manual = false) {
    if (booting || authRequired || document.hidden || backgroundPaused) return;
    refreshCount++; refreshInFlight = true; schedulePaint(); schedulePoll();
    pollNotifications();
    try {
        const paths = routePaths().filter(p => !activityPaused || !p.startsWith('activity?'));
        activePaths = new Set(routePaths());
        await Promise.all([...paths.map(p => load(p, manual)), ...visibleCommandPaths().map(path => loadCommand(path, manual))]);
        const errors = paths.filter(p => CACHE.get(p)?.error);
        if (manual) toast(errors.length ? `${errors.length} 个资源刷新失败，其余数据可用` : '已重新读取当前视图', errors.length ? 'warn' : 'good');
    } finally {
        refreshInFlight = --refreshCount > 0; schedulePaint();
    }
}
function schedulePoll() {
    clearTimeout(refreshTimer);
    if (!pref.poll || document.hidden || backgroundPaused || booting || authRequired) return;
    refreshTimer = setTimeout(() => void refresh(), pref.poll * 1000);
}
function resourceState(path: string) {
    const entry = CACHE.get(path), name = resourceName(path);
    if (entry?.data) return '';
    const failed = Boolean(entry?.error), loading = !failed || Boolean(entry?.loading);
    if (failed) localReadFailures.add(path);
    const title = loading ? (failed ? '正在重试' : '正在读取') + name : name + '暂未读取';
    return `<section class="panel resource-state ${loading ? 'loading' : 'read-failed'}" data-key="resource-${esc(path)}" aria-label="${esc(name)}读取状态" aria-busy="${loading}"><div class="resource-state-heading">${loading ? '<span class="spinner"></span>' : icon('alert',18)}<h3>${esc(title)}</h3></div><p role="status">${failed ? esc(readFailureMessage(entry!.error)) : '已读取的内容会先显示，其他部分仍在读取。'}</p>${loading && !failed ? '<div class="resource-skeletons" aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div></div>' : ''}<div class="resource-state-actions">${failed ? btn(loading ? '正在重试…' : '重试这部分', 'retry', `data-path="${esc(path)}" ${loading ? 'disabled' : ''}`, 'small') : ''}${path.startsWith('overview') ? btn('打开任务列表','nav','data-view="tasks"','small ghost') : ''}${failed ? btn('查看诊断','diagnostics','','small ghost') : ''}</div></section>`;
}
function staleNotice(path: string, captures?: RunDetail['changeCaptures']) {
  const entry = renderedResourceEntry(path), name = resourceName(path);
  const warnings = dedupeCaptureWarnings((entry?.data as { warnings?: string[] } | null)?.warnings || [], captures);
  const messages = warnings.filter(Boolean).map(readWarningMessage);
  const sources = (entry?.data as {sources?: SourceState[]} | undefined)?.sources || [];
  const pending = sources.some(source => ['loading','refreshing'].includes(source.state));
  let progress = '';
  if (entry?.data && entry.error) {
    localReadFailures.add(path);
    progress = `<div class="notice warn resource-update" role="status" aria-busy="${entry.loading}">${entry.loading ? '<span class="spinner"></span>' : icon('alert',16)}<div><b>${esc(entry.loading ? '正在重试' + name : name + '更新失败')}</b><p>${esc(readFailureMessage(entry.error))}</p><p class="small">继续显示${entry.time ? ' ' + esc(fullTime(entry.time)) + ' 读取的' : '上次成功读取的'}内容。</p></div>${btn(entry.loading ? '正在重试…' : '重试这部分','retry',`data-path="${esc(path)}" ${entry.loading ? 'disabled' : ''}`,'small')}</div>`;
  } else if (entry?.data && (entry.loading || pending)) {
    const exhausted = pendingReads.get(path)?.exhausted;
    progress = `<div class="resource-update pending" role="status" aria-busy="${!exhausted}">${exhausted ? icon('tasks',14) : '<span class="spinner"></span>'}<span>${exhausted ? '仍有数据未返回，保留已读取的内容。' : pending ? '部分数据仍在读取，已返回的内容先显示。' : '正在更新' + esc(name) + '，保留已读取的内容。'}</span>${exhausted ? btn('重新读取这部分','retry',`data-path="${esc(path)}"`,'small') : ''}</div>`;
  }
  const warning = messages.length ? '<div class="notice warn visually-spaced">' + icon('alert') + '<div>' + messages.map(esc).join('<br>') + '</div>' + btn('重试', 'retry', 'data-path="' + esc(path) + '"', 'small') + '</div>' : '';
  return `<div class="resource-state-slot" data-key="resource-status-${esc(path)}">${progress}${warning}</div>`;
}
function empty(title: string, text = '', action = '') { return `<div class="empty">${icon('workspaces', 26)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`; }
const pageHead = (title: string, subtitle = '', actions = '') => `<header class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
const panel = (title: string, body: string, right = '', foot = '', key = '') => `<section class="panel"${key ? ` data-key="${esc(key)}"` : ''}><div class="panel-head"><h3>${title}</h3>${right ? `<div class="right">${right}</div>` : ''}</div>${body}${foot ? `<div class="panel-foot">${foot}</div>` : ''}</section>`;
function tabs(items: Array<[string, string, (number | null | undefined)?]>, value: string, action = 'tab', attr = 'data-value') { return `<div class="tabs" aria-label="视图筛选">${items.map(([id, text, count]) => `<button class="tab ${id === value ? 'active' : ''}" data-action="${action}" ${attr}="${esc(id)}" aria-pressed="${id === value}">${text}${count != null ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</div>`; }
function segmented(items: Array<[string, string]>, value: string | number, action: string, extra = '') { return `<div class="segmented">${items.map(([id, label]) => `<button type="button" class="${String(id) === String(value) ? 'active' : ''}" data-action="${action}" data-value="${esc(id)}" aria-pressed="${String(id) === String(value)}" ${extra}>${label}</button>`).join('')}</div>`; }
function searchField(value: string | undefined, placeholder = '搜索标题、ID 或项目…', kind = 'query') { return `<label class="search-field">${icon('search', 15)}<span class="sr-only">${esc(placeholder)}</span><input class="input" id="${kind}-search" data-search="${kind}" type="search" value="${esc(value || '')}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`; }
const opt = (v: string | number, t: string, current: string | number | null | undefined) => `<option value="${esc(v)}" ${String(v) === String(current || '') ? 'selected' : ''}>${esc(t)}</option>`;
function scopes(project = true) { return `<select class="select" data-param="node" aria-label="机器范围">${opt('', '全部机器', route.p.node)}${(fleet()?.nodes || []).map(n => opt(n.id, n.short + ' · ' + n.name, route.p.node)).join('')}</select>${project ? `<select class="select" data-param="project" aria-label="项目范围">${opt('', '全部项目', route.p.project)}${projects().filter(p => !route.p.node || p.nodeId === route.p.node).map(p => opt(p.id, p.name, route.p.project)).join('')}</select>` : ''}`; }
function rangeSelect(value = '7', all = true) { return `<select class="select" data-param="days" aria-label="时间范围">${[['1', '近 24 小时'], ['7', '近 7 天'], ['14', '近 14 天'], ['30', '近 30 天'], ['0', '全部历史']].filter(([v]) => all || v !== '0').map(([v, t]) => opt(v, t, value)).join('')}</select>`; }
function pagination(d: RunPage | ActivityPage<unknown>, countLabel?: string) {
  const previous = 'previousCursor' in d ? d.previousCursor : String(Math.max(0, d.offset - d.limit));
  const incomplete = 'counts' in d ? !taskCountsComplete(d) : 'complete' in d && !d.complete;
  return '<div class="pagination"><span>' + (countLabel ?? (incomplete ? (d.items.length ? '本页已读取 ' + d.items.length + ' 条 · ' : '') + '总数待确认' : d.total ? (d.offset + 1) + '–' + Math.min(d.offset + d.items.length, d.total) + ' / ' + fmt(d.total) + ' 条' : '0 条'))
    + '</span><div class="actions">' + btn(icon('back', 14) + '上一页', 'page', 'data-value="' + esc(previous || '') + '" ' + (d.offset === 0 ? 'disabled' : ''), 'small')
    + btn('下一页' + icon('chevron', 14), 'page', 'data-value="' + esc(d.nextCursor || '') + '" ' + (d.nextCursor == null ? 'disabled' : ''), 'small') + '</div></div>';
}




const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function chrome() {
    const ov = overview(), f = fleet(), health = resourceHealth([...activePaths].map(renderedResourceEntry));
    const taskObservationWarnings = sourceWarnings([observedResourceEntry(overviewPath())]);
    const observationExpired = activePaths.has(overviewPath()) && taskObservationWarnings.length > 0 && !health.errors && !health.stale;
    const connectionLabel = health.errors || health.stale || observationExpired ? (health.confirmedAt ? '页面读取 ' + tm(health.confirmedAt) : '等待数据') : health.label;
    const groups = ov ? overviewTaskGroups(ov) : undefined;
    const currentCount = overviewObservation().current && !taskObservationWarnings.length && groups?.complete ? groups.currentCount : null;
    const nav = NAV.map(([v, t, i], index) => `${index === 4 ? '<div class="nav-label">基础设施</div>' : ''}${index === 8 ? '<div class="nav-divider"></div>' : ''}<button type="button" class="nav-item ${route.view === v ? 'active' : ''}" data-action="nav" data-view="${v}" ${route.view === v ? 'aria-current="page"' : ''} title="${t}">${icon(i, 16)}<span class="label">${t}</span>${v === 'tasks' && currentCount ? `<span class="nav-count" title="${currentCount} 项当前任务">${currentCount}</span>` : ''}</button>`).join('');
    updateHTML($('#sidebar'), `<div class="brand">${brand()}<span class="brand-text">QuayMesh</span>${ib('panel', 'sidebar', '折叠侧栏')}</div><div class="nav-label">工作台</div><nav aria-label="主导航">${nav}</nav><div class="sidebar-bottom"><button class="nav-item" data-action="palette" title="搜索与命令">${icon('terminal')}<span class="label">命令面板</span><kbd class="nav-count">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button><div class="profile"><span class="avatar">W</span><div class="profile-text"><b>${esc(API.session?.user?.name || 'Owner')}</b><small>${canWrite() ? '管理员' : '只读'}</small></div>${ib('settings', 'nav', '设置', 'data-view="settings"')}</div></div>`);
    updateHTML($('#topbar'), `<button class="collapsed-toggle icon-btn" data-action="sidebar" aria-label="展开侧栏">${icon('panel')}</button><div class="breadcrumb"><span class="workspace-label">个人工作区</span><span class="slash">/</span><b>${esc(titleOf(route.view))}</b></div><button class="top-search" data-action="palette" aria-label="搜索与命令面板">${icon('search', 14)}<span>搜索任务或命令</span><kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button><button class="demo-tag" data-action="diagnostics">诊断</button>${desktopActions()}${ib('refresh', 'refresh', refreshInFlight ? '重新发起当前页面读取' : '刷新当前页面')}${ib(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 'theme', '切换主题', '', 'theme-top')}`);
    updateHTML($('#global-notice'), failureSummary());
    updateHTML($('#statusbar'), `<span class="inline ${booting || authRequired || bootstrapError || health.errors || health.stale || observationExpired ? 'muted' : health.tone}" title="${esc(health.confirmedAt ? '页面最近读取：' + fullTime(health.confirmedAt) : '尚无已确认数据')}"><i class="dot"></i>${booting ? '连接中' : authRequired ? '请登录' : bootstrapError ? '未连接' : connectionLabel}</span><button data-action="nav" data-view="machines">${fleetOnlineLabel('节点在线')}</button><span>${fleetObservation().current ? '出网' : '上次出网'} ${esc(node(f?.gatewayId)?.short || '—')}</span><span class="spacer"></span><span>${document.hidden || backgroundPaused ? '已暂停' : pref.poll ? pref.poll + ' 秒检查更新' : '手动刷新'}</span><span>${timeZone() || deviceTimeZone}</span><button data-action="shortcuts">快捷键</button>`);
    updateHTML($('#bottom-nav'), [['overview', '总览', 'overview'], ['tasks', '任务', 'tasks'], ['sessions', '会话', 'sessions'], ['machines', '机器', 'machines'], ['more', '更多', 'more']].map(([v, t, i]) => `<button class="${v === route.view || v === 'more' && !['overview', 'tasks', 'sessions', 'machines'].includes(route.view) ? 'active' : ''}" data-action="${v === 'more' ? 'more' : 'nav'}" data-view="${v}" aria-label="${t}">${icon(i, 19)}<span>${t}</span></button>`).join(''));
}
function failureSummary() {
  if (authRequired) return '<div class="notice global-notice warn">' + icon('lock', 14) + '登录已过期</div>';
  if (bootstrapError && API.session) return '<div class="notice global-notice warn">' + icon('alert',14) + '<span>' + esc(readFailureMessage(bootstrapError)) + ' 仍保留已读取的内容。</span>' + btn('重新连接','reconnect','','small') + '</div>';
  if (booting && API.session) return '<div class="notice global-notice" role="status"><span class="spinner"></span>正在重新连接，保留已读取的内容。</div>';
  const failed = [...activePaths].filter(path => CACHE.get(path)?.error && CACHE.get(path)?.data && !localReadFailures.has(path));
  const sources = [...activePaths].flatMap(path => sourceWarnings([renderedResourceEntry(path)]).filter(source => sourceNeedsAttention(source)).map(source => ({path,source})));
  const notices: string[] = [], details: string[] = [];
  if (failed.length) notices.push([...new Set(failed.map(resourceName))].join('、') + '读取失败');
  details.push(...failed.map(path => resourceName(path) + '：' + readFailureMessage(CACHE.get(path)!.error)));
  if (sources.length) notices.push([...new Set(sources.map(({path}) => resourceName(path)))].join('、') + '更新延迟');
  details.push(...sources.map(({path,source}) => resourceName(path) + ' · ' + (source.name || source.nodeId) + '：' + sourceReadMessage(source) + (source.observedAt ? ' · 上次确认 ' + fullTime(source.observedAt) : '')));
  if (pref.notifications && notificationGaps.size) {
    notices.push('活动通知待更新');
    details.push(...[...notificationGaps].map(([id,message]) => (node(id)?.name || id) + '：' + message));
  }
  return notices.length ? '<div class="notice global-notice warn">' + icon('alert', 14) + '<details><summary>' + esc(notices.join(' · ')) + '</summary><div class="source-details">' + [...new Set(details)].map(esc).join('<br>') + '</div></details>' + btn('重试', 'refresh', '', 'small') + '</div>' : '';
}
let bootstrapError:ConsoleError|null=null;
let bootstrapRetryTimer:ReturnType<typeof setTimeout>|undefined;
let bootstrapAttempts=0;
function paint() {
    const root = $('#view')!;
    localReadFailures.clear();
    const overviewFocus = route.view === 'overview' && document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
        ? document.activeElement : null;
    root.classList.toggle('split-view', ['tasks', 'changes', 'sessions'].includes(route.view));
    let html;
    if (authRequired)
        html = loginPage();
    else if (bootstrapError && !API.session)
        html = `<div class="page"><section class="login-panel">${brand(48)}<h1>控制台暂未连接</h1><p>${esc(readFailureMessage(bootstrapError))}</p>${btn('重新连接','reconnect','','primary')}</section></div>`;
    else if (booting && !API.session)
        html = `<div class="page">${pageHead('正在建立连接', '读取会话与接口能力')}${resourceState('session')}</div>`;
    else
        html = renderView();
    chrome();
    updateHTML(root, `<div data-key="view-${route.view}-${authRequired ? 'login' : 'app'}" style="${['tasks', 'changes', 'sessions'].includes(route.view) && !authRequired ? 'height:100%;min-height:0' : ''}">${html}</div>`);
    if (overviewFocus?.isConnected && document.activeElement !== overviewFocus) overviewFocus.focus({preventScroll:true});
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
    if (routeFocusPending && !$('dialog[open]')) {
        (overlay ? $('#inspector-close') : root)?.focus({preventScroll:true});
        routeFocusPending = false;
    }
    attachClock();
}
async function loadCommand(path: string, force = false) {
  if (document.hidden || backgroundPaused) return;
  await commandReader.load(path, new Set(visibleCommandPaths()), force);
}
function visibleCommandPaths() {
  if (!route.p.run || route.p.tab !== 'commands') return [];
  const detail = data<RunDetail>(detailPath());
  return (detail?.commands || []).filter(command => command.outputAvailable && (document.getElementById('command-' + command.id) as HTMLDetailsElement | null)?.open)
    .map(command => 'runs/' + enc(route.p.run) + '/commands/' + enc(command.id));
}
function commandOutputText(command: Command, runId: string) {
  if (!command.outputAvailable) return command.output || '此命令没有保存可读取的输出';
  const entry = commandOutputs.get('runs/' + enc(runId) + '/commands/' + enc(command.id));
  if (!entry) return '展开后读取命令输出';
  return [commandOutputNotice(entry),entry.truncated?'较早输出已截断，以下为最近内容。':'',entry.text,
    entry.hasMore?'还有已保存的输出，可以继续读取。':'',entry.error?'读取失败：'+readWarningMessage(entry.error):'']
    .filter(Boolean).join('\n') || (entry.pending?'正在读取命令输出':entry.done?'此命令没有保存文本输出':'等待输出');
}
async function loadMoreFile(path: string): Promise<void> {
  const count = await resources.moreFile(path);
  const file = data<FileDiff>(path)?.file;
  if (count !== null && file) diffLimits.set(route.p.run + ':' + file.id, count);
}
document.addEventListener('toggle', event => {
  const target = (event.target as HTMLElement);
  if (target instanceof HTMLDetailsElement && target.id === 'overview-older-open') {
    if (target.open) expandedGroups.add('overview-older-open');
    else expandedGroups.delete('overview-older-open');
  }
  if (target instanceof HTMLDetailsElement && target.open && target.id.startsWith('command-') && route.p.run) {
    const commandId = target.id.slice('command-'.length);
    const command = data<RunDetail>(detailPath())?.commands.find(command => command.id === commandId);
    if (command?.outputAvailable) void loadCommand('runs/' + enc(route.p.run) + '/commands/' + enc(commandId));
  }
}, true);
function renderView() { return ({ overview: overviewPage, tasks: tasksPage, changes: tasksPage, sessions: sessionsPage, machines: machinesPage, workspaces: workspacesPage, activity: activityPage, usage: usagePage, settings: settingsPage } as Record<string, () => string>)[route.view](); }
function overviewTaskRow(r: Run & {progressLabel?: string; progressSummary?: string | null}, group: 'current' | 'older' | 'recent') {
    const title = r.title, observation = runObservation(r), activity = activityForRun(r);
    const stale = r.requestState !== 'closed' && (observation.stale || route.view === 'overview' && !overviewObservation().current);
    const label = activity.label;
    const tone = activity.state === 'ended' && r.resultStatus === 'completed' ? 'good' : activity.state === 'executing' ? 'live' : '';
    const at = group === 'recent' ? r.finishedAt || activity.lastProgressAt : activity.lastProgressAt;
    const validAt = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
    const timeLabel = group === 'recent' ? '结束于' : '上次活动';
    // Replace only the shared activity summary, never arbitrary business or attention text.
    const activitySummaries = ['已确认后台执行仍在运行','正在停止当前执行','已确认仍在执行队列中','最近 30 分钟没有新活动；任务仍可继续'];
    const saved = r.progressSummary || '', generated = activitySummaries.find(text => saved === text || saved === text + '；部分任务信息待更新');
    const retained = generated ? saved.endsWith('；部分任务信息待更新') ? '部分任务信息待更新' : null : r.progressSummary;
    const progress = [...new Set([activity.detail,retained].filter((text): text is string => Boolean(text)))].join(' · ');
    const observationNote = stale ? `<span class="small muted">状态待更新${typeof observation.observedAt === 'number' && Number.isFinite(observation.observedAt) && observation.observedAt > 0 ? ' · 上次确认 ' + smallTime(observation.observedAt) : ''}</span>` : '';
    return `<article class="overview-task-row" role="listitem" data-key="overview-${group}-${esc(r.id)}"><div class="overview-task-content"><div class="overview-task-heading"><button class="run-title overview-task-title" data-action="open-run" data-id="${esc(r.id)}" title="${esc(title)}">${esc(title)}</button>${badge(label,tone)}</div>${progress ? `<p class="overview-task-progress">${esc(progress)}</p>` : ''}<div class="overview-task-meta">${taskScope(r,false)}${workspaceSummary(r)}<span class="overview-task-time">${timeLabel} ${validAt !== null ? smallTime(validAt) : '尚未确认'}</span>${observationNote}</div></div>${ib('chevron','open-run','打开任务',`data-id="${esc(r.id)}"`)}</article>`;
}
function overviewAttentionRow(a: Overview['attention'][number]) {
    const confirmed = typeof a.observedAt === 'number' && Number.isFinite(a.observedAt) && a.observedAt > 0;
    const stale = a.stale || !overviewObservation().current || !confirmed || Date.now() - a.observedAt! > 30_000;
    return `<div class="attention-row" data-key="attention-${esc(a.id)}"><span class="${stale ? 'muted' : 'amber'}">${icon('alert',16)}</span><div><button class="run-title" data-action="open-run" data-id="${esc(a.id)}">${esc(a.title)}</button><p title="${esc(a.detail)}">${esc(a.detail)}</p>${stale ? `<p class="small muted">${confirmed ? '上次确认 ' + smallTime(a.observedAt) : '状态尚未确认'}</p>` : ''}${btn(esc(stale ? '查看任务记录' : a.actionLabel),'overview-task-action',`data-id="${esc(a.id)}" data-kind="${stale ? 'record' : esc(a.kind)}"`,'small ghost')}</div></div>`;
}
function overviewPage() {
    const o = overview(), f = fleet();
    if (!o) {
        const records = new Map<string, Run>();
        [...CACHE].filter(([path, entry]) => path.startsWith('runs?') && entry.data)
            .sort((a,b) => b[1].time-a[1].time).forEach(([,entry]) => {
                for (const run of (entry.data as RunPage).items) if (!records.has(run.id)) records.set(run.id, run);
            });
        const known = [...records.values()].slice(0,6);
        const lastTasks = known.length ? panel('已读取的任务记录', `<p class="panel-body small muted">总览尚未读取成功，先显示最近读取的任务记录；完整统计仍待确认。</p><div class="overview-task-list" role="list" aria-label="已读取的任务记录">${known.map(run => overviewTaskRow(run,'current')).join('')}</div>`, '', '', 'overview-cached-tasks') : '';
        const machines = f ? panel('机器', `<div class="panel-body"><p>${esc(fleetOnlineLabel('节点在线'))}</p><p class="small muted">节点读取与任务读取分别更新。</p></div>`, btn('查看机器','nav','data-view="machines"','small ghost'), '', 'overview-machines-panel') : resourceState('fleet/status');
        return `<div class="page overview-page">${pageHead('任务总览',day(Date.now()),btn(icon('tasks',14)+'全部任务','all-task-queue','','small'))}<div class="overview-grid"><div class="stack overview-primary">${resourceState(overviewPath())}${lastTasks}</div><aside class="stack overview-secondary" aria-label="节点状态">${machines}</aside></div></div>`;
    }
    const groups = overviewTaskGroups(o);
    const shown = (value: number | null | undefined) => value == null ? '待确认' : value;
    const hasTaskObservation = o.taskSources.some(source => source.observedAt !== null);
    const summaryValue = (value: number | null | undefined, known: number | undefined) => value == null
        && typeof known === 'number' && (known > 0 || hasTaskObservation)
        ? `<strong>${fmt(known)}</strong><span>项已读取</span>` : `<strong>${shown(value)}</strong>`;
    const groupCount = (value: number | null | undefined) => (groups.complete || value == null ? '' : '上次读取 ') + shown(value);
    const compactEmpty = (title: string) => `<div class="overview-empty">${icon('tasks',18)}<p>${esc(title)}</p></div>`;
    const current = panel('当前任务', `<div class="overview-task-list overview-current" role="list" aria-label="当前任务">${groups.current.map(r => overviewTaskRow(r,'current')).join('') || compactEmpty(groups.complete ? '暂无当前任务' : '已读记录中暂无当前任务，完整结果待更新')}</div>`, badge(groupCount(groups.currentCount)), !groups.complete ? `<span class="small muted">已读记录中 ${groups.current.length} 项当前 · 完整数量待更新</span>${btn('查看全部当前任务','current-task-queue','','small ghost')}` : '', 'overview-current-panel');
    const older = groups.olderOpen.length || groups.olderOpenCount ? `<details class="panel overview-older" id="overview-older-open" data-key="overview-older-open" ${expandedGroups.has('overview-older-open') ? 'open' : ''}><summary><span>较早未关闭</span>${badge(groupCount(groups.olderOpenCount))}<span class="small muted overview-expand">展开查看</span><span class="small muted overview-collapse">收起</span>${icon('down',14)}</summary><div class="overview-task-list" role="list" aria-label="较早未关闭">${groups.olderOpen.map(r => overviewTaskRow(r,'older')).join('')}</div><div class="panel-foot">${btn('查看全部较早未关闭任务','older-task-queue','','small ghost')}</div></details>` : '';
    const recent = panel('最近结束的任务', `<div class="overview-task-list overview-recent" role="list" aria-label="最近结束的任务">${o.recent.map(r => overviewTaskRow(r,'recent')).join('') || compactEmpty(o.coverage.tasks ? '暂无已结束任务' : '已结束任务状态待确认')}</div>`, btn('全部已结束任务','closed-task-queue','','small ghost'), '', 'overview-recent-panel');
    const attention = o.attention.length ? panel('需要处理', o.attention.slice(0, 3).map(a => overviewAttentionRow(a)).join(''), badge(String(shown(o.attentionCount)), 'warn'), o.attentionCount != null && o.attentionCount > 3 ? `<button class="link-btn" data-action="attention-queue">全部 ${o.attentionCount} 项 ${icon('arrow',13)}</button>` : '', 'overview-attention-panel') : '';
    const fleetBody = f ? `<div class="fleet-labels"><span>节点</span><span>CPU</span><span>内存</span></div>${f.nodes.map(n => `<div class="fleet-row" data-key="fleet-${esc(n.id)}"><button class="run-title" data-action="node" data-id="${esc(n.id)}">${nodeTag(n.id)}<span class="small muted fleet-description">${n.id === f.gatewayId ? fleetObservation().current ? '当前出口' : '上次出口' : n.online ? n.gpuSampled === false ? 'GPU 尚未采集' : n.gpus.length + ' GPU' : '离线'}</span></button><div class="reading">${n.online && n.cpu != null ? fmt(n.cpu) + '%' : '—'}${meter(n.online ? n.cpu : null)}</div><div class="reading">${n.online && percent(n.memoryUsed,n.memoryTotal) !== null ? Math.round(percent(n.memoryUsed,n.memoryTotal)!) + '%' : '—'}${meter(n.online ? percent(n.memoryUsed,n.memoryTotal) : null)}</div></div>`).join('')}` : resourceState('fleet/status');
    const machines = panel('机器', fleetBody, f ? `<button class="link-btn small" data-action="nav" data-view="machines">${fleetOnlineLabel()} ${icon('chevron', 12)}</button>` : '', '', 'overview-machines-panel');
    const gateway = f ? panel('连接', `<div class="connection-grid"><span class="muted">入口</span><span>${esc(node(f.ingressNodeId)?.short || '尚未配置')}</span>${f.ingressNodeId ? badge((fleetObservation().current ? '' : '上次确认') + (node(f.ingressNodeId)?.online ? '在线' : '未连接'), fleetObservation().current ? node(f.ingressNodeId)?.online ? 'good' : 'warn' : '') : badge('入口未配置')}<span class="muted">出网</span><span>${esc(node(f.gatewayId)?.short || '—')} · ${esc(node(f.gatewayId)?.egress?.region || '—')}</span><span class="num small">${node(f.gatewayId)?.egress?.latency ?? '—'} ms</span></div><div class="endpoint"><code>${esc(f.mcpUrl || f.ingressLabel || (f.ingressNodeId ? '由该节点的托管 MCP 隧道提供' : '尚未配置 MCP 入口'))}</code>${ib('copy', 'copy', '复制 MCP 地址', `data-text="${esc(f.mcpUrl || '')}" ${f.mcpUrl ? '' : 'disabled'}`)}</div>`, '', '', 'overview-connection-panel') : '';
    const summary = `<section class="overview-summary" aria-label="任务统计"><div><span>当前任务${groups.complete || groups.currentCount == null ? '' : ' · 上次读取'}</span>${summaryValue(groups.currentCount,o.knownCounts.current)}</div><button type="button" data-action="attention-queue"><span>需要处理</span>${summaryValue(o.attentionCount,o.knownCounts.attention)}</button><button type="button" data-action="completed-queue"><span>今日完成</span>${summaryValue(o.completedToday,o.knownCounts.completedToday)}</button></section>`;
    return `<div class="page overview-page">${pageHead('任务总览', day(Date.now()), btn(icon('tasks',14)+'全部任务','all-task-queue','','small'))}${staleNotice(overviewPath())}${summary}<div class="overview-grid"><div class="stack overview-primary">${current}${older}${recent}</div><aside class="stack overview-secondary" aria-label="待办与节点">${attention}${machines}${gateway}</aside></div></div>`;
}
function taskRow(r: Run) {
    const selected = selectedRuns.has(r.id), active = route.p.run === r.id;
    return `<tr class="${active ? 'selected' : ''}" data-key="row-${esc(r.id)}">
  <td class="check-cell"><label class="check-label"><input type="checkbox" data-select-run="${esc(r.id)}" ${selected ? 'checked' : ''} aria-label="选择任务 ${esc(r.title)}"></label></td>
  <td class="task-main"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)}">${esc(r.title)}</button><div class="run-sub">${workspaceSummary(r)}</div></td>
  <td class="task-state">${runBadges(r)}</td><td class="task-node">${taskScope(r, true)}</td>
  <td class="task-diff">${r.diff ? diffStat(r) : '<span class="muted">—</span>'}</td>
  <td class="task-time align-right">${taskActivityTime(r)}</td><td class="task-usage align-right">${usageText(r)}</td>
  <td class="task-start align-right">${Number.isFinite(r.startedAt) && r.startedAt > 0 ? smallTime(r.startedAt) : '<span class="muted">尚未确认</span>'}</td>
  <td class="task-open">${ib('chevron', 'open-run', '打开详情', `data-id="${esc(r.id)}"`, 'row-extra')}</td>
 </tr>`;
}
function taskScopeTabs(page?: RunPage, projection = taskPageProjection(page)) {
    const counts = page?.counts;
    const count = (key:string) => taskCountsComplete(page) ? counts?.[key] : undefined;
    const current = route.p.overviewGroup === 'current' ? 'current' : route.p.overviewGroup === 'olderOpen' ? 'older' : route.p.requestState === 'active' ? 'open' : route.p.requestState === 'closed' ? 'ended'
        : route.p.attention ? 'attention' : route.p.stage === 'running,stopping,queued' ? 'active' : '';
    return tabs([['current','当前任务',current === 'current' ? projection.total : undefined],['','全部',count('scopeAll')],['older','较早未关闭'],['open','未关闭',count('scopeOpen')],['ended','已结束',count('scopeClosed')],
        ['active','后台执行',count('scopeActive')],['attention','需要处理',count('scopeAttention')]], current, 'task-scope');
}
function taskCountsComplete(page?: RunPage): boolean { return Boolean(page?.coverage?.tasks ?? page?.complete); }
function setTaskScope(key: string) {
    param({status:null,scope:key === '' ? 'all' : null,overviewGroup:key === 'current' ? 'current' : key === 'older' ? 'olderOpen' : null,
        requestState:['current','older','open'].includes(key) ? 'active' : key === 'ended' ? 'closed' : null,
        attention:key === 'attention' ? '1' : null,stage:key === 'active' ? 'running,stopping,queued' : null});
}
function runBadges(run: Run): string {
    const activity = activityForRun(run), observation = runObservation(run);
    const tone = taskActivityTone(run);
    const notes = [...new Set([activity.detail,observation.stale && activity.state !== 'ended' ? '状态待更新' : null].filter((text): text is string => Boolean(text)))];
    return `<span class="state ${tone}" data-activity-state="${activity.state}">${icon(activity.state === 'executing' ? 'running' : activity.state === 'ended' ? 'check' : 'tasks',13)}${esc(activity.label)}</span>${notes.length ? `<div class="small muted">${notes.map(esc).join(' · ')}</div>` : ''}${run.actions.review ? badge('待验收','warn') : ''}${run.finalization?.error ? badge('交付确认失败','warn') : ''}`;
}

function phaseCards(detail: RunDetail): string {
    const phases = (detail.phases || []).filter(phase => phase.id !== detail.run.id);
    const references = (detail.phasePage?.references ?? detail.run.phaseRefs ?? []).filter(id => id !== detail.run.id);
    if (!phases.length && !references.length) return '';
    const byId=new Map(phases.map(phase=>[phase.id,phase]));
    const rows=(references.length?references:phases.map(phase=>phase.id)).map(id=>{
        const phase=byId.get(id);
        return phase?`<article class="phase-card"><div class="inline"><b>${esc(phase.run.projectName)}</b>${nodeTag(phase.run.nodeId,true)}<span class="spacer"></span>${status(stage(phase.run))}</div><code class="break">${esc(phase.run.root)}</code><p>${esc(phase.summary || phase.run.reason || '暂无结果总结')}</p><div class="inline"><span class="small muted">${esc(phase.run.branch || '')} · ${esc(phase.run.baseSha?.slice(0,12) || '')}</span><span class="spacer"></span>${btn('查看执行与改动','open-run',`data-id="${esc(phase.id)}"`,'small')}</div></article>`
          :`<div class="phase-card"><code>${esc(id)}</code>${btn('查看执行与改动','open-run',`data-id="${esc(id)}"`,'small')}</div>`;
    }).join('');
    return `<section class="phase-list"><h3>工作区与执行阶段</h3>${rows}</section>`;
}

function phasePagination(detail:RunDetail):string {
    const page=detail.phasePage;
    if(!page||page.total<=page.limit&&!page.offset)return '';
    const pageNumber=Math.floor(page.offset/page.limit)+1,totalPages=Math.max(1,Math.ceil(page.total/page.limit));
    return `<div class="panel-foot phase-pagination" aria-label="执行阶段分页"><span>第 ${pageNumber} / ${totalPages} 页 · ${detail.taskComplete?'共':'已知'} ${page.total} 个阶段<br><span class="small muted">${page.complete?'本页记录已读取':'本页记录仍在读取'} · 当前工作区优先</span></span><span class="spacer"></span>${btn('上一页','phase-page',`data-cursor="${esc(page.previousCursor??'')}" ${page.previousCursor?'':'disabled'}`,'small')}${btn('下一页','phase-page',`data-cursor="${esc(page.nextCursor??'')}" ${page.nextCursor?'':'disabled'}`,'small')}</div>`;
}

function tasksPage() {
    const path = runPath(), d = data<RunPage>(path), projection = taskPageProjection(d), review = route.view === 'changes', sel = route.p.run, counts = taskCountsComplete(d) ? d!.counts : {};
    const chosen = projection.items.filter(r => selectedRuns.has(r.id)), blocked = chosen.filter(r => changeCaptureBlockReason(data<RunDetail>(detailPath(r.id))?.changeCaptures)), eligible = chosen.filter(r => r.actions.review && !blocked.includes(r));
    const states: Array<[string,string,number?]> = [['', '全部', counts.all], ...taskStages.map(([key,label]):[string,string,number?]=>[key,label,counts[key]])];
    const bulk = selectedRuns.size ? `<div class="bulkbar"><span>${selectedRuns.size} 项已选</span>${blocked.length ? `<span class="amber">${blocked.length} 项文件证据待确认</span>` : ''}<span class="spacer"></span>${btn('验收' + (eligible.length ? ' ' + eligible.length : ''), 'bulk-accept', !eligible.length || !canWrite() ? 'disabled' : '', 'small')}${btn('驳回', 'bulk-reject', !eligible.length || !canWrite() ? 'disabled' : '', 'small')}${ib('copy', 'bulk-copy', '复制所选任务引用')}${ib('close', 'clear-selection', '取消选择')}</div>` : '';
    const scopeValue = route.p.overviewGroup === 'current' ? 'current' : route.p.overviewGroup === 'olderOpen' ? 'older' : route.p.requestState === 'active' ? 'open' : route.p.requestState === 'closed' ? 'ended' : '';
    const lifecycleStates: Array<[string,string,number?]> = [['current','当前任务',scopeValue === 'current' ? projection.total : undefined],['','全部任务',counts.scopeAll],['older','较早未关闭'],['open','未关闭',counts.scopeOpen],['ended','已结束',counts.scopeClosed]];
    const lifecycleControl = `<select class="select queue-state" data-task-scope="true" aria-label="任务范围">${lifecycleStates.map(([v,t,n]) => opt(v,t + (taskCountsComplete(d) && n != null ? ' · ' + n : ''),scopeValue)).join('')}</select>`;
    const stateControls = sel ? lifecycleControl + `<select class="select queue-state" data-param="status" aria-label="任务状态">${states.map(([v, t, n]) => opt(v, t + (n == null ? '' : ' · ' + n), route.p.status || '')).join('')}</select>` : taskScopeTabs(d, projection) + `<select class="select" data-param="status" aria-label="具体任务状态">${states.map(([v,t,n]) => opt(v,t + (n == null ? '' : ' · ' + n),route.p.status || '')).join('')}</select>`;
    const filters = `<div class="task-filters">${stateControls}<div class="toolbar list-search">${searchField(route.p.q, '搜索任务…')}${sel ? ib('filter', 'toggle-filters', '筛选任务', `aria-expanded="${route.p.filters === '1'}"`, route.p.filters === '1' ? 'active' : '') : ''}</div><div class="toolbar extended-filters ${sel && route.p.filters !== '1' ? 'hidden' : ''}">${scopes()}${rangeSelect(route.p.days ?? '0')}<select class="select" aria-label="任务排序" data-param="sort">${[['newest', '最近创建'], ['oldest', '最早创建'], ['tokens', '用量最高'], ['duration', '记录跨度最长']].map(([v, t]) => opt(v, t, route.p.sort || 'newest')).join('')}</select></div>${route.p.overviewGroup ? `<div class="filter-chip">${route.p.overviewGroup === 'current' ? '当前任务' : '较早未关闭'} ${ib('close', 'clear-overview-group', '清除任务分组')}</div>` : ''}${route.p.finishedDay ? `<div class="filter-chip">完成于 ${esc(route.p.finishedDay)} ${ib('close', 'clear-finished', '清除完成日期')}</div>` : ''}${route.p.attention ? `<div class="filter-chip">待办事项 ${ib('close', 'clear-attention', '清除待办筛选')}</div>` : ''}${route.p.usageDate || route.p.usageDays ? `<div class="filter-chip">用量发生范围：${esc(route.p.usageDate || ('近 ' + route.p.usageDays + ' 天'))}${ib('close','clear-usage-range','清除用量发生范围')}</div>` : ''}${route.p.date ? `<div class="filter-chip">${esc(route.p.date)} ${ib('close', 'clear-date', '清除日期筛选')}</div>` : ''}</div>`;
    const emptyTitle = projection.grouped ? projection.complete ? '暂无当前任务' : '本页已读记录中没有匹配任务' : d?.complete ? '没有匹配任务' : '已读取来源中没有匹配任务';
    const emptyDetail = projection.grouped ? projection.complete ? '' : '完整数量待更新，可以继续翻页或重新读取。' : d?.complete ? '' : '部分节点尚未确认，完整结果仍待核对。';
    let list = !d ? resourceState(path) : !projection.items.length ? `<div class="panel">${empty(emptyTitle, emptyDetail, btn('清除筛选', 'reset-filters'))}${pagination(d, projection.countLabel)}</div>` : sortLayout === 'timeline' && !sel ? timelineView({...d, items:projection.items}, projection.countLabel) : `<div class="panel task-list-panel"><div class="table-wrap"><table class="data-table run-table"><colgroup><col style="width:34px"><col><col style="width:140px"><col style="width:58px"><col style="width:105px"><col style="width:86px"><col style="width:90px"><col style="width:94px"><col style="width:32px"></colgroup><thead><tr><th><label class="check-label"><input type="checkbox" data-select-all="runs" aria-label="选择本页全部任务" ${projection.items.every(r => selectedRuns.has(r.id)) ? 'checked' : ''}></label></th><th>任务 / 项目</th><th>状态</th><th>节点</th><th>改动</th><th class="align-right">上次活动</th><th class="align-right">Token</th><th class="align-right">创建于</th><th></th></tr></thead><tbody>${projection.items.map(taskRow).join('')}</tbody></table></div>${pagination(d, projection.countLabel)}</div>`;
    if (projection.moved.length) list += panel('已移出当前的任务', `<p class="panel-body small muted">这些已读取的任务已转入较早未关闭，仍可打开任务记录。</p><div class="overview-task-list" role="list" aria-label="已移出当前的任务">${projection.moved.map(run => overviewTaskRow(run,'older')).join('')}</div>`, badge(String(projection.moved.length)), btn('查看全部较早未关闭任务','older-task-queue','','small ghost'), 'task-aged-records');
    const actions = sel ? ib('download', 'export-runs', '导出本页') : segmented([['list', icon('tasks', 14)], ['timeline', icon('activity', 14)]], sortLayout, 'layout') + btn(icon('download', 14) + '导出本页', 'export-runs', projection.items.length ? '' : 'disabled');
    return `<div class="split ${sel ? 'has-detail' : 'no-detail'} ${review ? 'review-mode' : ''} ${route.p.focus === '1' ? 'detail-focus' : ''}"><section class="list-pane" aria-label="任务列表"><div class="page">${pageHead(review ? '改动审查' : '任务', review ? '选择待验收结果，或切换查看所有文件改动。' : '', actions)}${review ? segmented([['review','待验收'],['all','全部改动']],route.p.reviewMode || 'review','review-mode') : ''}${filters}${bulk}${staleNotice(path)}${list}</div></section>${sel ? '<button class="inspector-mask" data-action="close-inspector" aria-label="关闭详情"></button>' + inspector() : ''}</div>`;
}
function timelineView(d: RunPage, countLabel?: string) {
    const now = Date.now(), days = Math.max(1, Math.min(30, Number(route.p.days) || 1)), span = days * 864e5, start = now - span, pct = (time: number) => clamp((time - start) / span * 100, 0, 100);
    const end = (run: Run) => { const activity=activityForRun(run);return run.finishedAt ?? (activity.state === 'executing' ? run.executionObservedAt : activity.lastProgressAt) ?? run.startedAt; };
    const tracks = (fleet()?.nodes || []).map(n => {
        const rows = d.items.filter(r => (r.nodeIds || [r.nodeId]).includes(n.id) && r.startedAt < now && end(r) >= start).sort((a,b) => a.startedAt - b.startedAt);
        const ends: number[] = [], placed = rows.map(r => {
            const left = pct(r.startedAt), right = pct(end(r)), width = Math.min(100 - left, Math.max(1, right - left));
            let lane = ends.findIndex(value => value <= left);
            if (lane === -1) { lane=ends.length; ends.push(0); }
            ends[lane]=left+width+.4;
            return {r,left,width,lane};
        });
        return `<div class="timeline-track"><div class="timeline-track-name">${nodeTag(n.id)}</div><div class="timeline-track-body" style="height:${Math.max(1,ends.length)*28+12}px">${placed.map(({r,left,width,lane})=>`<button class="timeline-run ${taskActivityTone(r)}" style="left:${left}%;width:${width}%;top:${lane*28+6}px" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)} · ${esc(activityForRun(r).label)} · 记录截至 ${esc(fullTime(end(r)))}">${esc(r.title)}</button>`).join('')}</div></div>`;
    }).join('');
    return `<div class="panel"><div class="panel-head"><h3>任务记录时间分布</h3><span class="meta">近 ${days} 天 · 本页 ${d.items.length} 项</span></div><p class="panel-body small muted">条带从任务创建画至结束或最近活动；各节点展示同一任务的已知记录范围。</p><div class="timeline-board">${tracks}</div><div class="chart-axis"><span>${day(start)} ${tm(start)}</span><span>${day(now)} ${tm(now)}</span></div>${pagination(d, countLabel)}</div>`;
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
function detailEmpty(detail: RunDetail, confirmedTitle: string, records: string) {
    return !detailRecordsComplete(detail) ? empty('本页详情尚未完整确认', `暂未显示${records}；部分记录仍待确认。`)
      : empty(detail.phasePage&&detail.phasePage.total>detail.phasePage.references.length?'本页'+confirmedTitle:confirmedTitle);
}
function inspector() {
    const id = route.p.run, path = detailPath(), d = data<RunDetail>(path), tab = route.p.tab || (route.view === 'changes' ? 'diff' : 'summary');
    if (!d) {
        const known = id ? findLoadedRun(id) : undefined;
        return `<aside class="inspector" id="inspector" aria-label="任务详情" tabindex="-1"><header class="session-card-head"><div class="session-heading"><h2>${esc(known ? known.title : '任务详情')}</h2>${known ? `<div class="session-meta">${taskScope(known)}${workspaceSummary(known)}</div>` : ''}</div><span class="spacer"></span>${ib('refresh', 'refresh', '刷新任务详情')}${ib('close', 'close-inspector', '关闭详情', 'id="inspector-close"')}</header><div class="inspector-body">${resourceState(path)}<p class="detail-read-help">任务列表仍可使用，可选择其他任务或稍后重试此详情。</p></div></aside>`;
    }
    const r = d.run;
    const retained=retainedDetailView(d,(CACHE.get(path) as CacheEntry<RunDetail>|undefined)?.retained),records=retained.detail;
    const historical=(key:DetailRecordKey)=>retained.historical.includes(key);
    const recordLabels:Record<DetailRecordKey,string>={files:'文件改动',commands:'命令',agents:'代理',evidence:'执行结果',timeline:'活动记录',instructions:'项目指令',skills:'技能'};
    const historyNotice=retained.time?`<div class="resource-update detail-history-note" role="status">${retained.historical.map(key=>recordLabels[key]).join('、')}显示上次读取的记录（${esc(fullTime(retained.time))}）；这些记录的当前状态尚未确认。</div>`:'';
    const captureBlocked = changeCaptureBlockReason(d.changeCaptures), captureAttrs = captureBlocked ? `disabled title="${esc(captureBlocked)}"` : '';
    const detailPendingNotice=pendingDetailRead(d)&&!captureBlocked&&!d.sources?.some(source=>['loading','refreshing'].includes(source.state))
        ? '<div class="resource-update pending" role="status">部分详情状态尚未确认；当前展示已读取的记录，可稍后刷新。</div>' : '';
    const shownCaptures = captureBlocked ? d.changeCaptures : undefined, runWarnings = dedupeCaptureWarnings(r.warnings || [], shownCaptures);
    const state = stage(r), running = d.commands.find(c => commandStatus(c, r) === 'running'), latest = d.commands.filter(c => !c.supersededBy).at(-1), failed = !['completed','ended','cancelled','handed_off'].includes(r.executionStatus) && latest && commandStatus(latest, r) === 'failed' ? latest : undefined, live = running || failed;
    const head = `<header class="session-card-head"><span class="session-symbol">${icon('changes', 17)}<i class="session-dot ${taskActivityTone(r) || 'ended'}"></i></span><div class="session-heading"><h2 title="${esc(r.title)}">${esc(r.title)}</h2><div class="session-meta">${nodeTag(r.nodeId, true)}<span class="project-name">${esc(r.projectName)}</span><span class="branch-meta">${icon('changes', 12)}<code title="${esc(r.branch)}">${esc(r.branch)}</code></span></div></div><div class="session-stats">${r.diff ? diffStat(r) : ''}<span class="card-elapsed">${taskActivityTime(r)}</span></div>${ib('refresh', 'refresh', '刷新任务详情')}${ib('external', 'focus-detail', route.p.focus === '1' ? '恢复分栏' : '展开详情', '', 'desktop-only')}${ib('close', 'close-inspector', '关闭详情（Esc）', 'id="inspector-close"')}</header>`;
    const strip = live ? `<button class="session-live ${running ? '' : 'failed'}" data-action="live-command" data-id="${esc(live.id)}">${running ? '<span class="spinner"></span>' : icon('failed', 14)}<span class="agent-label">${esc(live.agent)}</span><code>${esc(live.command)}</code><span class="live-meta">${running ? '运行中' : live.exit == null ? '最近执行失败' : '最近退出码 ' + live.exit}</span>${icon('chevron', 12)}</button>` : '';
    const confirmedCount = (count: number) => detailRecordsComplete(d) ? count : undefined;
    const tabsHTML = tabs([['summary', icon('file', 14) + '概要'], ['diff', icon('changes', 14) + '改动', confirmedCount(d.files.length)], ['commands', icon('terminal', 14) + '命令', confirmedCount(d.commands.length)], ['agents', icon('bot', 14) + '代理', confirmedCount(d.agents.length)], ['context', icon('workspaces', 14) + '上下文']], tab, 'detail-tab');
    let body = '';
    if (tab === 'summary') {
        body = `<section class="detail-section result-section"><div class="result-heading">${runBadges(r)}<span class="spacer"></span><span class="small muted">创建于 ${smallTime(r.startedAt)}</span></div>${resultExplanation(d.summary,r.reason,state)}${r.resultStatus === 'handed_off' ? `<p>${badge('请求已交接')} ${r.executionStatus === 'running' ? '后台执行仍在继续' : esc(stages[state] || state)}</p>` : ''}${phaseCards(d)}${r.reviewNote ? `<p class="review-note">验收记录：${esc(r.reviewNote)}</p>` : ''}</section>`;
        if (records.evidence.length)
            body += `<section class="detail-section"><h3>执行结果</h3><div class="evidence-list">${records.evidence.map(e => `<div class="evidence-row"><span class="${e.ok === true ? 'green' : e.ok === false ? 'red' : 'muted'}">${icon(e.ok === true ? 'accepted' : e.ok === false ? 'failed' : 'queued', 15)}</span><b>${esc(e.name)}</b><span>${esc(e.detail)}</span>${e.time ? smallTime(e.time) : ''}<div class="evidence-actions">${ib('copy','copy','复制证据引用',`data-text="${esc(e.detail)}"`)}${btn('搜索相关活动','evidence-events',`data-reference="${esc(e.detail)}"`,'small')}</div></div>`).join('')}</div></section>`;
        if (r.usage?.quality !== 'not_used')
            body += `<section class="detail-section"><div class="section-line"><h3>Token 用量</h3>${badge(QUALITY[r.usage?.quality] || '未知', r.usage?.quality === 'partial' ? 'warn' : '')}</div><dl class="usage-mini">${([['总量', r.usage?.total], ['输入', r.usage?.input], ['输出', r.usage?.output]] as Array<[string, number | null | undefined]>).map(([k, v]) => `<div><dt>${k}</dt><dd>${v == null ? '未知' : compact(v)}</dd></div>`).join('')}</dl><div class="usage-breakdown"><span>输入含缓存 <b>${compact(r.usage?.cached)}</b></span><span>输出含推理 <b>${compact(r.usage?.reasoning)}</b></span></div></section>`;
        if (records.timeline.length)
            body += `<section class="detail-section"><h3>活动记录</h3><div class="timeline">${records.timeline.map(e => `<div class="timeline-entry"><time title="${fullTime(e.time)}">${tm(e.time)}</time><span class="timeline-line"><i class="dot ${e.tone}"></i></span><span>${esc(e.text)}</span></div>`).join('')}</div></section>`;
    }
    else if (tab === 'diff')
        body = diffView(records);
    else if (tab === 'commands')
        body = records.commands.length ? `<div class="command-list">${records.commands.map(c => { const cs = commandStatus(c, r), output=commandOutputs.get('runs/' + enc(id) + '/commands/' + enc(c.id)), outputAction=output?.hasMore?'继续读取输出':commandOutputNeedsRetry(output)?'重新读取输出':null; return `<details class="command command-card" data-key="${esc(c.id)}" id="command-${esc(c.id)}"><summary><span class="command-chevron">${icon('chevron', 12)}</span><span class="${historical('commands') ? 'muted' : cs === 'done' ? 'green' : cs === 'failed' ? 'red' : cs === 'running' ? 'accent' : 'muted'}">${cs === 'running' && !historical('commands') ? '<span class="spinner"></span>' : icon(cs === 'done' ? 'accepted' : cs, 14)}</span><code title="${esc(c.command)}">${esc(c.command)}</code><span class="agent-label">${esc(c.agent)}</span><span class="command-result">${historical('commands')?'上次记录：':''}${c.exit == null ? esc(stages[cs] || '等待回执') : 'exit ' + c.exit}</span></summary><pre>${esc(commandOutputText(c, r.id))}</pre><div class="command-footer"><span>${c.ms == null ? '' : duration(c.ms)}</span>${c.supersededBy ? badge('已由后续执行取代') + ib('copy','copy','复制接续执行引用',`data-text="${esc(c.supersededBy)}"`) : ''}${outputAction ? btn(output?.pending?'正在读取…':outputAction, 'more-command-output', 'data-id="' + esc(c.id) + '"' + (output?.pending?' disabled':''), 'small') : ''}${ib('copy', 'copy', '复制命令', `data-text="${esc(c.command)}"`)}</div></details>`; }).join('')}</div>` : detailEmpty(d,'暂无命令','命令记录');
    else if (tab === 'agents')
        body = records.agents.length ? `<div class="agent-list">${records.agents.map(a => `<article class="agent-card"><span class="agent-avatar">${icon('bot', 17)}</span><div class="agent-main"><div class="section-line"><h3>${esc(a.name)}</h3>${historical('agents')?badge('上次记录：'+(stages[a.status]||a.status)):status(a.status)}</div><p>${esc(a.role)}</p><div class="small muted">${a.tokens == null ? '用量未上报' : compact(a.tokens) + ' Token'}</div></div></article>`).join('')}</div>` : detailEmpty(d,'暂无代理','代理记录');
    else
        body = `${phaseCards(d)}<section class="detail-section"><h3>${r.phaseRefs && r.phaseRefs.length > 1 ? '任务汇总与主记录' : '工作区'}</h3><dl class="context-table">${[['项目', r.projectName], ['路径', r.root], ['节点', node(r.nodeId)?.name || r.nodeId], ['分支', r.branch], ['基线', r.baseSha], ['执行 ID', r.id], ['来源', r.origin], ['创建于', fullTime(r.startedAt)], ['结束', r.finishedAt ? fullTime(r.finishedAt) : '—'], ['执行状态', r.executionStatus], ['验收状态', r.acceptanceStatus]].map(([k, v]) => `<div><dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('')}</dl></section><section class="detail-section"><h3>项目指令</h3><dl class="context-table">${(records.instructions || []).map(item => '<div><dt>' + esc(item.status === 'loaded' ? '已读取' : '可读取') + '</dt><dd>' + esc(item.path) + '</dd></div>').join('') || '<div class="muted">' + (!detailRecordsComplete(d) ? '项目指令尚未完整读取' : '未发现项目指令') + '</div>'}</dl><h3 class="section-gap">技能</h3><dl class="context-table">${(records.skills || []).map(item => '<div><dt>' + esc(item.state === 'read' ? '已使用' : '可使用') + '</dt><dd>' + esc(item.name) + '</dd></div>').join('') || '<div class="muted">' + (!detailRecordsComplete(d) ? '技能记录尚未完整读取' : '未发现技能') + '</div>'}</dl></section>`;
    const footer = `<span class="card-footer-state">${runBadges(r)}<span class="revision" title="回执版本">r${r.revision}</span></span><span class="spacer"></span>${['running', 'queued', 'stopping'].includes(state) ? btn(icon('stopping', 13) + (state === 'queued' ? '取消排队' : '中断'), 'run-control', `data-id="${esc(id)}" data-value="interrupt" ${r.actions?.interrupt ? writeAttrs() : 'disabled title="当前节点没有可控制的后台执行句柄"'}`, 'danger small') : state === 'interrupted' ? btn(icon('running', 13) + '恢复', 'run-control', `data-id="${esc(id)}" data-value="resume" ${r.actions?.resume ? writeAttrs() : 'disabled title="需要从原工作入口继续"'}`, 'primary small') : ''}${r.actions.complete ? btn('结束任务', 'finish-task', `data-id="${esc(id)}" ${writeAttrs()}`, 'primary small') : ''}${r.actions.review ? btn('驳回', 'single-reject', `data-id="${esc(id)}" ${captureAttrs || writeAttrs()}`, 'small') + btn(icon('check', 13) + '验收', 'single-accept', `data-id="${esc(id)}" ${captureAttrs || writeAttrs()}`, 'primary small') : ''}${d.files.length && r.actions?.patch !== false ? btn(icon('download', 13) + '补丁', 'patch', `data-id="${esc(id)}" ${captureAttrs}`, 'small') : ''}${d.files.length && r.actions?.revert && !['running', 'queued', 'stopping'].includes(state) ? ib('undo', 'revert', '还原文件', `data-id="${esc(id)}" ${captureAttrs || writeAttrs('revert')}`) : ''}`;
    return `<aside class="inspector" id="inspector" aria-label="执行详情" tabindex="-1"><button class="resize-handle" role="separator" aria-label="调整列表宽度" aria-orientation="vertical" aria-valuemin="270" aria-valuemax="520" aria-valuenow="${pref.listWidth}" title="拖动调整列表宽度"></button>${head}${strip}${tabsHTML}${phasePagination(d)}<div class="inspector-body" data-key="body-${esc(id)}-${tab}">${staleNotice(path, shownCaptures)}${runWarnings.length ? `<div class="notice warn">${runWarnings.map(readWarningMessage).map(esc).join('<br>')}</div>` : ''}${tab !== 'diff' && captureBlocked ? changeCaptureNotice(d.changeCaptures) : ''}${detailPendingNotice}${historyNotice}${body}</div><footer class="inspector-footer">${footer}</footer></aside>`;
}

const highlightCache = new Map<string, string>(), diffOpen = new Map<string, Set<string>>();
const commandReader = new CommandOutputs((path, signal) => API.get<import('./command-output.js').CommandOutputPage>(path, signal), schedulePaint);
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
    const captureNotice = changeCaptureNotice(d.changeCaptures);
    if(!d.files.length&&d.phasePage?.references.length
      &&!d.phasePage.references.some(reference=>d.run.currentPhaseRefs?.includes(reference)))
        return captureNotice+empty('本页为历史执行','可在阶段卡片查看该阶段改动。')+phaseCards(d);
    if (!d.files.length)
        return captureNotice + (changeCaptureBlockReason(d.changeCaptures) ? '' : detailEmpty(d,'暂无已记录的文件改动','文件改动'));
    const files = visibleFiles(d), opened = openFiles(d);
    const toolbar = `<div class="diff-toolbar">${searchField(fileSearch, '查找文件…', 'files')}<span class="spacer"></span><label class="switch"><input type="checkbox" data-diff-wrap ${pref.wrap ? 'checked' : ''} aria-label="代码自动换行">换行</label><span class="desktop-only">${segmented([['unified', '统一'], ['split', '并排']], diffMode, 'diff-mode')}</span>${ib('panel', 'files-toggle-all', '展开或收起文件', `aria-label="展开或收起文件"`)}</div>`;
    return `<div class="session-diff">${captureNotice}${toolbar}${files.map(f => { const on = opened.has(f.id), parts = f.path.split('/'), name = parts.pop(), dir = parts.join('/'); return `<section class="file-section ${on ? 'expanded' : ''}" data-key="file-${esc(d.run.id)}-${esc(f.id)}"><header class="file-header"><button class="file-toggle" data-action="toggle-file" data-id="${esc(f.id)}" aria-expanded="${on}" title="${esc(f.path)}">${icon(on ? 'down' : 'chevron', 13)}<span class="file-status ${f.kind}">${f.kind}</span><span class="file-path">${dir ? `<span>${esc(dir)}/</span>` : ''}<b>${esc(name)}</b>${f.source ? `<small class="file-source">${esc(f.source.nodeId)} · ${esc(f.source.projectName)} · ${esc(f.source.root)}</small>` : ''}</span><span class="diff-summary"><span class="green">+${fmt(f.add)}</span><span class="red">−${fmt(f.del)}</span></span></button>${ib('copy', 'copy-path', '复制文件路径', `data-text="${esc(f.source ? f.source.root.replace(/[\\/]$/, '') + '/' + f.path : f.path)}"`, 'file-copy')}</header>${on ? diffFile(d, f) : ''}</section>`; }).join('') || empty('没有匹配文件')}</div>`;
}
function machinesPage() {
    const f = fleet();
    if (!f)
        return `<div class="page">${pageHead('机器')}${resourceState('fleet/status')}</div>`;
    const q = (route.p.q || '').toLowerCase(), nodes = f.nodes.filter(n => [n.name, n.id, n.role].join(' ').toLowerCase().includes(q)), candidates = f.nodes.filter(n => n.capabilities.egress && n.priority > 0).sort((a, b) => b.priority - a.priority);
    const discoveryNodes = f.nodes.filter(n => n.capabilities.discovery);
    const discoveryReady = discoveryNodes.filter(n => n.online && n.discovery?.ready).length;
    const observation = fleetObservation(), current = observation.current;
    const discovery = panel('发现端', `<div class="panel-body"><div class="inline">${badge(`${current ? '' : '上次确认 '}${discoveryReady} / ${discoveryNodes.length} 就绪`, current && discoveryReady ? 'good' : 'warn')}<span class="spacer"></span></div><div class="discovery-grid">${discoveryNodes.map(n => {
      const component=n.components.find(item=>item.id==='discovery');
      const ready=n.online && n.discovery?.ready;
      return `<div class="discovery-node" data-key="discovery-${esc(n.id)}"><div class="inline">${nodeTag(n.id,true)}<span class="spacer"></span>${badge((current ? '' : '上次确认') + (!n.online ? '离线' : ready ? '就绪' : component?.state==='backoff' ? '等待重启' : '正在连接'), current && ready ? 'good' : 'warn')}</div><div class="small muted">版本 ${esc(n.version ?? '未上报')}${component?.pid ? ` · PID ${component.pid}` : ''}</div>${n.discovery?.lastError ? `<div class="small amber">${esc(n.discovery.lastError)}</div>` : ''}</div>`;
    }).join('') || empty('尚未启用发现端')}</div></div>`);
    const egress = panel('连接与出网链路', `<div class="panel-body route-grid"><div><p class="small muted" style="margin-bottom:12px">MCP 入口连接</p><div class="endpoint">${nodeTag(f.ingressNodeId, true)}<code>${esc(f.mcpUrl || f.ingressLabel || (f.ingressNodeId ? '托管 MCP 隧道' : '尚未配置 MCP 入口'))}</code>${ib('copy', 'copy', '复制 MCP 地址', `data-text="${esc(f.mcpUrl || '')}" ${f.mcpUrl ? '' : 'disabled'}`)}</div></div><div><p class="small muted" style="margin-bottom:12px">出网候选 · 按优先级排序</p><div class="route-candidates">${candidates.map(n => `<div class="route-candidate ${current && n.id === f.gatewayId ? 'current' : ''}"><div class="inline">${nodeTag(n.id, true)}<span class="small muted">P${n.priority}</span></div>${n.id === f.gatewayId ? badge(current ? '当前出网' : '上次出网', current ? 'good' : 'warn') : !current ? badge('当前状态待确认', 'warn') : !n.online ? badge('离线', 'bad') : n.egress?.healthy === false ? badge('探测失败', 'warn') : badge('待命')}<small class="muted">${current ? '' : '上次探测：'}${n.egress?.region ? esc(n.egress.region) + ' · ' : ''}${n.egress?.latency != null ? Math.round(n.egress.latency) + ' ms' : n.egress?.healthy ? '探测正常' : '未探测'}</small></div>`).join('')}</div></div></div>`, '', '');
    let inventory = machineLayout === 'table' ? `<div class="panel table-wrap"><table class="data-table matrix"><thead><tr><th style="width:25%">机器</th><th>状态</th><th>CPU</th><th>内存</th><th>GPU</th><th>延迟</th><th>版本</th><th></th></tr></thead><tbody>${nodes.map(n => `<tr data-key="node-table-${esc(n.id)}"><td><button class="run-title" data-action="node" data-id="${esc(n.id)}">${nodeTag(n.id)}</button></td><td>${machineStatus(n)}${n.settingsState?.error ? badge('配置应用失败','warn') : n.settingsState?.pending ? badge('配置待应用','warn') : ''}</td><td class="num">${n.online && n.cpu != null ? Math.round(n.cpu) + '%' : '—'}</td><td class="num">${n.online && percent(n.memoryUsed,n.memoryTotal) !== null ? Math.round(percent(n.memoryUsed,n.memoryTotal)!) + '%' : '—'}</td><td>${n.gpuSampled === false ? '未取得' : n.gpus.length || '无'}</td><td class="num">${n.online && n.latency != null ? Math.round(n.latency) + ' ms' : '—'}</td><td class="mono">${esc(n.version ?? '未上报')}</td><td>${ib('chevron', 'node', '查看节点', `data-id="${esc(n.id)}"`)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="node-grid">${nodes.map(nodeCard).join('')}</div>`;
    if (!nodes.length)
        inventory = `<div class="panel">${empty('没有匹配的机器', '', btn('清除搜索', 'reset-filters'))}</div>`;
    return `<div class="page">${pageHead('机器', fleetOnlineLabel() + (current ? '' : ` · 当前状态待确认${observation.confirmedAt ? ' · 最后确认 ' + esc(fullTime(observation.confirmedAt)) : ''}`), btn(icon('settings', 14) + '统一出口配置', 'egress-settings'))}${staleNotice('fleet/status')}${discovery}${egress}<div class="toolbar section-gap">${searchField(route.p.q, '搜索机器、能力或 ID…')}<span class="spacer"></span>${segmented([['cards', icon('overview', 14) + ' 卡片'], ['table', icon('tasks', 14) + ' 对比表']], machineLayout, 'machine-layout')}</div>${inventory}</div>`;
}
function nodeCard(n: Machine) {
    const tasks = overview()?.active || [];
    const stateOnNode = (r: Run) => r.nodeStates?.[n.id] ?? (r.nodeId === n.id ? r.executionStatus : null);
    const active = tasks.filter(r => ['running','queued','stopping'].includes(stateOnNode(r) || ''));
    const waiting = tasks.filter(r => ['waiting','stalled','finalizing'].includes(stateOnNode(r) || ''));
    const totals = overview()?.nodeCounts?.[n.id];
    const activeCount = totals?.running != null && totals?.queued != null ? String(totals.running + totals.queued) : '至少 ' + active.length;
    const waitingCount = totals?.waiting != null ? String(totals.waiting) : '至少 ' + waiting.length;
    const disk = [...(n.disks || [])].sort((a,b) => b.used/b.total-a.used/a.total)[0];
    const resources: Array<[string, number | null | undefined, number | null | undefined, string]> = [
      ['CPU', n.cpu, 100, '%'],
      ['内存', n.memoryUsed, n.memoryTotal, 'GiB'],
      [disk ? '磁盘 ' + disk.mount : '磁盘', disk?.used, disk?.total, 'GiB'],
    ];
    const resourceRows = resources.map(([label, value, total, unit]) => {
      const hasValue = n.online && value != null && total != null && total > 0 && Number.isFinite(value) && Number.isFinite(total);
      const percent = hasValue ? value / total * 100 : null;
      const capacity = unit === '%'
        ? '采样 ' + tm(fleetObservation().confirmedAt)
        : hasValue ? fmt(value) + ' / ' + fmt(total) + ' ' + unit : n.online ? '尚未采集' : '节点离线';
      return `<div><span class="resource-name">${esc(label)}</span><span class="resource-value">${hasValue ? (unit === '%' ? fmt(value) : Math.round(percent!)) + '%' : '—'}</span>${meter(percent, unit !== '%' && percent !== null && percent > 85 ? 'amber' : '')}<small class="muted" style="display:block;margin-top:6px">${capacity}</small></div>`;
    }).join('');
    const gpuRows = n.gpuSampled === false
      ? '<div class="small muted" style="padding:12px 0">GPU 数据未取得</div>'
      : n.gpus.length
      ? `<div class="gpu-labels"><span>GPU</span><span>负载</span><span>显存 / GiB</span><span>温度</span></div>${n.gpus.map(g => `<div class="gpu-line"><span class="ellipsis" title="${esc(g.name)}">${esc(g.name)}</span><span>${n.online ? Math.round(g.util) + '%' : '—'}</span><span>${n.online ? g.used.toFixed(1) + ' / ' + g.total.toFixed(1) : '—'}</span><span class="${g.temp != null && g.temp >= 78 ? 'amber' : ''}">${n.online && g.temp != null ? Math.round(g.temp) + '°' : '—'}</span></div>`).join('')}`
      : '<div class="small muted" style="padding:12px 0">无 GPU</div>';
    const running = active.slice(0, 1).map(r => `<div class="panel-foot"><span class="accent">${icon('running', 13)}</span><button class="run-title ellipsis small" data-action="open-run" data-id="${esc(r.id)}">${esc(r.title)}</button></div>`).join('');
    return `<article class="panel node-card" data-key="node-${esc(n.id)}"><header class="node-card-head"><span class="node-mark big ${n.online ? '' : 'offline'}">${esc(n.short)}</span><div style="min-width:0"><button class="run-title" data-action="node" data-id="${esc(n.id)}"><h3>${esc(n.name)}</h3></button><p>${esc(n.role)}</p></div><span class="spacer"></span>${machineStatus(n)}${n.settingsState?.error ? badge('配置应用失败','warn') : n.settingsState?.pending ? badge('配置待应用','warn') : ''}${ib('more', 'node', '节点详情与设置', `data-id="${esc(n.id)}"`)}</header>${!n.online ? `<div class="notice warn" style="margin:12px">${icon('alert', 15)}最后在线 ${esc(fullTime(n.lastSeen))}</div>` : ''}<div class="node-resources">${resourceRows}</div><div class="gpu-list">${gpuRows}</div><div class="panel-foot"><span class="${active.length ? 'accent' : 'muted'}">${activeCount} 项执行 / 排队 · ${waitingCount} 项暂无后台执行${totals?.complete ? '' : ' · 覆盖待确认'}</span><span class="spacer"></span><span>${n.online ? (n.latency != null ? Math.round(n.latency) : '—') + ' ms' : '最后心跳 ' + ago(n.lastSeen)}</span><span class="mono">v${esc(n.version ?? '未上报')}</span></div>${running}</article>`;
}
function sessionsPage() {
    const ps = projects().filter(p => !sessionSearch || [p.name, p.path, p.nodeId].join(' ').toLowerCase().includes(sessionSearch.toLowerCase()));
    const p = projects().find(p => p.id === route.p.project), key = p ? 'projects/' + enc(p.id) + '/sessions' : '', d = p ? data<Sessions>(key) : null;
    const left = `<aside class="project-list" aria-label="项目列表"><div class="project-list-head"><h3>项目 <span class="count">${projects().length}</span></h3>${searchField(sessionSearch, '查找项目…', 'session-project')}</div><button class="project-item ${!p ? 'active' : ''}" data-action="global-sessions">${icon('sessions',16)}<b>全部会话</b></button>${ps.map(x => `<button class="project-item ${p?.id === x.id ? 'active' : ''}" data-action="session-project" data-id="${esc(x.id)}" data-key="project-${esc(x.id)}"><span class="project-item-icon">${icon('workspaces', 16)}</span><span><b class="ellipsis">${esc(x.name)}</b><span class="project-item-sub">${nodeTag(x.nodeId, true)}<span>${x.sessionCount ?? 0} 个会话</span>${x.active ? `<span class="accent">${x.active} 项运行</span>` : ''}${x.review ? `<span>${x.review} 待验收</span>` : ''}</span></span>${icon('chevron', 12)}</button>`).join('') || empty('没有匹配项目')}</aside>`;
    if (!p) {
        const path = conversationPath(), global = data<ListResponse<Sessions['conversations'][number]>>(path);
        const body = route.p.project ? empty('项目不存在', '', btn('查看全部会话','global-sessions')) : !global ? resourceState(path)
            : global.items.length ? conversationCards(global.items) : empty(global.complete ? '没有匹配会话' : '已读取范围内没有匹配会话', global.complete ? '可按会话标题或 ID 搜索，或从左侧选择项目。' : '仍有节点数据待确认。');
        return `<div class="session-layout">${left}<section class="session-content"><div class="page">${pageHead('全部会话','按聊天标题、会话 ID 查找；项目用于缩小范围。')}<div class="toolbar">${searchField(route.p.q,'搜索会话标题或 ID…')}${scopes(false)}</div>${staleNotice(path)}${body}</div></section></div>`;
    }
    const filter = route.p.state || 'active', items = d?.items.filter(t => filter === 'all' ? true : filter === 'protected' ? t.protected : t.archiveState === filter) || [], tab = route.p.tab || 'sessions';
    let body;
    if (!d)
        body = resourceState(key);
    else if (tab === 'sessions')
        body = conversationCards(d.conversations);
    else if (tab === 'batches')
        body = `<div class="panel">${d.batches.map(b => `<div class="recent-row"><span>${icon('archive', 16)}</span><div class="recent-name"><b>${b.mode === 'archive' ? '归档' : '恢复'}批次</b><span class="mono small muted">${esc(b.id)}</span></div>${badge(b.status === 'completed' ? '已完成' : b.status === 'partial' ? '部分失败' : '待确认', b.status === 'completed' ? 'good' : b.status === 'partial' ? 'warn' : '')}${smallTime(b.createdAt)}</div>`).join('') || empty('暂无归档批次')}</div>`;
    else if (tab === 'claims')
        body = '<div class="panel">'+d.executionClaims.map(c=>`<div class="claim-row"><b>${esc(c.title || c.kind)}</b><span>${c.state==='queued'?'等待执行许可':'持有资源记录'}</span><div class="small muted">进程 ${c.ownerPid} · 取得于 ${esc(fullTime(c.acquiredAt ? Date.parse(c.acquiredAt) : null))}</div>${c.taskId ? btn('查看所属任务','open-run',`data-id="${esc('qmtask:'+c.taskId)}"`,'small') : ''}<p class="small muted">${c.state==='queued'?'等待以下资源的执行许可。':'中断后的占用记录需要核对所属任务与进程结果。'}</p>${c.waiting ? `<div class="notice warn"><span>${c.waiting.reason === 'claim_or_prior_waiter' ? '等待现有占用或前序排队释放：' : '等待执行许可或调度：'}${c.waiting.owners.map(owner => `${esc(owner.claimId)} (${owner.state === 'queued' ? '前序排队' : '持有记录'})`).join('、')}${c.waiting.ownersTruncated ? '，其余阻塞项见原入口' : ''}</span></div>` : ''}<code>${esc(c.operationId || c.id)}</code><div>${c.scopes.map(s=>`<div class="resource-path"><span>${s.access==='write'?'写入':'读取'}</span><code>${esc(s.kind==='named'?s.key:s.path)}</code></div>`).join('')}</div></div>`).join('')+'</div>';

    else
        body = `<div class="toolbar">${segmented([['active', '未归档'], ['archived', '已归档'], ['protected', '已保留'], ['all', '全部']], filter, 'session-filter')}<span class="spacer"></span>${btn(icon('archive', 14) + (filter === 'archived' ? '恢复' : '归档'), 'archive-preview', `data-value="${filter === 'archived' ? 'restore' : 'archive'}" ${writeAttrs('archive')}`)}</div>${selectedThreads.size ? `<div class="bulkbar">${selectedThreads.size} 个会话已选<span class="spacer"></span>${btn('取消选择', 'clear-threads', '', 'small')}</div>` : ''}<div class="session-card-grid">${items.map((t, i) => `<article class="session-card" data-key="session-${esc(t.id)}"><label class="check-label session-selection"><input type="checkbox" data-select-thread="${esc(t.id)}" ${selectedThreads.has(t.id) ? 'checked' : ''} aria-label="选择会话 ${esc(t.title)}"></label><details open data-key="session-details-${esc(t.id)}"><summary class="session-summary"><span class="session-symbol">${icon('changes', 16)}<i class="session-dot ${t.control === 'quaymesh' ? 'running' : t.control === 'desktop' ? 'review' : 'done'}"></i></span><span class="session-heading"><b title="${esc(t.title)}">${esc(t.title)}</b><span class="session-meta"><code>${esc(t.turnId)}</code><span>·</span><span>${t.runIds.length} 次执行</span>${t.protected ? badge('保留') : ''}</span></span><span class="summary-chevron">${icon('chevron', 13)}</span></summary><div class="session-runs">${t.runs.map(r => `<button class="session-run-link" data-action="open-run" data-id="${esc(r.id)}"><span class="${r.status === 'failed' ? 'red' : r.status === 'running' ? 'accent' : 'muted'}">${icon(r.status, 14)}</span><span class="ellipsis">${esc(r.title || r.id)}</span><span class="small muted">${esc(stages[r.status] || r.status)}</span>${icon('chevron', 12)}</button>`).join('')}</div></details><footer><span class="session-owner ${t.control === 'quaymesh' ? 'accent' : 'muted'}">${icon(t.control === 'idle' ? 'unlock' : 'lock', 12)}${t.control === 'quaymesh' ? 'QuayMesh' : t.control === 'desktop' ? 'Desktop' : '空闲'}</span>${!t.verified ? badge('归属待确认', 'warn') : t.external ? badge('外部续写', 'warn') : ''}<span class="spacer"></span>${t.control === 'quaymesh' ? btn('转向', 'session-control', `data-value="steer" data-id="${esc(t.id)}" ${writeAttrs()}`, 'small ghost') + btn('接管', 'session-control', `data-value="takeover" data-id="${esc(t.id)}" ${writeAttrs()}`, 'small') : t.control === 'desktop' ? btn('归还', 'session-control', `data-value="return" data-id="${esc(t.id)}" ${writeAttrs()}`, 'small') : ''}${ib('pin', 'protect', t.protected ? '取消保留' : '保留会话', `data-id="${esc(t.id)}" ${writeAttrs()}`, t.protected ? 'accent' : '')}${ib('more', 'session-info', '会话详情', `data-id="${esc(t.id)}"`)}</footer></article>`).join('') || empty('暂无会话')}</div>`;
    return `<div class="session-layout has-project">${left}<section class="session-content"><div class="page"><div class="mobile-only">${btn(icon('back', 14) + '项目', 'session-back', '', 'ghost')}</div>${pageHead(p.name, `${nodeTag(p.nodeId, true)} <code title="${esc(p.path)}">${esc(p.path)}</code>`)}${tabs([['sessions', '会话', d?.conversations.length], ['threads', '代理会话', d?.items.length], ['batches', '代理归档', d?.batches.length], ['claims', '资源占用', d?.executionClaims.length]], tab, 'session-tab')}${staleNotice(key)}<div class="section-gap">${body}</div></div></section></div>`;
}
function workspacesPage() {
    const d = data<ListResponse<Root>>('roots'), q = (route.p.q || '').toLowerCase(), roots = (d?.items || []).filter(r => (!route.p.node || r.nodeId === route.p.node) && (!q || [r.name, r.id, r.path, r.description, ...r.tags].join(' ').toLowerCase().includes(q))), orphans = projects().filter(p => !p.rootId && (!route.p.node || p.nodeId === route.p.node) && [p.id,p.name,p.path].join(' ').toLowerCase().includes(q));
    const content = !d ? resourceState('roots') : `<div class="panel root-panel"><div class="root-labels"><span></span><span>根目录</span><span>路径</span><span>状态</span><span></span></div>${roots.map(r => { const ps = projects().filter(p => p.rootId === r.id), open = expandedRoots.has(r.id), online = node(r.nodeId)?.online; return `<section data-key="root-${esc(r.id)}"><div class="root-row">${ib(open ? 'down' : 'chevron', 'root-expand', (open ? '收起' : '展开') + '项目', `data-id="${esc(r.id)}" aria-expanded="${open}" ${ps.length ? '' : 'disabled'}`)}<div class="root-name"><h3>${esc(r.name)}</h3><p>${nodeTag(r.nodeId, true)}<span>${ps.length} 项目</span>${r.readOnly ? badge('只读') : ''}${r.tags.slice(0, 2).map(t => badge(t)).join('')}</p></div><div class="root-path"><code title="${esc(r.path)}">${esc(r.path)}</code><span class="mono muted">${esc(r.id)}</span></div><span class="root-status">${badge(r.settingsError ? '配置应用失败' : r.settingsPending ? '配置待应用' : !r.enabled ? '已停用' : online ? '可用' : '离线', r.settingsError || r.settingsPending ? 'warn' : !r.enabled ? '' : online ? 'good' : 'warn')}</span><div class="root-actions">${ib('copy', 'copy', '复制根目录引用', `data-text="${esc(r.reference)}"`)}${ib('settings', 'root-edit', '编辑根目录', `data-id="${esc(r.id)}" ${writeAttrs('settings')}`)}</div></div>${open ? `<div class="root-projects">${ps.map(p => `<div class="root-project">${icon('workspaces', 14)}<button class="run-title" data-action="project-tasks" data-id="${esc(p.id)}">${esc(p.name)}</button><span class="small muted ellipsis">${esc(p.path)}</span><span class="spacer"></span><span class="small muted">${p.total} 次执行</span>${p.active ? badge(p.active + ' 活跃') : ''}</div>`).join('')}</div>` : ''}</section>`; }).join('') || empty('没有匹配根目录', '', btn('清除筛选', 'reset-filters'))}</div>`;
    return `<div class="page">${pageHead('工作空间', `${roots.length} 个匹配根目录 · ${projects().filter(p => roots.some(r => r.id === p.rootId)).length + orphans.length} 个相关项目`, btn(icon('plus', 14) + '添加根目录', 'root-edit', writeAttrs('settings'), 'primary'))}<div class="toolbar">${searchField(route.p.q, '搜索目录、路径或标签…')}${scopes(false)}</div>${staleNotice('roots')}${content}${orphans.length ? `<section class="section-gap">${panel('未分配根目录', orphans.map(p => `<div class="recent-row"><span class="amber">${icon('workspaces', 16)}</span><div class="recent-name"><h3>${esc(p.name)}</h3><code class="small muted">${esc(p.path)}</code></div>${nodeTag(p.nodeId, true)}${btn('查看任务', 'project-tasks', `data-id="${esc(p.id)}"`, 'small')}</div>`).join(''), badge(orphans.length + ' 项', 'warn'))}</section>` : ''}</div>`;
}
function eventLinks(event: EventRow): string {
    const details = event.details || {}, taskId = event.taskId || (typeof details.taskId === 'string' ? details.taskId : typeof details.task_id === 'string' ? details.task_id : null);
    const runId = event.runId || (typeof details.runId === 'string' ? details.runId : null), operationId = event.operationId || (typeof details.operationId === 'string' ? details.operationId : null);
    return '<div class="actions">' + (taskId ? btn('查看任务','open-run',`data-id="${esc(taskId.startsWith('qmtask:') ? taskId : 'qmtask:'+taskId)}"`,'small') : runId ? btn('查看执行','open-run',`data-id="${esc(runId.startsWith('qm:') ? runId : workspaceHandle(event.nodeId,runId))}"`,'small') : '')
        + (operationId ? ib('copy','copy','复制操作引用',`data-text="${esc(operationId)}"`) : '') + (event.requestId ? ib('copy','copy','复制请求引用',`data-text="${esc(event.requestId)}"`) : '') + '</div>';
}
function receiptsPage(tabsHTML: string): string {
    const path = activityPath(), receipts = data<{items:ActionReceipt[]}>(path);
    return `<div class="page">${pageHead('活动','最近 50 次操作回执；记录每个目标的处理结果。',btn('重新核对','refresh'))}${tabsHTML}${staleNotice(path)}${!receipts ? resourceState(path) : receipts.items.length ? `<div class="panel">${receipts.items.map(receipt=>`<article class="receipt-row"><div class="inline"><b>${esc(receiptLabel(receipt))}</b><span class="spacer"></span>${smallTime(timestamp(receipt.finishedAt ?? receipt.createdAt))}</div><code class="break">${esc(receipt.path)}</code><p class="small muted">请求 ${esc(receipt.requestKey)} · ${esc(receipt.scope)}</p>${receipt.error ? `<p class="amber">${esc(typeof receipt.error === 'string' ? receipt.error : receipt.error.message || receipt.error.code)}</p>` : ''}<details><summary>查看逐项结果</summary><pre class="code-block">${esc(JSON.stringify(receipt.response ?? {effect:receipt.effect},null,2))}</pre></details>${canQueryReceipt(receipt) ? btn('查询原请求结果','receipt-query',`data-id="${esc(receipt.requestKey)}" data-path="${esc(receipt.path)}" data-target="${esc(receipt.scope.slice(('console:'+receipt.path+':').length))}"`,'small') : ''}</article>`).join('')}</div>` : empty('暂无操作回执')}</div>`;
}
function activityPage() {
    const path = activityPath(), d = data<ActivityPage>(path), kind = route.p.kind || 'events';
    const tabsHTML = tabs([['events', '系统事件'], ['calls', 'MCP 调用'], ['transfers', '文件传输'], ['audit', '操作审计'], ['receipts', '操作回执']], kind, 'activity-kind');
    if (kind === 'receipts') return receiptsPage(tabsHTML);
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
        body = `<div class="panel"><div class="histogram" aria-label="近 24 小时事件分布">${d.bins.map(b => `<button class="${b.errors ? 'bad' : b.warnings ? 'warn' : ''}" style="height:${Math.max(3, b.count / max * 52)}px" data-action="event-hour" data-value="${Math.floor(b.start / 3600000)}" title="${fullTime(b.start)} · ${b.count} 条 · ${b.errors} 错误" aria-label="筛选 ${tm(b.start)} 的 ${b.count} 条事件"></button>`).join('')}</div><div class="chart-axis"><span>24 小时前</span><span>现在</span></div>${groups.map(({ item: e, items }) => `<div class="event-row" data-key="event-${esc(e.id)}"><time title="${fullTime(e.time)}">${tm(e.time)}</time><span class="${e.level === 'error' ? 'red' : e.level === 'warn' ? 'amber' : 'muted'}">${icon(e.level === 'error' ? 'failed' : e.level === 'warn' ? 'alert' : 'info', 15)}</span><span class="node-mark">${esc(node(e.nodeId)?.short || e.nodeId)}</span><details><summary>${esc(e.message)}</summary><p>${esc(node(e.nodeId)?.name || e.nodeId)} · ${esc(e.level)} · ${items.length} 条原始记录</p>${eventLinks(e)}<pre>${esc(JSON.stringify(items, null, 2))}</pre></details>${items.length > 1 ? badge('×' + items.length) : '<span></span>'}</div>`).join('')}${pagination(d)}</div>`;
    }
    else if (kind === 'calls')
        body = `<div class="panel">${d.items.map(c => `<div class="event-row" data-key="call-${esc(c.id)}"><time title="${fullTime(c.time)}">${tm(c.time)}</time><span class="${c.ok === true ? 'green' : c.ok === false ? 'red' : 'muted'}">${icon(c.ok === true ? 'check' : c.ok === false ? 'failed' : 'queued', 14)}</span><span class="node-mark">${esc(node(c.nodeId)?.short || '?')}</span><details><summary><code>${esc(c.tool)}</code> <span class="small muted">${esc(c.summary)}</span></summary><p>节点 ${esc(c.nodeId)} / ${esc(c.rootId)} · 请求 ${esc(c.requestId || c.id)}</p>${eventLinks(c)}<pre>${esc(JSON.stringify(c, null, 2))}</pre></details><span class="mono small ${c.ok === false ? 'red' : 'muted'}">${c.ok === true ? (c.duration == null ? '未记录时长' : c.duration + ' ms') : c.ok === false ? esc(c.error) : c.state === 'pending' ? '等待响应' : c.state === 'responded' ? (c.responseRecorded === false ? '已响应 · 历史结果未保存' : '已响应') : '状态待核对'}</span></div>`).join('')}${pagination(d)}</div>`;
    else if (kind === 'transfers')
        body = `<div class="panel">${(d.items as unknown as TransferRow[]).map(t => `<article class="transfer" data-key="transfer-${esc(t.id)}"><div class="inline"><h3>${esc(t.source.split(/[\\/]/).pop())}</h3><span class="spacer"></span>${status(t.status === 'completed' ? 'done' : t.status)}</div><div class="transfer-path" style="margin-top:11px"><span class="muted">来源</span><span class="break">${esc(t.source)}</span><span class="muted">目标</span><span class="break">${esc(t.destination)}</span></div>${meter(transferPercent(t), t.status === 'failed' ? 'red' : '')}<div class="inline"><span class="small muted num">${bytes(t.bytes)} / ${bytes(t.total)} · ${transferPercent(t) === null ? '总量待确认' : transferPercent(t)!.toFixed(1) + '%'}</span><span class="spacer"></span>${t.status === 'running' ? `${t.speed == null ? '' : `<span class="small muted">${bytes(t.speed)}/s</span>`}${btn('取消传输', 'cancel-transfer', `data-id="${esc(t.id)}" ${writeAttrs()}`, 'small danger')}` : t.error ? `<span class="small red">${esc(t.error)}</span>` : ''}</div></article>`).join('')}${pagination(d)}</div>`;
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
    const chart = panel('每日已结束轮次用量', `<div class="chart-topline"><span>${compact(mx)}</span><span>Token</span></div><div class="usage-chart" aria-label="每日 Token">${u.daily.map(d => `<div class="usage-column"><button class="usage-bar" style="height:${Math.max(1, (d.total ?? 0) / mx * 140)}px" data-action="usage-date" data-value="${esc(d.day)}" title="${d.day}\n总量 ${fmt(d.total)}\n非缓存输入 ${fmt(noncachedInput(d))}\n缓存输入 ${fmt(d.cached)}\n输出 ${fmt(d.output)}" aria-label="${d.day} 用量 ${fmt(d.total)}，查看任务"><i class="part output" style="height:${usageParts(d).output}%"></i><i class="part input" style="height:${usageParts(d).input}%"></i><i class="part cache" style="height:${usageParts(d).cache}%"></i></button><span class="day">${d.day.slice(5)}</span></div>`).join('')}</div>`, `<div class="legend"><span><i></i>非缓存输入</span><span><i class="cache"></i>缓存</span><span><i class="output"></i>输出</span></div>`);
    const quality = panel('统计明细', `<div class="usage-summary"><div class="section-line"><span class="muted">输入缓存占比</span><b class="ratio">${ratio === null ? '未知' : ratio.toFixed(1) + '%'}</b></div>${meter(ratio)}<div class="usage-breakdown"><span>${compact(u.cached)} / ${compact(u.input)}</span></div><dl class="quality-list"><div><dt>完整记录</dt><dd>${u.records - u.missing - u.partial - u.notUsed}</dd></div><div><dt>部分记录</dt><dd class="${u.partial ? 'amber' : ''}">${u.partial}</dd></div><div><dt>用量未知</dt><dd class="${u.missing ? 'amber' : ''}">${u.missing}</dd></div><div><dt>未调用模型</dt><dd>${u.notUsed}</dd></div></dl></div>`);
    const byProject = panel('项目用量', `<div class="usage-ranking table-wrap"><table class="data-table"><colgroup><col><col style="width:116px"><col style="width:116px"><col style="width:66px"></colgroup><thead><tr><th>项目</th><th class="align-right">Token</th><th>占比</th><th class="align-right">执行</th></tr></thead><tbody>${u.projects.map(p => `<tr><td><button class="run-title" data-action="project-tasks" data-id="${esc(p.id)}">${esc(p.name)}</button><div class="run-sub">${nodeTag(p.nodeId, true)}${p.missing || p.partial ? badge('部分记录') : ''}</div></td><td class="align-right num">${p.partial || p.missing ? '≥ ' : ''}${compact(p.total)}</td><td><div class="share-cell">${meter(u.total ? (p.total ?? 0) / u.total * 100 : 0)}<span class="muted num">${(u.total ? (p.total ?? 0) / u.total * 100 : 0).toFixed(1)}%</span></div></td><td class="align-right num">${p.records}</td></tr>`).join('')}</tbody></table></div>`);
    const top = panel('高用量任务', `<div class="panel-body">${u.top.map((r, i) => `<div class="rank-row"><span class="rank-number">${String(i + 1).padStart(2, '0')}</span><div style="min-width:0"><button class="run-title ellipsis" data-action="open-run" data-id="${esc(r.id)}" title="${esc(r.title)}">${esc(r.title)}</button><p class="small muted">${esc(r.projectName)}</p></div>${usageText(r)}</div>`).join('') || empty('暂无用量')}</div>`);
    return `<div class="page">${pageHead('用量分析', '按代理执行轮次结束日统计，使用当前选择的时区。', btn(icon('download', 14) + '导出完整统计', 'export-usage'))}<div class="toolbar">${scopes()}${rangeSelect(route.p.days || '14', false)}<span class="spacer"></span><span class="small muted">${u.records} 个已结束轮次</span></div>${staleNotice(path)}${u.pendingUsage.records || u.undatedUsage.records ? `<div class="notice warn visually-spaced">未结束轮次 ${u.pendingUsage.records} 个（已记录 ${compact(u.pendingUsage.total)} Token）；结束时间缺失 ${u.undatedUsage.records} 个（已记录 ${compact(u.undatedUsage.total)} Token）。这些记录保留在此处，日期图表尚未计入。</div>` : ''}<section class="summary-grid">${metric('已记录 Token', (u.partial || u.missing ? '≥ ' : '') + compact(u.total), '')}${metric('输入', compact(u.input), '缓存 ' + compact(u.cached))}${metric('输出', compact(u.output), '推理 ' + compact(u.reasoning))}${metric('已结束轮次', fmt(u.records), u.notUsed + ' 次未调用模型')}</section><div class="usage-grid">${chart}${quality}</div><div class="usage-grid">${byProject}${top}</div></div>`;
}
const SETTINGS = [['appearance', '外观'], ['data', '刷新与通知'], ['connection', '数据连接'], ['egress', '统一出口'], ['security', '登录与权限'], ['shortcuts', '快捷键']];
const settingRow = (title: string, desc: string, control: string) => `<div class="setting-row"><div><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}</div><div class="control">${control}</div></div>`;
function settingsPage() {
    const sec = route.p.section || 'appearance';
    let body = '';
    if (sec === 'appearance')
        body = `<div class="section-heading"><h2>外观</h2></div><div class="panel">${settingRow('主题', '', segmented([['system', '系统'], ['light', '浅色'], ['dark', '深色']], pref.theme, 'preference', 'data-key="theme"'))}${settingRow('行密度', '', segmented([['compact', '紧凑'], ['comfortable', '舒适']], pref.density, 'preference', 'data-key="density"'))}${settingRow('侧栏', '', segmented([['expanded', '展开'], ['collapsed', '折叠']], pref.sidebar, 'preference', 'data-key="sidebar"'))}${settingRow('时区', '', `<select class="select" data-pref-select="timeZone" aria-label="时区">${[['local', '跟随设备'], ['Asia/Shanghai', '北京时间'], ['America/New_York', '纽约时间'], ['UTC', '协调世界时 UTC']].map(([v, t]) => opt(v, t, pref.timeZone)).join('')}</select>`)}${settingRow('代码换行', '', `<label class="switch"><input type="checkbox" data-pref-check="wrap" ${pref.wrap ? 'checked' : ''}>自动换行</label>`)}</div>`;
    else if (sec === 'data')
        body = `<div class="section-heading"><h2>刷新与通知</h2></div><div class="panel">${settingRow('刷新频率', '', segmented([['0', '手动'], ['8', '8 秒'], ['15', '15 秒'], ['30', '30 秒'], ['60', '1 分钟']], pref.poll, 'preference', 'data-key="poll"'))}${settingRow('错误事件通知', '按节点补读真实错误事件；断开期间保留进度，恢复后继续。随刷新频率检查。', `<label class="switch"><input type="checkbox" data-notifications ${pref.notifications ? 'checked' : ''}>浏览器通知</label>`)}${settingRow('缓存资源', '', `<span class="mono muted">${CACHE.size} 项</span>`)}${settingRow('本机偏好', '', btn('恢复默认', 'reset-preferences', '', 'danger'))}</div>`;
    else if (sec === 'connection')
        body = `<div class="section-heading"><h2>数据连接</h2></div><div class="panel">${settingRow('当前接口', 'quaymesh.console.v4', `<code>${esc(API.base())}</code>`)}${settingRow('任务来源', '各节点已保存的 QuayMesh 工作记录', badge(resourceHealth([...activePaths].map(path => CACHE.get(path))).label, resourceHealth([...activePaths].map(path => CACHE.get(path))).tone === 'green' ? 'good' : 'warn'))}${settingRow('刷新状态', '各资源独立更新，读取失败保留最近确认记录。', btn('重新读取', 'refresh') + btn('查看诊断','diagnostics'))}</div>`;
    else if (sec === 'egress')
        body = `<div class="section-heading"><h2>统一出口</h2></div><form id="egress-form" data-preserve="egress-settings" class="panel"><div class="panel-body field-grid"><label class="field">来源节点<select class="select" name="sourceNodeId">${(fleet()?.nodes || []).map(n => opt(n.id, n.name, fleet()?.gatewayId)).join('')}</select></label><label class="field">上传配置<input type="file" name="config" accept=".yaml,.yml,text/yaml"><small>上传后使用文件配置 · 最大 256 KiB</small></label><div class="field full"><span>目标节点</span><div class="target-grid">${(fleet()?.nodes || []).map(n => `<label class="switch"><input type="checkbox" name="targets" value="${esc(n.id)}" ${n.online && n.egress.enabled ? 'checked' : ''} ${!n.online ? 'disabled' : ''}>${esc(n.name)} ${n.online ? '' : '（离线）'}</label>`).join('')}</div></div><label class="switch"><input type="checkbox" name="reload" checked>校验后热加载</label><div class="error-text full" data-form-error></div></div><div class="dialog-footer">${btn('同步配置', 'egress-sync', writeAttrs('settings'), 'primary')}</div></form><div class="section-gap panel">${(fleet()?.nodes || []).map(n => settingRow(esc(n.name), `优先级 ${n.priority} · 端口 ${n.egress.port}`, btn('节点设置', 'node', `data-id="${esc(n.id)}" data-tab="settings"`, 'small'))).join('')}</div>`;
    else if (sec === 'security')
        body = `<div class="section-heading"><h2>登录与权限</h2></div><div class="panel">${settingRow('当前账号', `${esc(API.session?.user?.name || '未登录')}`, badge(canWrite() ? '管理员' : '只读', canWrite() ? 'good' : 'warn'))}${settingRow('操作确认', '', badge('已启用'))}${settingRow('当前设备', API.session?.expiresAt ? '保持登录至 '+fullTime(API.session.expiresAt) : '保持登录', btn('退出登录', 'logout', writeAttrs(), 'danger'))}${settingRow('全部设备', '', btn('撤销登录', 'revoke-all', writeAttrs(), 'danger'))}</div>`;
    else
        body = `<div class="section-heading"><h2>快捷键</h2></div><div class="panel panel-body"><div class="key-grid">${KEYS.map(([k, t]) => `<div><span>${t}</span><kbd>${k}</kbd></div>`).join('')}</div></div>`;
    return `<div class="page settings-page">${pageHead('设置')}<div class="settings-layout"><nav class="settings-nav" aria-label="设置分区">${SETTINGS.map(([id, text]) => `<button class="${id === sec ? 'active' : ''}" data-action="settings-section" data-value="${id}" ${id === sec ? 'aria-current="page"' : ''}>${text}</button>`).join('')}</nav><div class="settings-content">${body}</div></div></div>`;
}
const KEYS = [['⌘ / Ctrl K', '搜索与命令面板'], ['/', '聚焦当前页搜索'], ['G → O / T / C', '总览 / 任务 / 改动'], ['G → S / M / W', '会话 / 机器 / 工作空间'], ['G → A / U / ,', '活动 / 用量 / 设置'], ['J / K', '下一项 / 上一项任务'], ['Esc', '关闭详情或对话框'], ['[', '折叠 / 展开侧栏'], ['R', '刷新当前视图'], ['T', '切换深浅主题'], ['← / →', '聚焦分隔线时调整宽度'], ['?', '显示快捷键']];
function diagnosticSnapshot() {
    return {capturedAt:new Date().toISOString(),view:route,contract:API.session?.contract,assets:[...document.scripts].map(script=>script.src).filter(Boolean),
        health:resourceHealth([...activePaths].map(path=>CACHE.get(path))),pendingRequests:API.pending.size,requestCount:API.requestCount,
        nodes:(fleet()?.nodes || []).map(n=>({id:n.id,version:n.version,online:n.online,lastSeen:n.lastSeen})),
        resources:[...activePaths].map(path=>{const entry=CACHE.get(path);return {path,loading:entry?.loading,lastReadAt:entry?.time,durationMs:entry?.duration,error:entry?.error?.message,sources:(entry?.data as {sources?:SourceState[]}|undefined)?.sources};})};
}
async function diagnostics() {
    const snapshot = diagnosticSnapshot();
    await dialog({title:'连接与页面诊断',wide:true,confirm:null,cancel:'关闭',body:`<p>${esc(snapshot.health.label)} · ${snapshot.pendingRequests} 个请求正在等待。</p><div class="panel">${snapshot.resources.map(item=>`<div class="panel-foot"><code class="break">${esc(item.path)}</code><span>${item.loading ? '读取中' : item.error ? '读取失败' : '已读取'}</span><span>${item.durationMs == null ? '—' : duration(item.durationMs)}</span>${smallTime(item.lastReadAt)}</div>`).join('')}</div><div class="form-actions">${btn('导出诊断记录','export-diagnostics')}</div><details><summary>版本与来源详情</summary><pre class="code-block">${esc(JSON.stringify(snapshot,null,2))}</pre></details>`});
}
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
async function invalidateAfterWrite() { resources.invalidate(); await refresh(true); ensureRoute(); }
async function withLock(key: string, fn: () => unknown | Promise<unknown>) { if (writePending.has(key)) { toast('该操作正在处理，请等待当前结果。'); return; } writePending.add(key); schedulePaint(); try {
    return await fn();
}
finally {
    writePending.delete(key); schedulePaint();
} }
function findLoadedRun(id: string) {
    const o = overview();
    return data<RunDetail>(detailPath(id))?.run || data<RunPage>(runPath())?.items?.find(r => r.id === id)
        || (o ? [...o.current, ...o.olderOpen, ...o.recent, ...o.active].find(r => r.id === id) : undefined);
}
async function reviewRuns(ids: string[], verdict: 'accept' | 'reject') {
    ensureWritable();
    const candidates = ids.map(findLoadedRun).filter((r): r is Run => Boolean(r && r.actions.review));
    const checked = await Promise.all(candidates.map(async run => {
        const detail = await API.get<RunDetail>('runs/' + enc(run.id) + '?fresh=1');
        return {run: detail.run, blocked: changeCaptureBlockReason(detail.changeCaptures)};
    }));
    const skipped = checked.filter(item => item.blocked || !item.run.actions.review);
    const rs = checked.filter(item => !item.blocked && item.run.actions.review).map(item => item.run);
    if (!rs.length)
        return toast(skipped.some(item => item.blocked) ? '所选任务的文件证据仍待确认，请打开改动详情核对后刷新' : '所选任务没有可验收的结果', 'warn');
    const intent = new WriteIntent(API, 'runs/review');
    const refs = rs.map(r => ({ id: r.id, expectedRevision: r.revision }));
    const result = await dialog({ title: verdict === 'accept' ? `验收 ${rs.length} 项结果` : `驳回 ${rs.length} 项结果`, danger: verdict === 'reject', confirm: verdict === 'accept' ? '确认验收' : '确认驳回', body: `${skipped.length ? `<div class="notice warn"><div>以下 ${skipped.length} 项未纳入本次提交：${skipped.map(item => `<p>${esc(item.run.title)}：${esc(item.blocked || '当前没有可验收的结果')}</p>`).join('')}</div></div>` : ''}<div class="panel" style="margin-bottom:16px">${rs.map(r => `<div class="panel-foot"><span class="ellipsis">${esc(r.title)}</span><span class="spacer"></span><span class="mono">rev ${r.revision}</span></div>`).join('')}</div><label class="field">${verdict === 'reject' ? '驳回原因（必填）' : '验收说明（可选）'}<textarea name="note" ${verdict === 'reject' ? 'required' : ''} placeholder="记录你核对过的证据与结论…" maxlength="4000"></textarea></label>`, onSubmit: form => intent.submit<ReviewReceipt>({ refs, verdict, note: formObject(form).note?.trim() || '' }) });
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
    const queued = stage(r) === 'queued', label = action === 'resume' ? '恢复执行' : queued ? '取消排队' : '中断执行', intent = new WriteIntent(API, 'runs/' + enc(id) + '/control');
    const result = await dialog({ title: label + '？', confirm: label, danger: action === 'interrupt', body: `<p><b>${esc(r.title)}</b></p><p>${action === 'resume' ? '继续从检查点执行，工作区可能产生修改。' : queued ? '从等待队列移除这个任务。' : '停止当前执行，保留工作区和执行记录。'}</p>`, onSubmit: () => intent.submit<ControlReceipt>({ action, expectedRevision: r.revision }) });
    if (!result)
        return;
    await invalidateAfterWrite();
    const descriptions:Record<string,string> = {completed:queued ? '已取消排队' : action === 'resume' ? '已恢复执行' : '已确认停止',accepted:'请求已接收，等待最终回执',partial:'部分目标已处理，仍有目标需要核对',rejected:'所有目标均未执行，请查看拒绝原因',unknown:'执行结果待核对'};
    toast(descriptions[result.status] || '控制结果已记录，请查看操作回执', ['partial','unknown','rejected'].includes(result.status) ? 'warn' : result.status === 'completed' ? 'good' : 'info');
    if (result.targets?.length || result.results?.length || result.missingNodes?.length) await dialog({title:'控制目标与结果',confirm:null,cancel:'关闭',body:controlTargets(result)});
}
function controlTargets(receipt: ControlReceipt): string {
    const targets = [...(receipt.targets || []),...(receipt.results || []).flatMap(result => result.targets?.map(target=>({...target,nodeId:result.nodeId})) || [{id:result.phaseId || result.nodeId || '执行阶段',kind:'phase',status:result.status || 'unknown',error:result.error,nodeId:result.nodeId}])];
    return `<div class="panel">${targets.map(target => `<div class="panel-foot">${target.nodeId ? nodeTag(target.nodeId,true) : ''}<code class="break">${esc(target.id)}</code><span>${esc(target.kind === 'command' ? '命令' : target.kind === 'agent' ? '代理' : '执行阶段')}</span><b>${esc(({completed:'已确认',accepted:'已接收',rejected:'已拒绝',unknown:'待核对',failed:'失败'} as Record<string,string>)[target.status] || target.status)}</b>${target.error ? `<span class="amber">${esc(target.error)}</span>` : ''}</div>`).join('')}</div>${receipt.missingNodes?.length ? `<p class="notice warn">以下节点尚未确认：${receipt.missingNodes.map(id=>esc(node(id)?.name || id)).join('、')}</p>` : ''}<p class="form-caption">完整记录保存在“活动 → 操作回执”。</p>`;
}
async function finishTask(id: string) {
    ensureWritable();
    const detail = await API.get<RunDetail>('runs/' + enc(id) + '?fresh=1');
    const run = detail.run, messages = detail.taskMessages;
    if (!messages || !messages.available || messages.taskId !== run.taskId) {
        await dialog({title:'暂不能结束目标',confirm:null,cancel:'返回任务',
            body:`<p class="notice warn">${esc(messages && !messages.available ? messages.error : '尚未取得权威节点确认的任务消息状态，请刷新后重试。')}</p>`});
        return;
    }
    if (messages.taskState === 'closed') {
        await invalidateAfterWrite();
        toast('工作目标已经结束，历史记录仍可查看。','info');
        return;
    }
    if (messages.pending > 0) {
        await dialog({title:'消息尚未确认',confirm:null,cancel:'返回任务',
            body:`<p>此目标还有 <b>${messages.pending}</b> 条用户消息未由模型确认收到。请在任务卡片中处理消息，再重新确认结束。</p>`});
        return;
    }
    const intent = new WriteIntent(API, 'runs/' + enc(id) + '/finish');
    const result = await dialog({title:'结束工作目标',confirm:'保存目标结果',body:`<p><b>${esc(run.title)}</b></p><p>只在目标完成或明确终止时保存最终结果。换对话、交接或临时离开时，保持同一目标开放。</p><p>当前没有等待模型确认的消息。收到新消息后，需要重新核对并确认。</p><label class="field">结果<select name="result" class="select"><option value="completed">目标已完成</option><option value="failed">目标未完成，确认结束</option><option value="cancelled">取消目标</option></select></label><label class="field">结果说明<textarea name="summary" required maxlength="4000" placeholder="说明目标结果，以及明确终止时仍未完成的部分。"></textarea></label>`,
        onSubmit: form => intent.submit({expectedRevision:run.revision,expectedTaskRevision:messages.taskRevision,
            messageSequence:messages.sequence,...formObject(form)})});
    if (result) { await invalidateAfterWrite(); toast('工作目标已结束，历史记录仍可查看或验收。','good'); }
}
async function getPatch(id: string) {
  const detail = await API.get<RunDetail>('runs/' + enc(id) + '?fresh=1');
  const blocked = changeCaptureBlockReason(detail.changeCaptures);
  if (blocked) return toast(blocked, 'warn');
  const controller = new AbortController();
  const view: {progress?: HTMLElement | null} = {};
  let finished = false;
  void dialog({title:'正在导出补丁',body:'<p data-download-progress>正在读取第一部分…</p>',confirm:null,cancel:'取消下载',onMount: d => { view.progress = d.querySelector('[data-download-progress]'); }})
    .then(() => { if (!finished) controller.abort(); });
  let cursor = null, revision = null;
  const chunks = [];
  try {
  do {
    const payload: PatchPage = await API.get<PatchPage>('runs/' + enc(id) + '/patch' + (cursor ? '?cursor=' + enc(cursor) : ''), controller.signal);
    if (typeof payload.patch !== 'string') throw new ApiError('补丁读取失败', 0, 'invalid_patch');
    if (revision !== null && revision !== payload.revision) throw new ApiError('下载期间文件发生变化，请重新下载', 409, 'revision_conflict');
    revision = payload.revision;
    chunks.push(payload.patch);
    if (view.progress) view.progress.textContent = `已读取 ${chunks.length} 部分 · ${bytes(chunks.reduce((sum, part) => sum + new TextEncoder().encode(part).length, 0))}`;
    if (payload.complete) break;
    if (!payload.nextCursor || payload.nextCursor === cursor) throw new ApiError('补丁分页缺少下一页', 0, 'invalid_cursor');
    cursor = payload.nextCursor;
  } while (cursor);
  if (controller.signal.aborted) return;
  download(id.replaceAll(':', '-') + '.patch', chunks.join(''), 'text/x-diff;charset=utf-8');
  finished = true;
  if (view.progress) {
    view.progress.textContent = '补丁已生成并下载。';
    const close = view.progress.closest('dialog')?.querySelector<HTMLElement>('footer [data-dialog-close]');
    if (close) close.textContent = '关闭';
  }
  } catch (error) {
    finished = true;
    if (view.progress) view.progress.textContent = controller.signal.aborted ? '下载已取消。' : '读取失败：' + consoleError(error).message;
    if (!controller.signal.aborted) throw error;
  }
}
async function revertRun(id: string) { ensureWritable('revert'); const d = await API.get<RunDetail>('runs/' + enc(id) + '?fresh=1'), r = d.run; const blocked = changeCaptureBlockReason(d.changeCaptures); if (blocked) return toast(blocked, 'warn'); const previewIntent = new WriteIntent(API,'runs/revert/preview'); const preview = await dialog({ title: '选择要还原的文件', wide: true, confirm: '检查还原计划', body: `<div class="panel">${d.files.map(f => `<label class="panel-foot" style="cursor:pointer"><input type="checkbox" name="files" value="${esc(f.id)}" ${f.revertible ? 'checked' : 'disabled'}><code class="break">${esc(f.path)}</code><span class="spacer"></span><span class="green">+${f.add}</span><span class="red">−${f.del}</span></label>`).join('')}</div>`, onSubmit: form => { const files = new FormData(form).getAll('files'); if (!files.length)
        throw new Error('至少选择一个文件'); return previewIntent.submit<RevertPreview>({ id, files, expectedRevision: r.revision }); } }); if (!preview)
    return; const intent = new WriteIntent(API,'runs/revert/commit'); const result = await dialog({ title: '确认还原计划', danger: true, confirm: '确认还原所选文件', body: `<p>将还原 <b>${preview.files.length}</b> 个文件。预览有效期至 ${esc(fullTime(preview.expiresAt))}。</p><pre class="code-block">执行：${esc(id)}\n文件：${preview.files.length}</pre>`, onSubmit: () => intent.submit<RevertReceipt>({ previewId: preview.id, confirmationHash: preview.hash }) }); if (result) {
    await invalidateAfterWrite();
    toast(result.status === 'completed' ? '还原回执已确认，文件已恢复' : '还原请求已接收，等待结果', 'info');
} }
function currentSessions() { return data<Sessions>('projects/' + enc(route.p.project || '') + '/sessions'); }
async function sessionControl(id: string, action: string) { ensureWritable(); const t = currentSessions()?.items.find(t => t.id === id); if (!t)
    throw new Error('会话未加载'); const intent = new WriteIntent(API,'sessions/' + enc(id) + '/control'); const result = await dialog({ title: action === 'steer' ? '向当前轮次补充指令' : action === 'takeover' ? '接管到 Codex Desktop？' : '归还会话控制权？', confirm: action === 'steer' ? '发送指令' : action === 'takeover' ? '确认接管' : '确认归还', danger: action === 'takeover', body: `<p>${esc(t.title)}</p><p>${action === 'steer' ? '指令将发送给当前执行中的代理。' : action === 'takeover' ? '当前任务将中断，随后交由 Codex Desktop 控制。' : '会话将返回空闲状态。'}</p>${action === 'steer' ? '<label class="field">补充指令<textarea name="prompt" required maxlength="12000" placeholder="例如：先修复失败测试，保留现有工作区改动。"></textarea></label>' : ''}`, onSubmit: form => intent.submit<{ status: string }>({ action, expectedRevision: t.revision, expectedTurnId: t.turnId, ...(action === 'steer' ? { prompt: formObject(form).prompt.trim() } : {}) }) }); if (result) {
    await invalidateAfterWrite();
    toast(result.status === 'completed' ? '已收到会话控制回执' : '请求已接收，等待控制权回执', result.status === 'completed' ? 'good' : 'info');
} }
async function archivePreview(mode: string) {
    ensureWritable('archive');
    const projectId = route.p.project;
    if (!projectId) throw new Error('请先选择项目');
    const request = {projectId,mode,ids:[...selectedThreads]};
    let preview = await API.post<ArchivePreview>('archive/preview',request);
    const missingUsage = preview.entries.filter(entry => entry.reason === 'usage_incomplete');
    if (missingUsage.length) {
        const choice = await dialog({title:'用量记录尚不完整',confirm:'继续查看归档计划',body:`<p>${missingUsage.length} 个代理会话缺少完整用量记录。选择下项后会保留缺失标记，并重新检查其余归档条件。</p><label class="switch"><input type="checkbox" name="acceptPartial">允许用量不完整的会话参加归档检查</label>`,onSubmit:form=>({acceptPartial:new FormData(form).has('acceptPartial')})});
        if (!choice) return;
        if (choice.acceptPartial) preview=await API.post<ArchivePreview>('archive/preview',{...request,acceptPartial:true});
    }
    const ready=preview.entries.filter(entry=>entry.ready), confirmationHash=preview.confirmationHash;
    if (ready.length && !confirmationHash) throw new ApiError('归档预览缺少确认凭据。',0,'invalid_response');
    let step=0;
    const intents=new Map<number,WriteIntent>();
    let latest:{batch:ArchivePreview}|undefined;
    const result=await dialog({title:mode==='restore'?'恢复代理会话预览':'归档代理会话预览',wide:true,confirm:ready.length?`确认${mode==='restore'?'恢复':'归档'} ${ready.length} 项`:null,cancel:'关闭',
        body:`<p>可执行 ${ready.length} 项，跳过 ${preview.entries.length-ready.length} 项。预览有效期 ${esc(fullTime(preview.expiresAt))}。${preview.acceptPartial?'已允许保留不完整用量记录。':''}</p><p>本操作管理代理会话的归档状态，任务、文件和用量历史继续保留。</p><div class="panel">${preview.entries.map(entry=>`<div class="panel-foot"><span class="ellipsis">${esc(entry.title)}</span>${badge(entry.ready?'可执行':entry.reason || '不可执行',entry.ready?'good':'warn')}</div>`).join('') || empty('没有符合条件的代理会话')}</div>${ready.length?'<label class="switch visually-spaced"><input type="checkbox" name="externalIdle" required>已暂停这些代理会话在其他客户端中的操作</label>':''}<p data-archive-progress class="small muted"></p>`,
        onSubmit:async(form,d)=>{
            while(step<ready.length) {
                let intent=intents.get(step); if(!intent){intent=new WriteIntent(API,'archive/commit');intents.set(step,intent);}
                latest=await intent.submit<{batch:ArchivePreview}>({previewId:preview.id,confirmationHash:confirmationHash!,externalIdleConfirmed:new FormData(form).has('externalIdle')});
                step++;
                const progress=d.querySelector<HTMLElement>('[data-archive-progress]');
                if(progress)progress.textContent=`已确认 ${latest.batch.succeededCount} 项，待核对 ${latest.batch.reconciliationCount} 项，待执行 ${latest.batch.readyCount} 项。`;
                if(!latest.batch.readyCount)break;
            }
            return latest;
        }});
    await invalidateAfterWrite();
    if (!result) return;
    if(!result.batch?.results)throw new ApiError('未收到归档回执。',0,'invalid_response');
    selectedThreads.clear();
    const batch=result.batch;
    toast(`${batch.succeededCount} 项已${mode==='restore'?'恢复':'归档'}，${batch.reconciliationCount} 项待核对，${batch.readyCount} 项待执行，${batch.skippedCount} 项跳过`,batch.reconciliationCount||batch.readyCount?'warn':'good');
}
function nodeDetailsBody(n: Machine, tab: string) {
    if (tab === 'settings')
        return `<div class="field-grid"><label class="field">节点昵称<input class="input" name="name" value="${esc(n.name)}" required maxlength="100"></label><label class="field">出网优先级<input class="input" type="number" name="priority" value="${n.priority}" min="0" max="1000" step="1" required></label><label class="field full">mihomo 配置路径<input class="input mono" name="config" value="${esc(n.egress.config)}"></label><label class="field">代理端口<input class="input" type="number" name="port" value="${n.egress.port ?? ''}" min="1" max="65535" required></label><label class="field">回切等待（秒）<input class="input" type="number" name="recovery" value="${n.egress.recovery ?? ''}" min="0" max="300" required></label><label class="field full">探测 URL<input class="input mono" name="probe" type="url" value="${esc(n.egress.probe)}" required></label><label class="switch"><input type="checkbox" name="enabled" ${n.egress.enabled ? 'checked' : ''}>参与出网候选</label><label class="switch"><input type="checkbox" name="inherit" ${n.egress.inherit ? 'checked' : ''}>新进程继承代理</label></div><p class="form-caption">代理设置对新进程生效。</p>`;
    return `<div class="inline visually-spaced"><span class="node-mark big">${esc(n.short)}</span><div><h2>${esc(n.name)}</h2><p class="small muted">${esc(n.role)} · ${esc(n.os)}</p></div><span class="spacer"></span>${machineStatus(n)}${n.settingsState?.error ? badge('配置应用失败','warn') : n.settingsState?.pending ? badge('配置待应用','warn') : ''}</div><dl class="key-values"><div><dt>CPU</dt><dd>${n.online && n.cpu != null ? n.cpu + '%' : '未上报'}</dd></div><div><dt>内存</dt><dd>${n.online ? n.memoryUsed + ' / ' + n.memoryTotal + ' GiB' : '数据过期'}</dd></div><div><dt>连接延迟</dt><dd>${n.online && n.latency != null ? n.latency + ' ms' : '未上报'}</dd></div><div><dt>版本 / 配置版本</dt><dd>${esc(n.version ?? '未上报')} · rev ${n.revision}</dd></div><div><dt>优先级</dt><dd>${n.priority}</dd></div><div><dt>出口 IP</dt><dd>${esc(n.egress.ip || '未配置')}</dd></div><div><dt>出网探测</dt><dd>${!n.egress.enabled ? '未参与' : n.egress.healthy === true ? '正常' : n.egress.healthy === false ? '失败' : '未上报'}</dd></div><div><dt>最后采样</dt><dd>${esc(fullTime(n.lastSeen))}</dd></div></dl><h3 class="section-gap">磁盘</h3>${n.disks.map(d => `<div class="section-gap"><div class="inline small"><code>${esc(d.mount)}</code><span class="spacer"></span><span>${n.online ? fmt(d.total - d.used) + ' / ' + fmt(d.total) + ' GiB 可用' : '数据过期'}</span></div>${meter(n.online ? percent(d.used,d.total) : null, (percent(d.used,d.total) ?? 0) > 85 ? 'amber' : '')}</div>`).join('')}<h3 class="section-gap">GPU</h3>${n.gpuSampled === false ? '<p class="form-caption">GPU 数据尚未取得。</p>' : n.gpus.length ? n.gpus.map(g => `<div class="section-gap"><div class="inline"><b class="small">${esc(g.name)}</b><span class="spacer"></span><span class="small">${n.online ? g.util + '% · ' + g.temp + '°C' : '数据过期'}</span></div><p class="form-caption">显存 ${n.online ? g.used + ' / ' + g.total + ' GiB' : '未更新'}</p>${meter(n.online ? percent(g.used,g.total) : null)}</div>`).join('') : '<p class="form-caption">无 GPU，正常。</p>'}<h3 class="section-gap">统一出口</h3><pre class="code-block">配置：${esc(n.egress.config)}\n端口：${n.egress.port}\n探测：${esc(n.egress.probe)}\n回切等待：${n.egress.recovery}s</pre>`;
}
function settingsStateNotice(state: {savedRevision?:number|null;appliedRevision?:number|null;pending?:boolean|null;error?:string|null} | undefined): string {
    const known=state?.savedRevision != null, applied=known && state?.appliedRevision===state.savedRevision && state.pending===false && !state.error;
    const title=!known ? '配置版本尚未取得' : state?.error ? '运行配置应用失败' : state?.pending ? '配置已保存，运行配置待应用' : applied ? '配置已保存并应用' : '配置已保存，应用状态待确认';
    return `<div class="notice ${applied?'':'warn'} visually-spaced"><div><b>${title}</b><p class="small">已保存 ${known?'r'+state!.savedRevision:'未知'} · 已应用 ${state?.appliedRevision == null?'未知':'r'+state.appliedRevision}</p>${state?.error?`<p>${esc(state.error)}</p>`:''}</div></div>`;
}
function allowSettingsSave(d: HTMLDialogElement, allowed: boolean) {
    const button=d.querySelector<HTMLButtonElement>('[data-dialog-confirm]');
    if(button){button.dataset.available=String(allowed);button.disabled=!allowed;}
}
async function readNodeSettings(id: string): Promise<NodeSettingsSnapshot> {
    const snapshot=await API.get<NodeSettingsSnapshot>('nodes/'+enc(id)+'/settings');
    if(!snapshot.settings || !Array.isArray(snapshot.roots)) throw new ApiError('节点持久配置尚未取得，请重试读取。',503,'settings_unavailable',{effect:'none'});
    const settings=snapshot.settings, cached=node(id);
    if(cached){
        cached.name=settings.nickname;cached.priority=settings.priority;cached.revision=settings.revision;
        Object.assign(cached.egress,settings.egress);
        cached.settingsState={savedRevision:settings.savedRevision??settings.revision,appliedRevision:settings.appliedRevision??null,pending:settings.pending??null,error:settings.error??null};
    }
    return snapshot;
}
async function openNode(id: string, tab = 'overview') {
    const loaded=node(id);if(!loaded)throw new Error('节点数据未加载');
    const n=clone(loaded);
    if(tab!=='settings'){
        const body=()=>nodeDetailsBody(n,'overview')+`<div data-settings-state>${settingsStateNotice(n.settingsState)}</div><div class="form-actions">${btn(icon('settings',14)+'编辑节点设置','node-edit-from-drawer',`data-id="${esc(id)}" ${writeAttrs('settings')}`)}</div>`;
        await dialog({title:'节点详情',drawer:true,body:body(),confirm:null,cancel:'关闭',refreshLabel:'读取配置状态',refresh:async d=>{
            await readNodeSettings(id);Object.assign(n,node(id));updateHTML(d.querySelector('.dialog-body'),body());return '已读取该节点保存的配置与应用状态。';
        }});return;
    }
    ensureWritable('settings');
    let revision:number|null=null,intent=new WriteIntent(API,'nodes/'+enc(id)+'/settings'),baseline=fieldsFromHTML(nodeDetailsBody(n,'settings'));
    const result=await dialog({title:n.name+' · 节点设置',drawer:true,confirm:'保存节点设置',
        body:`<div data-settings-state>${settingsStateNotice(undefined)}</div>`+nodeDetailsBody(n,'settings'),
        onMount:d=>{allowSettingsSave(d,false);d.querySelector<HTMLButtonElement>('[data-dialog-refresh]')!.click();},
        refresh:async d=>{
            revision=null;allowSettingsSave(d,false);
            const snapshot=await readNodeSettings(id),settings=snapshot.settings!;
            const current={...n,name:settings.nickname,priority:settings.priority,revision:settings.revision,egress:{...n.egress,...settings.egress}};
            const remote=fieldsFromHTML(nodeDetailsBody(current,'settings'));
            const message=refreshFields(d.querySelector('form')!,baseline,remote);baseline=remote;revision=settings.revision;
            updateHTML(d.querySelector('[data-settings-state]'),settingsStateNotice({...settings,savedRevision:settings.savedRevision??settings.revision}));
            allowSettingsSave(d,revision!==null);intent=new WriteIntent(API,'nodes/'+enc(id)+'/settings');
            return revision===null?'尚未取得可保存的配置版本，请重试读取。':message;
        },onSubmit:async form=>{
            if(revision===null)throw new ApiError('请先读取该节点的当前配置版本。',409,'settings_unavailable',{effect:'none'});
            const fd=new FormData(form),settings={name:String(fd.get('name')).trim(),priority:Number(fd.get('priority')),egress:{enabled:fd.has('enabled'),inherit:fd.has('inherit'),config:String(fd.get('config')).trim(),port:Number(fd.get('port')),probe:String(fd.get('probe')).trim(),recovery:Number(fd.get('recovery'))}};
            if(id===fleet()?.gatewayId&&(!settings.egress.enabled||settings.priority===0)&&!await confirmAction('将影响当前出网节点','<p>当前节点正在承载出网。此修改可能触发切换，并造成短暂连接中断。</p>','仍然保存'))throw new Error('已取消出网变更，输入保留');
            return intent.submit<{saved?:boolean;revision?:number;appliedRevision?:number;pending?:boolean}>({settings,expectedRevision:revision});
        }});
    if(result){await invalidateAfterWrite();toast(result.pending?'节点配置已保存，运行配置待应用；可在节点详情读取配置状态。':`节点配置已保存${result.appliedRevision != null?'，已应用至版本 '+result.appliedRevision:'，应用状态可在节点详情核对'}`,result.pending?'warn':'good');}
}
async function editRoot(id: string | undefined) {
    ensureWritable('settings');let roots=data<ListResponse<Root>>('roots');
    if(!roots){await load('roots',true);roots=data<ListResponse<Root>>('roots');}
    const existing=roots?.items.find(root=>root.id===id);
    if(id&&!existing)throw new Error('根目录当前不可读取，请刷新工作空间后重试。');
    let revision:number|null=null,baseline:FieldValues={},snapshot:NodeSettingsSnapshot|undefined,intent=new WriteIntent(API,'roots/save');
    const result=await dialog({title:existing?'编辑根目录':'添加根目录',wide:true,confirm:'保存根目录',
        body:`<div data-settings-state>${settingsStateNotice(undefined)}</div><div class="field-grid"><label class="field">所在机器<select class="select" name="nodeId" ${existing?'disabled':''}>${(fleet()?.nodes||[]).map(n=>opt(n.id,n.name,existing?.nodeId||fleet()?.nodes?.[0]?.id||'')).join('')}</select></label><label class="field">稳定 ID<input class="input mono" name="id" value="${esc(existing?.localId||'')}" pattern="[-a-zA-Z0-9_.]{1,64}" required ${existing?'readonly':''} placeholder="s1-research"></label><label class="field full">目录昵称<input class="input" name="name" value="${esc(existing?.name||'')}" required maxlength="100"></label><label class="field full">该机器上的绝对路径<input class="input mono" name="path" value="${esc(existing?.path||'')}" required placeholder="/data/projects 或 E:/Projects"></label><label class="field full">用途说明<textarea name="description" rows="2" maxlength="1000">${esc(existing?.description||'')}</textarea></label><label class="field full">标签（逗号分隔）<input class="input" name="tags" value="${esc(existing?.tags.join(', ')||'')}" maxlength="300"></label><label class="switch"><input type="checkbox" name="enabled" ${existing?.enabled!==false?'checked':''}>向 MCP 提供</label><label class="switch"><input type="checkbox" name="readOnly" disabled title="执行节点当前不支持根目录级只读设置" ${existing?.readOnly?'checked':''}>只读访问</label></div>`,
        onMount:d=>{
            baseline=readFields(d.querySelector('form')!);allowSettingsSave(d,false);
            const refresh=d.querySelector<HTMLButtonElement>('[data-dialog-refresh]')!;
            d.querySelector('[name=nodeId]')?.addEventListener('change',()=>refresh.click());refresh.click();
        },refresh:async d=>{
            revision=null;allowSettingsSave(d,false);
            const select=d.querySelector<HTMLSelectElement>('[name=nodeId]')!;select.disabled=true;
            try{
                snapshot=await readNodeSettings(select.value);const settings=snapshot.settings!;
                let message='已读取所选节点的当前配置，新的目录输入已保留。';
                if(existing){
                    const remoteRoot=snapshot.roots.find(root=>root.id===existing.id);
                    if(!remoteRoot)throw new Error('此根目录已从保存的配置中移除，请关闭后重新查看。');
                    const remote:FieldValues={nodeId:remoteRoot.nodeId,id:remoteRoot.localId,name:remoteRoot.name,path:remoteRoot.path,description:remoteRoot.description,tags:remoteRoot.tags.join(', '),enabled:remoteRoot.enabled,readOnly:remoteRoot.readOnly};
                    message=refreshFields(d.querySelector('form')!,baseline,remote);baseline=remote;
                }
                revision=settings.revision;updateHTML(d.querySelector('[data-settings-state]'),settingsStateNotice({...settings,savedRevision:settings.savedRevision??settings.revision}));
                allowSettingsSave(d,revision!==null);intent=new WriteIntent(API,'roots/save');
                return revision===null?'尚未取得可保存的配置版本，请重试读取。':message;
            }finally{select.disabled=Boolean(existing);}
        },onSubmit:form=>{
            if(revision===null||!snapshot)throw new ApiError('请先读取所选节点的当前配置版本。',409,'settings_unavailable',{effect:'none'});
            const f=formObject(form),fd=new FormData(form),nodeId=existing?.nodeId||f.nodeId;
            const root={id:existing?.id||f.id.trim(),nodeId,name:f.name.trim(),path:f.path.trim(),description:f.description.trim(),tags:[...new Set(f.tags.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean))],enabled:fd.has('enabled'),readOnly:baseline.readOnly===true};
            if(!existing&&snapshot.roots.some(value=>value.localId===root.id))throw new Error('该节点已有相同稳定 ID 的根目录，请选择不同 ID 或编辑原目录。');
            const windows=node(nodeId)?.os==='windows';if(windows?!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(root.path):!root.path.startsWith('/'))throw new Error(windows?'请填写 Windows 绝对路径，例如 E:/Projects':'请填写 Linux 绝对路径，例如 /data/projects');
            return intent.submit<{saved?:boolean;pending?:boolean;appliedRevision?:number}>({root,create:!existing,expectedRevision:revision});
        }});
    if(result){await invalidateAfterWrite();toast(result.pending?'根目录配置已保存，仍待节点应用；可在节点详情读取配置状态。':'根目录配置已保存，可在节点详情核对应用版本。',result.pending?'warn':'good');}
}
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
    const intent = new WriteIntent(API,'egress/sync');
    const result = await dialog({
      title: '确认同步出口配置', wide: true, danger: true, confirm: '校验并同步',
      body: `<p>来源：${text ? '上传文件 ' + esc(upload!.name) : esc(node(sourceNodeId)?.name)}。目标 ${nodeIds.length} 台；${request.reload ? '校验通过后热加载' : '仅保存，不热加载'}。</p><div class="panel">${nodeIds.map(id => `<div class="panel-foot">${nodeTag(id)}<span class="spacer"></span><code class="break">${esc(node(id)?.egress?.config)}</code></div>`).join('')}</div>`,
      onSubmit: () => intent.submit<{ results: Array<{ nodeId: string; ok: boolean; reloaded: boolean; error?: string }> }>(request),
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
    const o = overview();
    if (o) [...o.active, ...o.current, ...o.olderOpen, ...o.recent].forEach(r => runs.set(r.id, r));
    [...runs.values()].filter(r => [r.title, r.id, r.projectName].join(' ').toLowerCase().includes(q)).slice(0, 12).forEach(r => items.push({ type: '已加载任务', title: r.title, description: r.projectName, icon: 'tasks', action: () => navigate('tasks', { run: r.id }) }));
    projects().filter(p => [p.name, p.path].join(' ').toLowerCase().includes(q)).slice(0, 8).forEach(p => items.push({ type: '项目', title: p.name, description: node(p.nodeId)?.short, icon: 'workspaces', action: () => navigate('tasks', { project: p.id }) }));
    (fleet()?.nodes || []).filter(n => (n.name + ' ' + n.id).toLowerCase().includes(q)).forEach(n => items.push({ type: '机器', title: n.name, description: n.id, icon: 'machines', action: () => openNode(n.id) }));
    items.push({ type: '完整任务搜索', title: '搜索全部任务 “' + query + '”', description: '全部历史', icon: 'search', action: () => navigate('tasks', { q: query, days: '0' }) });
} return items.slice(0, 40); }
function openPalette() { if ($<HTMLDialogElement>('dialog.palette-dialog'))
    return; const previous = document.activeElement, d = document.createElement('dialog'); d.className = 'palette-dialog'; d.setAttribute('aria-label', '搜索与命令面板'); d.innerHTML = `<div class="palette-input">${icon('search', 18)}<input type="search" placeholder="搜索页面、命令、项目或执行 ID…" role="combobox" aria-autocomplete="list" aria-controls="palette-results" aria-expanded="true" autocomplete="off" aria-label="搜索命令"><kbd>Esc</kbd></div><div class="palette-results" id="palette-results" role="listbox" aria-label="搜索结果"></div><footer class="palette-foot"><span>↑ ↓ 选择</span><span>Enter 打开</span></footer>`; document.body.append(d); let directoryTimer: ReturnType<typeof setTimeout> | undefined; let idx = 0, items: ReturnType<typeof paletteItems> = []; const input = $<HTMLInputElement>('input', d)!; const draw = () => { items = paletteItems(input.value); idx = clamp(idx, 0, Math.max(0, items.length - 1)); let group = ''; $('#palette-results', d)!.innerHTML = items.map((item, i) => { const label = group !== item.type ? `<div class="palette-group" role="presentation">${esc(item.type)}</div>` : ''; group = item.type; return label + `<button type="button" class="palette-item" role="option" id="palette-option-${i}" data-palette="${i}" aria-selected="${i === idx}" tabindex="-1">${icon(item.icon, 16)}<span class="ellipsis">${esc(item.title)}</span><small>${esc(item.description || '')}</small></button>`; }).join('') || empty('没有结果'); const directory = CACHE.get('projects'), directorySources = (directory?.data as ListResponse<Project> | undefined)?.sources || [], directoryWarnings = sourceWarnings([directory]); const directoryNotice = directory?.error ? '工作区目录读取失败：' + readFailureMessage(directory.error) : directoryWarnings.length ? '工作区目录待更新：' + directoryWarnings.map(sourceReadMessage).join('；') : !directory?.data || directorySources.some(source => ['loading','refreshing'].includes(source.state)) ? '正在读取工作区目录…' : ''; if (directoryNotice) $('#palette-results', d)!.insertAdjacentHTML('beforeend', '<div class="palette-group">' + esc(directoryNotice) + '</div>'); input.setAttribute('aria-activedescendant', 'palette-option-' + idx); $('[aria-selected=true]', d)?.scrollIntoView({ block: 'nearest' }); }; const close = () => { clearTimeout(directoryTimer); d.close(); d.remove(); paletteState = null; if (previous instanceof HTMLElement && previous.isConnected)
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
} }); d.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    close();
}); d.addEventListener('cancel', e => { e.preventDefault(); close(); }); d.showModal(); draw(); input.focus();
    const readDirectory = async () => {
        clearTimeout(directoryTimer);
        if (!d.isConnected || document.hidden || backgroundPaused || authRequired) return;
        await load('projects');
        if (!d.isConnected || document.hidden || backgroundPaused || authRequired) return;
        draw();
        const entry = CACHE.get('projects'), sources = (entry?.data as ListResponse<Project> | undefined)?.sources || [];
        if (!entry?.error && (!entry?.data || sources.some(source => ['loading','refreshing'].includes(source.state))))
            directoryTimer = setTimeout(() => void readDirectory(), 1_000);
    };
    paletteState = {close, pause:() => clearTimeout(directoryTimer), resume:() => void readDirectory()};
    void readDirectory();
}
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
    'toggle-file': (el: HTMLElement) => { const d = data<RunDetail>(detailPath())!, opened = openFiles(d); opened.has(el.dataset.id!) ? opened.delete(el.dataset.id!) : opened.add(el.dataset.id!); ensureRoute(); schedulePaint(); },
    'files-toggle-all': () => { const d = data<RunDetail>(detailPath())!, opened = openFiles(d), files = visibleFiles(d), expand = files.some(f => !opened.has(f.id)); files.forEach(f => expand ? opened.add(f.id) : opened.delete(f.id)); ensureRoute(); schedulePaint(); },
    'skip-content': () => $('#view')!.focus(), nav: (el: HTMLElement) => navigate(el.dataset.view!), 'nav-dialog': (el: HTMLElement) => { closeTopDialog(); navigate(el.dataset.view!); }, more: navigationDialog,
    'open-run': (el: HTMLElement) => { if (route.p.run !== el.dataset.id!)
        fileSearch = ''; navigate(route.view === 'changes' ? 'changes' : 'tasks', {run:el.dataset.id!,tab:route.view === 'changes' ? 'diff' : 'summary',file:null,...(route.view === 'usage' ? {days:'0',usageDays:route.p.days || '14',node:route.p.node,project:route.p.project} : route.view === 'sessions' ? {project:route.p.project,node:route.p.node} : {})}, false, route.view === 'tasks' || route.view === 'changes'); },
    'close-inspector': () => { const id=route.p.run; navigate(route.view, { run: null, tab: null, file: null, focus: null, browse: '1' }, false, true); setTimeout(() => { if (lastFocus?.isConnected && !lastFocus.closest('#inspector,.skip-link'))
        lastFocus.focus({ preventScroll: true });
    else
        ((id ? $('.list-pane [data-action="open-run"][data-id="' + CSS.escape(id) + '"]') : null) || $('#view'))?.focus({ preventScroll: true }); }, 30); },
    'phase-page': (el:HTMLElement) => navigate(route.view,{phaseCursor:el.dataset.cursor||null,file:null},false,true),
    'detail-tab': (el: HTMLElement) => navigate(route.view, { tab: el.dataset.value! }, true, true), file: (el: HTMLElement) => navigate(route.view, { file: el.dataset.id! }, true, true),
    'load-big': (el: HTMLElement) => { loadedBigFiles.add(el.dataset.run! + ':' + el.dataset.id!); ensureRoute(); schedulePaint(); }, 'copy-path': (el: HTMLElement) => copy(el.dataset.text!), 'copy-link': () => copy(location.href), copy: (el: HTMLElement) => copy(el.dataset.text!),
    'more-diff': (el: HTMLElement) => { const key = el.dataset.run! + ':' + el.dataset.id!; diffLimits.set(key, (diffLimits.get(key) || 400) + 400); schedulePaint(); }, 'diff-mode': (el: HTMLElement) => { diffMode = el.dataset.value!; savePref({diffMode}); schedulePaint(); }, layout: (el: HTMLElement) => { sortLayout = el.dataset.value!; savePref({taskLayout:sortLayout}); schedulePaint(); }, 'machine-layout': (el: HTMLElement) => { machineLayout = el.dataset.value!; savePref({machineLayout}); schedulePaint(); },
    'running-queue': () => navigate('tasks', { stage: 'running,stopping', days:'0' }), 'review-queue': () => navigate('tasks', { status: 'review', days: '0' }), 'completed-queue': () => navigate('tasks', { days: '0', requestState: 'closed', resultStatus: 'completed', finishedDay: day(Date.now()) }), 'attention-queue': () => navigate('tasks', { days: '0', attention: '1' }), 'usage-nav': () => navigate('usage'),
    'current-task-queue': () => navigate('tasks', { days: '0', requestState: 'active', overviewGroup: 'current' }),
    'older-task-queue': () => navigate('tasks', { days: '0', requestState: 'active', overviewGroup: 'olderOpen' }),
    'clear-overview-group': () => param({overviewGroup:null,scope:'all'}),
    'all-task-queue': () => navigate('tasks',{scope:'all',days:'0'}),
    'closed-task-queue': () => navigate('tasks', { days: '0', requestState: 'closed' }),
    'overview-task-action': (el: HTMLElement) => navigate('tasks', { run: el.dataset.id!, tab: el.dataset.kind === 'review' ? 'diff' : 'summary', days: '0' }),
    status: (el: HTMLElement) => param({ status: el.dataset.value!, stage:null, attention:null }), 'reset-filters': () => navigate(route.view, {}, true), 'clear-date': () => param({ date: null }), 'clear-finished': () => param({ finishedDay: null, execution: null, resultStatus: null }), 'clear-attention': () => param({ attention: null }), page: (el: HTMLElement) => { selectedRuns.clear(); param({ cursor: el.dataset.value! || null }); $('.list-pane')?.scrollTo({ top: 0 }); $('#view')!.scrollTo({ top: 0 }); },
    'clear-selection': () => { selectedRuns.clear(); schedulePaint(); }, 'clear-threads': () => { selectedThreads.clear(); schedulePaint(); },
    'single-accept': (el: HTMLElement) => reviewRuns([el.dataset.id!], 'accept'), 'single-reject': (el: HTMLElement) => reviewRuns([el.dataset.id!], 'reject'), 'bulk-accept': () => reviewRuns([...selectedRuns], 'accept'), 'bulk-reject': () => reviewRuns([...selectedRuns], 'reject'),
    'bulk-copy': () => copy([...selectedRuns].map(id => { const r = findLoadedRun(id); return r ? r.nodeId + '/exec/' + r.id : id; }).join('\n')),
    'run-control': (el: HTMLElement) => runControl(el.dataset.id!, el.dataset.value!), patch: (el: HTMLElement) => getPatch(el.dataset.id!), revert: (el: HTMLElement) => revertRun(el.dataset.id!),
    refresh: () => refresh(true), retry: (el: HTMLElement) => load(el.dataset.path!, true), theme: () => { savePref({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }); schedulePaint(); }, sidebar: () => { savePref({ sidebar: pref.sidebar === 'expanded' ? 'collapsed' : 'expanded' }); schedulePaint(); }, palette: openPalette,
    node: (el: HTMLElement) => openNode(el.dataset.id!, el.dataset.tab), 'node-edit-from-drawer': (el: HTMLElement) => { const id = el.dataset.id!; closeTopDialog(); return openNode(id, 'settings'); },
    'project-tasks': (el: HTMLElement) => navigate('tasks', { project: el.dataset.id!, node:route.p.node, days:route.view === 'usage' || el.dataset.usageDays ? '0' : route.p.days || '0', date:route.p.date, usageDays:el.dataset.usageDays || (route.view === 'usage' ? route.p.days || '14' : route.p.usageDays),usageDate:route.p.usageDate }), 'session-project': (el: HTMLElement) => { selectedThreads.clear(); storage.set('quaymesh.last-project', el.dataset.id!); navigate('sessions', { project: el.dataset.id! }); }, 'session-back': () => navigate('sessions', { picker: '1' }),
    'session-tab': (el: HTMLElement) => param({ tab: el.dataset.value! }), 'session-filter': (el: HTMLElement) => { selectedThreads.clear(); param({ state: el.dataset.value! }); }, 'session-control': (el: HTMLElement) => sessionControl(el.dataset.id!, el.dataset.value!), 'session-info': (el: HTMLElement) => { const t = currentSessions()?.items.find(t => t.id === el.dataset.id!); if (!t)
        throw new Error('会话未加载'); return dialog({ title: '会话身份与归档条件', confirm: null, cancel: '关闭', body: `<dl class="key-values"><div><dt>会话 ID</dt><dd class="mono">${esc(t.id)}</dd></div><div><dt>当前轮次</dt><dd class="mono">${esc(t.turnId)}</dd></div><div><dt>资源版本</dt><dd>rev ${t.revision}</dd></div><div><dt>当前控制权</dt><dd>${esc(t.control)}</dd></div><div><dt>归属已核实</dt><dd>${t.verified ? '是' : '否'}</dd></div><div><dt>归档保护</dt><dd>${esc(t.skipReason || '当前无阻止条件')}</dd></div></dl>` }); },
    protect: async (el: HTMLElement) => { ensureWritable(); const t = currentSessions()?.items.find(t => t.id === el.dataset.id!); if (!t)
        throw new Error('会话未加载'); await API.post<{ saved?: boolean; ok?: boolean }>('sessions/' + enc(t.id) + '/protect', { protected: !t.protected, expectedRevision: t.protectRevision }); await invalidateAfterWrite(); toast(t.protected ? '已取消保留' : '已保留会话', 'good'); }, 'archive-preview': (el: HTMLElement) => archivePreview(el.dataset.value!),
    'root-expand': (el: HTMLElement) => { expandedRoots.has(el.dataset.id!) ? expandedRoots.delete(el.dataset.id!) : expandedRoots.add(el.dataset.id!); schedulePaint(); }, 'root-edit': (el: HTMLElement) => editRoot(el.dataset.id!),
    'activity-kind': (el: HTMLElement) => { activityPaused = false; navigate('activity', { kind: el.dataset.value! }); }, 'activity-pause': () => { activityPaused = !activityPaused; ensureRoute(); schedulePaint(); }, 'event-hour': (el: HTMLElement) => param({ hour: el.dataset.value!, cursor: null }), 'clear-hour': () => param({ hour: null, cursor: null }),
    'usage-date': (el: HTMLElement) => navigate('tasks', { usageDate:el.dataset.value!,usageDays:route.p.days || '14',days:'0',node:route.p.node,project:route.p.project }),
    'clear-usage-range':()=>param({usageDate:null,usageDays:null}),
    'evidence-events':(el:HTMLElement)=>navigate('activity',{kind:'events',q:el.dataset.reference}),
    diagnostics,
    'finish-task': (el:HTMLElement) => finishTask(el.dataset.id!),
    'receipt-query': async (el:HTMLElement) => { await API.get('receipts/' + enc(el.dataset.id) + '?path=' + enc(el.dataset.path) + '&target=' + enc(el.dataset.target)); await load('receipts?limit=50',true); toast('已查询原请求结果'); },
    'global-sessions': () => navigate('sessions', {q:route.view === 'sessions' ? route.p.q : undefined,node:route.p.node}),
    'task-scope': (el:HTMLElement) => setTaskScope(el.dataset.value!),
    'review-mode':(el:HTMLElement)=>param({reviewMode:el.dataset.value!,status:null,stage:null,attention:null,run:null,cursor:null}),
    'settings-section': (el: HTMLElement) => navigate('settings', { section: el.dataset.value! }), 'api-settings': () => navigate('settings', { section: 'connection' }), 'egress-settings': () => navigate('settings', { section: 'egress' }),
    preference: (el: HTMLElement) => { const k = el.dataset.key!, v = k === 'poll' ? Number(el.dataset.value!) : el.dataset.value!; savePref({ [k]: v }); if (k === 'poll')
        schedulePoll(); schedulePaint(); },
    'egress-sync': syncEgress,
    'reset-preferences': async () => { if (!await confirmAction('恢复本机默认偏好？', '<p>将恢复当前浏览器的外观与刷新设置。</p>', '恢复默认'))
        return; notificationReader?.cancel(); notificationReader = null; notificationGaps.clear(); if (notificationStorageKey) storage.del(notificationStorageKey); pref = { ...DEFAULTS }; savePref(pref); CACHE.clear(); await bootstrap(); },
    reconnect: () => bootstrap(),
    'desktop-browser': () => notifyDesktop('external'),
    'desktop-settings': () => notifyDesktop('settings'),
    'waiting-queue': () => navigate('tasks', { stage:'waiting,stalled,finalizing', days:'0' }),
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
        throw new Error('传输记录未加载'); const intent = new WriteIntent(API,'transfers/cancel'); const result = await dialog({ title: '取消文件传输？', danger: true, confirm: '取消传输', body: `<p>${esc(t.source)} → ${esc(t.destination)}</p><p>已传输的文件将保留。</p>`, onSubmit: () => intent.submit<{ transfer?: { status: string } }>({ id: t.id, expectedRevision: t.revision }) }); if (result) {
        await invalidateAfterWrite();
        toast(result.transfer?.status === 'cancelled' ? '已收到取消回执' : '取消已请求，等待回执', 'info');
    } },
    'export-runs': () => { const d = data<RunPage>(runPath()); if (!d)
        return; const rows = [['id', 'title', 'node', 'project', 'executionStatus', 'acceptanceStatus', 'tokens', 'usageQuality', 'startedAt'], ...taskPageProjection(d).items.map(r => [r.id, r.title, r.nodeId, r.projectId, r.executionStatus, r.acceptanceStatus, r.usage?.total ?? '', r.usage?.quality, new Date(r.startedAt).toISOString()])]; download('quaymesh-runs-page.csv', '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8'); },
    'export-activity': () => { const d = data<ActivityPage>(activityPath()); if (d)
        download('quaymesh-activity-page.json', JSON.stringify(d, null, 2), 'application/json'); },
    'export-usage': () => { const u = data<UsageReport>(usagePath()); if (u)
        download('quaymesh-usage.json', JSON.stringify({exportedAt:new Date().toISOString(),query:usagePath(),timeZone:timeZone() || deviceTimeZone,...u},null,2), 'application/json'); },
    'export-diagnostics': () => download('quaymesh-console-diagnostics.json', JSON.stringify(diagnosticSnapshot(),null,2), 'application/json'), shortcuts: () => dialog({ title: '工作台快捷键', wide: true, confirm: null, cancel: '关闭', body: `<div class="key-grid">${KEYS.map(([k, t]) => `<div><span>${t}</span><kbd>${k}</kbd></div>`).join('')}</div>` })
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
        if (el.dataset.taskScope) setTaskScope(el.value);
        else if (el.dataset.param) {
            const key = el.dataset.param;
            param({ [key]: el.value, ...(key === 'node' ? { project: null } : {}), ...(key === 'status' ? {stage:null,attention:null,...(route.p.overviewGroup === 'current' ? {overviewGroup:null,requestState:null,scope:'all'} : {})} : {}), ...(key === 'requestState' ? {status:null,stage:null,attention:null,overviewGroup:null} : {}) });
        }
        else if (el.dataset.selectRun) {
            el.checked ? selectedRuns.add(el.dataset.selectRun) : selectedRuns.delete(el.dataset.selectRun);
            schedulePaint();
        }
        else if (el.dataset.selectAll === 'runs') {
            const rows = taskPageProjection(data<RunPage>(runPath())).items;
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
            notificationReader?.cancel(); notificationReader = null; notificationGaps.clear();
            if (notificationStorageKey) storage.del(notificationStorageKey);
            pollNotifications();
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
      validateSession(session);
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
document.addEventListener('keydown', event => {
    if (event.isComposing || ['Shift','Control','Alt','Meta'].includes(event.key)) return;
    const firstKeyboardFocus = document.documentElement.dataset.inputMethod !== 'keyboard';
    document.documentElement.dataset.inputMethod = 'keyboard';
    // If the native shell preselected the first link, the first Tab reveals it instead of skipping it.
    if (firstKeyboardFocus && event.key === 'Tab' && !event.shiftKey && document.activeElement?.matches('.skip-link')) event.preventDefault();
}, true);
document.addEventListener('pointerdown', () => { document.documentElement.dataset.inputMethod = 'pointer'; }, true);
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
        const rows = taskPageProjection(data<RunPage>(runPath())).items, idx = rows.findIndex(r => r.id === route.p.run), r = rows[clamp(idx + (e.key === 'j' ? 1 : -1), 0, rows.length - 1)];
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
        pausePendingReads();
        paletteState?.pause();
        resources.cancelAll(); commandReader.cancelAll(); notificationReader?.cancel();
    }
    else {
        attachClock();
        ensureRoute();
        refresh();
        schedulePoll();
        paletteState?.resume();
    }
});
addEventListener('pagehide', () => { pausePendingReads(); clearTimeout(refreshTimer); clearTimeout(clockTimer); paletteState?.pause(); resources.cancelAll(); commandReader.cancelAll(); notificationReader?.cancel(); });
addEventListener('online', () => { backgroundPaused = false; refresh(); schedulePoll(); paletteState?.resume(); });
addEventListener('offline', () => { backgroundPaused = true; pausePendingReads(); clearTimeout(refreshTimer); paletteState?.pause(); resources.cancelAll(); commandReader.cancelAll(); notificationReader?.cancel(); toast('浏览器离线，保留已读取的内容。', 'warn'); schedulePaint(); });
let notificationReader: EventNotifications | null = null, notificationStorageKey = '';
const notificationGaps = new Map<string,string>();
function pollNotifications() {
    if (!pref.notifications || !API.session || document.hidden || backgroundPaused || authRequired || booting) return;
    const key = 'quaymesh.notifications.v1:' + API.base() + ':' + API.session.user.name;
    if (!notificationReader || notificationStorageKey !== key) {
        notificationReader?.cancel(); notificationStorageKey = key; notificationGaps.clear();
        notificationReader = new EventNotifications({
            memory:storage.get<NotificationMemory>(key,{}),
            read:(nodeId,cursor,signal) => API.get<NotificationPage>('activity?' + queryString({kind:'events',level:'error',limit:100,node:nodeId,after:cursor?.after,afterId:cursor?.afterId}),signal),
            save:memory=>storage.set(key,memory),
            gap:(nodeId,message)=>{ if (message) notificationGaps.set(nodeId,message); else notificationGaps.delete(nodeId); schedulePaint(); },
            emit:(nodeId,events)=>{
                if (!pref.notifications || authRequired) return;
                const title = (node(nodeId)?.name || nodeId) + ' · ' + events.length + ' 条新错误';
                toast(title,'bad');
                if (globalThis.Notification?.permission === 'granted') {
                    const notification = new Notification('QuayMesh · ' + title,{body:events.slice(0,3).map(event=>event.message).join('\n'),tag:'quaymesh-errors-'+nodeId});
                    notification.onclick=()=>{ window.focus(); navigate('activity',{kind:'events',level:'error',node:nodeId}); notification.close(); };
                }
            },
        });
    }
    void notificationReader.poll((fleet()?.nodes || []).map(item=>item.id));
}
let clockTimer: ReturnType<typeof setTimeout> | undefined, clockNodes: HTMLElement[] = [];
let fleetWasCurrent = false;
let overviewDisplayDeadline: number | null = null;
function tickClock() {
    clearTimeout(clockTimer);
    if (document.hidden)
        return;
    const now = Date.now();
    clockNodes = clockNodes.filter((el: HTMLElement) => el.isConnected);
    for (const el of clockNodes) {
        const observed = Number(el.dataset.observed), stale = observed > 0 && now - observed > 30_000;
        const text = duration((stale ? observed : now) - Number(el.dataset.elapsed)) + (stale ? ' · 待核对' : '');
        if (stale) el.title = '截至最后确认 ' + fullTime(observed);
        if (el.textContent !== text)
            el.textContent = text;
    }
    const observation = fleetObservation();
    if (fleetWasCurrent && !observation.current) schedulePaint();
    if (overviewDisplayDeadline !== null && now >= overviewDisplayDeadline) {
        overviewDisplayDeadline = null;
        schedulePaint();
    }
    fleetWasCurrent = observation.current;
    const deadlines = [observation.current ? observation.expiresAt : null, overviewDisplayDeadline]
        .filter((at): at is number => at !== null && at > now);
    if (clockNodes.length)
        clockTimer = setTimeout(tickClock, 1000 - now % 1000);
    else if (deadlines.length)
        clockTimer = setTimeout(tickClock, Math.max(1, Math.min(...deadlines) - now));
}
function attachClock() {
    clockNodes = $$('[data-elapsed]'); fleetWasCurrent = fleetObservation().current;
    const observation = overviewObservation(), o = overview(), now = Date.now();
    const taskTimes = o ? [...o.taskSources, ...(route.view === 'overview' ? [...o.current, ...o.olderOpen, ...o.attention] : [])].map(item => item.observedAt) : [];
    const taskRows = [...activePaths].flatMap((path): Run[] => {
        if (path.startsWith('overview')) { const value=data<Overview>(path);return value ? [...value.current,...value.olderOpen,...value.recent] : []; }
        if (path.startsWith('runs?')) return data<RunPage>(path)?.items || [];
        if (/^runs\/[^/]+$/.test(path.split('?')[0]!)) { const value=data<RunDetail>(path);return value ? [value.run] : []; }
        return [];
    }).filter(run => run.requestState !== 'closed');
    const activityDeadlines = taskRows.flatMap(run => {
        const progress = run.lastProgressAt ?? run.lastActivityAt;
        return [typeof run.executionObservedAt === 'number' && Number.isFinite(run.executionObservedAt) ? run.executionObservedAt + TASK_EXECUTION_FRESHNESS_MS : null,
            typeof progress === 'number' && Number.isFinite(progress) ? progress + TASK_SILENCE_MS : null];
    });
    const deadlines = [observation.current ? observation.expiresAt : null,
        ...taskTimes.map(at => typeof at === 'number' && Number.isFinite(at) ? at + 30_001 : null),...activityDeadlines]
        .filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > now);
    overviewDisplayDeadline = deadlines.length ? Math.min(...deadlines) : null;
    tickClock();
}
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
    if (values.run && !/^(?:qm|qmtask|task):/.test(values.run)) values.run = workspaceHandle(nodeId, values.run);
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
        validateSession(session);
        API.session = session;
        API.csrf = session.csrf;
    }
    if (API.session) validateSession(API.session);
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
