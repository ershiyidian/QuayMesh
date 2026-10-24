#!/usr/bin/env bash
set -Eeuo pipefail

# 阿里云只保留 EasyTier 会合与三个 TCP 转发端口。
# 历史发行、主控数据库与迁移缓存已由家庭网关接管，此脚本只执行一次。

mode="${1:---dry-run}"
if [[ "$mode" != "--dry-run" && "$mode" != "--apply" ]]; then
  echo "Usage: bash cloud-prune-after-cutover.sh [--dry-run|--apply]" >&2
  exit 2
fi

old_unit=quaymesh-node.service
log=/root/.cache/quaymesh-home-migration/cutover.log
token=/root/.local/state/quaymesh/cluster.token

[[ "$(systemctl is-active "$old_unit")" == "inactive" ]] || { echo "Old Coordinator still running"; exit 3; }
[[ "$(systemctl is-enabled "$old_unit")" == "disabled" ]] || { echo "Old Coordinator still enabled"; exit 3; }
[[ "$(systemctl is-active easytier.service)" == "active" ]] || { echo "EasyTier is not running"; exit 3; }
for port in 7676 7680 7681; do
  systemctl is-active --quiet "quaymesh-home-forward@${port}.socket" || {
    echo "Forwarding port $port is not active"; exit 3;
  }
done
grep -q 'CUTOVER_OK' "$log" || { echo "Missing successful cutover receipt"; exit 3; }
curl -fsS --max-time 5 http://127.0.0.1:7676/readyz >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:7681/healthz >/dev/null

python3 - "$token" <<'PY'
import json, sys, urllib.request
token=open(sys.argv[1]).read().strip()
request=urllib.request.Request('http://127.0.0.1:7681/v1/membership',
                               headers={'Authorization':'Bearer '+token})
nodes=json.load(urllib.request.urlopen(request, timeout=5))['nodes']
online={n['id'] for n in nodes if n.get('online')}
required={'cloud','desktop','home-gateway','s1','s2'}
assert required <= online, ('Missing nodes', sorted(required-online))
coordinator=next(n for n in nodes if n['id']=='cloud')
assert coordinator['release'].startswith('b34bfd56'), coordinator['release']
print('Five live nodes confirmed; authoritative Coordinator is on the new release')
PY

if command -v fuser >/dev/null && fuser -s /root/.local/state/quaymesh/core/quaymesh.sqlite; then
  echo "Legacy Cloud SQLite database is still open"; exit 4
fi

paths=(
  /root/.cache/quaymesh-rollout
  /root/.cache/quaymesh-rollout-20261021
  /root/.cache/quaymesh-native13-20261022
  /root/.config/quaymesh/installations
  /root/.local/share/quaymesh/releases
  /root/.local/state/quaymesh
  /root/.config/quaymesh
  /root/.cache/quaymesh-home-migration
)
for path in "${paths[@]}"; do
  if [[ -L "$path" ]]; then echo "Refusing symlink: $path"; exit 4; fi
  if [[ -e "$path" && ! -d "$path" ]]; then echo "Expected directory: $path"; exit 4; fi
done
echo "The following old Coordinator paths will be removed:"
for path in "${paths[@]}"; do
  if [[ -d "$path" ]]; then du -sh "$path" 2>/dev/null || true; fi
done
echo "Original systemd unit: /etc/systemd/system/$old_unit"
df -h /

if [[ "$mode" == "--dry-run" ]]; then
  echo "DRY_RUN_OK: no files deleted"
  exit 0
fi

[[ -f /etc/systemd/system/$old_unit && ! -L /etc/systemd/system/$old_unit ]] || {
  echo "Unexpected original systemd unit"; exit 4;
}

for path in "${paths[@]}"; do
  if [[ -d "$path" ]]; then rm -rf -- "$path"; fi
done
rm -f -- /etc/systemd/system/quaymesh-node.service
systemctl daemon-reload
echo "Old Cloud Coordinator state and install files removed."
curl -fsS --max-time 5 http://127.0.0.1:7676/readyz >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:7681/healthz >/dev/null
for port in 7676 7680 7681; do
  systemctl is-active --quiet "quaymesh-home-forward@${port}.socket"
done
echo "CLOUD_RELAY_ONLY_OK"
df -h /
