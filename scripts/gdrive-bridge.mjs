import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";

const INLINE_BYTES = 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const FILE_ID = /^[A-Za-z0-9_-]{10,128}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?)?$/u;
const HELP = [
  "Usage:",
  "  node scripts/gdrive-bridge.mjs pull --file-id ID --out PATH [--sha256 HEX] [--allow-html]",
  "  node scripts/gdrive-bridge.mjs push --file PATH --folder-id ID [--name NAME] [--mime-type TYPE]",
  "  node scripts/gdrive-bridge.mjs encode --file PATH",
  "  node scripts/gdrive-bridge.mjs decode --base64 TEXT --out PATH [--sha256 HEX]",
  "",
  "Use GDRIVE_ACCESS_TOKEN for private downloads and uploads. Push requires an explicit",
  "--folder-id or GDRIVE_FOLDER_ID. HTTP_PROXY/HTTPS_PROXY/NO_PROXY are honored;",
  "--proxy URL overrides them. Network requests accept --timeout-ms (default 300000).",
  "Encode/decode accept up to 1 MiB. For larger VM transfers, use read encoding=base64",
  "pages or Google Drive. Existing output files are never overwritten.",
].join("\n");

function requireValue(value, name) {
  if (!value) throw new Error("Missing " + name);
  return value;
}

function fileId(value, name = "--file-id") {
  requireValue(value, name);
  if (!FILE_ID.test(value)) throw new Error("Invalid " + name);
  return value;
}

function digest(value) {
  if (value === undefined) return undefined;
  const normalized = value.replace(/^sha256:/u, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error("Expected a SHA-256 hex digest");
  return normalized;
}

function googleUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (url.port && url.port !== "443")
    || url.username || url.password || url.hash
    || !(["drive.google.com", "drive.usercontent.google.com", "docs.google.com", "www.googleapis.com"].includes(host)
      || host.endsWith(".googleusercontent.com") || host.endsWith(".googlevideo.com"))) {
    throw new Error("Untrusted Google Drive URL");
  }
  return url;
}

async function publishNewFile(out, write) {
  await mkdir(dirname(out), { recursive: true });
  const partial = out + "." + randomUUID() + ".part";
  try {
    const result = await write(partial);
    await link(partial, out);
    return result;
  } finally {
    await rm(partial, { force: true });
  }
}

async function pull(flags, token, request) {
  const id = fileId(flags["file-id"]);
  const out = resolve(requireValue(flags.out, "--out"));
  const expected = digest(flags.sha256);
  let url = googleUrl(token
    ? "https://www.googleapis.com/drive/v3/files/" + id + "?alt=media"
    : "https://drive.usercontent.google.com/download?id=" + id + "&export=download&confirm=t");
  let response;
  for (let redirects = 0; redirects <= 6; redirects++) {
    response = await request(url, {
      headers: token && url.hostname === "www.googleapis.com" ? { Authorization: "Bearer " + token } : {},
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 6) throw new Error("Invalid Google Drive redirect");
    url = googleUrl(new URL(location, url));
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Google Drive download failed: HTTP " + response.status);
  }
  if (response.headers.get("content-type")?.split(";")[0].trim() === "text/html" && !flags["allow-html"]) {
    await response.body.cancel();
    throw new Error("Google Drive returned HTML; use GDRIVE_ACCESS_TOKEN or enable file sharing");
  }
  const result = await publishNewFile(out, async partial => {
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) { hash.update(chunk); size += chunk.length; yield chunk; }
      },
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    const sha256 = hash.digest("hex");
    if (expected && sha256 !== expected) throw new Error("Downloaded SHA-256 does not match");
    return { size, sha256 };
  });
  return { ok: true, path: out, gdrive_file_id: id, ...result };
}

