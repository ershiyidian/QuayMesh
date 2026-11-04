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

## Gemini 虚拟机、Library 与工作节点之间传文件

MCP 工具负责把文件字节传过虚拟机边界。Gemini 的原生文件工具把 Library 文件读入虚拟机，也负责把虚拟机中还原的文件保存到 Library。QuayMesh 读取或写入所选工作节点的工作区。

| 方向 | 用法 | 限制 |
| --- | --- | --- |
| 虚拟机或 Library → 工作节点 | 在虚拟机读取文件并转成 base64，调用 `download_artifact`，传入 `file.content_base64` | 每个文件解码后最多 1 MiB |
| 工作节点 → 虚拟机或 Library | 调用 `read` 并设置 `encoding: "base64"`，逐页解码后追加到虚拟机文件 | 每页最多 16,384 字节 |
| 较大文件 | 上传到明确选择的 Google Drive 文件夹，再把文件 ID 交给 `download_artifact` 或发行包内的 Drive 脚本 | MCP 接收遵守工作节点的文件大小配置和五分钟下载期限；脚本流式处理大文件 |

整个 MCP JSON 请求上限为 2 MiB。Base64 会增加体积，因此内联接收上限设为 1 MiB。`download_artifact` 创建新文件；提供 `size` 或 `sha256` 时会校验。下载失败会保留已有目标文件。

内联输入示例：

```json
{
  "workspace_id": "所选工作区句柄",
  "path": "input/example.bin",
  "file": {
    "content_base64": "AP8BAg==",
    "file_name": "example.bin",
    "size": 4
  }
}
```

读取二进制文件时，首次把 `response_offset` 设为零，随后使用返回的 `response_page.next_offset`，直到它为 null。在 base64 模式下，偏移量和 `response_page.total_code_points` 都按字节计数；`result_sha256` 对应当前页解码后的字节。每页可能带有 base64 补位，必须逐页解码，再追加字节。传输期间保持源文件稳定。

从 Drive 接收时，传入 `file: { "gdrive_file_id": "Drive 文件 ID", "file_name": "archive.zip" }`。公开分享文件无需令牌；私有文件使用目标工作节点服务环境中的 `GDRIVE_ACCESS_TOKEN`，令牌需要有读取该文件的权限。令牌不进入 MCP 参数。默认文件下载在启用动态出口时经过工作节点的 QuayMesh 出口，否则遵循该进程的 HTTP 代理环境。跳转后的内容地址不会收到 Google API 的授权令牌。

通过 MCP 下载 Google Drive 文件时，跳转和文件正文共用五分钟网络期限。大文件或慢速连接应在目标工作节点运行发行包的 `pull` 命令，并设置适合的 `--timeout-ms`，例如 `--timeout-ms 1800000` 表示三十分钟。脚本把文件流式写入所选的新路径；下载失败后重新执行 `pull` 会从头开始。

### 发行包内的 Drive 脚本

使用发行包自带的 Node 运行：

```bash
./runtime/node scripts/gdrive-bridge.mjs pull --file-id DRIVE_FILE_ID --out archive.zip
./runtime/node scripts/gdrive-bridge.mjs push --file archive.zip --folder-id DRIVE_FOLDER_ID
./runtime/node scripts/gdrive-bridge.mjs encode --file small.bin
./runtime/node scripts/gdrive-bridge.mjs decode --base64 AP8BAg== --out example.bin
```

已安装的工作节点通过 `node.json` 的 `secretsFile` 指定凭据文件，在该文件设置 `GDRIVE_ACCESS_TOKEN`。Node 会把文件内容注入 Core 环境，安装升级会保留该凭据文件。保留文件原有的访问限制及其他条目。独立运行脚本时，从本地进程环境读取私有下载和上传所需的令牌。上传必须明确提供 `--folder-id` 或 `GDRIVE_FOLDER_ID`，脚本没有内置个人目录。缺少授权时会在上传前报错。命令行参数不接收凭据。

上传采用 Google 的可续传协议，每次发送最多 8 MiB 的文件分片。响应丢失时先查询服务器进度，再从服务器确认的位置继续，并限制重试次数。下载流式写入临时文件，完成下载及所要求的 SHA-256 校验后再发布为新文件。`--timeout-ms` 设置每次网络请求的期限，默认为 300,000 毫秒。脚本遵循 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`；`--proxy` 可指定 HTTP 代理。通过 QuayMesh 启动的命令按配置继承其动态出口代理。

`encode` 和 `decode` 最多处理 1 MiB；更大的虚拟机传输使用上述分页读取或 Drive 流程。Google 授权和 Library 文件发布由宿主的原生功能完成，脚本不代办授权或发布 Library 文件。

需要同时更新协调节点和将要读取、接收文件的工作节点。旧版 `584819d` 的工具定义缺少二进制读取和新增文件引用。继续使用原有 Gemini HTTPS 入口及已保留的 Tailscale 身份。
