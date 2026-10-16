# QuayMesh Android 客户端

当前仓库已建立唯一的 Android 源码树：`app/src/main`、Gradle 配置和 `build-cli.sh`。客户端默认只接受用户输入的 HTTPS Console 地址，使用系统存储访问令牌范围内的文件 URI；Manifest 只声明网络权限，保存文件使用 64 KiB 分块。

本机目前只有 `adb`，没有 Java、Gradle、Android SDK Build Tools，因此还没有生成 APK。运行 `build-cli.sh` 时会在缺少官方工具时直接报出缺失项并退出，不会生成伪造产物。正式发布前仍需使用真实 SDK 构建，并在真实设备验证 Access 登录、上传、下载、旋转、前后台切换和取消保存。
