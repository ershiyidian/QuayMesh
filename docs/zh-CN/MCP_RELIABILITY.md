# MCP 可靠性恢复契约与实验记录

[English](../MCP_RELIABILITY.md) · 简体中文 · [首页](../../README.zh-CN.md)

本文记录 2026-10-19–20 调查的可靠性改动。
证据来自源码审阅，以及临时 SQLite 数据库、真实子进程、MCP handler 和本地 HTTP 连接实验。
系统整体模型可参阅[执行生命周期](../RELIABILITY.md)与[架构](ARCHITECTURE.md)。

## 范围与证据

源码基线为 `d452b51`。实验使用 Node.js 24.21.0、2.0.0 版本的 MCP server/Node adapter 包，以及官方 MCP client SDK 1.29.0。
仓库开发环境同时固定 pnpm 11.25.0，见[参与开发](CONTRIBUTING.md)。
下列耗时来自单次本地实验，不作为宿主客户端的延迟承诺。

一次请求会经过多个可以分别观察的边界：宿主授权审核与派发、MCP 入站、准入、操作持久化、执行节点运行、响应发送，以及宿主消费响应。
QuayMesh 记录服务端传输是否结束；没有宿主回执时，`hostAcknowledgment` 保持为 `"unknown"`。
宿主显示的 “Thinking failed” 或 “message delivery time out” 本身不能定位其中哪一步出了问题。

### 初期验证状态

此表保留早期实验；后面的 Windows 矩阵记录后续整合运行、清理失败与成功复跑。

| 实验 | 已观察结果 | 范围与剩余验收 |
| --- | --- | --- |
| 加入首块注释前的静默 SSE | 首个响应体字节在 **5008.478 ms** 到达，内容为 SDK keepalive | 真实 Node HTTP，SDK 心跳间隔为 5000 ms |
| 加入首块注释后的直连 | 首字节 **10.862 ms** | 真实 Node HTTP，此时被门闩阻塞的工具尚未结束 |
| 加入首块注释后的流式代理 | 首字节 **3.690 ms** | 真实 loopback 转发代理 |
| 独立请求与观察者断开 | 通过 | 阻塞调用旁的 12 个快速调用，以及观察者断开后的另一次调用 |
| 暂停消费的 8 MiB 响应 | 取消已到达且仅发生一次；首轮测试过早检查了 reader 解锁 | 修正后的清理观测已在下方 Windows SSE 组通过 |
| 首轮合并 HTTP 矩阵 | **9/11 通过** | 已修正取消清理观测，以及 SDK 纯文本错误的断言；后续 Windows 结果见下方 |
| 代理轮询遇真实 SQLite 写锁 | 旧进程以状态码 1 退出；修后存活并完成原操作 | 同 PID、持久结果、重试与 tracker 恢复，并检查事件数量 |
| 同步 SQLite 争锁 | 追加耗时 **5007.875 ms**；10 ms 定时器实际在 **5009.010 ms** 后触发 | 默认 `busy_timeout=5000`，额外定时器延迟 **4999.010 ms** |
| 周期账本核对遇真实写锁 | **1/1 通过** | 实际错误码、同一进程、释放锁后原操作收敛 |
| 空闲任务活性 | 真实 HTTP 通过 | 停滞展示停止计时，下一次调用复用原任务与 run |
| 输出 schema 与 handler 契约 | **10/10 通过** | 官方 JSON Schema 校验器，覆盖成功、结构化错误与递归成功类型 |
| 官方 SDK 发现工具与文件错误恢复 | **1/1 通过** | 正常 `Client.listTools()` 与 `Client.callTool()`，经 transport 正式 fetch 接口进入实际 handler；真实 ENOENT 后成功读取文件；未监听 TCP 端口 |
| 本地准入重试 | **7/7 通过** | 包含两个真实进程争用同一操作 key |
| 两节点 HTTP 准入重试 | **2/2 通过**，约 **941 ms**、**379 ms** | 准入改动 worktree 的原始 SDK 请求；整合后的 Windows 清理与复跑见下方 |
| 整合主线本地回归 | **80/80 通过**，**30.42 s** | Session、迁移、执行协调器，以及真实周期核对子进程测试 |
| 旧 v5 数据库打开代码访问 v6 | 因数据库版本不受支持而拒绝 | 真实临时数据库；协调节点与执行节点混版本运行尚未实测 |

早期整合主线的类型检查、完整构建与源码检查已通过。
本地启动剩余 TCP 与 Node 矩阵的尝试，多次因自动权限审核容量不足或达到审核期限而结束；这些具体命令保持未执行状态。
后续 Windows 运行补充了以下证据。

### Windows `5964a6a` 验收

Windows 运行使用固定的 Node.js 24.21.0 和真实 TCP 连接。以下计数与测量对应这次检出与运行。

