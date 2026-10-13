# File changes and concurrency

[English](execution-resources.md) · [简体中文](zh-CN/execution-resources.md) · [Home](../README.md)

QuayMesh tracks the scope of each operation so independent work can proceed concurrently.

## Files and project scopes

Structured file updates request the files they change. Two operations on different files can proceed independently. A directory write includes the files beneath that directory.

General shell commands use a project scope. Inside a Git repository, the default scope is the working tree. In a directory containing several projects, the default covers that directory.

`working_directory` selects the command's actual directory. `execution_scope` declares the affected project area for scheduling. Operating-system permissions determine which files the process can access.

Use a specific project directory for long-running commands. This leaves unrelated projects available for other operations.

## Changes and snapshots

The first mutation establishes a task baseline. Structured edits and transfers provide affected paths for incremental collection. General shell commands trigger collection of workspace changes.

Git snapshots use a temporary index, preserving the user's staged changes. Each task keeps its own baseline and file summaries.

The console displays the saved difference for each file. Restore actions check the recorded ownership and current file contents before applying a change.

## Parallel development

Use separate Git worktrees for tasks that need independent copies of the same repository:

```json
{
  "root_id": "worker/projects",
  "subdirectory": "my-app",
  "mode": "worktree",
  "base_ref": "main"
}
```

For operations sharing a checkout, select non-overlapping file or project areas. A conflict response identifies the operation and resource currently in use.

## Command profiles

Administrators can configure reusable commands under `tools.commandProfiles`. A profile specifies the executable, arguments, read paths, write paths, and shared resources.

The `${workspace}` placeholder expands to the workspace directory. `${output}` identifies the operation's output directory.

Profiles are useful for recurring builds, metrics collection, and project-specific commands with known file access.

## Service changes

Installation and configuration changes account for accepted operations before replacing components. Existing output remains queryable during maintenance.

Each node reports its applied release and configuration. See [installation](INSTALL.md) for service commands.
