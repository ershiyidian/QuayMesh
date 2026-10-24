#!/usr/bin/env bash
set -Eeuo pipefail

# 实际 Coordinator 只允许在家庭网关本地重启，不影响独立的 Home Worker 和 EasyTier。
base=/home/quaymesh/quaymesh-archive/releases/gemini-mcp-ingress-20261024
unit=/home/quaymesh/.config/systemd/user/quaymesh-coordinator.service
root=/home/quaymesh/.local/share/quaymesh/releases
previous="$root/2dab7fd19a89ce7decb265f07c26a7540ffe8d26-linux-x64"
next="$root/94849a1feccbcf75cfc8831ceeb2d3c72b043cbb-linux-x64"
log="$base/issuer-compat-upgrade.log"

umask 077
exec >> "$log" 2>&1
echo "$(date -u +%FT%TZ) Preparing controlled Coordinator upgrade"
systemctl --user is-active --quiet quaymesh-coordinator.service
systemctl --user is-active --quiet quaymesh-node.service
test -x "$next/runtime/node"
test -s "$base/coordinator-pre-94849a1.sqlite"
test ! -e "$base/issuer-previous-unit.service"
cp -a "$unit" "$base/issuer-previous-unit.service"

python3 - "$unit" "$previous" "$next" "$base/issuer-next-unit.service" <<'PY'
from pathlib import Path
import sys
existing=Path(sys.argv[1]).read_text()
assert existing.count(sys.argv[2]) >= 2, "Unexpected installed Coordinator version"
next_unit=existing.replace(sys.argv[2],sys.argv[3])
Path(sys.argv[4]).write_text(next_unit)
print("New Coordinator unit has correct release paths")
PY

# 让调用进程先返回稳定执行回执；后续重启在独立 systemd 服务里执行。
sleep 7
cutover=false
rollback() {
  local code="$?"
  trap - EXIT
  if [[ "$code" == 0 ]]; then echo "ISSUER_COMPAT_UPGRADE_OK"; exit 0; fi
  echo "Upgrade failed ($code); rolling back previous Coordinator release"
  systemctl --user stop quaymesh-coordinator.service || true
  cp -a "$base/issuer-previous-unit.service" "$unit"
  systemctl --user daemon-reload
  systemctl --user start quaymesh-coordinator.service
  if curl -fsS --max-time 4 http://127.0.0.1:27676/readyz >/dev/null;then
    echo "OLD_COORDINATOR_RECOVERED"
  else
    echo "OLD_COORDINATOR_RECOVERY_UNCONFIRMED"
  fi
  exit "$code"
}
trap rollback EXIT
systemctl --user stop quaymesh-coordinator.service
cp -a "$base/issuer-next-unit.service" "$unit"
systemctl --user daemon-reload
systemctl --user start quaymesh-coordinator.service

ready=false
for _ in $(seq 1 100);do
  if curl -fsS --max-time 2 http://127.0.0.1:27676/readyz >/dev/null 2>&1 &&
     curl -fsS --max-time 2 http://127.0.0.1:27681/healthz >/dev/null 2>&1;then
    ready=true;break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "New Core did not become ready";exit 1; }
release=$(curl -fsS --max-time 4 http://127.0.0.1:27677/status |
  python3 -c 'import json,sys;print(json.load(sys.stdin).get("release",""))')
[[ "$release" == "94849a1feccbcf75cfc8831ceeb2d3c72b043cbb" ]] || {
  echo "Unexpected active release: $release";exit 1;
}
systemctl --user is-active --quiet quaymesh-node.service
echo "Coordinator successfully upgraded to $release; original Home Worker still running"
