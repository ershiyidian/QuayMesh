#!/usr/bin/env bash
set -Eeuo pipefail

root=/root/.cache/quaymesh-home-migration
state=/root/.local/state/quaymesh
remote=rsync://10.144.144.3:18730/coordinator-data
mkdir -p "$root"
exec >> "$root/cutover.log" 2>&1
echo "$(date -u +%FT%TZ) Starting QuayMesh state cutover"

old_stopped=false
committed=false
sockets=(quaymesh-home-forward@7676.socket quaymesh-home-forward@7680.socket quaymesh-home-forward@7681.socket)

send_marker() {
  local name="$1"
  printf '%s\n' "$(date -u +%FT%TZ)" > "$root/$name"
  rsync --archive --timeout=20 "$root/$name" "$remote/.$name"
}

rollback() {
  local original="$?"
  trap - EXIT
  if (( original == 0 )); then
    echo "$(date -u +%FT%TZ) CUTOVER_OK"
    exit 0
  fi
  echo "$(date -u +%FT%TZ) CUTOVER_FAILED exit=$original"
  if [[ "$committed" == true || "$old_stopped" != true ]]; then exit "$original"; fi
  send_marker migration-abort || true
  local home_stopped=false
  for _ in $(seq 1 50); do
    if ! curl -fsS --max-time 1 -H 'Host: 10.144.144.254:7676' http://10.144.144.3:27676/healthz >/dev/null 2>&1; then
      home_stopped=true
      break
    fi
    sleep 2
  done
  if [[ "$home_stopped" != true ]]; then
    echo 'SAFETY_STOP: Home Coordinator is still serving; do not restart stale Cloud state'
    exit "$original"
  fi
  systemctl stop "${sockets[@]}" || true
  systemctl disable "${sockets[@]}" || true
  systemctl enable --now quaymesh-node.service
  echo "$(date -u +%FT%TZ) Previous Cloud Coordinator restored"
  exit "$original"
}
trap rollback EXIT

systemctl disable --now quaymesh-node.service
old_stopped=true
if systemctl is-active --quiet quaymesh-node.service; then
  echo 'Old Cloud Core is still active'; exit 1
fi
echo "$(date -u +%FT%TZ) Cloud Coordinator stopped; EasyTier remains independently active"
systemctl is-active --quiet easytier.service

python3 - "$state/core/quaymesh.sqlite" "$root/quaymesh.sqlite" <<'PY'
import sqlite3,sys
source=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=30)
target=sqlite3.connect(sys.argv[2])
source.backup(target,pages=2048,sleep=0.1)
assert target.execute('pragma quick_check').fetchone()[0]=='ok'
print('Final consistent SQLite backup prepared')
target.close()
source.close()
PY
rsync --archive --no-owner --no-group --timeout=180 "$root/quaymesh.sqlite" "$remote/core/quaymesh.sqlite"
for name in owner.json identity.json cluster.snapshot.json; do
  rsync --archive --no-owner --no-group --timeout=60 "$state/$name" "$remote/$name"
done
rsync --archive --no-owner --no-group --timeout=60 "$state/coordinator/" "$remote/coordinator/"

changes=$(rsync --archive --checksum --dry-run --itemize-changes --timeout=120 "$root/quaymesh.sqlite" "$remote/core/quaymesh.sqlite")
if [[ -n "$changes" ]]; then echo "Final SQLite checksum mismatch: $changes"; exit 1; fi
echo "$(date -u +%FT%TZ) Home has the final verified database and identity"
send_marker migration-ready

ready=false
for _ in $(seq 1 150); do
  if curl -fsS --max-time 2 -H 'Host: 10.144.144.254:7676' http://10.144.144.3:27676/readyz >/dev/null 2>&1 &&
     curl -fsS --max-time 2 http://10.144.144.3:27681/healthz >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Home Coordinator readiness timeout';exit 1;fi
echo "$(date -u +%FT%TZ) Home Core/Registry directly reachable"

systemctl enable --now "${sockets[@]}"
for port in 7676 7681; do
  path=/healthz
  [[ "$port" == 7676 ]] && path=/readyz
  if ! curl -fsS --max-time 10 "http://127.0.0.1:$port$path" >/dev/null; then
    echo "Cloud forwarding failed on port $port"; exit 1
  fi
done
echo "$(date -u +%FT%TZ) Public-identity Cloud forwarding is active"

online=false
for _ in $(seq 1 100); do
  if python3 - "$state/cluster.token" <<'PY'
import json,sys,urllib.request
token=open(sys.argv[1]).read().strip()
req=urllib.request.Request('http://127.0.0.1:7681/v1/membership',headers={'Authorization':'Bearer '+token})
try:
    with urllib.request.urlopen(req,timeout=4) as response:
        nodes=json.load(response)['nodes']
except Exception:
    sys.exit(1)
online={node['id'] for node in nodes if node.get('online')}
expected={'cloud','home-gateway','desktop','s1','s2'}
if not expected.issubset(online):sys.exit(1)
print('Verified online nodes:',','.join(sorted(expected)))
PY
  then online=true; break; fi
  sleep 2
done
if [[ "$online" != true ]]; then echo 'Fleet membership did not fully recover'; exit 1; fi
send_marker migration-commit
committed=true
echo "$(date -u +%FT%TZ) All five logical nodes reconnected to Home Coordinator"
