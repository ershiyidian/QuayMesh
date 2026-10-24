# Console

[English](console.md) · [简体中文](zh-CN/console.md) · [Home](../README.md)

The console brings tasks, workspaces, commands, and coding agents into one view. Open it in a browser or through the Windows desktop application.

![QuayMesh console](assets/console.png)

## Find your work

The overview shows current work and recent tasks. The task list provides the full history with status filters. Expand a task to inspect its workspaces, commands, output, and file changes.

Workspace details include the owning node, project, and path. Conversation pages group related tasks, while agent pages show provider threads and their execution state.

## Follow an operation

Command output is retained with the operation that produced it. A task can contain operations from several machines, each with its own state and result.

File differences belong to their task. Completed tasks retain their recorded files and output for later viewing.

### Understand task state

A request, its background executions, and its review have separate states. Finishing one command or workspace phase does not close the request. A request can also be handed off while its background execution continues. The details retain the delivery result alongside the current execution state.

“No background execution” means there is no confirmed active command or agent. It does not imply a request for user input. A failed or stopped last execution remains visible until further work supersedes it. Unresolved effects and stale observations stay in the attention view, including those from an older phase or a closed request. Finalization failures show their recorded cause.

Use **Finish request** to record a delivery result. Review acceptance and rejection are separate actions. Finishing requires confirmation that all relevant task members have no active or unresolved execution. An unrelated offline node does not block the task's controls.

### File evidence and capture state

An empty file list can mean that change capture is still running or has failed. The **Changes** tab reports capture state for each affected workspace, including its node, full path, and any recorded error. Files already captured remain available to inspect. A pending or failed capture is shown as incomplete evidence instead of “no changes.”

While the selected live scope has pending or failed capture, review acceptance and rejection, patch export, and file reversion are unavailable. Resolve a reported capture error or wait for the current capture, then refresh the file evidence. The server also checks capture state and evidence versions before allowing these operations. If evidence changes during a revert preview or paged patch export, refresh and start again so the operation uses one version you have inspected.

The absence of a capture notice means that the current service has not observed pending or failed capture. It does not establish that every file change has been archived. Completed immutable checkpoints retain their own evidence: capture in a later task, even in the same workspace, does not block viewing or exporting an earlier checkpoint. Older nodes that do not report capture state are not labelled as failed solely because that field is missing.

### Controls and receipts

Stop controls include managed commands and agents in all relevant phases. A batch preserves each target's outcome, including partial success and unavailable nodes. The original target plan and request identity are saved before dispatch. The operation receipts view can inspect the original request after a lost response without replaying successful targets.

Receipts distinguish no effect, applied, partial, and unknown effects. Acknowledging a stop request does not assert that its process has exited. When a write outcome is unknown, the form retains the original intent for reconciliation. A new edited intent receives a new request identity after a confirmed rejection.

### History, settings, and usage

Conversation search spans projects and nodes, and requests without an execution phase remain accessible. Multi-workspace task details identify each file's source and provide phase links for workspace-specific patch and revert operations. Task pagination preserves the chosen ordering for up to fifteen minutes. Cache capacity or a server restart can expire it earlier; an expired page prompts you to return to the first page. Refresh the first page to include later tasks or a new ordering.

Settings forms read the saved configuration with its revision, including changes awaiting application. Refresh compares the original values, local edits, and the newly saved values. Conflicting fields require an explicit choice. Saved and applied revisions, pending application, and application errors remain distinct.

Usage is assigned to each agent execution's completion date in the selected timezone. Running executions and records without a completion time are reported separately. Drilldowns retain the contributing execution date range, and task rankings combine all contributing phases before choosing the top tasks. Exports include their filters, timezone, and source coverage.

## Sign in

Use the owner password generated with your site configuration. Console sessions persist across browser visits, and the Windows application stores its session through the current user's encrypted storage.

The account controls include signing out of the current device and revoking sessions across devices.

## Desktop application

Enable `desktopUi` on a Windows node before installation. The application opens the same console through the node's local relay and follows its light or dark theme.

The local entry loads the console page, versioned assets, and API from the coordinator through the same authenticated connection. Updating the coordinator updates the page served by every relay. If the page cannot load, a reconnect screen retries the current address and keeps the existing sign-in session.

The tray, Host, browser favicon, and desktop application share the project icon in `app.ico`.

## Connection state

The console reports node connectivity and the freshness of displayed data. Previously received data remains visible while the next refresh runs. Normal background refreshes have no warning. Delayed updates and failed reads appear in one expandable notice, with the affected sources and their last confirmation times.

Resources refresh independently. Hiding the page or losing the connection cancels unnecessary reads; returning resumes them. Stale execution observations show that an update is needed. The task timer measures time from request creation to delivery, while each command retains its own execution duration. Known counts and missing coverage are shown separately. The diagnostics panel provides resource timings, versions, source state, and an exportable record.

Failure notifications use a separate saved event cursor for each node. An unavailable node keeps its cursor so events can be read when it returns. Notifications do not depend on the small sample shown in the overview.

Node status and component logs are available for investigating a disconnected machine. See [installation](INSTALL.md#inspect-a-node).

## Task history

![QuayMesh](assets/tasks.png)
