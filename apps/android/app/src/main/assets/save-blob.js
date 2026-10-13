(function () {
  "use strict";
  const MAX_CHUNK = 64 * 1024;
  window.quaymeshSaveBlob = async function (url, port) {
    if (location.origin !== new URL(url, location.href).origin) throw new Error("只能保存当前授权来源的文件。");
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok || !response.body) throw new Error("文件读取失败。");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const message = await new Promise(resolve => port.onmessage = event => resolve(event.data));
        if (!message || message.type === "CANCEL") return;
        if (message.type !== "NEXT") throw new Error("保存协议顺序错误。");
        const chunk = await reader.read();
        if (chunk.done) { port.postMessage({ type: "DONE" }); return; }
        if (chunk.value.byteLength > MAX_CHUNK) throw new Error("文件块超过大小限制。");
        port.postMessage({ type: "CHUNK", bytes: chunk.value }, [chunk.value.buffer]);
      }
    } catch (error) { port.postMessage({ type: "ERROR", message: String(error) }); throw error; }
    finally { reader.cancel().catch(() => {}); port.close(); }
  };
}());
