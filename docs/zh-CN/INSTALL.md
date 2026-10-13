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

## 升级

在新版安装包目录执行：

```bash
./runtime/node bin/quaymesh.js install --config /path/to/current/node.json --no-start
./runtime/node bin/quaymesh.js activate --prepared /path/returned/prepared.json
```

第一条命令准备新的版本目录，并返回 `manifestFile`。第二条命令在当前工作允许切换时更新服务。安装记录保留上一版本，便于恢复。

## 查看节点

```bash
./runtime/node bin/quaymesh.js status --config /path/to/node.json
./runtime/node bin/quaymesh.js doctor --config /path/to/node.json
./runtime/node bin/quaymesh.js restart --config /path/to/node.json --component discovery
```

`status` 显示运行版本、组件状态、集群连接和配置版本。组件日志位于 `stateDir/logs/`。

接下来可以阅读[配置说明](CONFIGURATION.md)和[任务说明](TASKS.md)。
