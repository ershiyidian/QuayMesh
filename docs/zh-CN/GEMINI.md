# Gemini 入口

[English](../GEMINI.md) · 简体中文 · [安装](INSTALL.md)

QuayMesh 可以在 Linux 节点上管理供 Gemini 使用的固定 HTTPS MCP 地址。发行包包含公网 MCP 适配器，可选的 Tailscale 组件提供 Funnel 公网连接。它们分别以 `public-mcp` 和 `funnel` 接入现有节点组件管理。

## 配置入口

使用已获得固定 `*.ts.net` 地址和 Funnel 权限的专用 Tailscale 身份。首次设备登录和 Funnel 授权按照 [Tailscale 文档](https://tailscale.com/docs/features/tailscale-funnel)完成，QuayMesh 将身份保存在指定状态目录中。

在协调节点声明公网 OAuth 资源：

```json
{
  "publicMcp": {
    "url": "https://my-gateway.example-tailnet.ts.net/mcp",
    "allowedRedirectHosts": ["oauth-redirect.googleusercontent.com"]
  }
}
```

在承载入口的 Linux 节点配置同一公网地址，并启用受管 Funnel：

```json
{
  "publicMcp": {
    "url": "https://my-gateway.example-tailnet.ts.net/mcp",
    "listenPort": 29177,
    "funnel": {
      "stateDir": "/var/lib/quaymesh/gemini-tailscale",
      "controlProxyPort": 17889
    }
  }
}
```

入口节点需要外网访问能力。执行节点通过已有 MCP 转发入口连接协调节点。适配器只开放 MCP、OAuth 授权和发现路径，本地监听绑定回环地址。任务执行、OAuth 凭据和授权仍由协调节点统一管理。

`listenPort` 默认为 `29177`。`funnel.stateDir` 默认为节点 `stateDir` 下的 `tailscale` 目录；服务账户需要能够写入该目录。设备身份和 Funnel 配置保存在其中，升级时继续使用。`funnel.controlProxyPort` 默认为 `17889`，不能与其他本地监听端口冲突。

Linux 发行包可以在 `components/<platform>/` 中包含配套的 `tailscaled` 和 `tailscale`。已有相同版本的程序也可以通过 `components.tailscale.executable` 指向 `tailscaled`，CLI 必须放在同一目录。版本和官方下载地址记录在 `components.lock.json` 中，构建方法见[组件打包](CONTRIBUTING.md#构建平台安装包)。

## 动态出口与恢复

启用 QuayMesh 动态出口时，受管 Funnel 使用独立的回环控制入口，默认为 `127.0.0.1:17889`，由 `publicMcp.funnel.controlProxyPort` 配置。这个入口复用普通流量的动态出口选择和路由。普通业务仍使用 `127.0.0.1:17890`，或 `consoleSettings.egress.listenPort` 指定的端口。新连接使用当前选中的健康出口节点，已有健康连接沿原路径继续运行。

只有同时启用受管 Funnel 和动态出口时才会开放控制入口。维护暂停普通业务准入期间，Funnel 的控制连接仍能恢复，因此激活流程可以先确认入口就绪，再恢复业务。两个入口继续遵循相同的动态选出口能力。

组件会检查专用 Tailscale 实例及 Funnel 配置。进程仍在运行、控制连接却持续停滞时，入口会显示异常，并可以独立重启。重建的连接通过当前动态出口重新连接。需要登录或外部网络中断时，组件显示相应状态，避免立即反复重启。

重启 `funnel` 保留状态目录、域名和已有授权，Core 与已经受理的任务继续运行。健康的出口切换本身不会触发入口重启。

## 接管已有的独立入口

先准备包含 Tailscale 配套程序的正式 QuayMesh 发行包。如果当前版本尚不支持受管 Funnel 配置，先保持现有节点配置并完成一次正式激活。成功后再添加 `publicMcp.funnel`，确保回退版本也能识别新配置。保留原公网地址以及协调节点的资源声明。

如果原独立适配器和 Tailscale 服务使用该节点的动态出口，应在激活流程排空旧节点前停止它们。保留原配置和服务定义以便回退，并在受管 Funnel 接管前禁用旧服务的自动启动。Tailscale 停止后，可以继续使用原状态目录，也可以将其中所有常规文件和目录连同权限完整复制到新的持久 `funnel.stateDir`；不要复制 `tailscaled.sock`。保留原目录作为回退副本，不能同时运行使用同一身份的两个 daemon。

备份节点配置，将受管 Funnel 设置写入已安装的 `node.json`，然后执行 `install --config /path/to/node.json --prefix /path/to/new-empty-release-directory --no-start`，再执行 `activate --prepared <manifestFile>`。安装器支持将同一源码提交再次准备到新的空目录，并沿用安装记录中的服务身份。准备已有安装时，安装器采用当前正式节点配置。两次激活都保留正常的准入排空、进程检查、数据库备份和稳定性检查。

确认 Tailscale 设备身份保持不变、公网 OAuth 元数据正常，并完成一次真实 Gemini MCP 请求后，再移除旧服务定义。后续按正常节点安装、激活流程升级，入口代码和组件定义随正式发行更新。

## 查看与恢复

```bash
./runtime/node bin/quaymesh.js status --config /path/to/node.json
./runtime/node bin/quaymesh.js doctor --config /path/to/node.json
./runtime/node bin/quaymesh.js restart --config /path/to/node.json --component funnel
```

分别查看 `public-mcp` 和 `funnel` 的组件状态。最近就绪检查时间和探测错误对应本地适配器、隧道的实际状态。日志位于 `stateDir/logs/public-mcp.log` 和 `stateDir/logs/funnel.log`。

完整调用验证包括读取公网 OAuth 元数据，以及重新发起 Gemini MCP 请求。匿名访问 `/mcp` 通常得到 OAuth `401` 授权提示；后续带授权的客户端响应会记录在适配器请求日志中。日志省略查询参数、授权值和 Cookie。
