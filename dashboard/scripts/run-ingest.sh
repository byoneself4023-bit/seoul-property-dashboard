#!/bin/sh
# run-ingest.sh — launchd 래퍼
# 대시보드 주간 자동 갱신용. dashboard/ingest.mjs 를 실행하고 모든 표준출력/에러를
# dashboard/logs/ingest-launchd.log 로 남긴다. 매 실행 시 직전 로그를 .prev 로 1세대만
# 보관해 로그가 무한 증식하지 않게 한다.
#
# launchd 는 PATH 가 최소이므로 node 는 절대경로를 사용한다. 설치 스크립트가 plist 의
# EnvironmentVariables 로 INGEST_NODE(= which node 결과)를 주입한다. 없으면 기본 경로.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE="${INGEST_NODE:-/usr/local/bin/node}"
LOG_DIR="$PROJECT/dashboard/logs"
LOG="$LOG_DIR/ingest-launchd.log"

mkdir -p "$LOG_DIR"
# 직전 실행 로그를 .prev 로 이동(1세대 보관). 항상 현재+직전 2개만 유지.
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.prev"

rc=0
{
  echo "=== ingest 시작: $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  echo "PROJECT=$PROJECT"
  echo "NODE=$NODE"
  if cd "$PROJECT"; then
    "$NODE" dashboard/ingest.mjs
    rc=$?
  else
    echo "[래퍼] cd 실패: $PROJECT"
    rc=1
  fi
  echo "=== ingest 종료 (exit=$rc): $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
} > "$LOG" 2>&1

exit "$rc"
