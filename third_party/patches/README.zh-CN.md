# 本地组件源码补丁

[English](README.md)

`scripts/build-components.mjs` 使用的源码归档已经包含下列补丁。可读补丁用于审查和复现修改；组件构建**不会再次应用**这些补丁，也不需要新增补丁工具。`components.lock.json` 记录修补后归档、修补前归档和各项本地补丁的哈希。上游组件版本保持不变。

## tunnel-client 0.0.15 — quaymesh-json-events-v1

补丁：[tunnel-client-0.0.15-json-events-v1.patch](tunnel-client-0.0.15-json-events-v1.patch)

| 源码记录 | SHA-256 |
| --- | --- |
| 此前纳入仓库的归档 | `7eb1cb293aa3cd7d5aba448f9e5f96bd1f518bde354207e1887b092c25ca0359` |
| 修补后归档 | `b095cd82e0d64762afe1592a3ec41b082c12b00fe811bc4702d4c90361f52dcc` |
| 可读补丁 | `2e3aee8605ec194e3febbb93a8469af600a892e178845bf6011dce96cec38bb3` |

`pkg/codexappserver/bridge.go` 改为通过 `encoding/json` 编码 stderr 和无法解析的 stdout 行。`strconv.Quote` 产生的 Go 字符串转义（包括 `\x1b`）并非合法 JSON 转义，会导致整份事件历史无法序列化。无效 UTF-8 按 JSON 编码器的规则替换为替代字符。事件顺序和错误行之后的有效通知保持原有语义。

`pkg/adminui/ui.go` 改为先完成 JSON 编码，再提交 HTTP 状态。遇到不支持的值、非法原始 JSON 或自定义序列化器错误时，返回 HTTP 500 和固定的 `response_encoding_failed` JSON 错误，不包含被拒绝的载荷或编码错误详情。成功响应仍保留 HTML 转义和末尾换行。本补丁不改变桥的启动、停止或任务 RPC 行为。

归档在对应包内增加 `bridge_json_test.go` 和 `json_response_test.go`。其余 783 个既有条目的内容、ZIP 元数据和压缩后的本地记录均保持原样，原有许可证和版权声明继续保留。

### 验证

在解压后的 `tunnel-client-master` 目录中，使用 Go 1.27.0 执行：

```sh
GOTOOLCHAIN=local go test -count=1 ./pkg/codexappserver ./pkg/adminui
GOTOOLCHAIN=local GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -o /tmp/tunnel-client-linux ./cmd/client
GOTOOLCHAIN=local GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -buildvcs=false -trimpath -o /tmp/tunnel-client-windows.exe ./cmd/client
```

这里的 `-buildvcs=false` 用于没有 Git 检出的独立源码解压目录的编译检查。组件构建器原有的解压和构建流程没有修改。

回归测试实际调用 stdout/stderr 读取器，覆盖 ANSI 转义、控制字节、无效 UTF-8，以及错误行之后的有效通知。真实 HTTP 测试服务器覆盖非法原始 JSON、不支持的 channel、非有限数值和自定义序列化器错误，并验证失败响应不泄露原始载荷或错误详情。将这些测试应用于修补前源码，可复现非法事件载荷和空的成功 HTTP 响应；修补后两个包的测试均通过。编译得到二进制文件并不等于已经更新运行中的安装。
