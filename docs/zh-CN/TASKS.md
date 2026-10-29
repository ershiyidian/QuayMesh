# 任务与代理

[English](../TASKS.md) · 简体中文 · [首页](../../README.zh-CN.md)

QuayMesh 将一个目标涉及的工作区、命令、文件和编程代理保存在同一个 Task 中，目标可以跨外部对话持续。Task 的开放或关闭表示目标状态；每个命令的结果单独表示执行状态。

## 创建任务与工作区

仅为新的独立目标调用 `start_session`。追问沿用已有 Task 和工作区句柄；创建另一个目标不会关闭原 Task。重试同一次创建时，继续使用相同的 `request_key` 和输入参数。

```json
{
  "title": "Build the application",
  "request_key": "build-application-001"
}
```

`title` 是任务标题，`request_key` 用于识别同一个请求。

已验证的宿主入口已经选择 Task 时，新的 key 本身不会再创建目标。`TASK_START_SELECTION_REQUIRED` 会返回原 Task ID、当前绑定 revision 和 `effect: "not_started"`。先检查该 Task；目标未变就继续它。仅明确要建立独立目标时，传 `new_goal: true`，以及从 `task_resume inspect` 或选择冲突中取得的 `expected_binding_revision`。版本已变化会在创建之前被拒绝。原 Task 已关闭也需要同样的明确选择，start 不会重新打开它。

历史创建 key 返回原 Task，但不会把入口重新切回去。旧 Session 的当前 Task 可以作为 revision 为 `0` 的历史候选返回，仅观察它不会建立绑定。入口从未选择目标且没有历史候选时，首次创建仍兼容上面的例子。`source_task_id` 记录新 Task 的来源，不是父子关系，也不是继续另一个 Task 的授权。

这项选择保护只适用于具有已验证 owner/client 和稳定宿主关联标识的入口。没有该标识的通用 MCP 客户端保留现有创建路径，其持久创建 key 作用域仍是独立兼容缺口。服务器不会把 owner 或 transport ID 伪造成入口；没有稳定入口却显式要求绑定 revision 时，返回 `TASK_ENTRY_REQUIRED`。

通过 `workspace_catalog` 查找项目目录，再使用 `open_workspace` 打开具体项目，后续操作沿用返回的 `workspace_id`：

```json
{
  "root_id": "worker/projects",
  "subdirectory": "my-app"
}
```

`mode: "checkout"` 使用现有项目目录，`mode: "worktree"` 创建独立的 Git 检出目录。

使用 `attach_workspace` 的 `path` 或 `root_id` 参数，将另一个项目加入当前会话。创建或恢复 Git 工作树可能运行仓库配置的检出 hook 和 filter，因此这两个工具如实声明具有写入及开放环境行为。

### 恢复被清理的工作树

只读工具不会重建已被保留策略清理的托管工作树。文件读取和环境查询会返回 `WORKSPACE_RESTORE_REQUIRED`，并包含 `effect: "not_started"`、`retry_hint: "fix_input"` 和 `details.restore.arguments` 中的原工作区句柄。

需要继续工作时，在原会话中使用该句柄调用 `attach_workspace`：

```json
{
  "workspace_id": "<original_workspace_id>",
  "session_id": "<original_session_id>"
}
```

工作区属于执行节点时，保留完整的 `qm:node:...` 句柄。此形式不传 `path`、`root_id`、`subdirectory`、`mode`、`base_ref` 或 `create_directory`。原会话必须有活跃任务；如果上一任务已结束，先在原会话中创建下一任务。此调用不能恢复属于其他会话的工作区。

恢复保留原工作区 ID、目录、会话成员，以及已保存的受跟踪文件的暂存和未暂存修改。并发恢复共用同一次执行，已处于活跃状态的工作区直接复用。目录缺失时，`workspace_context` 的 `status`、`recovery` 以及 `read_output` 仍可读取经过授权且尚在保留期内的历史记录，包括已结束任务的记录。

## 阅读与修改文件

`read` 读取指定文本范围或图片。`workspace_context` 可以批量收集文件片段、搜索工作区或恢复已保存的任务上下文。

`apply_patch` 支持新增、修改、移动和删除文件。可选的 `expected_content` 将目标路径与之前读取的内容关联起来。

任务会记录涉及的文件，并通过控制台展示文件差异。

## 执行命令

```json
{
  "workspace_id": "<workspace_id>",
  "cmd": "pnpm build",
  "yield_time_ms": 1000
}
```

返回结果包含 `operation_id`。命令继续运行时，使用这个编号调用 `read_output`：

```json
{
  "workspace_id": "<workspace_id>",
  "operation_id": "<operation_id>",
  "cursor": 0,
  "wait_ms": 1000
}
```

后续从返回的 `next_cursor` 继续读取。`write_stdin` 用于发送输入或调整终端大小，`cancel_command` 用于停止指定命令。

重试同一次写入或命令提交时，继续使用原来的 `operation_key`；新的标识代表新的操作。

如果 `EXECUTION_CONFLICT` 或 `NODE_ADMISSION_PAUSED` 返回 `effect: not_started` 和 `retry_hint: retry_later`，等待占用解除后使用原 key 重试。新请求可以在原来仍活跃的任务和工作区内重新申请执行，保留同一个 `operation_id` 和最初的拒绝记录；并发重试共用一次尝试。已完成、已取消、部分执行、效果未知及永久参数错误不会重新执行。无法证明原任务归属的历史回执仍可查询，但不能转给后来的任务执行。

## 使用编程代理

`spawn_agent` 创建代理任务并返回已接收的操作。通过 `list_agents` 和 `wait_agent` 查看进度与已保存的结果。

