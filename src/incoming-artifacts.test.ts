import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ArtifactError } from "./artifact-error.js";
import {
  IncomingArtifactAdapterRegistry,
  createGoogleDriveIncomingArtifactAdapter,
  createInlineBase64ArtifactAdapter,
  createOpenAIIncomingArtifactAdapter,
  describeIncomingArtifactValue,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";

await testRegistryFailsClosed();
await testOpenAIFileAdapter();
await testInlineBase64Adapter();
await testGoogleDriveAdapter();
testLogShapeRedaction();

async function testRegistryFailsClosed(): Promise<void> {
  const registry = new IncomingArtifactAdapterRegistry();
  await expectArtifactError(
    registry.open("https://example.com/untrusted.bin"),
    "unsupported_incoming_artifact",
  );
  await expectArtifactError(
    registry.open("/tmp/local-file.bin"),
    "unsupported_incoming_artifact",
  );
  await expectArtifactError(
    registry.open(Buffer.from("raw bytes")),
    "unsupported_incoming_artifact",
  );

  const ambiguous: IncomingArtifactAdapter = {
    id: "ambiguous",
    canHandle: () => true,
    async open() {
      return { name: "a.bin", stream: Readable.from(["a"]) };
    },
  };
  const ambiguousRegistry = new IncomingArtifactAdapterRegistry([
    ambiguous,
    { ...ambiguous, id: "ambiguous-two" },
  ]);
  await expectArtifactError(
    ambiguousRegistry.open({ native: true }),
    "ambiguous_incoming_artifact",
  );

  assert.throws(
    () => new IncomingArtifactAdapterRegistry([{ ...ambiguous, id: "UPPER" }]),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_incoming_adapter",
  );
  assert.throws(
    () => new IncomingArtifactAdapterRegistry([ambiguous, ambiguous]),
    (error: unknown) => error instanceof ArtifactError && error.code === "duplicate_incoming_adapter",
  );
}

async function testOpenAIFileAdapter(): Promise<void> {
  const bytes = Buffer.from("chatgpt generated image bytes");
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-type": "image/png",
      },
    });
  };
  const registry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({ fetch: fetchImpl }),
  ]);
  const reference = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  const generatedReference = {
    download_url: "https://oaisdmntprcentralindia.blob.core.windows.net/chatgpt-file/generated-image.png?sig=secret",
    file_id: "file-service://generated+opaque/abc123",
    mime_type: null,
    file_name: null,
    name: "/mnt/data/generated-image.png",
    size: bytes.length,
  };

  const opened = await registry.open(reference);
  assert.equal(opened.adapterId, "openai-file");
  assert.equal(opened.name, "generated.png");
  assert.equal(opened.mimeType, "image/png");
  assert.equal(opened.size, bytes.length);
  assert.deepEqual(await collect(opened.stream), bytes);

  // Real byte ranges are stitched only under a stable strong ETag. A lost
  // response resumes at the last successfully consumed byte, not at zero.
  const rangeBytes=Buffer.from("0123456789abcdef");
  const requestedRanges:string[]=[];
  let dropped=false;
  const ranged=new IncomingArtifactAdapterRegistry([createOpenAIIncomingArtifactAdapter({
    rangeChunkBytes:4,
    fetch:async (_input,init)=>{
      const headers=new Headers(init?.headers);
      const value=headers.get("range")!;
      requestedRanges.push(value);
      const match=/^bytes=(\d+)-(\d+)$/u.exec(value)!;
      const start=Number(match[1]),end=Number(match[2]);
      if(start>0)assert.equal(headers.get("if-range"),'"stable-etag"');
      let body:BodyInit=rangeBytes.subarray(start,end+1);
      if(start===4&&!dropped){
        dropped=true;
        body=new ReadableStream<Uint8Array>({start(controller){
          controller.enqueue(rangeBytes.subarray(4,6));
          controller.error(new Error("connection dropped"));
        }});
      }
      return new Response(body,{status:206,headers:{
        "etag":'"stable-etag"',"content-range":`bytes ${start}-${end}/${rangeBytes.length}`,
      }});
    },
  })]);
  const resumed=await ranged.open({...reference,size:rangeBytes.length});
  assert.equal(resumed.size,rangeBytes.length);
  assert.deepEqual(await collect(resumed.stream),rangeBytes);
  assert.deepEqual(requestedRanges,["bytes=0-3","bytes=4-7","bytes=4-7","bytes=8-11","bytes=12-15"]);

  const generatedOpened = await registry.open(generatedReference);
  assert.equal(generatedOpened.name, "generated-image.png");
  assert.equal(generatedOpened.mimeType, "image/png");
  assert.deepEqual(await collect(generatedOpened.stream), bytes);
  assert.equal(requested.length, 2);

  // ChatGPT 当前按地区和文件服务编号分配官方文件主机。
  for (const host of ["sdmntprcentralus.oaiusercontent.com", "sdmntprsouthcentralus.oaiusercontent.com", "files01.oaiusercontent.com"]) {
    const regional = await registry.open({ ...reference, download_url: `https://${host}/files/example?sig=secret` });
    assert.deepEqual(await collect(regional.stream), bytes);
    assert.equal(new URL(requested.at(-1)!).hostname, host);
  }
  const requestsBeforeRejectedHosts = requested.length;
  for (const host of ["oaiusercontent.com.example.net", "fakeoaiusercontent.com", "sdmntprcentralus.oaiusercontent.com.example.net"]) {
    await expectArtifactError(registry.open({ ...reference, download_url: `https://${host}/file` }), "unsafe_openai_file_reference");
  }
  assert.equal(requested.length, requestsBeforeRejectedHosts);

  const fallbackOpened = await registry.open({
    ...generatedReference,
    file_name: null,
    name: null,
  });
  assert.equal(fallbackOpened.name, "chatgpt-file.png");
  fallbackOpened.stream.destroy();

  await expectArtifactError(
    registry.open({
      ...generatedReference,
      file_name: "first.png",
      name: "second.png",
    }),
    "ambiguous_openai_file_name",
  );
  await expectArtifactError(
    registry.open({ ...generatedReference, size: bytes.length + 1 }),
    "openai_file_size_mismatch",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      download_url: "http://files.oaiusercontent.com/file_123/download",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      download_url: "https://example.com/file_123/download",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      download_url: "https://arbitrary.blob.core.windows.net/container/file.png",
    }),
    "unsafe_openai_file_reference",
  );
  await expectArtifactError(
    registry.open({
      ...reference,
      extra: "unexpected",
    }),
    "unsupported_incoming_artifact",
  );

  const redirectRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async (input) => {
        if (String(input).includes("first")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://files.oaiusercontent.com/second?sig=next",
            },
          });
        }
        return new Response(bytes, { status: 200 });
      },
    }),
  ]);
  const redirected = await redirectRegistry.open({
    ...reference,
    download_url: "https://files.oaiusercontent.com/first?sig=initial",
  });
  assert.deepEqual(await collect(redirected.stream), bytes);

  const unsafeRedirectRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "https://example.com/stolen" },
      }),
    }),
  ]);
  await expectArtifactError(
    unsafeRedirectRegistry.open(reference),
    "unsafe_openai_file_reference",
  );

  const failedDownloadRegistry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter({
      fetch: async () => new Response("nope", { status: 500 }),
    }),
  ]);
  await expectArtifactError(
    failedDownloadRegistry.open(reference),
    "openai_file_download_failed",
  );
}

