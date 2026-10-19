# Python projects

[English](PYTHON_WORKFLOW.md) · [简体中文](zh-CN/PYTHON_WORKFLOW.md) · [Home](../README.md) · [Task operations](TASKS.md)

Open the project's workspace on the machine that contains its Python environment. Use the environment's Python executable when running project commands.

## Find an interpreter

Call `workspace_context` with `action: "status"` and `environment: true` to read the workspace's platform, shell, configured command profiles, and Python candidate paths. An optional `python` selects a path or executable name to look up.

The response's `python.executable` is the first candidate found, or `null` when none is found. `python.candidates` contains the discovered paths, and `python.verification` is always `"not_run"`. Discovery reads filesystem metadata and `PATH`; it does not start Python, import project code, or verify a Python version. An explicit candidate that is missing does not fall back to another interpreter.

Use `exec_command` to check the chosen interpreter or run a script, and inspect its output and exit code. A discovered file may fail to start or may be a different program. Environment discovery does not install or repair it.

## Run a project command

A Linux virtual environment:

```json
{
  "workspace_id": "<workspace_id>",
  "cmd": ".venv/bin/python -m pytest",
  "yield_time_ms": 1000
}
```

A Windows virtual environment:

```json
{
  "workspace_id": "<workspace_id>",
  "cmd": ".venv\\Scripts\\python.exe -m pytest",
  "yield_time_ms": 1000
}
```

Read subsequent output through `read_output` and the returned operation ID. The command uses the selected workspace as its directory.

## Save reusable scripts

Write project scripts into files, then execute them through the project's interpreter. This keeps the command readable and makes the same script available to collaborators.

Record useful decisions and the next action with `checkpoint_task`. Generated reports and packages can be transferred to another workspace through `copy_artifact`.
