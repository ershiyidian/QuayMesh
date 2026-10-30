# 提案：本地命令行与 QuayDock 接口

[English](NEXT-CLI-QUAYDOCK.md)

状态：下一版本提案，核对日期为 2026-10-30。下文接口和命令均为设计示例，尚未实现，也不改变本轮部署。

## 方案

在现有服务中增加本地用户接口，由轻量命令行程序和 QuayDock 共用。首版提供任务查看，之后单独授权消息发送。继续使用现有后台服务和 Task 层级。

复用现有 Task、工作区、操作、消息、版本号和游标，以及经过认证的所有者、客户端和 Task 权限检查。读取请求不切换当前 Task、不恢复会话、不确认收到消息，也不创建工作。

任务查看以 Task 为授权和数据单位。`tasks.list` 为每个已授权 Task 返回一条摘要，包含工具调用间隙或没有运行命令的开放请求。分别保留 Task 已存的生命周期与交付结果、最后任务活动、观测新鲜度和可选执行证据；某次执行完成或停止，不代表整个 Task 完成或停止。“当前”“较早”仅用于展示分组，不改变生命周期；数据暂不可用时保留上次快照、观测时间，并明确标为待更新。

现有 [server](../../src/server.ts) 包含控制停止、准入的管理通道，以及使用集群凭据的内部接口。新增用户接口应与这些管理能力分开。权限必须在每个方法的分派处检查；仅公布权限名称，或连接时检查一个总权限，不能限制具体方法。

## 首版接口

| 拟议方法 | 所需权限 | 返回内容或作用 |
| --- | --- | --- |
| `status.get` | `status:read` | 服务版本、就绪状态及观测时间 |
| `tasks.list` | `tasks:read` | 有权访问的 Task 摘要和分页信息 |
| `tasks.get` | `tasks:read` | Task 生命周期与交付结果、活动和观测时间、版本号及快照游标 |
| `events.read` / `events.watch` | `events:read` | 指定 Task 的限量事件元数据 |
| `outputs.read` | `outputs:read` | 可选独立授权：读取已授权 Task 中某次操作的持久输出 |
| `messages.enqueue` | `messages:write` | 后续可选：保存用户消息并返回回执 |

首次授权仅包含前三种读取权限。任务标题和事件元数据同样受 Task 权限保护。默认返回字段不包含原始命令参数、标准输出、文件正文、环境变量和凭据；额外内容需要相应的独立权限。

QuayDock 需要显示 Task 的实际输出时，另行授予 `outputs:read`，默认授权不包含此项。输出入口位于该 Task 的详情中，操作引用用于定位要查看的执行证据。`outputs.read` 必须提供 `task_id`，以及操作 ID 或可解析到该操作的服务端输出引用。先确认操作归属于已授权 Task，再复用 `read_output`、字节游标、保留范围标记及每页字节预算。该方法不接受任意文件路径。输出可能包含项目正文或敏感值，因此 QuayDock 仅在已授权界面展示，不写入常规诊断日志。

每次调用都先核验客户端身份、当前授权和方法所需权限，再读取或修改数据；涉及 Task 的方法还需核验每个目标或返回 Task 的访问权。客户端身份来自凭据，输入中的 `client_id`、`owner_id` 不产生授权。每次翻页和每批事件继续检查适用权限。这一设计遵循 RFC 9700 §2.3 的资源与操作限制，以及 MCP 的逐操作权限要求。[1][3]

## 本地传输与信任边界

Windows 使用命名管道，Unix 使用文件系统中的本地域套接字；Node 的 IPC（进程间通信）接口支持这两种传输。[4] 从受保护的本机安装记录取得入口，首版不开放公网 TCP 监听。

Windows 由现有原生宿主创建用户管道，显式设置访问控制表，只允许指定登录身份及服务身份，拒绝远程客户端，并授予必要的管道权限。默认管道权限包含更广的读取访问，因此必须明确配置访问控制。[5]

Unix 将套接字放入所有者控制的 `0700` 目录，套接字权限为 `0600`。用户入口与停止服务、暂停准入的管理入口分开，不提供任意方法、路径或请求头转发。

本机信任边界以操作系统账号为单位。同一账号下的普通应用可能访问该账号的凭据，应用显示名称不提供进程隔离。独立客户端授权用于限制权限，并支持单独撤销。

## 注册、凭据与撤销

