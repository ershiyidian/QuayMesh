#!/usr/bin/env bash
set -Eeuo pipefail

# 家庭网关接管数据库后，移除阿里云上的历史 QuayMesh / TaskQuay 构建和备份。
# 本脚本为一次性清理，禁止触碰独立的 /opt/easytier 和 TCP 转发单元。

mode="${1:---dry-run}"
[[ "$mode" == "--dry-run" || "$mode" == "--apply" ]] || exit 2
[[ "$(systemctl is-active easytier.service)" == "active" ]] || exit 3
for port in 7676 7680 7681; do
  systemctl is-active --quiet "quaymesh-home-forward@${port}.socket" || exit 3
done
for service in taskquay.service taskquay-portal.service quaymesh-backup.service; do
  [[ "$(systemctl is-active "$service")" != "active" ]] || { echo "$service active"; exit 3; }
done
[[ ! -e /root/.local/state/quaymesh ]] || { echo "Coordinator state still on Cloud"; exit 3; }
[[ ! -e /root/.local/share/quaymesh/releases ]] || { echo "Legacy active releases still on Cloud"; exit 3; }
curl -fsS --max-time 5 http://127.0.0.1:7676/readyz >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:7681/healthz >/dev/null

paths=(
  /root/quaymesh-backup-out
  /root/quaymesh-incoming
  /root/quaymesh-new-43c7c00
  /root/quaymesh-stage-ffb46f0
  /root/quaymesh-stage-2165565
  /root/quaymesh-stage-14e807f
  /root/qm-stage-0b8d1a5
  /root/quaymesh-backups
  /root/quaymesh-backup-20261002-171515
  /root/quaymesh-lifecycle-20261023
  /root/quaymesh-upgrade-43c7c00
  /root/quaymesh-0.1.0-1408d2d1adaa-linux-x64.zip
  /root/quaymesh-43c7c00.tar.gz
  /root/quaymesh-ffb46f0-linux-x64.zip
  /root/quaymesh-0b8d1a5-linux-x64.zip
  /root/.local/share/quaymesh/staging
  /opt/quaymesh/releases
  /opt/taskquay
  /opt/taskquay-portal
  /opt/taskquay-next
  /opt/taskquay-final-20260929
)
for path in /opt/taskquay-final-20260929-* /opt/taskquay-final-20260930-*; do
  [[ -e "$path" || -L "$path" ]] && paths+=("$path")
done

for path in "${paths[@]}"; do
  if [[ -L "$path" ]]; then echo "Refusing symlink $path";exit 4;fi
  if [[ -e "$path" && ! -d "$path" && ! -f "$path" ]]; then
    echo "Unexpected file type $path";exit 4
  fi
done

echo "Cloud legacy files selected for deletion:"
for path in "${paths[@]}"; do
  if [[ -e "$path" ]]; then du -sh "$path" 2>/dev/null || true;fi
done
df -h /

if [[ "$mode" == "--dry-run" ]]; then
  echo LEGACY_DRY_RUN_OK
  exit 0
fi

for path in "${paths[@]}"; do
  if [[ -d "$path" ]]; then rm -rf -- "$path"
  elif [[ -f "$path" ]]; then rm -f -- "$path"
  fi
done
for unit in /etc/systemd/system/taskquay.service /etc/systemd/system/taskquay-portal.service;do
  if [[ -f "$unit" && ! -L "$unit" ]];then rm -f -- "$unit";fi
done
systemctl daemon-reload
curl -fsS --max-time 5 http://127.0.0.1:7676/readyz >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:7681/healthz >/dev/null
systemctl is-active --quiet easytier.service
for port in 7676 7680 7681; do
  systemctl is-active --quiet "quaymesh-home-forward@${port}.socket"
done
echo LEGACY_PRUNE_OK
df -h /
