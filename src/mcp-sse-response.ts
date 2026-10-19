/** SSE 响应建立后立即发送首块注释，响应仍由 Node 适配器统一写入。 */
export function primeMcpSseResponse(response: Response): Response {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.body || mediaType !== "text/event-stream") return response;

  const reader = response.body.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 注释表示传输已建立，工具进度由真实事件报告。
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
    },
    async pull(controller) {
      try {
        const part = await reader.read();
        if (cancelled) return;
        if (part.done) {
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(part.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
