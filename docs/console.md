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

## Sign in

Use the owner password generated with your site configuration. Console sessions persist across browser visits, and the Windows application stores its session through the current user's encrypted storage.

The account controls include signing out of the current device and revoking sessions across devices.

## Desktop application

Enable `desktopUi` on a Windows node before installation. The application opens the same console through the node's local relay and follows its light or dark theme.

The tray, Host, browser favicon, and desktop application share the project icon in `app.ico`.

## Connection state

The console reports node connectivity and the freshness of displayed data. Previously received data remains visible while the next refresh runs.

Node status and component logs are available for investigating a disconnected machine. See [installation](INSTALL.md#inspect-a-node).

## Task history

![QuayMesh](assets/tasks.png)
