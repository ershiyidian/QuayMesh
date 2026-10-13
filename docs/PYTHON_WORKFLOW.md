# Python projects

[Home](../README.md) · [Task operations](TASKS.md)

Open the project's workspace on the machine that contains its Python environment. Use the environment's Python executable when running project commands.

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
