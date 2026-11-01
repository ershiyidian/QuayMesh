# 有时限的读取与任务状态

[English](bounded-read-architecture.md) · [简体中文](bounded-read-architecture.zh-CN.md)

本文替代[控制台读取隔离 v1](console-read-isolation-v1.zh-CN.md)中的临时详情限制。Core 保留任务准入、控制和持久化写入；控制台数据重建、MCP 工作区状态、后台快照计算分别交给独立的只读进程。

## 所有权与容量

三个读取器共用 `src/console-workbench/read-process.ts`。进程生命周期规则集中在这里，各路由不再各自管理一套子进程。

| 所有者 | 读取器与固定 worker | Runtime 诊断分类 |
| --- | --- | --- |
| Console 模块级池 | `isolated-queries.ts` → `read-worker.ts` | `console_read` |
| SessionRuntime | `session/status-reader.ts` → `status-read-worker.ts` | `mcp_status_read` |
| 按需创建的 SessionProjector | `session/projection-reader.ts` → `projection-read-worker.ts` | `session_projection_read` |

每个池最多执行一个请求、排队八个请求。从入队开始计时，等待、进程启动、查询和结果交付合计不超过 5,000 ms。请求 JSON 最多 64 KiB，响应信封最多 8 MiB，子进程堆上限为 192 MiB。三个池的容量互相独立；正常单个 Core 最多同时有三个活动读取进程。

健康子进程按帧顺序复用，响应必须匹配请求 ID。空闲 30 秒后退出；空闲句柄不阻止所有者结束。超时、取消、协议错误或崩溃只终止该池持有的读取进程。即使调用者已收到错误，也要等操作系统发出 `close` 才释放活动名额。取消排队请求不会终止其他请求。

worker 仅继承固定系统环境白名单，不继承凭据或 `NODE_OPTIONS`。加载查询模块前即启用只读数据库模式，不迁移、不改 journal、不修复状态，也不启动执行 Runtime 或监听服务。协议只接受固定操作与经过验证的身份，不接受调用者提供的 SQL、模块名或任意路径。

## 读取与发布合同

控制台详情、文件、补丁、命令输出、工作区会话和审计均使用专门的只读实现。父进程继续核对 Owner、Task、成员、工作区和变更捕获身份。写授权与写回执仍由原写入路径处理。旧节点缺少所需隔离路由时，返回升级或读取错误，不退回会阻塞的同步路由。

MCP 工作区状态先选定有界的最终事件窗口，再序列化结果；保留原操作身份、重试状态和当前进程句柄。成员活动使用限定范围的 SQL 查询，替代先扫描完整历史、再逐执行查询的做法。

后台投影在子进程中完成完整汇总和还原资格读取。远端成员可以使用已保存数据生成快照，但不得触发本机文件或占用检查。发布之前及取得写锁之后，父进程均核对当前身份、版本和捕获代次/序号。读取、策略检查和发布整体受 5 秒预算约束，调用者可选择更短预算。失败保留上次确认的快照；取消或关闭后不允许迟到写入，也没有同步回退路径。

## 控制台行为

正常加载和刷新属于进度状态；失败或过期证据才需要关注。页面成功取到数据，不代表节点的旧观测时间被刷新，也不证明任务仍在执行。

部分详情保留上次读取的记录、原读取时间和明确的历史标记。未知数量保持未知，未经确认的证据不能启用验收、还原或结束动作。待补齐的详情会在有限时间内补读，手动刷新模式也适用。详情标题栏提供独立刷新入口，窄窗口无需先关闭详情。

命令输出区分读取失败、不完整、已过期和已确认的空输出。重试保留字节游标合同与已读取内容，不把错误转换为空成功。

任务显示与资源占用分别判断。没有新进展、也没有新执行证据的任务，超过 30 分钟移出当前活动分组；仍有新执行证据的静默训练任务可继续显示为当前任务。轮询和任务间消息不刷新进展时间。显示超时不杀进程、不关闭 Task、不释放占用；占用恢复必须有匹配的持久化结束证据。详见[本地 API 活动语义](../local-user-api-cli.md)。

## 维护与回归

新增读取时扩展固定只读操作及其校验器，复用共同进程引擎，将写入保留在引擎之外。异步工作始终携带节点、工作区、Task 和 operation 身份。保留原始错误及观测时间，不以成功的零值填补未知状态。

诊断记录固定路由、阶段、子进程 PID、耗时及结果码，不记录命令正文和秘密。共同引擎发出 `start`、`finish`、`timeout`，Runtime 适配器附上表中的分类。用这些时间区分排队、worker 启动与读取失败，不把它们直接等同于执行或心跳状态。

相关回归组：

- `test/console-v5/console-read-process.test.ts`、`console-read-worker.test.ts`、`isolated-read-routing.test.ts`：生命周期、只读和混合版本路由。
- `test/console-v5/readonly-*.test.ts`、`console-read-detail.test.ts`：详情、已存文件、审计和工作区会话。
- `test/session-card/status-read.test.ts`、`projection-read.test.ts`：真实 SQLite 阻塞、父进程响应、取消、范围及发布竞争。
- `src/session/session-store.test.ts`、`finalization-budget.test.ts`：快照、远端成员和收尾预算。
- `test/console-v5/experience.browser.spec.ts`：真实浏览器的部分详情保留、补读、重试和窄窗口交互。

使用仓库固定的 Node/pnpm 完成类型检查和构建，再运行依赖编译后 worker 的检查。集成验证使用真实临时数据库、文件、子进程和本地连接。隔离边界限制慢读取的影响，并不单独证明每次历史冻结的原因。
