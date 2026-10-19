# MCP 可靠性恢复契约与实验记录

[English](../MCP_RELIABILITY.md) · 简体中文 · [首页](../../README.zh-CN.md)

本文记录 2026-10-19 调查的可靠性改动。
证据来自源码审阅，以及临时 SQLite 数据库、真实子进程、MCP handler 和本地 HTTP 连接实验。
系统整体模型可参阅[执行生命周期](../RELIABILITY.md)与[架构](ARCHITECTURE.md)。

## 范围与证据

源码基线为 `d452b51`。实验使用 Node.js 24.21.0、2.0.0 版本的 MCP server/Node adapter 包，以及官方 MCP client SDK 1.29.0。
仓库开发环境同时固定 pnpm 11.25.0，见[参与开发](CONTRIBUTING.md)。
下列耗时来自单次本地实验，不作为宿主客户端的延迟承诺。

一次请求会经过多个可以分别观察的边界：MCP 入站、准入、操作持久化、执行节点运行、响应发送，以及宿主消费响应。
QuayMesh 记录服务端传输是否结束；没有宿主回执时，`hostAcknowledgment` 保持为 `"unknown"`。
宿主显示的 “Thinking failed” 或 “message delivery time out” 本身不能定位其中哪一步出了问题。

### 验证状态

| 实验 | 已观察结果 | 范围与剩余验收 |
| --- | --- | --- |
| 加入首块注释前的静默 SSE | 首个响应体字节在 **5008.478 ms** 到达，内容为 SDK keepalive | 真实 Node HTTP，SDK 心跳间隔为 5000 ms |
| 加入首块注释后的直连 | 首字节 **10.862 ms** | 真实 Node HTTP，此时被门闩阻塞的工具尚未结束 |
| 加入首块注释后的流式代理 | 首字节 **3.690 ms** | 真实 loopback 转发代理 |
| 独立请求与观察者断开 | 通过 | 阻塞调用旁的 12 个快速调用，以及观察者断开后的另一次调用 |
| 暂停消费的 8 MiB 响应 | 取消已到达且仅发生一次；首轮测试过早检查了 reader 解锁 | 已改为等待真实 Node handler 清理完成；**最终 TCP 复验待执行** |
| 首轮合并 HTTP 矩阵 | **9/11 通过** | 已修正取消清理观测，以及 SDK 纯文本错误的断言；整合复验待执行 |
| 代理轮询遇真实 SQLite 写锁 | 旧进程以状态码 1 退出；修后存活并完成原操作 | 同 PID、持久结果、重试与 tracker 恢复，并检查事件数量 |
| 同步 SQLite 争锁 | 追加耗时 **5007.875 ms**；10 ms 定时器实际在 **5009.010 ms** 后触发 | 默认 `busy_timeout=5000`，额外定时器延迟 **4999.010 ms** |
| 周期账本核对遇真实写锁 | **1/1 通过** | 实际错误码、同一进程、释放锁后原操作收敛 |
| 空闲任务活性 | 真实 HTTP 通过 | 停滞展示停止计时，下一次调用复用原任务与 run |
| 输出 schema 与 handler 契约 | **10/10 通过** | 官方 JSON Schema 校验器，覆盖成功、结构化错误与递归成功类型 |
| 官方 SDK 发现工具与文件错误恢复 | **1/1 通过** | 正常 `Client.listTools()` 与 `Client.callTool()`，经 transport 正式 fetch 接口进入实际 handler；真实 ENOENT 后成功读取文件；未监听 TCP 端口 |
| 本地准入重试 | **7/7 通过** | 包含两个真实进程争用同一操作 key |
| 两节点 HTTP 准入重试 | **2/2 通过**，约 **941 ms**、**379 ms** | 准入改动 worktree 的原始 SDK 请求；整合后的最终标准 `callTool` 矩阵待验 |
| 整合主线本地回归 | **80/80 通过**，**30.42 s** | Session、迁移、执行协调器，以及真实周期核对子进程测试 |
| 旧 v5 数据库打开代码访问 v6 | 因数据库版本不受支持而拒绝 | 真实临时数据库；协调节点与执行节点混版本运行尚未实测 |

整合主线的类型检查、完整构建与源码检查已通过；最终标准 SDK/TCP 与 Node 生命周期矩阵仍为独立待验项。
执行环境的自动权限审核多次因容量不足或审核超时，在命令启动前中止。剩余验收需要完成权限审核；这些待验项目尚无测试通过或失败结果。

