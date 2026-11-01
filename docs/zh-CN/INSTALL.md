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

准备发行包时，会使用包内 Node 和实际安装的 SQLite 依赖完成验证，包括 500 轮原生连接关闭与垃圾回收。激活默认保存一致的 SQLite 备份，持久化 `installation-transition.json`，并要求同一个 Core 进程连续就绪 60 秒后恢复工作准入。管理进程重启会保留这段暂停；`status` 显示尚未收口的切换记录。

明确不需要复制数据库时，在激活命令中选择 `--no-backup`：

```bash
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json --no-backup
```

合并准备与激活的 `install --config /path/to/current/node.json --no-backup` 也支持此选项。使用 `--no-start` 时，后续 `activate` 仍需重新指定 `--no-backup`；准备阶段不保存激活策略。代码调用形式为 `activateInstallation(manifestFile, { backup: false })`。

该模式用候选发行的 SQLite 运行时只读打开现有数据库，要求记录的版本与候选要求的版本相同，且没有待执行的旧 Agent 修复。数据库不存在、版本不同或需要修复时，会在停止旧服务前拒绝激活，并释放本次维护暂停。该模式不创建数据库备份；准入排空、维护租约检查、回退边界和 60 秒连续稳定检查继续生效。准备发行包仍会写入选定的安装目录，可用 `--prefix` 选择有空间的磁盘；日常状态与配置更新继续使用其配置位置。

对于另外审核过的**统一数据库结构 16 → 19** 迁移，明确不需要数据库备份时，显式选择仅向前迁移：

```bash
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json --no-backup --forward-only
```

代码调用形式为 `activateInstallation(manifestFile, { backup: false, migrationPolicy: "forward-only" })`。该策略只接受完整的统一数据库 1–16 迁移记录和要求结构版本 19 的目标发行；数据库不存在、结构混杂、版本未知或源版本不同都会拒绝。单独使用 `--no-backup` 仍要求结构版本相同，有备份激活保留原有行为。准备阶段不保存激活策略，因此使用 `--no-start` 后仍需在激活时再次显式选择相应选项。

只读计划会在停止服务前拒绝已有外键违例，并列明版本 17 增加的 3 个索引；版本 18 在 `execution_claims` 和 `execution_waiters` 中各增加的 3 个可空 `TEXT` 列及 1 个索引；版本 19 增加的 5 张表及 6 个索引。计划同时列明候选发行末尾的旧 Agent 修复：存在 `thinking` 时，可能补齐最多 13 个缺失字段及 `local_agent_turns`，并且仅在 `effort IS NULL AND thinking IS NOT NULL` 时用 `thinking` 填充 `effort`。已有非空 effort 值保留。

正规停止服务、完成既有维护检查后，operator 使用候选发行的 SQLite 依赖打开原数据库，在一个外层 `IMMEDIATE` 事务中调用候选发行真实迁移函数，验证后才提交。验证覆盖原结构对象和旧表行数、迁移记录、新增可空身份列、新表为空、旧 Agent 修复及外键。过程不复制数据库、不创建旧表副本，也不对全部业务行计算哈希。行数及外键检查可能读取较多数据；助手执行时限为 3 分钟，operator 会等待其退出。超时或回执丢失**不代表已经回滚**：失败恢复会读取实际结构版本。一旦版本 19 已提交，激活的任何后续失败都会保留数据库和 `recovery_required` 标记，不会自动启动不兼容的旧版本 16 二进制。准入、停止范围审核、维护租约的全部四个阶段和稳定检查均保持原样。

确认迁移提交后，验证中的切换记录以 `database` 表示当前结构版本 19，让不可变候选发行使用正常启动预算；`databaseBeforeMigration` 保留原结构版本 16 的计划。安装器仍以原版本判断回滚边界；后续若进入 `recovery_required`，记录中的 `database` 保持原版本 16，实际版本另存为 `currentDatabaseVersion`。

独立受审的 operator 可以使用已准备发行的运行时，激活该不可变发行：

```bash
/path/to/prepared/runtime/node /path/to/reviewed-operator/bin/quaymesh.js \
  activate --prepared /path/returned/prepared.json --no-backup --forward-only
```

迁移助手来自 operator 的 `node/` 目录，真实迁移函数及 SQLite 依赖来自准备记录 `directory` 指向的发行。已准备的发行不需要包含新助手，也不会被改写。已有外部维护 provider 仍通过代码传给 `activateInstallation`；本选项不替代或绕过这些检查。

备份固定同一读取快照，后台状态写入不会让复制反复重启。连续 60 秒没有复制页数进展时中止；总时限按 60 秒加上快照大小以 4 MiB/s 换算的时间计算，最多 30 分钟。备份失败只终止自有备份子进程，等待它退出后才放弃激活；当前服务继续运行，数据库迁移尚未开始。

切换记录中的备份需要升级到相匹配的目标发行结构版本时，Core 启动时限为 30 秒加上备份实际大小以 4 MiB/s 换算的时间，最多 30 分钟。激活另保留 60 秒连续稳定检查和 30 秒服务启动余量。普通启动、结构版本不变的重装、降级和恢复标记仍使用原来的 30 秒 Core 时限；节点状态会显示本次采用的启动预算。

默认 `prove` 策略在数据库结构保持兼容时可自动回切。失败升级已经改变结构时，安装器保留新版数据库、已创建的备份和切换记录，等待恢复处理。还原前应核对已记录的备份以及所有使用该状态目录的进程。现有命令管道、PTY 和模型连接继续由原进程持有；升级等待这些工作结束。

显式 `historyPolicy: "preserve"` 必须使用受审外部维护 provider，保留未核实的执行历史及 claim，不将它们声明为物理完成或空闲。尝试停机后失败，会保留 `recovery_required`、数据库、已创建的备份和租约；即使数据库结构兼容，也不会自动启动旧二进制。后续恢复前须重新审核保留状态与当前进程代次。详见[保留未核实执行历史的升级](operations/PRESERVE-HISTORY-UPGRADES.md)。

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
