#!/bin/sh
# install-scheduler.sh — 대시보드 주간 자동 갱신 launchd LaunchAgent 등록 (이 맥 한정)
#
# 매주 월요일 07:00 에 dashboard/ingest.mjs 를 실행하도록 사용자 LaunchAgent 를 등록한다.
# 절대경로는 이 스크립트 위치와 `which node` 로 실행 시점에 자동 해석하므로, 레포를 옮겨도
# 재실행하면 새 경로로 갱신된다. 재등록 안전(기존 등록이 있으면 bootout 후 bootstrap).
#
# 시각 변경: 아래 START_HOUR / START_WEEKDAY 수정 후 재실행.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.kuka.dashboard-ingest"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$SCRIPT_DIR/run-ingest.sh"
NODE="$(command -v node)"
UID_NUM="$(id -u)"

# 스케줄 (launchd Weekday: 0/7=일, 1=월 ... 6=토)
START_WEEKDAY=1
START_HOUR=7
START_MINUTE=0

chmod +x "$WRAPPER"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/dashboard/logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$WRAPPER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>INGEST_NODE</key>
    <string>$NODE</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$PROJECT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>$START_WEEKDAY</integer>
    <key>Hour</key>
    <integer>$START_HOUR</integer>
    <key>Minute</key>
    <integer>$START_MINUTE</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT/dashboard/logs/launchd-stderr.log</string>
</dict>
</plist>
PLIST_EOF

# 재등록 안전: 기존 등록 제거 후 재등록
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

echo "등록 완료: $PLIST"
echo "  스케줄: 매주 월요일 ${START_HOUR}:$(printf '%02d' "$START_MINUTE") (Weekday=$START_WEEKDAY)"
echo "  node:   $NODE"
echo ""
echo "상태 확인:  launchctl print gui/$UID_NUM/$LABEL"
echo "즉시 실행:  launchctl kickstart -k gui/$UID_NUM/$LABEL"
echo "로그:       $PROJECT/dashboard/logs/ingest-launchd.log"
echo "해제:       sh $SCRIPT_DIR/uninstall-scheduler.sh"
