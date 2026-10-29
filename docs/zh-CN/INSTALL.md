# 安装

[English](../INSTALL.md) · 简体中文 · [首页](../../README.zh-CN.md)

## 安装包

从[发布页面](https://github.com/ershiyidian/QuayMesh/releases)下载 Windows x64 或 Linux x64 安装包，解压到自行选择的目录。包内包含 Node.js、Core（核心服务）、Console（控制台）、网络组件和运行依赖。

使用 Git 工作区的机器需要安装 Git。Linux 后台服务使用 systemd，Windows 桌面窗口使用 Microsoft Edge WebView2。

## 在一台机器上运行

`examples/local.json` 将协调节点、执行节点和控制台入口配置在同一台机器上，使用本机地址，工作目录为 `~/quaymesh-projects`。

Linux，在解压目录中执行：

```bash
mkdir -p ~/quaymesh-projects
./runtime/node bin/quaymesh.js init-site --directory ./site --inventory ./examples/local.json
./runtime/node bin/quaymesh.js run --config ./site/local.json
```

Windows，使用 PowerShell：

```powershell
New-Item -ItemType Directory -Force "$HOME\quaymesh-projects"
.\runtime\node.exe .\bin\quaymesh.js init-site --directory .\site --inventory .\examples\local.json
.\runtime\node.exe .\bin\quaymesh.js run --config .\site\local.json
```

打开 `http://127.0.0.1:17676/console/`。登录密码是 `site/secrets.local.env` 中自动生成的 `QUAYMESH_OWNER_TOKEN`。将这个文件保存在自己的本机配置目录中。

修改 `site/local.json` 的 `roots`，可以添加自己的项目目录：

```json
{
  "roots": [
    {
      "id": "projects",
      "nickname": "Projects",
      "path": "~/quaymesh-projects"
    }
  ]
}
```

安装后台服务前，使用 Ctrl+C 结束前台进程。

## 安装后台服务

Linux：

```bash
./runtime/node bin/quaymesh.js install --config /absolute/path/site/local.json
systemctl --user status quaymesh-node.service
```

需要在登录前启动时，由管理员为该账户开启用户服务：

```bash
sudo loginctl enable-linger YOUR_USER
```

Windows：

```powershell
.\runtime\node.exe .\bin\quaymesh.js install --config C:\QuayMeshSite\local.json
```

使用托盘和桌面窗口时，在节点配置的 `capabilities` 中增加 `"desktopUi": true`，然后安装。安装器会为当前用户创建名为 `QuayMesh` 的计划任务。使用 TUN 网络模式时，需要管理员终端。

Linux 系统服务可以使用专用账户。先创建账户，配置该账户能够访问的 `stateDir`，然后执行：

```bash
sudo ./runtime/node bin/quaymesh.js install \
  --system --service-user quaymesh \
  --config /etc/quaymesh-site/worker.json
```

## 连接 MCP 客户端

本地 MCP 入口是 `http://127.0.0.1:17676/mcp`。在支持 HTTP 的 MCP 客户端中填写这个地址，并完成所有者授权。

连接 ChatGPT 时，通过反向代理或 OpenAI Secure MCP Tunnel（安全 MCP 隧道）提供 HTTPS 入口。在 ChatGPT 的应用设置中创建应用，填写 MCP 地址，并完成 QuayMesh 的 OAuth 登录。应用中能够使用的操作由 ChatGPT 工作区设置决定。

具体界面操作见 OpenAI 的[连接说明](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)和[开发者模式说明](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。

## 连接多台机器

准备一个协调节点和若干执行节点。协调节点提供统一 MCP 入口和任务目录，各个执行节点提供本机项目。

使用协调节点实际可达的地址生成站点：

```bash
./runtime/node bin/quaymesh.js init-site \
  --directory ./site \
  --peer udp://YOUR_COORDINATOR_ADDRESS:11010
```

命令会生成 `cluster.json`、`cloud.json`、`worker.json` 及每个节点对应的凭据文件。设置执行节点的项目目录后，将每个节点的配置、凭据文件和共享集群配置复制到对应机器。

先安装协调节点，再安装执行节点：

```bash
./runtime/node bin/quaymesh.js install --config /path/site/cloud.json
./runtime/node bin/quaymesh.js install --config /path/site/worker.json
```

增加节点时，为其设置独立的 ID 和网络地址。`examples/` 包含 Linux 和 Windows 节点示例；也可以通过 `init-site --inventory` 一次生成自定义站点的全部配置。

`mesh.mode: "no-tun"` 通过本机 SOCKS5 连接虚拟网络。`mesh.mode: "tun"` 使用系统虚拟网卡。已有网络能够提供配置中的节点地址时，可以设置 `mesh.enabled: false`。

使用 OpenAI 隧道发现服务时，在终端设置 `QUAYMESH_TUNNEL_ID` 和 `QUAYMESH_TUNNEL_API_KEY`，并为 `init-site` 增加 `--resource-url YOUR_TUNNEL_RESOURCE_URL`。发现节点连接同一个隧道资源和协调节点。

同一个 Linux 账户同时运行协调节点和执行节点时，为它们分别配置配置目录、状态目录、端口、systemd 服务和发行目录（`--prefix`）。协调节点使用 `install --config /path/site/cloud.json --config-dir /path/coordinator-config --prefix /path/coordinator-releases/RELEASE --service-name quaymesh-coordinator.service`，执行节点可沿用 `quaymesh-node.service`。后续升级自动沿用各自安装记录中的服务名。

## 升级

在新版安装包目录执行：

```bash
./runtime/node bin/quaymesh.js install --config /path/to/current/node.json --no-start
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json
```

第一条命令准备新的版本目录，并返回 `manifestFile`。第二条命令在当前工作允许切换时更新服务。安装记录保留上一版本，便于恢复。

升级时使用已安装的 `node.json`，使用其他配置文件则传入原来的 `--config-dir`；省略服务选项会继承记录中的用户／系统服务范围、运行账户和 unit 路径，显式改变这些身份会被拒绝。

切换会暂停新工作，等待已受理的命令、Agent 回合、文件传输和出口连接结束。出口隧道持续占用到客户端关闭；一段时间没有流量不会授权切断模型连接。排空超时会保留当前服务。

准备发行包时，会使用包内 Node 和实际安装的 SQLite 依赖完成验证，包括 500 轮原生连接关闭与垃圾回收。激活会保存一致的 SQLite 备份，持久化 `installation-transition.json`，并要求同一个 Core 进程连续就绪 60 秒后恢复工作准入。管理进程重启会保留这段暂停；`status` 显示尚未收口的切换记录。

备份固定同一读取快照，后台状态写入不会让复制反复重启。连续 60 秒没有复制页数进展时中止；总时限按 60 秒加上快照大小以 4 MiB/s 换算的时间计算，最多 30 分钟。备份失败只终止自有备份子进程，等待它退出后才放弃激活；当前服务继续运行，数据库迁移尚未开始。

切换记录中的备份需要升级到相匹配的目标发行结构版本时，Core 启动时限为 30 秒加上备份实际大小以 4 MiB/s 换算的时间，最多 30 分钟。激活另保留 60 秒连续稳定检查和 30 秒服务启动余量。普通启动、结构版本不变的重装、降级和恢复标记仍使用原来的 30 秒 Core 时限；节点状态会显示本次采用的启动预算。

数据库结构保持兼容时可自动回切。失败升级已经改变结构时，安装器保留新版数据库、备份和切换记录，等待恢复处理。还原前应核对记录中的备份以及所有使用该状态目录的进程。现有命令管道、PTY 和模型连接继续由原进程持有；升级等待这些工作结束。

通过 QuayMesh 命令发起 Windows 升级时，先准备发行包，再启动独立激活任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\node\windows-activate.ps1 -PreparedManifest C:\path\returned\prepared.json
```

命令返回 `resultPath`。Windows Task Scheduler 持有独立激活进程，旧 Host 进程组退出后安装器继续执行。任务验证准备记录与原生运行时，再交由安装器完成准入、持久工作排空、备份和稳定就绪检查。安装器的物理静止检查认可有效执行证明，同时保留历史未知结果；活动工作或尚无物理证明的工作会阻挡切换，保留当前服务。结果和完整日志保留在 `stateDir/activations/`。发行已提交后，末尾状态复核失败会保留当前服务。TUN 节点需要从已提升权限的会话注册任务。

新版发行清单记录 Node、依赖锁文件和验证时实际加载的 SQLite 原生模块的 SHA-256。激活在整个就绪窗口中核对运行 Core 的进程身份与这些指纹。同一发行重启时，`active-release.json` 保留原激活时间，并用 `startedAt` 单独记录本次进程启动。

## 查看节点

```bash
./runtime/node bin/quaymesh.js status --config /path/to/node.json
./runtime/node bin/quaymesh.js doctor --config /path/to/node.json
./runtime/node bin/quaymesh.js restart --config /path/to/node.json --component discovery
```

`status` 显示运行版本、组件状态、集群连接和配置版本。组件日志位于 `stateDir/logs/`。

组件状态分别记录最近退出码、退出信号和就绪探测错误。近期反复退出的组件需连续通过就绪探测 60 秒才恢复正常，并在此期间退出网关候选。新网关配置的恢复回切等待默认为 60 秒，已有明确设置保持原值。

新旧版本共存时，旧管理器已记录至少三次 Core 重启的节点，需要报告就绪状态和新鲜观测，并保持同一进程及节点连接稳定至少五分钟，才会承载新的出口连接。达到稳定窗口后，历史重启次数继续保留且恢复网关资格。现有模型流仍由原网关承载。

接下来可以阅读[配置说明](CONFIGURATION.md)和[任务说明](TASKS.md)。
