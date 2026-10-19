/** Give an established SSE response its first wire bytes before the SDK's
 * periodic heartbeat. The Node adapter remains the only response writer. */
export function primeMcpSseResponse(response: Response): Response {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.body || mediaType !== "text/event-stream") return response;

  const reader = response.body.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // A comment establishes transport liveness without claiming tool progress.
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