## 原因链与修复契约

### 1. 后台写入失败不能终止 Core

原代理定时器保存了 `poll(...).finally(...)`，却没有观察 Promise 拒绝。
轮询等待 `agentEvent()`，其中事件追加可能因 `SQLITE_BUSY` 失败。
这个拒绝离开定时器边界后可以终止进程，连带断开其它正常的 MCP 请求。

原配置已经启用了 WAL 和 5000 ms busy timeout。
原事件事务采用 deferred 模式，在第一次写入前先读取任务与版本；
另一个写入者提交后，旧读取快照可能无法再升级成写事务。
单纯增加 busy timeout，无法修复事务顺序与缺失的 Promise 异常边界。

[代理 tracker](../../src/session/agent-operations.ts) 现在观察成功与失败，保留持久身份，并用有上限的退避重试观察和收尾。
它不会重新启动提供方工作。关闭时清除后续定时器，等待正在执行的轮询；诊断回调自身失败也不能逃出该边界。
[事件存储](../../src/session/store.ts) 改为先通过 `transaction.immediate()` 取得写入资格，再读取版本和去重依据。

同一操作、同一代理观察状态使用稳定的事件 source ID。
因此，即使事务已经提交、随后变更订阅者才失败，重试或重建 tracker 也不会重复追加该事件。
代理记录丢失仍明确返回 unknown，不会被改写成成功完成。

测试用真实 SQLite 连接覆盖写入前争锁，以及提交后失败两条路径。
它检查一次 `agent_changed`、一次终态事件、原提供方输出，以及从持久身份恢复。
快速 tracker fixture 仅缩短自己的 busy timeout；另一个使用默认配置的实验测量仍存在的五秒停顿。

### 2. 周期账本核对需要自己的异常边界

[WorkRunReconciler](../../src/work-run-reconciler.ts) 在 interval 回调中同步执行数据库工作。
周期回调现在捕获异常、报告故障，并让账本在下一周期继续核对。
诊断回调也有独立保护；启动恢复保留其单独且更严格的失败路径。
周期核对不会重复执行可能中断当前进程所拥有工作的启动扫尾。

[服务端接线](../../src/server.ts) 优先通过 `ServerDiagnostics` 记录 `work_run_reconcile_failed`，
在持久诊断日志中保留受限错误身份与调用栈位置。
子进程测试通过同一个回调与 IPC 接收真正的 SQLite 错误。
这避免依赖当前执行环境中发生丢失的异步子进程 stderr：其写入回调虽成功，父进程却没有收到字节。

### 3. 尽快建立 SSE 传输，不制造进度

Node 适配器可能已经取得 Response，但响应头仍要等到写入第一个响应体块才真正发出。
对于静默操作，原先第一个块就是约五秒后的 SDK keepalive。

[SSE 首块处理](../../src/mcp-sse-response.ts) 在 SSE 响应体开头加入合法注释 `: connected\n\n`。
SDK Node 适配器仍是唯一的响应写入者；包装层只有一个 reader，按需拉取，`highWaterMark: 0`。
它保留状态与响应头，删除已经失效的 content length，并传递取消和源流错误。
它不生成工具进度通知、成功回执或额外心跳定时器。

首块注释只表示这条响应流已经建立。
它不表示操作已持久接收、执行完成，或宿主已读到响应。
同步阻塞的事件循环仍无法创建或发送首块，因此 SQLite 隔离是另一项工作。

慢消费者实验发现了一处测试观测竞态：进入 `source.cancel()` 早于包装层的 `finally` 清理。
修正后的测试等待真实 Node handler 结束，再检查源 reader 已解锁。
上游读取量受限、独立调用可完成、取消仅一次，以及适配器无错误等断言均保留。

### 4. 错误结果要能通过发现流程与输出校验

[现代 MCP 适配器](../../src/mcp-modern-server.ts) 公布的输出 schema 同时容纳成功类型和结构化错误回执。
联合类型与递归引用由 Zod 生成，成功对象的子节点不会因为根允许错误回执就误接受错误对象。
原成功类型的运行时校验保持不变。
真正的错误由 SDK 的 `isError` 分支处理；遗漏 `isError` 或标成 false 的错误对象，仍会被成功校验拒绝。

