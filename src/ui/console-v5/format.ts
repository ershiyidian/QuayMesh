let selectedZone = 'local';
export const setDisplayTimeZone = (zone: string) => { selectedZone = zone; };
export const timeZone = () => selectedZone === 'local' ? undefined : selectedZone;

let formatterZone: string | undefined;
let formatters: { time: Intl.DateTimeFormat; full: Intl.DateTimeFormat; short: Intl.DateTimeFormat; day: Intl.DateTimeFormat } | undefined;

const dayCache = new Map<number, string>();

const numberFormatter = new Intl.NumberFormat('en-US');

function dateFormatters() {
    const zone = timeZone() || 'local';
    if (formatters && zone === formatterZone)
        return formatters;
    formatterZone = zone;
    dayCache.clear();
    const options = { timeZone: timeZone(), hour12: false };
    formatters = {
        time: new Intl.DateTimeFormat('zh-CN', { ...options, hour: '2-digit', minute: '2-digit' }),
        full: new Intl.DateTimeFormat('zh-CN', { ...options, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        short: new Intl.DateTimeFormat('zh-CN', { ...options, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        day: new Intl.DateTimeFormat('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' })
    };
    return formatters;
}

export const tm = (t: number | null | undefined) => t ? dateFormatters().time.format(t) : '—';

export const fullTime = (t: number | null | undefined) => t ? dateFormatters().full.format(t) : '未上报';

export function day(t: number): string {
    const f = dateFormatters(), key = Math.floor(t / 60000);
    if (dayCache.has(key))
        return dayCache.get(key)!;
    const parts = f.day.formatToParts(t), get = (k: string) => parts.find(p => p.type === k)!.value;
    const value = get('year') + '-' + get('month') + '-' + get('day');
    if (dayCache.size >= 2048)
        dayCache.delete(dayCache.keys().next().value!);
    dayCache.set(key, value);
    return value;
}

export const smartTime = (t: number | null | undefined) => !t ? '—' : day(t) === day(Date.now()) ? tm(t) : dateFormatters().short.format(t);

export const ago = (t: number | null | undefined) => !t ? '未知' : Date.now() - t < 60000 ? '刚刚' : Date.now() - t < 3600000 ? Math.floor((Date.now() - t) / 60000) + ' 分钟前' : Date.now() - t < 86400000 ? Math.floor((Date.now() - t) / 3600000) + ' 小时前' : Math.floor((Date.now() - t) / 86400000) + ' 天前';

export function duration(ms: number | null | undefined): string { if (ms == null || ms < 0)
    return '—'; const s = Math.floor(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm'; }

export const fmt = (n: number | null | undefined): string => n == null ? '未知' : numberFormatter.format(Math.round(n));

export const compact = (n: number | null | undefined): string => n == null ? '未知' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : fmt(n);

export function bytes(n: number | null | undefined): string { if (n == null)
    return '未上报'; const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (n >= 1024 && i < 4) {
    n /= 1024;
    i++;
} return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }

export function csvCell(v: unknown): string { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s))
    s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