async function testInlineBase64Adapter(): Promise<void> {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const registry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter(),
    createInlineBase64ArtifactAdapter({ maxInlineBytes: 1024 }),
  ]);
  const opened = await registry.open({
    content_base64: bytes.toString("base64"),
    file_name: "sample.png",
    mime_type: "image/png",
    size: bytes.length,
  });
  assert.equal(opened.adapterId, "inline-base64");
  assert.equal(opened.name, "sample.png");
  assert.equal(opened.mimeType, "image/png");
  assert.equal(opened.size, bytes.length);
  assert.deepEqual(await collect(opened.stream), bytes);

  await expectArtifactError(
    registry.open({
      content_base64: bytes.toString("base64"),
      size: bytes.length + 1,
    }),
    "inline_artifact_size_mismatch",
  );
  await expectArtifactError(
    registry.open({
      content_base64: bytes.toString("base64"),
      sha256: "0".repeat(64),
    }),
    "inline_artifact_sha256_mismatch",
  );
  await expectArtifactError(
    registry.open({
      content_base64: "not-valid-base64!!!",
    }),
    "invalid_inline_artifact_reference",
  );
  for (const content_base64 of ["A", "Y==", "YQ=", "YQ==="]) {
    await expectArtifactError(registry.open({ content_base64 }), "invalid_inline_artifact_reference");
  }
  const urlEncoded = await registry.open({ content_base64: bytes.toString("base64url") });
  assert.deepEqual(await collect(urlEncoded.stream), bytes);
  await expectArtifactError(
    new IncomingArtifactAdapterRegistry([createInlineBase64ArtifactAdapter()]).open({
      content_base64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
    }),
    "artifact_file_too_large",
  );
}

async function testGoogleDriveAdapter(): Promise<void> {
  const bytes = Buffer.from("google drive bridge payload");
  const requested: string[] = [];
  const registry = new IncomingArtifactAdapterRegistry([
    createOpenAIIncomingArtifactAdapter(),
    createInlineBase64ArtifactAdapter(),
    createGoogleDriveIncomingArtifactAdapter({
      fetch: async (input) => {
        requested.push(String(input));
        if (String(input).includes("drive.usercontent.google.com")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://doc-00-00-docs.googleusercontent.com/docs/securesc/payload",
            },
          });
        }
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
          },
        });
      },
    }),
  ]);

  const opened = await registry.open({
    gdrive_file_id: "test_drive_file_123",
    file_name: "bridge.bin",
    size: bytes.length,
  });
  assert.equal(opened.adapterId, "google-drive");
  assert.equal(opened.name, "bridge.bin");
  assert.deepEqual(await collect(opened.stream), bytes);
  assert.equal(requested.length, 2);

  await expectArtifactError(
    registry.open({
      gdrive_file_id: "test_drive_file_123",
      download_url: "https://evil.example.com/download",
    }),
    "unsafe_google_drive_reference",
  );
  const headers: Headers[] = [];
  const privateAdapter = createGoogleDriveIncomingArtifactAdapter({
    accessToken: () => "test-private-token",
    fetch: async (url, init) => {
      headers.push(new Headers(init?.headers));
      return new URL(String(url)).hostname === "www.googleapis.com"
        ? new Response(null, { status: 302, headers: { location: "https://content.googleusercontent.com/file" } })
        : new Response(bytes);
    },
  });
  const privateFile = await privateAdapter.open({ gdrive_file_id: "test_private_123" });
  assert.deepEqual(await collect(privateFile.stream), bytes);
  assert.equal(headers[0]!.get("authorization"), "Bearer test-private-token");
  assert.equal(headers[1]!.has("authorization"), false);
}

function testLogShapeRedaction(): void {
  const value = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
    file_id: "file_secret",
    nested: {
      arbitrary: "private-value",
    },
  };
  const serialized = JSON.stringify(describeIncomingArtifactValue(value));
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("private-value"), false);
  assert.equal(serialized.includes("download_url"), true);
  assert.equal(serialized.includes("file_id"), true);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