通过已有的所有者认证设置页注册 QuayDock，展示客户端名称、读取权限、允许的 Task 和凭据有效期。为它生成独立随机凭据，服务端保存哈希及授权记录；客户端使用 Windows 凭据管理器或桌面 Secret Service 保存。[6][7] 安全存储不可用时明确提示设置要求，不静默保存明文凭据。

接口凭据不进入命令行参数、URL、标准输出、日志或工作区文件。本地凭据仅用于用户 IPC 入口。不得向 QuayDock 返回或转发 cluster bearer、所有者口令或管理凭据，也不得接受其他目标服务的令牌并原样转交下游。[1][2]

所有者可以单独撤销某个客户端，其余客户端及正在执行的 Task 继续运行。撤销后拒绝该客户端的新请求，并关闭其已有事件订阅。轮换只替换该客户端的凭据，旧凭据随即失效。`messages:write` 需要所有者追加授权，客户端不能自行提权。首版本地接口不增加 OAuth 刷新流程；未来的 HTTP 接入另行设计，并遵循 RFC 9700 的目标服务绑定和刷新令牌保护要求。[3]

## 回执、重试与游标

命令行与原生客户端共用带版本号的方法分派，沿用现有响应大小预算。命令行标准输出为 JSON，事件订阅逐行输出 JSON；供人阅读的诊断写到标准错误。调用时无需拼接 Shell 命令。

底层操作返回的 `task_id`、`operation_id`、消息回执和版本号保持原样。游标表示已授权 Task 中的位置，本身不授予访问权。断开后从最后保存的游标恢复，按事件身份去重。历史已超出保留范围时返回 `CURSOR_EXPIRED` 和 `retained_from`，QuayDock 获取新快照并显示记录缺口。

可选消息写入使用绑定到“客户端、Task、请求键”的幂等规则：相同内容重试返回原回执，相同键搭配不同内容则明确报冲突。超时后复用同一请求键重试，取得已保存的回执。用户消息会影响任务之后的行为，因此发送权限与查看权限分开。

## QuayDock 接入示例

所有者注册 `quaydock` 客户端后，拟议命令为：

```text
quaymesh --client quaydock status --json
quaymesh --client quaydock tasks list --json
quaymesh --client quaydock tasks get --task <返回的task-id> --json
quaymesh --client quaydock events watch --task <返回的task-id> --cursor <返回的游标> --jsonl
```

QuayDock 从可信安装记录定位命令行程序，通过参数数组启动，关闭 Shell 执行。`--client` 选择已注册记录，实际认证使用受保护的凭据。当前选中的 Task 使用一个事件订阅，关闭界面时关闭订阅。

独立授予输出读取权限后，可以从选中 Task 的详情分页查看其某次操作的输出：

```text
quaymesh --client quaydock outputs read --task <返回的task-id> --operation <返回的operation-id> --cursor <字节游标> --json
```

下一页使用返回的 `next_cursor`；较早字节已被清理时，沿用 `read_output` 的保留范围响应。输出字节游标与 Task 事件游标分别使用。

追加消息权限后，用户主动点击发送可调用：

```text
quaymesh --client quaydock messages enqueue --task <返回的task-id> --request-key <新请求键> --stdin --json
```

正文通过标准输入传递，取得已保存的回执前保留请求键。首版接口不包含执行命令、任意文件访问、取消任务、安装、停止服务或自动同意授权等方法。

## 交付范围

第一阶段实现查看和客户端撤销，输出读取需独立授权；第二阶段通过已有消息队列追加显式授权的发送能力。使用真实本地连接验证逐方法拒绝、跨 Task 拒绝、输出操作与 Task 的归属、撤销已打开的订阅、游标恢复和消息去重。实现单独进入下一版本审查，与本轮部署修复分开交付。

## 官方依据

1. [MCP Authorization，2026-07-28：权限提示与目标服务校验](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
2. [MCP Security Best Practices：令牌透传与最小权限](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
3. [RFC 9700：§2.3 权限限制、§4.14 刷新令牌保护](https://www.rfc-editor.org/rfc/rfc9700.html)
4. [Node.js 24：IPC 支持](https://nodejs.org/docs/latest-v24.x/api/net.html#ipc-support)
5. [Microsoft：命名管道安全与访问权限](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)；[CreateNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
6. [Microsoft：CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
7. [freedesktop.org：Secret Service](https://specifications.freedesktop.org/secret-service/latest/)
