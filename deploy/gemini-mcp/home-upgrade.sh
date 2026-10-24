#!/usr/bin/env bash
set -Eeuo pipefail

base=/home/quaymesh/quaymesh-archive/releases/gemini-mcp-ingress-20261024
node_config=/home/quaymesh/.config/quaymesh-coordinator/node.json
unit=/home/quaymesh/.config/systemd/user/quaymesh-coordinator.service
old_release=/home/quaymesh/.local/share/quaymesh/releases/b34bfd56d91db3a4385f184a980f7cd246ff5bc4-linux-x64
new_release=/home/quaymesh/.local/share/quaymesh/releases/2dab7fd19a89ce7decb265f07c26a7540ffe8d26-linux-x64
next_config="$node_config.gemini-next"
log="$base/coordinator-upgrade.log"
umask 077
exec >>"$log" 2>&1
echo "$(date -u +%FT%TZ) Starting Gemini resource compatibility upgrade"

test -x "$old_release/runtime/node"
test -x "$new_release/runtime/node"
test -f "$next_config"
test -f "$unit"
systemctl --user is-active --quiet quaymesh-coordinator.service
systemctl --user is-active --quiet quaymesh-node.service

backup_config="$base/config/coordinator.before-gemini.json"
backup_unit="$base/config/coordinator.before-gemini.service"
mkdir -p "$base/config"
test ! -e "$backup_config"
cp -a "$node_config" "$backup_config"
cp -a "$unit" "$backup_unit"
python3 - "$unit" "$new_release" "$base/config/coordinator.next.service" <<'PY'
from pathlib import Path
import sys
old=Path(sys.argv[1]).read_text()
old_release='/home/quaymesh/.local/share/quaymesh/releases/b34bfd56d91db3a4385f184a980f7cd246ff5bc4-linux-x64'
assert old.count(old_release)>=2,'Original unit unexpected; refusing migration'
new=old.replace(old_release,sys.argv[2])
Path(sys.argv[3]).write_text(new)
PY

# 当前命令回执先返回给 Cloud，再关闭 Coordinator；执行在独立 systemd 服务中。
sleep 8
upgraded=false
rollback() {
  local status="$?"
  trap - EXIT
  if [[ "$status" == 0 ]]; then echo "$(date -u +%FT%TZ) GEMINI_CORE_UPGRADE_OK"; exit 0; fi
  echo "$(date -u +%FT%TZ) Gemini Core upgrade failed, restoring original release"
  systemctl --user stop quaymesh-coordinator.service || true
  cp -a "$backup_config" "$node_config"
  cp -a "$backup_unit" "$unit"
  systemctl --user daemon-reload
  systemctl --user start quaymesh-coordinator.service
  if curl --fail --silent --max-time 4 http://127.0.0.1:27676/readyz >/dev/null; then
    echo "ROLLED_BACK_OLD_CORE_HEALTHY"
  else
    echo "ROLLED_BACK_OLD_CORE_UNCONFIRMED"
  fi
  exit "$status"
}
trap rollback EXIT
systemctl --user stop quaymesh-coordinator.service
cp -a "$next_config" "$node_config"
cp -a "$base/config/coordinator.next.service" "$unit"
systemctl --user daemon-reload
systemctl --user start quaymesh-coordinator.service
ready=false
for _ in $(seq 1 90); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:27676/readyz >/dev/null 2>&1 &&
     curl --fail --silent --max-time 2 http://127.0.0.1:27681/healthz >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "New Core readiness failed";exit 1; }
release=$(curl --fail --silent --max-time 4 http://127.0.0.1:27677/status |
  python3 -c 'import sys,json;print(json.load(sys.stdin).get("release",""))')
[[ "$release" == 2dab7fd19a89ce7decb265f07c26a7540ffe8d26 ]] || {
  echo "Unexpected release: $release";exit 1;
}
systemctl --user is-active --quiet quaymesh-node.service
upgraded=true
echo "The previous Home Worker is still running; Coordinator release $release"