| 检查 | 已观察结果 | 范围与剩余验收 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | Windows 上的 `tsc` 已完成 |
| SSE 测试组 | **6/6 通过** | 直连首字节 **65.0885 ms**；流式代理首字节 **7.3658 ms**；暂停消费的 8 MiB 响应与取消检查通过 |
| 合并 `mcp-http` 组 | 三个测试在数据库清理阶段失败；组进程到 **240 s** 运行器预算时仍未退出 | 删除目录时 SQLite 连接仍打开；修正清理后的 `run-02` 已通过，见下方 |
| `session-sqlite` | **92 个测试：90 通过、2 失败** | 两个失败均为相同数据库清理顺序问题；修正用例已在 `run-02` 通过 |
| `recovery-federation` | **43/43 通过** | 真实恢复与联邦 fixture |
| Node 生命周期 | **49/49 通过** | 真实 Node 测试入口 |

SSE 耗时来自单次观测；这些测量尚未建立宿主客户端的超时阈值。
Windows 失败暴露了测试资源归属问题：fixture 先注册会删除目录的 `after`，测试随后才注册旁路 SQLite 连接或 WorkLedger 的关闭回调。
实测 FIFO hook 顺序让目录删除先遇到仍打开的句柄；`EBUSY` 随后中断后续清理，留下未关闭的监听器。
提交 `e35fcfb` 将测试自身持有的句柄放进测试体 `finally`，在 fixture dispose 前关闭，涉及五个测试、四个文件：
[准入重试](../../src/session/admission-retry.test.ts)、[Session store](../../src/session/session-store.test.ts)、
[任务活性](../../test/reliability-liveness.test.ts)和[两节点准入](../../test/tool-contract/admission-retry.test.ts)。
已记录的清理失败继续保留在调查历史中；下方成功复跑验证了修后进程正常退出。

### 清理修复后的 Windows 验收

| 所需证据 | 当前记录 |
| --- | --- |
| 被测提交与工作树状态 | Windows `run-02` 于 **2026-10-19 09:38 UTC** 从 clean `52e8586` 开始，包含清理 `e35fcfb`、审核/环境修正 `a9ee137` 与 Windows 运行器 |
| 运行时与完成状态 | Node.js **24.21.0**；三个所选测试组均成功结束 |
| `mcp-http` | **36/36 通过**，**27.836 s**；正常退出 |
| `session-sqlite` | **92/92 通过**，**72.513 s**；正常退出 |
| `environment-review` | **6/6 通过**，**11.544 s**；两项检查/注解用例与四项 Python 工作流用例 |
| 保留证据 | [脱敏验收摘要](../../test/reliability-system/evidence/windows-20261019-20.json)：保留各轮提交、官方计数、完成状态与原始 summary 的 SHA-256；原始 TAP、JSON 事件保留在测试环境 |

