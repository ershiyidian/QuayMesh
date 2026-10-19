# Python 项目

[English](../PYTHON_WORKFLOW.md) · [简体中文](PYTHON_WORKFLOW.md) · [首页](../../README.md) · [任务操作](TASKS.md)

在包含项目 Python 环境的机器上打开工作区。运行项目命令时使用该环境的 Python 可执行文件。

## 查找解释器

调用 `workspace_context`，设置 `action: "status"` 和 `environment: true`，即可读取工作区的平台、Shell、已配置的命令配置及 Python 候选路径。可选参数 `python` 指定要查找的路径或可执行文件名。

返回的 `python.executable` 是找到的首个候选路径；找不到时为 `null`。`python.candidates` 列出发现的路径，`python.verification` 始终为 `"not_run"`。发现过程只读取文件元数据和 `PATH`，不会启动 Python、导入项目代码或验证 Python 版本。显式指定的候选不存在时，不会切换到其他解释器。

通过 `exec_command` 检查所选解释器或运行脚本，并查看输出和退出码。发现的文件可能无法启动，也可能是其他程序；环境查询不会安装或修复它。

## 运行项目命令

Linux 虚拟环境：

```json
{
  "workspace_id": "<workspace_id>",
  "cmd": ".venv/bin/python -m pytest",
  "yield_time_ms": 1000
}
```

Windows 虚拟环境：

```json
{
  "workspace_id": "<workspace_id>",
  "cmd": ".venv\\Scripts\\python.exe -m pytest",
  "yield_time_ms": 1000
}
```

通过 `read_output` 和返回的操作 ID 继续读取输出。命令以所选工作区为工作目录。

## 保存可复用脚本

将项目脚本保存为文件，再通过项目解释器执行。这样命令清晰可读，其他协作者也能运行同一份脚本。

通过 `checkpoint_task` 记录有用的决定和下一步操作。生成的报告及软件包可以通过 `copy_artifact` 传到另一个工作区。