QuayMesh 的结构化错误包含 `error_code`、`effect`、`retry_hint`，以及可选的操作标识、所属节点标识和 details。
可读 `content` 与 `isError: true` 同时保留。SDK 协议错误或校验错误可以只有文本，没有 `structuredContent`。
[官方客户端回归](../../src/mcp-sdk-error-contract.test.ts) 先调用 `listTools()` 缓存 SDK 实际输出校验器，再使用正常 `callTool()`。
真实 `readFile` ENOENT 保留 `isError: true` 和 `ENOENT` / `not_started` / `fix_input` 回执；创建文件后返回符合严格成功类型的读取结果。
transport 的正式 fetch 接口将真实 Request/Response 传入实际 handler，全程未监听 TCP 端口。
独立的 TCP 文件错误测试覆盖 SDK 纯文本错误；其修正后的断言，以及整合后的两节点标准客户端准入矩阵，仍待最终网络复跑。

[入站诊断](../../src/mcp-request-diagnostics.ts) 现在先读取规范的结构化错误字段，再考虑旧文本格式。
HTTP 完成、JSON-RPC 错误、工具错误，以及未检查的响应分别分类。
诊断只保留允许的分类、字节数量与指纹，不把工具参数或输出正文复制进错误记录。

### 5. 明确未执行的准入拒绝，可以在原操作下重试

操作 key 既要保留已接收工作的身份，也要允许重新评估临时拒绝。
[准入判定](../../src/session/outcome.ts) 要求已存结果同时为 `failed`、`effect: not_started`、`retry_hint: retry_later`，
并且错误是 `EXECUTION_CONFLICT` 或 `NODE_ADMISSION_PAUSED`。
Unknown、部分执行、已取消、已完成与永久失败都不会启动另一次尝试。

新的传输请求可以在原 operation ID 和原 active task 下建立符合条件的下一次尝试。
Owner、session、member、task、operation key 与参数继续绑定原范围。
重放原传输请求仍返回原尝试及其不可变回执；新任务或新会话不能只凭相同 key 继承旧操作。

[存储层](../../src/session/store.ts) 在事务中更新操作 key 的指向，并记录 `retry_of_invocation_id`。
Immediate 事务、比较后更新和唯一后继索引，共同保证并发争用只有一个获准者。
旧 invocation 更新与迟到收尾受到保护；账本重开归属于新尝试的请求身份。
即使执行节点在记录 invocation 前就拒绝准入，协调节点的下一次转发仍保留原 operation ID。

审阅这套新尝试模型时，又发现两处读取遗漏：代理恢复可能读到旧终态，恢复详情可能停留在旧 finished 事件。
两者现在与 activity/projection 逻辑一致选择当前尝试。
这些是审查新改动时发现的问题，不是已部署基线存在同类多尝试缺陷的证据。
历史尝试和事件继续作为证据保留，不通过删除旧记录来让当前展示显得正确。

### 6. 空闲活性属于读模型，不凭空生成终态

Run 租约过期且没有活跃后台工作，不代表用户任务已完成或已取消。
持续无活动达到既有静默阈值后，[任务视图](../../src/task-view.ts)与控制台分类显示停滞，并停止对应计时。
只读检查不能续租、申请执行 claim，或改写原 run。
HTTP 回归验证重复读取、活跃任务计数为零，以及下一次命令继续使用同一 task/run。
仍有活跃子工作或未确认结果的情况，继续遵守原有保护与核对规则。

## 复跑检查

使用固定运行时和隔离检出。Fixture 创建临时状态，并在结束时关闭数据库、进程与连接。
网络测试需要允许绑定 loopback 端口。被沙箱拒绝的测试属于未执行，不能记为通过。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

整合主线本地回归与 handler 契约：

```sh
pnpm exec node --import tsx --test --test-isolation=none --test-concurrency=1 \
  src/session/*.test.ts src/db/migrations.test.ts src/execution-coordinator.test.ts \
  test/reliability-background.test.ts
pnpm exec node --import tsx --test --test-isolation=none \
  src/mcp-modern-server.test.ts src/mcp-sdk-error-contract.test.ts
```

真实传输、任务活性与两节点契约：

```sh
pnpm exec node --import tsx --test --test-isolation=none --test-concurrency=1 \
  src/mcp-sse-response.test.ts src/mcp-request-diagnostics.test.ts \
  test/reliability-liveness.test.ts \
  test/tool-contract/error-receipt.test.ts test/tool-contract/admission-retry.test.ts
pnpm test:node
```

单独复验慢消费者时，添加 `--test-name-pattern='^a paused real HTTP'`，只选择 `src/mcp-sse-response.test.ts`。
保存运行时版本、提交、命令、传输模式和实际通过/失败数量；保留对应原始测试输出。
单次首字节观测与重复负载的分位数统计应分别报告。

