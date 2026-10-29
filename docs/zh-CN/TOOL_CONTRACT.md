# 工具参考

[主页](../../README.md) · [任务指南](TASKS.md) · [English](../TOOL_CONTRACT.md)

| 功能 | 工具 |
| --- | --- |
| 任务 | `start_session`、`task_resume`、`checkpoint_task`、`task_messages`、`finish_task` |
| 工作区 | `workspace_catalog`、`open_workspace`、`attach_workspace` |
| 文件 | `read`、`workspace_context`、`apply_patch` |
| 命令 | `exec_command`、`read_output`、`write_stdin`、`cancel_command` |
| 代理 | `spawn_agent`、`followup_agent`、`send_message`、`wait_agent`、`list_agents`、`interrupt_agent` |
| 文件传输 | `download_artifact`、`copy_artifact` |

连接的节点会公布可用工具及其参数格式。后续调用使用工具返回的工作区、操作、任务和传输标识。

## 工具返回结果

工具同时通过 `structuredContent` 和 `content` 中的 JSON 文本块提供结构化结果。只读取文本的客户端也能获得相同的工作区标识、操作标识、状态、错误和续读游标。独有的文字说明、图片和资源块继续保留，界面元数据留在 `_meta` 中。

工作区操作使用返回的 `workspace_id`。`worker/main` 这类导出的 `root_id` 用于选择要打开或挂载的目录。打开后的工作区标识包含执行节点的路由，后续原样复用。

分页读取和命令输出在计算回包大小时，会同时计入两种结果表示。需要更多内容时，使用返回的游标续读。文本序列化在节点路由和回执处理之后进行，历史回执也能获得完整文本表示，无需改写已保存的记录。

`workspace_context` 批量状态超过回包预算时，会保留每个操作的身份与状态，并返回 `details_deferred: true` 和读取该操作完整回执的单项 `next_action`。按该请求和后续分页游标读取原文；批量查询不会改动已保存的操作。

联邦部署由公开 MCP Coordinator 生成最终响应。发布返回格式修复时需要更新这个协调节点；单独更新 Worker 不会改变公开 MCP 响应。

完整操作示例见[任务与代理](TASKS.md)，执行范围见[文件变更与并发](execution-resources.md)。
