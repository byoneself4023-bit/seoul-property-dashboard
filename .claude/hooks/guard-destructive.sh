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

# ── 삭제 판정 ──────────────────────────
# 예전에는 rm 이 보이면 무조건 물었다. 세션이 만든 임시 스크립트를 치우는 것까지
# 승인을 받게 되어 승인만 잦아지고 정작 위험한 삭제에 무뎌졌다.
# 이제는 되돌릴 수 없는 것만 묻는다: git 추적 파일과 산출물·캐시.

# 지워도 되는 임시물인가? (스크래치패드·/tmp·dashboard/ 바로 아래 점파일)
is_temp_target() {
  _t="$1"
  case "$_t" in "~"/*) _t="$HOME/${_t#~/}" ;; esac
  case "$_t" in
    /tmp/*|/private/tmp/*|/var/folders/*) return 0 ;;
  esac
  # dashboard/.shot-wf.mjs 처럼 폴더 바로 아래 점으로 시작하는 파일.
  # .cache 와 .env 는 제외한다 — 되돌리기가 비싸거나 비밀값이다.
  case "$_t" in
    dashboard/.*|./dashboard/.*|*/dashboard/.*)
      _b=${_t##*/}
      case "$_b" in .cache|.env|.env.*) return 1 ;; esac
      case "$_b" in .?*) return 0 ;; esac
      ;;
  esac
  return 1
}

# git 이 추적 중인가? 한글 파일명 때문에 quotepath 를 끈다(CLAUDE.md 규칙).
is_tracked() {
  ( cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 1
    git -c core.quotepath=false ls-files --error-unmatch -- "$1" >/dev/null 2>&1 )
}

