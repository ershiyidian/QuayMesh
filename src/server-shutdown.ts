export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  report: (event: string) => void = () => {},
  timeoutMs = 15_000,
): Promise<void> {
  report("server_shutdown_started");
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else { report("server_http_drained"); resolve(); }
    });
  }).then(() => undefined, (error: unknown) => ({ error }));

  const waiting = setInterval(() => report("server_shutdown_waiting"), 10_000);
  waiting.unref();
  try {
    report("server_application_close_started");
    let timer: NodeJS.Timeout | undefined;
    const cleanup = closeApplication().then(() => "closed" as const);
    const outcome = timeoutMs > 0
      ? await Promise.race([cleanup, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); })])
      : await cleanup;
    if (timer) clearTimeout(timer);
    report(outcome === "closed" ? "server_application_closed" : "server_application_close_timeout");
    const httpResult = await httpClosed;
    if (httpResult) throw httpResult.error;
    report("server_shutdown_completed");
  } finally {
    clearInterval(waiting);
  }
}
