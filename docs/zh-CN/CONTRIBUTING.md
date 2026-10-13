# 参与开发

[English](../../CONTRIBUTING.md) · 简体中文 · [首页](../../README.zh-CN.md)

欢迎改进 QuayMesh 的核心服务、控制台、代理集成、文档和平台安装包。可以通过 Issue（问题讨论）说明需求，也可以提交 Pull Request（合并请求）。

## 准备源码

使用 `components.lock.json` 中记录的 Node.js **24.21.0**，以及 pnpm **11.25.0**。

```bash
git clone https://github.com/ershiyidian/QuayMesh.git
cd QuayMesh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

原生依赖使用当前操作系统对应的编译工具。

## 启动开发环境

```bash
pnpm dev:seed
pnpm dev
```

初始化命令在 `.quaymesh-dev/` 中创建本地配置、数据库、项目目录，并选择可用端口。终端会显示控制台地址。执行 `pnpm dev:reset` 前，先停止开发进程。

## 构建平台安装包

在对应操作系统上构建安装包：

```bash
pnpm build:components --source
pnpm build:bundle
```

组件构建使用 `third_party/sources/` 中的源码。Node.js、Rust、Go、EasyTier 和 tunnel-client 版本记录在 `components.lock.json` 中。

Linux 需要 C/C++ 编译器、pkg-config、OpenSSL 开发文件和 protobuf 编译器。Windows 需要 .NET 10 SDK 与 .NET Framework 4.8 编译器。

也可以导入已有组件程序：

```bash
pnpm build:components --easytier /path/easytier-core --tunnel /path/tunnel-client
pnpm build:bundle
```

输出目录为 `releases/quaymesh-<version>-<commit>-<platform>/`，包含 `release.json`、运行时、程序文件、运行依赖和组件源码。

## 检查修改

根据涉及的代码运行相应检查：

```bash
pnpm typecheck
pnpm test:node
pnpm build
```

指定 TypeScript 测试可以通过 `pnpm exec tsx --test <test-file>` 执行。集成测试使用真实临时文件、SQLite 数据库、子进程和本地连接。

界面修改后，查看桌面宽度与窄窗口中的实际效果。文档图片使用独立实例中的公开示例项目。

## 代码组织

[架构说明](ARCHITECTURE.md)提供目录分工。节点管理代码放在 `node/`，核心行为放在 `src/`，界面代码放在 `src/ui/`。

异步操作持续保留节点、工作区、任务和操作编号。用户配置及代理凭据保存在运行时的配置目录和状态目录。

## 提交修改

在合并请求中说明修改内容、使用效果和已经执行的检查。不同目的的修改分别提交。公共使用流程变化时，同时更新英文与简体中文文档。

保留所引用源码的版权与许可证。QuayMesh 的贡献使用 MIT 许可证，第三方组件保留各自许可。
