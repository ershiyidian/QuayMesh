#!/usr/bin/env bash
set -Eeuo pipefail

base=/home/quaymesh/quaymesh-archive/releases/gemini-mcp-stable-ingress-20261024
unit=/home/quaymesh/.config/systemd/user/quaymesh-coordinator.service
releases=/home/quaymesh/.local/share/quaymesh/releases
old="$releases/37d9b2fdc37c472ef992eec2cbbeb17db452f4a3-linux-x64"
next="$releases/64aa30259436a60b4a6ed1edac9f9f4d446b8472-linux-x64"
backup="$base/coordinator-before-64aa302.sqlite"
unit_backup="$base/coordinator.before-64aa302.service"
unit_next="$base/coordinator.64aa302.service"
log="$base/worker-catalog-upgrade.log"

umask 077
exec >>"$log" 2>&1
echo "$(date -u +%FT%TZ) Preparing Gemini worker-root catalog fix"
test -s "$backup"
test -x "$next/runtime/node"
test ! -e "$unit_backup"
systemctl --user is-active --quiet quaymesh-coordinator.service
systemctl --user is-active --quiet quaymesh-node.service
systemctl --user is-active --quiet quaymesh-public-mcp-tailscale.service
systemctl --user is-active --quiet quaymesh-tailscale-funnel.service

python3 - "$unit" "$old" "$next" "$unit_backup" "$unit_next" <<'PY'
from pathlib import Path
import sys
current=Path(sys.argv[1]).read_text()
assert current.count(sys.argv[2]) >= 2, 'Active Coordinator release unexpectedly changed'
assert sys.argv[3] not in current
Path(sys.argv[4]).write_text(current)
Path(sys.argv[5]).write_text(current.replace(sys.argv[2],sys.argv[3]))
PY
chmod 600 "$unit_backup" "$unit_next"

# 独立 systemd 单元继续处理，远端工具调用可以先交付回执。
sleep 8
switched=false
rollback() {
  local status="$?"
  trap - EXIT
  if [[ "$status" == 0 ]]; then
    echo "$(date -u +%FT%TZ) GEMINI_WORKER_CATALOG_FIX_OK"
    exit 0
  fi
  echo "$(date -u +%FT%TZ) Worker-catalog upgrade failed ($status)"
  if [[ "$switched" == true ]]; then
    systemctl --user stop quaymesh-coordinator.service || true
    cp -a "$unit_backup" "$unit"
    systemctl --user daemon-reload
    systemctl --user start quaymesh-coordinator.service
    if curl -fsS --max-time 4 http://127.0.0.1:27676/readyz >/dev/null 2>&1; then
      echo "PREVIOUS_COORDINATOR_RESTORED"
    else
      echo "PREVIOUS_COORDINATOR_RECOVERY_NEEDS_REVIEW"
    fi
  fi
  exit "$status"
}
trap rollback EXIT

systemctl --user stop quaymesh-coordinator.service
switched=true
cp -a "$unit_next" "$unit"
systemctl --user daemon-reload
systemctl --user start quaymesh-coordinator.service
ready=false
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 http://127.0.0.1:27676/readyz >/dev/null 2>&1 &&
     curl -fsS --max-time 2 http://127.0.0.1:27681/healthz >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "New Core or Registry failed readiness"; exit 1; }
release=$(curl -fsS --max-time 4 http://127.0.0.1:27677/status |
  python3 -c 'import json,sys;print(json.load(sys.stdin).get("release",""))')
[[ "$release" == 64aa30259436a60b4a6ed1edac9f9f4d446b8472 ]] || {
  echo "Unexpected active release: $release"
  exit 1
}
systemctl --user is-active --quiet quaymesh-node.service
systemctl --user is-active --quiet quaymesh-public-mcp-tailscale.service
systemctl --user is-active --quiet quaymesh-public-mcp.service
echo "Coordinator upgraded, old and new MCP origins and Home Worker preserved"