# 삭제 명령을 판정한다. 통과면 아무것도 출력하지 않고, 물어야 하면 이유를 낸다.
classify_delete() {
  _cmd="$1"
  _norm=$(printf '%s' "$_cmd" | tr '\n' ';' | sed 's/&&/;/g; s/||/;/g; s/|/;/g; s/&/;/g')
  _old_ifs=$IFS
  IFS=';'
  for _seg in $_norm; do
    IFS=$_old_ifs
    _seg=$(printf '%s' "$_seg" | sed 's/^[[:space:]]*//')
    case "$_seg" in
      rm|rm\ *|rmdir|rmdir\ *|trash|trash\ *|shred|shred\ *|*/rm\ *|*/rmdir\ *) ;;
      *) IFS=';' ; continue ;;
    esac
    # 따옴표·글롭·변수가 섞이면 낱말 분해를 믿을 수 없다 — 그때는 물어본다.
    # 위험 문자를 소스에 직접 적으면 이 파일의 인용이 깨진다(실제로 깨뜨렸다).
    # 8진 이스케이프로 만든다: ' " ` $ * ? [
    _meta=$(printf '\47\42\140\44\52\77\133')
    case "$_seg" in
      *[$_meta]*)
        printf '%s' "대상을 확신할 수 없습니다(따옴표·글롭·변수): $_seg"; IFS=$_old_ifs; return ;;
    esac
    # shellcheck disable=SC2086
    set -- $_seg
    shift
    _n=0
    for _a in "$@"; do
      case "$_a" in -*|--) continue ;; esac
      _n=$((_n+1))
      if is_tracked "$_a"; then
        printf '%s' "git 이 추적 중인 파일입니다: $_a"; IFS=$_old_ifs; return
      fi
      case "$_a" in
        *dashboard/data.js|*dashboard/dashboard.html|*dashboard/.cache*|*dashboard/reports*|*dashboard/assets*)
          printf '%s' "산출물·캐시입니다: $_a"; IFS=$_old_ifs; return ;;
      esac
      is_temp_target "$_a" || { printf '%s' "임시물이 아닙니다: $_a"; IFS=$_old_ifs; return; }
    done
    [ "$_n" -gt 0 ] || { printf '%s' "삭제 대상을 찾지 못했습니다: $_seg"; IFS=$_old_ifs; return; }
    IFS=';'
  done
  IFS=$_old_ifs
}
if [ "$TOOL" = "Bash" ]; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

  # 1. 원본 캐시 — 133MB / 45만 건, 이 맥에만 있다. 지우면 5,500회 재수집.
  printf '%s' "$CMD" | grep -qE "(^|[;&|[:space:]])(rm|trash|shred)([[:space:]]|$).*($PRECIOUS)" \
    && deny "차단: .cache/ingest 는 이 맥에만 있는 원본 45만 건입니다. 지우면 5,500회 재수집이 필요합니다. 정말 필요하면 사람이 직접 실행하세요."

  # 2. 삭제 — 임시물은 통과, 되돌리기 비싼 것만 확인
  if printf '%s' "$CMD" | grep -qE "(^|[;&|[:space:]])(rm|rmdir|trash|shred)([[:space:]]|$)"; then
    DEL_REASON=$(classify_delete "$CMD")
    [ -n "$DEL_REASON" ] && ask "삭제 명령입니다 — $DEL_REASON"
  fi

  # 3. force push / 이력 파괴
  printf '%s' "$CMD" | grep -qE 'git[[:space:]]+push.*(--force|-f([[:space:]]|$))' \
    && deny "차단: force push 는 원격 이력을 파괴합니다. 사람이 직접 실행하세요."
  printf '%s' "$CMD" | grep -qE 'git[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-[a-z]*f|filter-branch|filter-repo)' \
    && ask "되돌릴 수 없는 git 작업입니다: $CMD"

  # 4. 덮어쓰기 — 잘라내기 리다이렉트(>)와 cp/mv 로 기존 파일 위에 쓰는 것
  # 대상은 화면·데이터·원본 캐시 셋. 이 셋만 되돌리기가 비싸다.
  # (.env 는 permissions deny 와 block-secrets.sh 가 따로 막는다)
  printf '%s' "$CMD" | grep -qE '[^>2]>[[:space:]]*[^>|[:space:]]*(dashboard\.html|data\.js|dashboard/\.cache|\.cache/ingest)' \
    && ask "핵심 파일을 잘라내기 리다이렉트(>)로 덮어씁니다: $CMD"
  # cp/mv — 덮어쓸 때만 묻는다. 새로 만드는 복사(백업 생성 등)까지 묻으면
  # 승인만 잦아지고 정작 위험한 것에 무뎌진다. Write 훅과 같은 기준이다.
  # dashboard/ 아래를 건드릴 때만 본다. 다른 폴더의 복사·이동까지 물으면
  # 승인만 잦아지고 정작 위험한 것에 무뎌진다.
  if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])(cp|mv)[[:space:]]' \
     && printf '%s' "$CMD" | grep -q 'dashboard/'; then
    # mv 는 원본이 사라진다 — dashboard/ 안의 파일을 밖으로 옮기는 것도 삭제다
    if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])mv[[:space:]]+([^;&|]*[[:space:]])?[^;&|[:space:]]*dashboard/'; then
      ask "dashboard/ 아래 파일을 이동합니다(원본이 사라집니다): $CMD"
    fi
    case "$(classify_copy "$CMD")" in
      overwrite) ask "dashboard/ 아래 기존 파일을 덮어씁니다: $CMD" ;;
      unparsed)  ask "dashboard/ 대상 복사/이동을 확신할 수 없습니다(변수·글롭·복합 명령). 확인하세요: $CMD" ;;
    esac
  fi

  # 5. 배포·수집 — 외부에 나가거나 API 할당량을 쓴다
  printf '%s' "$CMD" | grep -qE 'deploy\.sh|run-ingest\.sh' \
    && ask "배포/수집 스크립트입니다. 라이브와 API 할당량에 영향을 줍니다: $CMD"
  # 파일 이름이 인자로 나오는 것만으로는 걸지 않는다.
  # `sed -n '1,50p' dashboard/ingest.mjs`, `grep ... ingest.mjs`, `cat ingest.mjs` 는
  # 읽기다 — 예전 규칙은 이것까지 물어서 코드를 읽을 때마다 승인을 받아야 했다.
  # node/npx 가 **스크립트로** 실행할 때만 판정한다(`node -e` 인라인 코드는 제외).
  printf '%s' "$CMD" \
    | grep -qE '(^|[;&|]|&&|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(node|nodejs|npx)[[:space:]]+([^;&|]*[[:space:]])?[^;&|[:space:]]*ingest\.mjs([[:space:]]|$)' \
    && ! printf '%s' "$CMD" | grep -qE '(node|nodejs)[[:space:]]+(-e|--eval)' \
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
