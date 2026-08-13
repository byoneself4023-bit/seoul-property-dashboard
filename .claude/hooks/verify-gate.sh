#!/usr/bin/env bash
# Stop 훅 — 검증 게이트.
#
# 작업 완료 신호가 오면 이미 있는 검증을 돌린다. 실패하면 정지를 되돌리고
# (decision=block) 통과할 때까지 계속 작업하게 한다.
#
# 재시도 상한 3회. 검증이 구조적으로 통과할 수 없는 경우(러너 환경 문제,
# 잘못된 전제)에 무한히 돌며 API를 소모하는 것을 막는다. 상한에 걸리면
# 멈추고, 무엇을 몇 번 시도했고 왜 실패했는지 남긴다.
#
# 변경된 파일에 따라 필요한 검증만 돌린다. npm run verify 는 puppeteer로
# 실제 브라우저를 띄우므로 화면/데이터가 바뀌었을 때만 돈다.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" 2>/dev/null || exit 0

MAX_ATTEMPTS=3
INPUT=$(cat)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null || echo nosession)

STATE_DIR="$ROOT/.claude/.state"
mkdir -p "$STATE_DIR" 2>/dev/null
COUNT_FILE="$STATE_DIR/verify-${SESSION}.count"
LOG_FILE="$STATE_DIR/verify-${SESSION}.log"

# ── 무엇이 바뀌었는지 ────────────────────────────────────────────
CHANGED=$(git status --porcelain 2>/dev/null | cut -c4- | tr -d '"')
if [ -z "$CHANGED" ]; then
  : > "$COUNT_FILE"
  exit 0                       # 변경 없음 — 검증할 것이 없다
fi

changed_match() { printf '%s\n' "$CHANGED" | grep -qE "$1"; }

CHECKS=()
changed_match '^dashboard/ingest\.mjs$'                 && CHECKS+=("ingest-syntax" "ingest-selftest")
changed_match '^dashboard/(dashboard\.html|data\.js)$'  && CHECKS+=("verify-quality")
changed_match '^dashboard/verify-quality\.mjs$'         && CHECKS+=("verify-quality")
changed_match '^dashboard/scripts/.*\.sh$'              && CHECKS+=("shell-syntax")

# 중복 제거
CHECKS=($(printf '%s\n' "${CHECKS[@]:-}" | awk 'NF && !seen[$0]++'))

FAILED=()
: > "$LOG_FILE"

run() {   # run <이름> <표시할 명령> -- <실제 명령...>
  local name="$1" label="$2"; shift 3
  {
    echo "=== $name : $label ==="
    "$@" 2>&1
    echo "--- exit=$? ---"
  } >> "$LOG_FILE" 2>&1
  if ! tail -1 "$LOG_FILE" | grep -q -- '--- exit=0 ---'; then
    FAILED+=("$name ($label)")
  fi
}

for c in "${CHECKS[@]:-}"; do
  case "$c" in
    ingest-syntax)   run "$c" "node --check dashboard/ingest.mjs" -- node --check dashboard/ingest.mjs ;;
    ingest-selftest) run "$c" "node dashboard/ingest.mjs --selftest" -- node dashboard/ingest.mjs --selftest ;;
    verify-quality)  run "$c" "npm run verify" -- npm run --silent verify ;;
    shell-syntax)
      for s in dashboard/scripts/*.sh; do
        run "$c" "sh -n $s" -- sh -n "$s"
      done ;;
  esac
done

# ── git status: 의도치 않은 변경 확인 ────────────────────────────
# 추적 파일 삭제와 gitignore 대상의 추적 진입은 거의 항상 사고다.
DELETED=$(git status --porcelain 2>/dev/null | grep -E '^( D|D )' | cut -c4- || true)
[ -n "$DELETED" ] && FAILED+=("의도치 않은 추적 파일 삭제: $(echo "$DELETED" | tr '\n' ' ')")
LEAKED=$(git diff --cached --name-only 2>/dev/null | grep -E '(^|/)(\.env($|\.)|\.cache/|data\.json$)' || true)
[ -n "$LEAKED" ] && FAILED+=("스테이징에 gitignore 대상이 들어옴: $(echo "$LEAKED" | tr '\n' ' ')")

# ── 판정 ─────────────────────────────────────────────────────────
if [ ${#FAILED[@]} -eq 0 ]; then
  : > "$COUNT_FILE"
  exit 0
fi

N=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$COUNT_FILE"
SUMMARY=$(printf '  - %s\n' "${FAILED[@]}")
TAIL=$(tail -40 "$LOG_FILE")

if [ "$N" -ge "$MAX_ATTEMPTS" ]; then
  : > "$COUNT_FILE"
  jq -n --arg s "검증 게이트: ${MAX_ATTEMPTS}회 시도 후 상한 도달 — 멈춥니다.
실패 항목:
$SUMMARY
전체 로그: $LOG_FILE

구조적으로 통과할 수 없는 검증일 수 있습니다(환경 문제·잘못된 전제). 사람이 확인하세요." \
    '{systemMessage: $s, suppressOutput: true}'
  exit 0
fi

jq -n --arg r "검증 게이트 실패 (시도 ${N}/${MAX_ATTEMPTS}). 아래를 고치고 다시 완료하세요.

실패 항목:
$SUMMARY

로그 끝부분:
$TAIL

전체 로그: $LOG_FILE" \
  '{decision: "block", reason: $r}'
exit 0
