#!/usr/bin/env bash
# PreToolUse 훅 — 되돌릴 수 없는 작업 가드.
#
# 파일 삭제, 덮어쓰기, force push 를 가로채 확인을 요구한다.
# 판정은 ask(확인 요구) 또는 deny(차단). 나머지는 조용히 통과시킨다.
set -uo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')

ask()  { jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'; exit 0; }
deny() { jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'; exit 0; }

# 되돌릴 수 없는 자산 — 지우면 복구 경로가 없거나 매우 비싸다
PRECIOUS='dashboard/\.cache|\.cache/ingest'

# cp/mv 가 무언가를 덮어쓰는가? overwrite / create / unparsed 를 출력한다.
# 목적지가 없으면 새로 만드는 것이라 되돌릴 것이 없다 — 물을 이유가 없다.
# 파싱이 조금이라도 불확실하면 unparsed 로 떨어뜨려 ask 로 보낸다(fail-closed).
classify_copy() {
  _c="$1"
  case "$_c" in
    *'|'*|*'$'*|*'`'*|*';'*|*'&&'*|*'*'*|*'?'*) echo unparsed; return ;;
    *' -t '*|*'--target-directory'*)             echo unparsed; return ;;
  esac
  # shellcheck disable=SC2086
  set -- $_c
  _d=""
  for _a in "$@"; do _d="$_a"; done
  [ -n "$_d" ] || { echo unparsed; return; }
  case "$_d" in -*) echo unparsed; return ;; esac
  case "$_d" in "~"/*) _d="$HOME/${_d#~/}" ;; esac

  if [ -d "$_d" ]; then
    # 기존 디렉터리로 넣는 경우 — 같은 이름이 이미 있을 때만 덮어쓴다
    _n=0
    for _a in "$@"; do
      _n=$((_n+1))
      [ "$_n" -eq 1 ] && continue          # cp/mv 자체
      [ "$_a" = "$_d" ] && continue        # 목적지
      case "$_a" in -*) continue ;; esac   # 옵션
      case "$_a" in "~"/*) _a="$HOME/${_a#~/}" ;; esac
      [ -e "$_d/$(basename "$_a")" ] && { echo overwrite; return; }
    done
    echo create; return
  fi
  [ -e "$_d" ] && { echo overwrite; return; }
  echo create
}

if [ "$TOOL" = "Bash" ]; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

  # 1. 원본 캐시 — 133MB / 45만 건, 이 맥에만 있다. 지우면 5,500회 재수집.
  printf '%s' "$CMD" | grep -qE "(^|[;&|[:space:]])(rm|trash|shred)([[:space:]]|$).*($PRECIOUS)" \
    && deny "차단: .cache/ingest 는 이 맥에만 있는 원본 45만 건입니다. 지우면 5,500회 재수집이 필요합니다. 정말 필요하면 사람이 직접 실행하세요."

  # 2. 삭제 일반
  printf '%s' "$CMD" | grep -qE "(^|[;&|[:space:]])(rm|rmdir|trash|shred)([[:space:]]|$)" \
    && ask "삭제 명령입니다. 대상을 확인하세요: $CMD"

  # 3. force push / 이력 파괴
  printf '%s' "$CMD" | grep -qE 'git[[:space:]]+push.*(--force|-f([[:space:]]|$))' \
    && deny "차단: force push 는 원격 이력을 파괴합니다. 사람이 직접 실행하세요."
  printf '%s' "$CMD" | grep -qE 'git[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-[a-z]*f|filter-branch|filter-repo)' \
    && ask "되돌릴 수 없는 git 작업입니다: $CMD"

  # 4. 덮어쓰기 — 잘라내기 리다이렉트(>)와 cp/mv 로 기존 파일 위에 쓰는 것
  printf '%s' "$CMD" | grep -qE '[^>2]>[[:space:]]*[^>|[:space:]]*(dashboard\.html|data\.js|\.env|\.gitignore|package\.json)' \
    && ask "핵심 파일을 잘라내기 리다이렉트(>)로 덮어씁니다: $CMD"
  # cp/mv — 덮어쓸 때만 묻는다. 새로 만드는 복사(백업 생성 등)까지 묻으면
  # 승인만 잦아지고 정작 위험한 것에 무뎌진다. Write 훅과 같은 기준이다.
  if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])(cp|mv)[[:space:]]'; then
    case "$(classify_copy "$CMD")" in
      overwrite) ask "기존 파일을 덮어씁니다: $CMD" ;;
      unparsed)  ask "복사/이동 대상을 확신할 수 없습니다(변수·글롭·복합 명령). 확인하세요: $CMD" ;;
    esac
  fi

  # 5. 배포·수집 — 외부에 나가거나 API 할당량을 쓴다
  printf '%s' "$CMD" | grep -qE 'deploy\.sh|run-ingest\.sh' \
    && ask "배포/수집 스크립트입니다. 라이브와 API 할당량에 영향을 줍니다: $CMD"
  printf '%s' "$CMD" | grep -qE 'ingest\.mjs' \
    && ! printf '%s' "$CMD" | grep -qE '(--selftest|--check)' \
    && ask "수집 실행입니다(--selftest 아님). RTMS API 할당량을 씁니다: $CMD"

  exit 0
fi

if [ "$TOOL" = "Write" ]; then
  FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')
  # Write 는 전체 덮어쓰기다. 산출물·설정 파일 위에 쓰는 것만 확인을 요구한다.
  # (일반 소스 편집은 Edit 이 담당하므로 여기서 막지 않는다 — 승인 횟수를 늘리지 않기 위해)
  case "$FP" in
    */dashboard/data.js|*/dashboard/dashboard.html|*/.env|*/.gitignore|*/package.json|*/dashboard/scripts/*.sh)
      [ -f "$FP" ] && ask "기존 파일을 전체 덮어씁니다: $FP (부분 수정이면 Edit 을 쓰세요)" ;;
  esac
fi

exit 0
