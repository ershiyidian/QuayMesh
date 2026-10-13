# 配置

[English](../CONFIGURATION.md) · 简体中文 · [首页](../../README.zh-CN.md)

QuayMesh 将集群共享设置与每台机器的配置分开保存。`init-site` 会生成这些配置及各个节点需要的凭据。

## 配置文件

| 文件 | 用途 |
| --- | --- |
| `cluster.json` | 协调节点地址、网络连接、隧道设置、出口优先级 |
| `<node>.json` | 节点能力、项目目录、存储位置、组件设置 |
| `secrets.<node>.env` | 对应节点使用的凭据 |
| `components.lock.json` | 构建发行包使用的组件和运行时版本 |

节点配置中的相对路径以配置文件所在目录为起点。以 `~` 开头的路径指向运行节点的账户目录。

## 节点能力

一个节点可以同时启用多项能力：

| 配置名称 | 职责 |
| --- | --- |
| `coordinator` | 统一 MCP 入口、授权、节点目录和任务目录 |
| `worker` | 工作区访问、命令、文件和编程代理 |
| `discovery` | 将 OpenAI 隧道连接到协调节点 |
| `consoleRelay` | 提供共享控制台的本地入口 |
| `desktopUi` | Windows 托盘和桌面窗口 |
| `meshRelay` | 提供 EasyTier 网络会合入口 |
| `egress` | 为其他节点提供网络出口 |

协调节点 ID 与 `cluster.coordinator.id` 一致。各执行节点使用独立的 ID 和网络地址。

## 项目目录

`roots` 指定执行节点提供哪些目录：

```json
{
  "roots": [
    {
      "id": "projects",
      "nickname": "Projects",
      "path": "~/projects",
      "description": "Application source",
      "tags": ["development"]
    }
  ]
}
```

客户端通过 `workspace_catalog` 查询目录，再通过 `open_workspace` 和选定的 `root_id` 打开工作区。也可以单独打开其中的子目录。

## 网络

`mesh.mode: "no-tun"` 通过 EasyTier 本地 SOCKS5 服务连接网络；`mesh.mode: "tun"` 创建系统虚拟网卡；`mesh.enabled: false` 使用已有网络连接。

直接访问外部服务的节点可以使用：

```json
{
  "network": {
    "externalAccess": true,
    "inheritProxy": false
  }
}
```

使用本地 HTTP 代理时，增加 `proxyUrl` 并填写实际地址。需要 QuayMesh 管理代理进程时，在 `components.egress` 中配置可执行文件、参数和配置路径。

共享配置中的 `egress.priorities` 指定出口偏好。健康节点按优先级接收新连接，已有连接继续使用原来选择的出口。

## 编程代理

节点的 `core` 字段可以设置核心服务选项。通过 `core.subagents` 启用本机已经安装和配置的代理，节点目录会显示它们的可用状态。

代理账户和凭据保留在该机器的代理配置中。具体操作见[任务与代理](TASKS.md)。

## 存储

| 平台 | 配置目录 | 状态目录 |
| --- | --- | --- |
| Linux | `~/.config/quaymesh/` | `~/.local/state/quaymesh/` |
| Windows | `%LOCALAPPDATA%\QuayMesh\config\` | `%LOCALAPPDATA%\QuayMesh\state\` |

通过 `stateDir` 可以将数据库、命令输出、任务记录和日志放在指定磁盘上。项目文件继续保存在 `roots` 对应的目录。

程序安装在独立的版本目录中，配置和状态与程序文件分开管理。

## 凭据

站点生成器创建集群、网络和所有者凭据。启用发现服务的节点还会获得隧道凭据。

凭据保存在生成的环境文件中，也可以通过进程环境变量提供。各个节点的配置文件交给运行该节点的账户保存。公开示例使用变量名称和文档示例值。

## 发布共享设置

修改共享集群配置后执行：

```bash
./runtime/node bin/quaymesh.js publish \
  --config /path/site/cloud.json \
  --cluster /path/site/cluster.json
```

节点分别记录已应用的配置版本和待应用版本，并根据组件依赖及当前工作执行配置切换。

## 默认端口

| 端口 | 服务 |
| --- | --- |
| `7676/TCP` | 核心 HTTP 服务：MCP、OAuth、控制台 |
| `7680/TCP` | 执行节点通信 |
| `7681/TCP` | 协调节点目录和共享配置 |
| `17676/TCP` | 本地 MCP 和控制台入口 |
| `17677/TCP` | 本地节点管理 |
| `17690/TCP` | no-TUN 模式的 EasyTier SOCKS5 |
| `17890/TCP` | 执行节点模型代理入口 |
| `11010/UDP` | 示例 EasyTier 会合入口 |
| `8080/TCP` | tunnel-client 健康接口 |

使用主机防火墙将集群服务限制在节点网络内。面向客户端的入口通过 HTTPS 反向代理或隧道提供。

全部字段见 [`schema/v1/`](../../schema/v1/) 中的 JSON 配置定义。
