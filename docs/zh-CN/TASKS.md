# 任务与代理

[English](../TASKS.md) · 简体中文 · [首页](../../README.zh-CN.md)

QuayMesh 将一次用户请求涉及的工作区、命令、文件和编程代理保存在同一个任务中。

## 创建任务与工作区

每次新的用户请求调用一次 `start_session`。重试同一个请求时，继续使用相同的 `request_key`。

```json
{
  "title": "Build the application",
  "request_key": "build-application-001"
}
```

`title` 是任务标题，`request_key` 用于识别同一个请求。

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

## 保存进度与结束任务

`checkpoint_task` 保存目标、判断、依据引用和下一步操作。这些说明与真实执行记录一起保留。

使用 `finish_task` 保存任务结果：

```json
{
  "task_id": "<task_id>",
  "status": "completed",
  "summary": "Built the application and copied the package to the release workspace."
}
```

示例摘要表示已经完成构建并将安装包复制到发布工作区。其他结果状态包括 `failed`（失败）、`cancelled`（已取消）和 `handed_off`（已交接）。当前回复结束后仍有已接收的工作继续执行时，使用 `handed_off`。

会话保留任务及其结果，方便之后查看。
