# Local component source patches

[简体中文](README.zh-CN.md)

The source archives used by `scripts/build-components.mjs` include the patches listed here. The readable patches document and reproduce the changes; the component build does **not** apply them again or require a new patching tool. `components.lock.json` records the patched archive hash, the preceding archive hash, and each local patch hash. The upstream component version remains unchanged.

## tunnel-client 0.0.15 — quaymesh-json-events-v1

Patch: [tunnel-client-0.0.15-json-events-v1.patch](tunnel-client-0.0.15-json-events-v1.patch)

| Source record | SHA-256 |
| --- | --- |
| Previously vendored archive | `7eb1cb293aa3cd7d5aba448f9e5f96bd1f518bde354207e1887b092c25ca0359` |
| Patched archive | `b095cd82e0d64762afe1592a3ec41b082c12b00fe811bc4702d4c90361f52dcc` |
| Readable patch | `2e3aee8605ec194e3febbb93a8469af600a892e178845bf6011dce96cec38bb3` |

`pkg/codexappserver/bridge.go` now encodes stderr and malformed stdout lines with `encoding/json`. Go string-literal escapes from `strconv.Quote`, including `\x1b`, are not valid JSON escapes and could make the event history impossible to serialize. Invalid UTF-8 follows the JSON encoder's replacement-character behavior. Event ordering and subsequent valid notifications are preserved.

`pkg/adminui/ui.go` now encodes a JSON response before committing its HTTP status. Unsupported values, malformed raw JSON, or a failing custom marshaler produce HTTP 500 with a fixed `response_encoding_failed` JSON error. The response includes neither the rejected payload nor the encoder error. Successful responses retain HTML escaping and their trailing newline. This patch does not change bridge startup, shutdown, or task RPC behavior.

The archive adds `bridge_json_test.go` and `json_response_test.go` in their respective packages. The other 783 existing entries retain their contents, ZIP metadata, and compressed local records. Existing license and copyright notices remain in place.

### Validation

Run inside the extracted `tunnel-client-master` directory with Go 1.27.0:

```sh
GOTOOLCHAIN=local go test -count=1 ./pkg/codexappserver ./pkg/adminui
GOTOOLCHAIN=local GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -o /tmp/tunnel-client-linux ./cmd/client
GOTOOLCHAIN=local GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -buildvcs=false -trimpath -o /tmp/tunnel-client-windows.exe ./cmd/client
```

`-buildvcs=false` is used for these standalone extracted-source compilation checks, which have no Git checkout. The component builder's extraction and build flow is unchanged.

The regression tests exercise the actual stdout/stderr readers with ANSI escapes, control bytes, invalid UTF-8, and a valid notification following malformed lines. Real HTTP test servers cover malformed raw JSON, an unsupported channel, a non-finite number, and a custom marshaler error, including checks that rejected payloads and errors are not exposed. Applying these tests to the preceding source reproduces invalid event payloads and empty successful HTTP responses. The fixed packages pass both suites. Compiling a binary does not update an already running installation.