`run-02` 选择了 `mcp-http`、`session-sqlite` 和 `environment-review`。
此前恢复/联邦的 `43/43` 与 Node 的 `49/49` 继续对应 `5964a6a`。
两轮合计覆盖 **226 个不同且通过的测试**，各组被测提交分别保留在上方。
Windows 运行器与调用方式见[复跑检查](#复跑检查)。

### 恢复回归与后续修复

Windows `run-03` 于 2026-10-20 使用 clean `6df1348`，启动前类型检查和完整构建均通过。
`recovery-federation` **43/43 通过**，耗时 **98.777 s**；`environment-review` **6/6 通过**，耗时 **12.931 s**。
`workspace-restore` 正常结束，**21 项通过、一项失败、五项平台跳过**，耗时 **27.559 s**。
真实双节点 HTTP 失败发生在工作树清理后的历史命令输出读取：`SessionStore.requireCommand` 仍对已删除目录执行路径解析。
提交 `27f9a25` 改为验证持久化的规范根身份；历史读取保留 owner、节点、根目录和 operation 检查，活动输入/取消入口仍先验证当前工作区，再使用规范根。
两个真实 SQLite/SDK 回归已在本地通过，包含合法别名与别名改指向后的拒绝；下方 Windows 后续验收原样复跑这条 HTTP 失败链。

审阅还实际复现了协调节点的关闭任务在 worker 首次接触时被镜像为 active 的边界。
提交 `f0bfac9` 在协调节点 `attach_workspace` 转发入口，完成 owner/session 检查后、创建 worker 镜像前拒绝关闭任务。
双库生产方法探针先复现缺陷，再验证修复后拒绝以及下一轮合法活动任务仍可转发；双节点 HTTP 恢复回归也纳入同一场景。

### 最终受影响组 Windows 验收

`run-04` 使用 clean **`e3d5b5ae26797a8a64c5aee3b9b686d613120008`**，从 **2026-10-20 06:31:19 UTC** 运行至 **06:35:24 UTC**，Node.js 为 **24.21.0**。
运行器启动前，类型检查和完整构建均成功完成。

| 测试组 | 官方结果 | 耗时 |
| --- | --- | --- |
| `mcp-http` | **37/37 通过** | **31.245 s** |
| `session-sqlite` | **94/94 通过** | **76.379 s** |
| `recovery-federation` | **43/43 通过** | **98.951 s** |
| `diagnostics` | **7/7 通过** | **9.854 s** |
| `workspace-restore` | **22 项通过、五项平台跳过**，无失败 | **28.425 s** |

五组均以 0 正常退出，无超时、取消或未完成清理：共 **203 项通过、五项跳过**。
Windows 的五项既有跳过用例涉及符号链接，已在此前 Linux 工作区/git-worktree 回归通过。
历史根目录修复后，真实双节点恢复用例通过，其中也包含关闭任务首次镜像前的拒绝。
诊断 HTTP 用例在输出读取尚未完成时观察到已认证入口，随后观察到完成记录；身份无效、目标资源不符的请求均未产生 authenticated 事件。
最终 SSE 单次首字节测得直连 **60.307 ms**、本地流式代理 **8.235 ms**；8 MiB 慢消费者案例在取消前读取 128 块中的 9 块，取消仅发生一次。
这些数值保留为单次本地观测。[验收摘要](../../test/reliability-system/evidence/windows-20261019-20.json)包含全部四轮及原始 summary 哈希，同时保留失败轮次。
此前 Node **49/49**、环境检查 **6/6** 结果继续对应上方各自提交，与这次最终受影响组矩阵分别记录。

## 自动权限审核与尚未抵达 QuayMesh 的请求

### 直接证据与授权

本次调查的本地执行尝试在创建进程前返回以下审核错误：

```text
Automatic approval review failed: Selected model is at capacity. Please try a different model.
The automatic permission approval review did not finish before its deadline.
```

工具错误同时报告动作尚未执行。用户的既有授权继续覆盖同一动作与范围。
沙箱执行能力、审批决定和审核器可用性分别构成执行条件。
[OpenAI 安全文档](https://learn.chatgpt.com/docs/agent-approvals-security)说明了额外模型调用与独立的超时结果；审核服务不可用时，可以在尚无完整风险决定的情况下阻止执行。
2026-10-19 审阅的公开 [Guardian policy template](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/policy_template.md) 将用户明确要求的动作及落实请求所必需的实现动作视为高授权，并按实际语义判断。
单纯重复用户同意，无法证明审核器容量已经恢复。

### 公开机制与部署边界

[OpenAI Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)描述了独立 reviewer：它接收具体待审批动作，以及由用户消息、可见助手更新和相关工具证据组成的精简上下文。
这些输入不包含主模型的私有思考链。
文档列出的入口包括 shell 升权、受阻网络访问、配置可写范围外的写入，以及因注解或审批模式而需要审核的 MCP/app 调用。
因此，进程启动或 MCP 请求派发之前存在一个可能失败的审核边界。

2026-10-19 审阅的公开 [`ReviewModel` 选择逻辑](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review.rs)和
[`review_session.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session.rs)包含独立审核模型/会话，以及覆盖审核准备和等待的 deadline。
主对话可以继续可用，同时这一依赖发生故障。本会话实际部署的 reviewer 模型、容量池与 deadline 尚未确认。
固定公开版本 [`rust-v0.163.0-alpha.10.2`](https://github.com/openai/codex/blob/rust-v0.163.0-alpha.10.2/codex-rs/ext/guardian-reviewer/src/lib.rs)定义 90 秒审核预算、最多三次尝试；
其 [`retry.rs`](https://github.com/openai/codex/blob/rust-v0.163.0-alpha.10.2/codex-rs/ext/guardian-reviewer/src/retry.rs)让符合条件的暂时性重试共享原 deadline。这些常量仅描述该版本，重试对象是执行前的审核计算。

[openai/codex issue #45395](https://github.com/openai/codex/issues/45395)创建于 2026-09-14，包含相同的容量报错。
其中 10 月 5 日的用户评论报告：已授权的 MCP 动作在送达前失败。它属于 OpenAI 公开仓库中的同类用户报告；当前个案根因与共享部署服务仍缺少确认。
官方文档证明审核框架能够覆盖 shell 和 MCP/app 动作；当前本地 exec 与网页版 MCP 的实际部署关系仍未核实。

另一段历史追踪 E13 观察到：三个子代理调用等待 **840–1417 秒**，所检查日志中没有对应 Cloud 入站；同期主会话一次读取在 **179 ms** 完成。
这组证据将停滞定位到所观察入口之前的特定调用路径。审核器可用性属于这些早期调用的合理候选，其记录没有对应的明确 reviewer 错误。
本轮容量/deadline 错误直接证明其各自本地执行尝试发生了审核失败。

### 跨越未入站边界的可观测性

现有[服务端诊断](../../src/server-diagnostics.ts)在启用请求日志时，于 HTTP 边界发出 `server_request_started`。
[MCP 诊断](../../src/mcp-request-diagnostics.ts)在 MCP 诊断边界发出 `mcp_exchange_started`，并在完成时保留请求身份、参数指纹、HTTP/RPC/tool 分类、首包耗时、aborted 状态及 unknown 宿主确认。
QuayMesh 只能直接测量抵达其可观察入口的请求。
提交 `1ee6931` 在 Bearer 身份和目标资源校验后增加 `mcp_exchange_authenticated`，记录这两项 HTTP 检查；工具授权、准入与执行分别使用各自证据。
按任务读取的 [`read_diagnostics` 投影](../../src/read-diagnostics.ts)纳入能够安全关联的 authenticated 和 finished 记录，按 owner、时间窗及任务/操作身份过滤；未经认证的 started 记录不进入该投影。
`coverage.task_transport` 分别报告观察到的两类记录数，并返回 `completion: "not_inferred"`；两者差值不会被展示为运行中操作数量。
`history_completeness` 与 `host_acknowledgment` 保持 `unknown`，缺少安全任务/操作关联的调用仍可能不在结果中。
32 MiB 扫描预算落实到文件流实际读取范围，包括单行超长的情况；回复预算、分页和诊断字段白名单继续生效。
解释空结果前检查 coverage 和相关入站记录。宿主审核、派发等上游阶段的关联仍需要宿主提供证据。

| 证据 | 该证据支持的归因 | 还需观察什么 |
| --- | --- | --- |
| 审核错误明确报告未执行 | 本次尝试在执行前结束 | 宿主提交/审核时间与派发状态 |
| 已有反向代理或 MCP 入站，尚无持久 invocation | 请求已抵达，故障可以发生在 invocation 记录之前 | 鉴权、路由、准入和数据库事件 |
| 已有持久操作，转发报告 `REQUEST_TIMEOUT` | 请求已进入后端路径 | 各跳等待、准备、执行与响应时间 |
| 已有后端完成与响应发送记录 | 服务端工作与发送状态已知 | 宿主收到或消费响应的证据 |
| QuayMesh 无记录，宿主/边缘入口也无追踪 | 送达状态继续为 unknown | 上游证据，或相关日志确实覆盖该时段的确认 |

关联 UTC 提交/审核事件、宿主和边缘请求 ID、有界参数指纹、进程启动证据，以及持久 operation ID。
分别保留 `review_state`、`execution_started` 与 `hostAcknowledgment`；拟议的宿主侧字段需要真实宿主证据。
仅凭 invocation 行缺失，无法证明请求从未到达。已经记录的后端超时仍需继续调查后端。
“Thinking failed” 和 “message delivery time out” 继续作为可能跨越多个边界的症状处理。

### 减轻方法与当前工作

为工具公布符合实际执行、观察、网络与中断能力的注解，让环境检查保持只读。
安装、修复或获取运行时通过修改入口执行，并遵守任务已有授权范围。
**提交 `a9ee137` 已实现能力注解与 Python 发现检查修正；Windows `environment-review` 在 `52e8586` 上 6/6 通过。**
[子代理工具](../../src/tool-surfaces/subagents.ts)声明了提供方执行的网络能力。
[工作区环境](../../src/workspace-environment.ts)通过文件与 PATH 发现已有解释器候选，返回 `verification: "not_run"`；解释器及其启动代码通过显式执行入口运行。

提交 `6df1348` 让 [`getWorkspace`](../../src/workspaces.ts)保持观察性：受管 worktree 已清理时，返回 `WORKSPACE_RESTORE_REQUIRED`、`effect: not_started` 和原工作区 handle。
恢复通过已授权 session 和活动 task 中的 `attach_workspace({workspace_id: originalHandle})` 显式进行，保留工作区/member 身份及原有暂存、未暂存内容，并合并并发恢复。
真实 Git checkout hook 回归检查了读取不重建目录、不触发 hook，显式恢复会触发，已活动目录的重复 attach 不再触发。
恢复前仍可读取历史状态与输出；上面的后续验收记录了实际运行这条链路时发现的历史根目录校验和关闭任务问题。
Python 测试覆盖解释器发现，工作区回归覆盖受管 worktree 恢复路径；其他观察入口继续遵守各自能力契约。

通过既有授权执行路径使用有界诊断与明确文件范围。
审核器明确报告未执行时，进行有次数上限的延后重试，并在接口支持时保留原意图/key。
执行状态不确定时，先查询原操作，再决定另一次副作用；恢复过程中保留原审核错误和各次尝试时间。
切换到已经授权的环境可以提供可用执行路径；目标环境仍受自己的审核和沙箱条件约束。
准确注解让审核看到真实能力，包括需要增加审核的情况；有界只读检查与重试限制重复调用，同时保留适用的审批策略。
服务容量仍属于宿主侧可用性依赖，这些方法尚不能保证其恢复时间。

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
提交 `e3d5b5a` 为规范错误文本增加简短恢复尾注，供只展示 `content` 的消费者使用。
尾注包含长度、格式受限的错误码、effect、retry hint 和明确传入的 operation ID；不复制原始 details，也不从消息猜测缺失身份。
再次规范包装时替换旧尾注，避免文本持续增长；结构化错误与成功校验保持原语义。
SDK 回归使用静态 fixture operation ID 验证这一契约；实际文件读取失败与随后成功读取均真实发生，该 ID 不表述为执行命令生成的回执。
[官方客户端回归](../../src/mcp-sdk-error-contract.test.ts) 先调用 `listTools()` 缓存 SDK 实际输出校验器，再使用正常 `callTool()`。
真实 `readFile` ENOENT 保留 `isError: true` 和 `ENOENT` / `not_started` / `fix_input` 回执；创建文件后返回符合严格成功类型的读取结果。
transport 的正式 fetch 接口将真实 Request/Response 传入实际 handler，全程未监听 TCP 端口。
独立的 TCP 文件错误测试覆盖 SDK 纯文本错误；上方 Windows 矩阵记录后续网络验证，包含 SQLite fixture 清理修复后整个 HTTP 组成功结束。

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

### Windows 验收运行器

仓库中的 [Windows 运行器](../../test/reliability-system/windows-acceptance.cjs)校验 Node.js 24.21.0，并记录实际可执行文件、提交和工作树状态。
它用独立进程、并发度一运行测试文件，文件预算为 120 秒，组预算默认为 240 秒。
计数来自官方根 `test:summary` 事件；各组保留 TAP 和 JSON 事件，退出码、超时和清理状态写入 `summary.json`。
正常结束等待子进程 `close`；超时或中断时仅处理本组创建的进程树，并记录终止结果。

在已经安装固定依赖的检出中，使用 PowerShell、通用本地路径和全新输出目录：

```powershell
$qmNode = "C:\Tools\node-v24.21.0-win-x64\node.exe"
$qmRepo = (Get-Location).Path
$qmResults = Join-Path $env:TEMP ("quaymesh-acceptance-" + [guid]::NewGuid().ToString("N"))
& $qmNode test/reliability-system/windows-acceptance.cjs $qmRepo $qmNode $qmResults --groups=mcp-http,session-sqlite,environment-review
```

最终恢复/诊断复验选择 `--groups=mcp-http,session-sqlite,recovery-federation,diagnostics,workspace-restore`，使用另一个全新输出目录。

`environment-review` 选择 `src/tool-surfaces/subagents.test.ts` 和 `test/python-workflow.test.ts`，使用 `--test-name-pattern=只读环境查询|真实 MCP 注解|^PY`，覆盖两项检查/注解回归与全部四项 Python 工作流测试。
省略 `--groups` 会运行全部七组，包含 `diagnostics`、`workspace-restore`、`recovery-federation` 和 `node`。
保留生成的证据后再回填最终 Windows 表格。组进程正常退出、官方计数通过、未超时且清理完成，才满足该组验收。

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
关闭任务恢复入口检查在协调节点运行新实现后生效。

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

## 同类 WebGPT MCP 项目对照

以下一手来源于 2026-10-20 核对。项目文档、用户报告和待合并方案的证据强度各有范围；项目采用的等待预算仅代表其自身策略。

| 项目与一手来源 | 已观察方案 | QuayMesh 的取舍 |
| --- | --- | --- |
| DevSpace [issue #334](https://github.com/Waishnav/devspace/issues/334)、[PR #335](https://github.com/Waishnav/devspace/pull/335) | 针对副作用已发生但响应丢失，设计 operation ID 回执、同请求重放与文件前置状态校验。PR 仍为 open，回执存在当前进程内。 | 保留 SQLite 持久回执与 attempt 防护，先恢复原命令或输入回执。 |
| WebCodex [故障排查](https://github.com/yyjeqhc/webcodex/blob/main/docs/TROUBLESHOOTING.md) | 明确讨论 Thinking failed，要求宿主中断后观察原 job。 | 让 operation ID、输出游标和检查点独立于模型轮次保存。 |
| WebCodex [MCP 契约](https://github.com/yyjeqhc/webcodex/blob/main/docs/MCP.md) | 分离观察窗口与执行期限，并记载针对 `openai-mcp` 的错误投影。 | 当前保留标准错误语义；兼容投影需要在受影响宿主路径上进行受控对照。 |
| WebCodex [Runner 契约](https://github.com/yyjeqhc/webcodex/blob/main/docs/RUNNER.md) | 分别处理进程所有权、重连恢复与持久终态回执。 | 分别展示保存的证据和当前存活状态；替换进程需要有效的执行所有权才能接管。 |
| Coding Tools MCP [运行契约](https://github.com/xyTom/coding-tools-mcp/blob/main/docs/runtime-contract-v0.3.md) | 分开前台等待、进程总寿命、输出偏移与显式取消；旧默认值曾在返回句柄后终止长命令。 | 每个 timeout 都标明它停止的是观察、准入、执行还是结果保留。 |
| Coding Tools MCP [issue #48](https://github.com/xyTom/coding-tools-mcp/issues/48) | 披露取消响应限制，以及客户端自选 JSON-RPC ID 冲突。 | 执行控制使用已授权 operation 身份；观察流释放保持单独语义。 |

本次一条真实主会话 MCP 调用收到 `isError: true / INVALID_ARGUMENT` 后，同轮下一次文件读取成功。原始错误正文未保留，因此不判断该次失败所在层。该结果记录了这一条调用链能够继续，其他 ChatGPT 客户端路径仍需单独验证。[证据摘要](../../test/reliability-system/evidence/windows-20261019-20.json)保留了这一范围。

## 消费者恢复策略

现有[命令入口](../../src/tool-surfaces/codex.ts)默认前台等待 2 秒，上限 12 秒。
[`read_output`](../../src/tool-surfaces/operations.ts)默认不等待，单次观察上限 10 秒；一次最多合并八个命令，共享最大 32 KiB 字节预算。
这些参数决定前台等待和观察窗口，调用者依据返回的 operation 及执行契约判断工作是否结束。
现有[联邦预算](../../src/tool-request-budget.ts)传递剩余请求期限，各跳不能重新获得一整份等待预算。

恢复动作根据持久证据和当前授权范围选择：

| 当前证据 | 下一步 |
| --- | --- |
| 已知 `operation_id`，执行结果不确定 | 查询原状态，再按保存的 byte cursor 调用 `read_output`，保留原 ID。 |
| 原操作仍拥有活动执行 | 处理独立工作，或进行一次有界观察，并遵守 `poll_after_ms`。 |
| 已有完成结果 | 取回保留结果，从已发生的效果继续。 |
| `effect=not_started`、`retry_hint=retry_later`，且属于支持的准入错误 | 在原 owner/session/member/active-task 范围内，以完全相同参数和 key 重试；已有准入契约为同一 operation 建立新 attempt。 |
| `effect=unknown`、部分效果或传输中断 | 先核对原操作，再决定新的修改；自动写重放继续关闭。 |
| `WORKSPACE_RESTORE_REQUIRED` | 在原 session 中以原 `workspace_id` 显式调用 `attach_workspace`；恢复前仍可读取历史输出。 |
| 恢复时返回 `TASK_NOT_ACTIVE` | 在原 session 中开始下一项已授权任务，再显式恢复原工作区；已关闭任务保持关闭。 |
| 缺少可安全关联的传输记录 | 查看 coverage 与已有任务恢复事实；有条件时取得上游证据，派发和审核状态保持 unknown。 |

相关文件选区和命令输出在工具已有上限内合并读取。形成重要判断或完成一个阶段后，保存包含操作引用、必要游标及下一步的检查点。代码完成一个可审阅阶段就形成提交。后续模型轮次依靠这些记录恢复工作，无需保留原始思考过程。

分别衡量四个目标：减少可避免的请求、观察者消失后保住已接受操作、防止重复副作用、降低每次中断损失的工作量。服务端错误数与宿主完成用户轮次的比例需要各自观测。

## 2026-10-20：SQLite 争用与执行收尾

本轮针对已测量的本地停顿，以及消除停顿时暴露出的恢复边界继续修复。
数据库 schema 保持第 6 版，本次验收没有部署生产节点。

### 为什么一个数据库锁会影响其它观察请求

原同步 SQLite 连接使用 `busy_timeout=5000`。SQLite 的 [busy handler](https://www.sqlite.org/c3ref/busy_timeout.html) 在数据库调用内部反复等待，直到预算耗尽。它在 Node 请求线程上等待时，定时器、HTTP 处理和传输活动也无法继续。[WAL 支持读者与写者并行](https://www.sqlite.org/isolation.html)，但我们的观察路径也会申请持久写租约，打开已是最新版本的数据库仍会进入迁移写事务。

新增真实 HTTP 回归先在 `eb0adca` 上运行，只叠加测试和独立持锁 Worker。Worker 对实际数据库持写锁三秒，历史输出、诊断和 Console 观察未能在持锁期间完成。这是基线故障证据；它没有测量 ChatGPT 的超时阈值。整条测试耗时包含 fixture 创建与清理，不能当作查询耗时。

修复分三层：

1. 打开最新数据库时，只读检查 schema 和旧结构修复需求。真正迁移或修复仍取得写锁、重读版本并原子提交。初始化失败会关闭连接。
2. `runSqliteWrite` 临时关闭该连接的 busy handler，再尝试 `BEGIN IMMEDIATE`。准入遇到 `SQLITE_BUSY` 时先恢复设置，再通过定时器让出执行。默认准入预算五秒，退避从 10 ms 增至最多 100 ms；取得写锁后才进入事务体。
3. 历史 `read_output`、`read_diagnostics`、代理 list/wait、工作区 status/recovery、空 stdin 轮询和 Console GET/HEAD，不再仅为查看状态申请持久执行租约。原处理函数继续检查身份和范围，写操作继续保留执行 claim。

这套方案让争锁等待让出事件循环，SQL 事务体仍同步执行。大查询、序列化、文件系统操作和 checkpoint 需要分别测量，仍可能阻塞请求线程。

### 事务与副作用的边界

`runSqliteWrite` 只接受同步、纯 SQL 回调。它拒绝已有外层事务和 async 回调，观察误返回 Promise 的拒绝，并在每次同步尝试结束后恢复 `busy_timeout`。取消信号可以中断等待；已经开始的同步事务体会执行到自身结束。

只有**尚未进入事务体时的写锁准入 BUSY**会重试。事务体、COMMIT、ROLLBACK 或连接清理失败，均不能导致事务体重放。应用监听器即使抛出形似 SQLite 的错误码，也遵循这个边界。命令、文件写入、网络请求和提交后通知都放在重试边界之外。

invocation 层现在分开执行操作和保存回执。保存失败返回 `INVOCATION_PERSISTENCE_FAILED`，携带原 operation ID，并把报告的 effect 标为 unknown。已经完成的文件修改不会被改记为新的 `not_started` 执行失败，也不会重跑命令。持久的 accepted/running 记录继续保留供核对。永久存储故障下丢失的任意结果，目前不会由内存重试队列自动重建。

review 状态和 review 事件一起提交，之后才触发变更监听器。创建 work run 与建立 task/member 关联，现在使用同一连接、同一事务。等待锁之后，事务内重新检查 owner、member、任务是否 active、收尾状态和 invocation attempt。review 等锁期间切换当前任务会拒绝旧更新，避免改动新任务。并发请求共享正在创建的 run，并在写锁内重查已有关联。

迟到的操作事件也在事件写事务内检查 attempt。回归实验让旧 finish 等锁，同时创建新 attempt；旧 finish 不能晚于新 start 追加，也不能让 task/session 的活动时间倒退。

### 进程与后台任务生命周期

运行时租约、命令和修改 claim 增加异步申请与释放入口。动作只执行一次，放在取锁重试之外。动作结束后若释放失败，`releaseAsync()` 返回 `EXECUTION_RELEASE_PENDING`，指向原操作供查询。释放错误不会覆盖动作原异常；进程收尾记录待清理状态后，继续交付已确认的终态结果。有界、单飞的清理循环只重试删除本 coordinator 明确已经结束的占用，活动 claim 不会被抢走。待释放 claim 在数据库删除提交前继续挡住冲突，但不能授权新的嵌套写入。

待释放集合仅存在于当前进程；占用行直到 DELETE 提交才消失。进程重启后的遗留占用仍按现有 owner/operation 核对规则恢复。

会话观察、保留期清理和 work-run 核对，每个循环最多一个维护任务在途。异常被观察并报告，后续周期可以恢复。关闭运行时时取消正在等锁的维护工作，等待其结束后关闭连接。

异步改造暴露了命令启动竞争：同 operation ID 的两个并发调用都可能通过最初的 session 检查，并继承同一 claim。真实探针启动了两个进程、追加了两次文件。现在 `ProcessSessionManager` 在第一次 await 前占住 ID，准备失败时释放占位；已经完成的 session 继续拒绝重复启动。

shutdown 等待所有所属 session 的 exit 和 close promise，包括已经设置 `running=false`、仍在释放 claim 或执行 finish 回调的 session。已结束 claim 离开 manager 的活动集合；coordinator 在内存保留待清理项，SQLite 中的占用行继续保留。真实延迟外键覆盖了 DELETE 成功、COMMIT 失败，然后移除约束再完成清理的路径。

### 跨节点任务边界

新转发工作在发送 RPC 和首次创建远端任务镜像前检查 Task 状态。任务关闭后，既有工作的观察和已保存回执重放仍可使用。

文件复制另有 transfer 协议入口，需要独立检查。任务已关闭或正在收尾时，入口只允许只读查找原复制回执；owner、请求 key、session、task、member 和原复制参数都必须相符。没有旧回执就拒绝新复制。查询失败或旧节点不支持查询方法时，返回明确错误，不会退回启动复制。

活动任务的复制在转发前记录参与的 task/member，因此仅执行复制的任务也能将目标节点纳入收尾。目标端在 `beforeOperation` 前预留 invocation 时，保留原 task 和 operation ID。目标任务已经关闭时可以在副作用前拒绝复制；这条被拒绝的 invocation 也必须成为终态，避免永久停在 accepted。

旧节点测试使用旧式 RPC 分发分支，配合真实的当前传输实现。它没有覆盖两套历史发行二进制的完整混版本矩阵。尚未升级的旧入口节点仍保留旧行为。

### 可复现实验与剩余范围

回归使用真实 SQLite 文件、独立 Worker 写锁、SQL 触发器与延迟外键、真实 Node 子进程，以及经过 OAuth 的 MCP SDK/TCP。断言覆盖原身份、单次文件副作用、事件数、持锁期间可观察和资源正常清理。相关入口：

- [写锁准入](../../src/db/async-write.test.ts)、[执行协调器](../../src/execution-coordinator.async.test.ts)、[进程生命周期](../../src/process-sessions-contention.test.ts)。
- [回执争锁](../../src/session/receipt-contention.test.ts)、[run/review 原子性](../../src/session/run-review-atomicity.test.ts)、[运行时维护](../../src/session/runtime-contention.test.ts)。
- [跨节点复制状态](../../src/federation/copy-task-state.test.ts)、[HTTP 写锁争用](../../test/tool-contract/sqlite-contention.test.ts)、[进程退出时的 HTTP 观察](../../test/tool-contract/sqlite-process-exit.test.ts)。

HTTP fixture 在持写锁期间检查输出、诊断、Console 和 MCP ping，再检查原命令收敛、相同 key 不重复副作用。耗时均为单次受控实验，没有据此报告生产分位数或 ChatGPT 故障率下降比例。

其它调用者仍保留同步 API，包括代理排队的 claim 转换和线程绑定。本轮没有将所有数据库工作搬入专用 worker，也没有改变上游审核、派发行为；每条宿主 `thinking failed` 的原因仍需对应证据。提交中的验收记录列明本轮实际覆盖的本地路径。

## 后续设计阶段

### 第一阶段：保留验收证据，增加混版本发布检查

按提交保留 Windows summary，包含已通过的六项 SSE 测试与完整 HTTP 组正常退出的记录。
把恢复失败、对应修复和受影响组复验共同保留，让这项回归始终可以复现。
增加独立的混版本发布矩阵，覆盖所有共享状态的进程，以及协调节点/执行节点的两种升级方向。
将现有故障 fixture 纳入发布检查，以原 operation ID 和单次外部效果为核心断言。

### 第二阶段：继续隔离剩余同步数据库工作

上面的后续修复已让覆盖到的请求、回执、claim 和维护路径在争锁时让出事件循环。
继续测量剩余同步调用者、大查询、checkpoint 和序列化，再将其放到有界 worker thread 或独立进程接口之后，由该执行上下文拥有数据库连接。
同时协调代理排队转换和剩余后台记账等写入者；只搬走一个调用点仍会留下其它同步阻塞路径。
缩短事务，记录队列饱和，把准入等待计入请求期限。
在操作身份提交前，内存队列接收不能被报告成持久接收。

分别测量持锁、大查询、事件序列化、checkpoint 和快照负载。
写锁保持五秒期间，验证传输心跳与独立只读回执请求仍能及时响应。
释放后验证原身份、单次副作用、有界排队与正常关闭。
调查使用有界诊断 API 和明确文件范围；通用 shell 命令继续遵守其真实资源 claim。

### 第三阶段：让长宿主轮次可以恢复

宿主等待、HTTP 响应、操作执行与输出保留分别设置预算。
尽早返回已持久化的操作引用，让观察调用有界，并按 cursor 接续输出。
在已有跨节点剩余期限契约上，补齐准入、准备、执行与响应的独立耗时测量。
观察者消失时释放其流；取消执行仍是针对操作的明确动作。

持久 checkpoint 保存当前操作引用、输出 cursor、已作决策和下一步安全动作。
恢复时先查询原操作/key，再决定是否提交另一个副作用。
保持错误 schema 可发现、响应大小受限；大段不可变输出保留在引用后，不在每次轮询中重复发送。
只报告真实工具活动与已知执行状态，传输注释和卡片刷新不能制造工作进度或宿主确认。

### 下一次架构改动的验收目标

分别测量已接收操作的恢复成功率、重复外部效果、持久准入回执耗时和事件循环延迟。
重复受控实验后再报告分位数，同时保留并发度、输出大小、运行时和传输模式。
SQLite 写锁被持有时，独立观察仍应及时响应；释放后，原操作完成一次。
写入之后丢失响应时，应恢复保存的回执且不重复写入；执行所有者重启后，要么恢复已证实的所有权，要么明确进入核对状态。
宿主轮次完成率需要用户可见错误时间与宿主证据共同测量，当前服务端测试尚未建立该指标。

