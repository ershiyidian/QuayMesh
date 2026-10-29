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

### Linux SQLite 兼容构建

需要支持较旧的 glibc 时，在该 Linux 基线环境上，使用相匹配的 Node 头文件和已有的 node-gyp 构建锁定的 SQLite 依赖。编译和消费回执的构建机均需能从 `PATH` 找到 GNU binutils 的 `readelf`，也可通过独立工具目录提供。工具复制独立源码，将临时文件和缓存保存在指定工作目录，并记录编译器、头文件、依赖、运行时和二进制指纹；不会下载工具或头文件。请在 Git 工作树外选择新的工作目录，并保留足够空间。

```bash
node scripts/build-sqlite-native.mjs \
  --work-dir /data/quaymesh-native-build \
  --node-gyp /opt/node-gyp/bin/node-gyp.js \
  --node-headers /opt/node-headers/24.21.0 \
  --python /usr/bin/python3 --cc /usr/bin/gcc --cxx /usr/bin/g++ \
  --max-glibc 2.31

pnpm build:bundle --sqlite-native-receipt /data/quaymesh-native-build/build-receipt.json
```

源码构建使用 SQLite 的 `--force_build=1`，检查 ELF 依赖，并通过默认加载器完成 500 次原生关闭／垃圾回收验证。回执与相对路径下的产物可一起传到其他 Linux 构建机。打包时要求 Node 实际字节、依赖锁和 SQLite/node-addon-api 源码完全相同，将已验证文件复制为独立 inode，随后执行原有的完整发行和数据库结构验证，最后归档。`release.json` 记录实际原生 SHA 和随包 `sqlite-native-build.json` 的回执 SHA。产物单独归档时，还可传 `--sqlite-native-artifact /path/linux-x64.node`，其字节仍必须匹配回执中的哈希。

编译器嵌入了私有 RPATH 或 RUNPATH 时，可增加 `--patchelf /usr/bin/patchelf`。工具保留原编译产物，只在新副本上移除该路径，记录工具及修改前后哈希，并确认动态依赖没有改变。随后清空 `LD_LIBRARY_PATH` 验证实际加载；系统 C++ 运行库不足时，构建仍会失败。

编译器的 C++ 运行库比目标系统更新时，可增加 `--static-cxx-runtime`。构建记录 `-static-libstdc++ -static-libgcc`，拒绝仍依赖动态 `libstdc++` 或 `libgcc_s` 的产物，并执行相同的干净环境加载和 GC 验证；不会替换系统运行库。

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