async function push(flags, env, request) {
  const token = requireValue(env.GDRIVE_ACCESS_TOKEN?.trim(), "GDRIVE_ACCESS_TOKEN");
  const folder = fileId(flags["folder-id"] || env.GDRIVE_FOLDER_ID, "--folder-id or GDRIVE_FOLDER_ID");
  const file = resolve(requireValue(flags.file, "--file"));
  if (!(await stat(file)).isFile()) throw new Error("--file must name a regular file");
  const name = flags.name || basename(file);
  const mimeType = flags["mime-type"] || "application/octet-stream";
  const blob = await openAsBlob(file, { type: mimeType });
  const hash = createHash("sha256");
  for await (const chunk of blob.stream()) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const headers = { Authorization: "Bearer " + token };
  const start = await request("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink", {
    method: "POST", redirect: "error",
    headers: { ...headers, "Content-Type": "application/json",
      "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(blob.size) },
    body: JSON.stringify({ name, parents: [folder] }),
  });
  const location = start.headers.get("location");
  await start.body?.cancel();
  if (!start.ok || !location) throw new Error("Google Drive upload initialization failed: HTTP " + start.status);
  const uploadUrl = googleUrl(location);
  if (uploadUrl.hostname !== "www.googleapis.com") throw new Error("Unexpected Google Drive upload host");
  let offset = 0;
  let retries = 0;
  while (true) {
    const end = Math.min(blob.size, offset + UPLOAD_CHUNK_BYTES);
    const probeOnly = blob.size > 0 && offset === blob.size;
    let response;
    try {
      response = await request(uploadUrl, {
        method: "PUT", redirect: "error",
        headers: { ...headers, "Content-Type": mimeType, "Content-Length": String(end - offset),
          ...(blob.size ? { "Content-Range": probeOnly ? "bytes */" + blob.size
            : "bytes " + offset + "-" + (end - 1) + "/" + blob.size } : {}) },
        ...(probeOnly ? {} : { body: blob.slice(offset, end) }),
      });
    } catch (error) {
      if (++retries > 3) throw error;
    }
    if (!response || response.status >= 500) {
      await response?.body?.cancel();
      if (response && ++retries > 3) throw new Error("Google Drive upload retry limit exceeded");
      response = await request(uploadUrl, {
        method: "PUT", redirect: "error",
        headers: { ...headers, "Content-Length": "0", "Content-Range": "bytes */" + blob.size },
      });
    }
    if (response.ok) {
      const created = await response.json();
      if (!created.id) throw new Error("Google Drive upload response omitted its file ID");
      return { ok: true, path: file, gdrive_file_id: created.id, name: created.name || name,
        size: blob.size, sha256, webViewLink: created.webViewLink };
    }
    const range = response.headers.get("range");
    await response.body?.cancel();
    if (response.status !== 308) throw new Error("Google Drive upload failed: HTTP " + response.status);
    const match = range === null ? null : /^bytes=0-(\d+)$/u.exec(range);
    if (range !== null && !match) throw new Error("Invalid Google Drive upload range");
    const next = match ? Number(match[1]) + 1 : 0;
    if (!Number.isSafeInteger(next) || next < offset || next > end) throw new Error("Invalid Google Drive upload progress");
    if (next === offset) {
      if (++retries > 3) throw new Error("Google Drive upload made no progress");
    } else retries = 0;
    offset = next;
  }
}

async function encode(flags) {
  const file = resolve(requireValue(flags.file, "--file"));
  const info = await stat(file);
  if (!info.isFile() || info.size > INLINE_BYTES) throw new Error("Encode requires a regular file up to 1 MiB");
  const bytes = await readFile(file);
  if (bytes.length > INLINE_BYTES) throw new Error("Encode file exceeds 1 MiB");
  return { ok: true, path: file, file_name: basename(file), size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), content_base64: bytes.toString("base64") };
}

async function decode(flags) {
  if (flags.base64 === undefined) throw new Error("Missing --base64");
  const encoded = flags.base64.replace(/\s+/gu, "");
  if (!BASE64.test(encoded)) throw new Error("Invalid base64 content");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > INLINE_BYTES) throw new Error("Decode content exceeds 1 MiB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = digest(flags.sha256);
  if (expected && expected !== sha256) throw new Error("Decoded SHA-256 does not match");
  const out = resolve(requireValue(flags.out, "--out"));
  await publishNewFile(out, partial => writeFile(partial, bytes, { flag: "wx", mode: 0o600 }));
  return { ok: true, path: out, size: bytes.length, sha256 };
}

export async function runBridge(args, { env = process.env, fetch: suppliedFetch } = {}) {
  const { values: flags, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: Object.fromEntries([
      ...["file-id", "out", "sha256", "file", "folder-id", "name", "mime-type", "base64", "proxy", "timeout-ms"]
        .map(key => [key, { type: "string" }]),
      ["allow-html", { type: "boolean" }], ["help", { type: "boolean", short: "h" }],
    ]),
  });
  if (flags.help) return { help: HELP };
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error("Unexpected positional arguments");
  if (command === "encode") return encode(flags);
  if (command === "decode") return decode(flags);
  if (command !== "push" && command !== "pull") throw new Error(HELP);
  const timeoutMs = Number(flags["timeout-ms"] ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  const dispatcher = suppliedFetch ? undefined : flags.proxy
    ? new ProxyAgent(flags.proxy)
    : new EnvHttpProxyAgent({ httpProxy: env.HTTP_PROXY || env.http_proxy, httpsProxy: env.HTTPS_PROXY || env.https_proxy,
      noProxy: env.NO_PROXY || env.no_proxy });
  const request = (url, init) => (suppliedFetch || undiciFetch)(url, {
    ...init, signal: AbortSignal.timeout(timeoutMs), ...(dispatcher ? { dispatcher } : {}),
  });
  try {
    return command === "pull"
      ? await pull(flags, env.GDRIVE_ACCESS_TOKEN?.trim(), request)
      : await push(flags, env, request);
  } finally {
    await dispatcher?.destroy();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runBridge(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