独立的 [SQLite 事件循环测量脚本](../../test/reliability-system/sqlite-event-loop.ts) 使用另一个连接持有真实写锁：

```sh
pnpm exec node --import tsx test/reliability-system/sqlite-event-loop.ts
```

已记录的运行使用 SQLite 3.53.1，释放锁并重试后仅有一条事件。
该脚本报告耗时，不设依赖机器速度的通过阈值，并在 `finally` 中删除临时数据库。

## 数据库升级与发布边界

[Schema v6](../../src/db/invocation-attempt-schema.ts) 增加任务身份和尝试关联，并保留历史回执。
迁移仅通过范围一致的已有 run 关联补全任务身份；历史证据不足的记录继续保持未确认。
打开数据库时会执行[版本检查与迁移](../../src/db/migrations.ts)。
旧 v5 迁移代码实测拒绝 v6 数据库，错误为“不支持的 QuayMesh 数据库版本：6”。

共享同一 state directory 的所有进程需要一致切换；新增列并不代表旧程序会接受新的 schema 版本。
对于各自拥有数据库的协调节点和执行节点，源码契约支持先升级执行节点、再升级协调节点的发布顺序建议。
混版本运行仍需独立矩阵；已通过的两节点测试使用相同实现版本。

以下混版本行为属于**源码推断，尚未完成对应网络实验**：

| 组合 | 预期限制 |
| --- | --- |
| 旧协调节点、新执行节点 | 协调节点可能直接重放缓存的拒绝，不创建新尝试 |
| 新协调节点、旧执行节点 | 执行节点可能重放旧拒绝；若此前根本没有 worker invocation，旧 ID 推导还可能与协调节点分歧 |

新重试行为没有单独的能力协商开关。切换每个节点共享状态的组件前，先暂停准入并排空工作。
旧进程已打开的数据库连接不会因迁移自动停止，应在切换前关闭这些进程。
全链路升级后先做一次同 key 重试探测，再恢复一般准入。

升级前保存一致的数据库备份，并把对应发布包与配置作为同一恢复集合保留。
恢复旧账本不会撤销备份之后发生的文件变化或外部副作用。
已有新工作后，优先前滚修复以保留证据；任何数据库恢复都需要明确核对这些外部效果。
Unknown 结果、缺失任务身份或不完整的旧错误回执，都不足以开放自动重试。

## 后续设计阶段

### 第一阶段：完成整合验收

完成发现工具后的标准 SDK 矩阵，覆盖结构化业务错误、正常读取与准入重试。
复跑修正后的慢消费者测试，保留真实传输清理完成的观测。
增加独立的混版本发布矩阵，覆盖所有共享状态的进程，以及协调节点/执行节点的两种升级方向。
将现有故障 fixture 纳入发布检查，以原 operation ID 和单次外部效果为核心断言。

### 第二阶段：把同步 SQLite 停顿移出请求处理

将易争锁的数据库工作放到有界的 worker thread 或独立进程接口之后，由该执行上下文拥有数据库连接。
同时协调后台代理记账等所有写入者；只搬走一个调用点仍会留下其它同步阻塞路径。
缩短事务，记录队列饱和，把准入等待计入请求期限。
在操作身份提交前，内存队列接收不能被报告成持久接收。

分别测量持锁、大查询、事件序列化、checkpoint 和快照负载。
写锁保持五秒期间，验证传输心跳与独立只读回执请求仍能及时响应。
释放后验证原身份、单次副作用、有界排队与正常关闭。
调查使用有界诊断 API 和明确文件范围；通用 shell 命令继续遵守其真实资源 claim。

### 第三阶段：让长宿主轮次可以恢复

宿主等待、HTTP 响应、操作执行与输出保留分别设置预算。
尽早返回已持久化的操作引用，让观察调用有界，并按 cursor 接续输出。
跨节点传递剩余期限，分别记录准入、准备、执行与响应耗时。
观察者消失时释放其流；取消执行仍是针对操作的明确动作。

持久 checkpoint 保存当前操作引用、输出 cursor、已作决策和下一步安全动作。
恢复时先查询原操作/key，再决定是否提交另一个副作用。
保持错误 schema 可发现、响应大小受限；大段不可变输出保留在引用后，不在每次轮询中重复发送。
只报告真实工具活动与已知执行状态，传输注释和卡片刷新不能制造工作进度或宿主确认。

