#!/usr/bin/env bash
set -Eeuo pipefail

base=/home/quaymesh/quaymesh-archive/releases/gemini-mcp-stable-ingress-20261024
config=/home/quaymesh/.config/quaymesh-coordinator/node.json
unit=/home/quaymesh/.config/systemd/user/quaymesh-coordinator.service
releases=/home/quaymesh/.local/share/quaymesh/releases
old="$releases/94849a1feccbcf75cfc8831ceeb2d3c72b043cbb-linux-x64"
next="$releases/190b01bad9f31de02a97af6ec514295638caf9f6-linux-x64"
candidate="$base/coordinator.tsnet-next.json"
previous_config="$base/coordinator.before-tsnet.json"
previous_unit="$base/coordinator.before-tsnet.service"
next_unit="$base/coordinator.tsnet-next.service"
log="$base/coordinator-tsnet-cutover.log"

umask 077
exec >>"$log" 2>&1
echo "$(date -u +%FT%TZ) Preparing fixed-domain OAuth cutover"
test -s "$base/coordinator-before-tsnet.sqlite"
test -s "$candidate"
test -s "$previous_config"
test -x "$next/runtime/node"
test ! -e "$previous_unit"
systemctl --user is-active --quiet quaymesh-coordinator.service
systemctl --user is-active --quiet quaymesh-node.service
systemctl --user is-active --quiet quaymesh-public-mcp.service
systemctl --user is-active --quiet quaymesh-public-mcp-tailscale.service

python3 - "$unit" "$old" "$next" "$previous_unit" "$next_unit" "$candidate" <<'PY'
import json,sys
from pathlib import Path
source,old,next,backup,destination,candidate=sys.argv[1:]
current=Path(source).read_text()
assert current.count(old)>=2 and next not in current
settings=json.loads(Path(candidate).read_text())
assert settings['id']=='cloud'
assert settings['publicMcp']['url']=='https://quaymesh-mcp-home.tail2e51e6.ts.net/mcp'
assert settings['publicMcp']['legacyUrls']==['https://139-196-215-153.sslip.io/mcp']
Path(backup).write_text(current)
Path(destination).write_text(current.replace(old,next))
PY
chmod 600 "$previous_unit" "$next_unit"

# 启动命令先返回；后续操作在独立 systemd 单元内完成。
sleep 7
switched=false
rollback() {
  local status="$?"
  trap - EXIT
  if [[ "$status" == 0 ]]; then
    echo "$(date -u +%FT%TZ) TSNET_COORDINATOR_UPGRADE_OK"
    exit 0
  fi
  echo "$(date -u +%FT%TZ) Cutover failed ($status)"
  if [[ "$switched" == true ]]; then
    systemctl --user stop quaymesh-coordinator.service || true
    cp -a "$previous_config" "$config"
    cp -a "$previous_unit" "$unit"
    systemctl --user daemon-reload
    systemctl --user start quaymesh-coordinator.service
    if curl -fsS --max-time 5 http://127.0.0.1:27676/readyz >/dev/null 2>&1; then
      echo "PREVIOUS_COORDINATOR_RESTORED"
    else
      echo "PREVIOUS_COORDINATOR_RECOVERY_UNCONFIRMED"
    fi
  fi
  exit "$status"
}
trap rollback EXIT

systemctl --user stop quaymesh-coordinator.service
switched=true
cp -a "$candidate" "$config"
cp -a "$next_unit" "$unit"
systemctl --user daemon-reload
systemctl --user start quaymesh-coordinator.service
healthy=false
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 http://127.0.0.1:27676/readyz >/dev/null 2>&1 &&
     curl -fsS --max-time 2 http://127.0.0.1:27681/healthz >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || { echo "New Core/Registry failed readiness";exit 1; }
release=$(curl -fsS --max-time 5 http://127.0.0.1:27677/status |
  python3 -c 'import json,sys;print(json.load(sys.stdin).get("release",""))')
[[ "$release" == 190b01bad9f31de02a97af6ec514295638caf9f6 ]] || {
  echo "Unexpected active release: $release"
  exit 1
}
systemctl --user is-active --quiet quaymesh-node.service
systemctl --user is-active --quiet quaymesh-public-mcp.service
systemctl --user is-active --quiet quaymesh-public-mcp-tailscale.service
echo "New Coordinator active, legacy and new OAuth gateways remain running"
