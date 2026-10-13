#!/usr/bin/env sh
set -eu
command -v java >/dev/null 2>&1 || { echo '缺少 Java；请安装受支持的 JDK。' >&2; exit 1; }
command -v gradle >/dev/null 2>&1 || { echo '缺少 Gradle；请安装官方 Gradle 或提交 wrapper。' >&2; exit 1; }
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
[ -n "$ANDROID_HOME" ] || { echo '缺少 ANDROID_HOME/ANDROID_SDK_ROOT；请安装 Android SDK。' >&2; exit 1; }
test -x "$ANDROID_HOME/platform-tools/adb" || { echo 'Android SDK platform-tools 不完整。' >&2; exit 1; }
gradle --no-daemon --offline -p "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" :app:assembleRelease
