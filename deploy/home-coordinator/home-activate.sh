#!/usr/bin/env bash
set -Eeuo pipefail

state=/home/quaymesh/.local/state/quaymesh-coordinator
logdir=/home/quaymesh/quaymesh-archive/releases/coordinator-migration-20261024/logs
mkdir -p "$logdir"
exec >> "$logdir/home-activation.log" 2>&1
echo "$(date -u +%FT%TZ) Waiting for the authoritative Cloud snapshot"

deadline=$((SECONDS+900))
while [[ ! -f "$state/.migration-ready" ]]; do
  if (( SECONDS >= deadline )); then echo 'No migration marker received'; exit 1; fi
  sleep 1
done

if [[ -f "$state/.migration-abort" ]]; then exit 1; fi
python3 - "$state/core/quaymesh.sqlite" <<'PY'
import sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
check=db.execute('pragma quick_check').fetchone()[0]
sessions=db.execute('select count(*) from qm_sessions').fetchone()[0]
tasks=db.execute('select count(*) from qm_tasks').fetchone()[0]
assert check=='ok' and sessions>=216 and tasks>=1283,(check,sessions,tasks)
db.close()
print('Validated migrated SQLite: sessions',sessions,'tasks',tasks)
PY
chmod 600 "$state/core/quaymesh.sqlite"
systemctl --user start quaymesh-coordinator.service
echo "$(date -u +%FT%TZ) Started Home-hosted Coordinator"

ready=false
for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 http://127.0.0.1:27676/readyz >/dev/null 2>&1 &&
     curl -fsS --max-time 2 http://127.0.0.1:27681/healthz >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [[ -f "$state/.migration-abort" ]]; then break; fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo 'New Coordinator did not become ready; stopping it'
  systemctl --user stop quaymesh-coordinator.service || true
  touch "$state/.migration-home-stopped"
  exit 1
fi

touch "$state/.migration-home-ready"
echo "$(date -u +%FT%TZ) Home Core and Registry ready, awaiting Cloud forwarding verification"
deadline=$((SECONDS+600))
while (( SECONDS < deadline )); do
  if [[ -f "$state/.migration-abort" ]]; then
    systemctl --user stop quaymesh-coordinator.service || true
    systemctl --user disable quaymesh-coordinator.service || true
    touch "$state/.migration-home-stopped"
    echo 'Aborted and stopped the new Coordinator'
    exit 1
  fi
  if [[ -f "$state/.migration-commit" ]]; then
    systemctl --user enable quaymesh-coordinator.service
    echo "$(date -u +%FT%TZ) Coordinator enabled for reboot persistence"
    exit 0
  fi
  sleep 2
done
echo 'Commit confirmation timed out; leaving the active Coordinator running for safe recovery'
exit 1
