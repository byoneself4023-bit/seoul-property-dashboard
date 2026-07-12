#!/bin/sh
# uninstall-scheduler.sh — 대시보드 주간 자동 갱신 LaunchAgent 해제
# launchd 등록을 내리고 plist 를 삭제한다. 로그(dashboard/logs/)는 남긴다.
set -u

LABEL="com.kuka.dashboard-ingest"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "해제 완료: $LABEL 등록 해제 + plist 삭제 ($PLIST)"
