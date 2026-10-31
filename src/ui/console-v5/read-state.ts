import type { ConsoleError } from './client.js';

/** Keep transport details in diagnostics, and explain the effect on the visible data. */
export function readFailureMessage(failure: unknown): string {
  const error = failure instanceof Error ? failure as ConsoleError : new Error(String(failure)) as ConsoleError;
  if (error.code === 'CONSOLE_LOGIN_REQUIRED') return '登录已过期，请重新登录后继续读取。';
  if (error.status === 401 || error.status === 403) return '当前登录无权读取这部分数据。';
  if (error.code === 'contract_mismatch') return '控制台与服务版本不一致，请更新后重试。';
  if (error.code === 'timeout' || /超时|timeout|timed out|超过\s*\d+\s*秒/i.test(error.message))
    return '读取用时较长，本次未能取得最新结果。';
  if (error.status === 502 || error.status === 503 || error.status === 504)
    return '服务暂时不可用，恢复后可重试。';
  if (error.status === 404) return '暂时找不到这项记录，可返回列表重新选择。';
  if (error.code === 'invalid_response' || /响应结构|结构不完整|接口缺少|没有返回 JSON/.test(error.message))
    return '收到的数据不完整，暂时无法更新。';
  if (error.code === 'network' || /offline|fetch|ECONN|ENET|连接|离线/i.test(error.message))
    return '连接暂时中断，请检查连接后重试。';
  return '这部分数据暂时未能读取，请重试。';
}

export function readWarningMessage(message: string): string {
  return /\/internal\/|\/api\/|ECONN|ENET|rpc.*timeout/i.test(message)
    ? readFailureMessage(new Error(message)) : message;
}