`send_message` 向正在执行的代理补充要求，`followup_agent` 继续原来的线程，`interrupt_agent` 停止指定执行轮次。

QuayMesh 包含 Codex、Claude Code、OpenCode、Pi、Cursor、Copilot 和 Grok 集成。各节点会报告本机安装、启用和配置的代理。

分配并行工作时，为代理选择独立的项目范围或 Git 工作树。范围与并发关系见[执行说明](execution-resources.md)。

## 传输文件

`copy_artifact` 在执行节点之间复制文件。`start` 返回 `copy_id`，`observe` 查询进度，`cancel` 停止指定传输。

`download_artifact` 将聊天附件导入新的工作区路径。客户端提供附件引用、目标工作区和保存路径。

## 保存进度并在另一对话继续

`checkpoint_task` 将目标、判断、依据引用和下一步操作与真实执行记录一起保存。保存检查点或回复进度时，Task 保持开放。

换对话、交接给另一个入口、等待命令都不需要调用 `finish_task`。在接收入口先用 `task_resume` 检查原 Task：

```json
{"action":"inspect","task_id":"<original_task_id>"}
```

再使用返回的 `binding.binding_revision` 和本次选择的稳定 key 恢复：

```json
{"action":"resume","task_id":"<original_task_id>","expected_binding_revision":3,"request_key":"resume-original-goal-001"}
```

示例中的版本 `3` 必须替换为实际读到的绑定版本。回执丢失时沿用同一个 key 和版本重试；绑定已变化时先重新检查，再明确选择。恢复沿用 Task、原存储会话、工作区句柄和已受理操作的归属，不会自动让模型开始推理。卡片的当前入口与模型入口可能不同，各入口都必须使用自己经过认证的选择。已关闭 Task 保留为历史记录，`task_resume` 不能将它重新开启。

使用 `task_messages` 收取消息、确认具体消息 ID，并回复这个 Task 的输入。仅收取消息不会把它选为当前执行目标。

消息保留完整原文。普通文本最多使用 16 KiB UTF-8，JSON 转义也计入该上限。正文会同时出现在结构化结果和 JSON 文本块中，这两份编码后的正文合计最多 44 KiB；包含大量引号或反斜杠的文字会更早达到限制。卡片和服务端使用相同校验，在保存之前明确拒绝超限输入。

历史和领取请求按完整消息分页，在完整回包的 48 KiB 预算内为 ID、确认事实和游标保留空间。旧版本已经保存的消息或领取批次若超过该预算，请求会返回 `TASK_MAILBOX_BATCH_LIMIT`，保存的原文与原始确认状态保持完整；此错误不会确认、丢弃或替换消息。

### 恢复卡片中尚未确认的消息

点击卡片的保存按钮后，QuayMesh 会保留提交的原文和消息 key，直到收到匹配的服务端回执。宿主支持可选的 widget state API 时，卡片还会把这份待确认提交保存在自己专用的 `privateContent` 字段中。重新打开同一张卡片、查看同一个 Task 时，可以恢复原文和 key；需要明确点击**重试保存**，才会查询或重试原提交。恢复界面不会自动重发，也不会自动让 GPT 开始推理。如果宿主状态迟到，而你已经编辑了不同的草稿，卡片会保留草稿并单独显示上次待确认的原文。**重试上次消息**只提交原文和原 key，当前草稿仍未发送。

Widget state 属于这张渲染卡片，是否保留取决于宿主；它不是跨设备备份，也不能证明消息已由服务端保存。宿主不支持、状态畸形或过大、写入失败，或缓存属于另一个 Task 时，仍使用当前页面内存中的重试行为。此功能不保存尚未点击提交的文字。收到匹配的保存回执后，只有宿主当前可见记录的 Task、key 和原文全部匹配，卡片才尝试移除该缓存；记录缺失时不写入。宿主 API 没有比较并交换操作，无法保证不同 iframe 的旧快照之间清理绝对原子。消息状态和 GPT 回复仍从 Task 的服务端历史读取。

## 明确结束工作目标

仍需继续的目标可以保持开放。仅在目标完成，或用户明确终止它时调用 `finish_task`。命令完成、单次命令报错、回复进度或更换对话本身都不表示目标结束。

```json
{
  "task_id": "<task_id>",
  "status": "completed",
  "summary": "Built the application and copied the package to the release workspace.",
  "message_sequence": 0
}
```

`completed` 表示目标已完成；`failed` 表示目标没有完成且已经明确结束；`cancelled` 表示明确取消目标。`message_sequence` 必须等于最新 `task_messages` 返回的邮箱序号；只有从未有过消息时才使用 `0`。所有用户消息都必须已确认收到。确认期间出现新输入时，先读取和处理，再重新确认。

结束操作会核对活跃及结果未明的执行、收集留存证据，并记录目标的最终结果。持久确认仍在进行时，可以先返回 `state: "finalizing"`。`finish_task` 不负责取消命令；停止某条命令应使用 `cancel_command`，再核对实际结果。已关闭 Task 不再接收新工作或邮箱消息；文件、操作和已保存结果仍可经过授权查看。

新的 `finish_task(status="handed_off")` 请求返回 `TASK_HANDOFF_NOT_TERMINAL` 和 `effect: "not_started"`，Task 保持开放。先用 `checkpoint_task` 保存进度，再在接收入口恢复同一个 Task。历史上已经关闭的 `handed_off` 记录保持原样并可继续查看。启动时，开放 Task 上尚未确认的旧交接结束意图会标记为拒绝并退出自动结束重试，原摘要和以前的错误仍保留；不会自动重新开启历史 Task，也不会代替用户确认消息。
