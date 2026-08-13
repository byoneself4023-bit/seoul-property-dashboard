#!/usr/bin/env bash
# PreToolUse 훅 — 비밀값 차단.
#
# 키가 커밋·로그·파일에 들어가는 것을 막는다.
# .env 의 실제 값과 대조하되, 값 자체는 절대 출력하지 않는다(변수 이름만 말한다).
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')

deny() { jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'; exit 0; }

# 검사 대상 텍스트 — 도구별로 다르다
case "$TOOL" in
  Bash)        HAY=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""') ;;
  Write)       HAY=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // ""') ;;
  Edit)        HAY=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""') ;;
  NotebookEdit) HAY=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_source // ""') ;;
  *)           exit 0 ;;
esac
[ -z "$HAY" ] && exit 0

# ── 1. .env 의 실제 값이 그대로 들어갔는가 ───────────────────────
if [ -f "$ROOT/.env" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue;; esac
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    v="$(printf '%s' "$v" | tr -d '[:space:]')"
    [ ${#v} -lt 12 ] && continue          # 짧은 값은 오탐이 난다
    case "$HAY" in
      *"$v"*) deny "차단: 환경변수 ${k} 의 실제 값이 내용에 들어 있습니다. 값 대신 process.env.${k} 또는 \${{ secrets.${k} }} 를 쓰세요." ;;
    esac
  done < "$ROOT/.env"
fi

# ── 2. 알려진 키 형태 (다른 계정·폐기된 키까지 잡는다) ───────────
printf '%s' "$HAY" | grep -qE 'sk-ant-[A-Za-z0-9_-]{20}' \
  && deny "차단: Anthropic API 키 형태(sk-ant-…)가 내용에 있습니다."
printf '%s' "$HAY" | grep -qE 'gh[pousr]_[A-Za-z0-9]{30}' \
  && deny "차단: GitHub 토큰 형태가 내용에 있습니다."
printf '%s' "$HAY" | grep -qE '(RTMS_SERVICE_KEY|SEOUL_OPENAPI_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9%+/=_-]{15}' \
  && deny "차단: 키에 리터럴 값을 대입하고 있습니다. 값은 .env 나 GitHub Secrets 에만 둡니다."

# ── 3. Bash 전용: .env 를 커밋·전송·출력하는 경로 ────────────────
if [ "$TOOL" = "Bash" ]; then
  printf '%s' "$HAY" | grep -qE 'git[[:space:]]+add[[:space:]].*(^|[[:space:]/])\.env([[:space:]]|$)' \
    && deny "차단: .env 를 스테이징하려 합니다."
  printf '%s' "$HAY" | grep -qE 'git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$)' \
    && deny "차단: git add -A / . 는 쓰지 않습니다. 파일 경로를 지정해서 담으세요."
  # .env 를 읽어서 밖으로 내보내는 조합 (파이프·리다이렉트·전송)
  printf '%s' "$HAY" | grep -qE '(cat|head|tail|source|\.|grep|awk|sed)[[:space:]]+[^|;&]*\.env([[:space:]]|$)' \
    && printf '%s' "$HAY" | grep -qE '\||>|curl|gh[[:space:]]|nc[[:space:]]|ssh[[:space:]]' \
    && deny "차단: .env 내용을 다른 명령/파일로 내보내려 합니다."
  printf '%s' "$HAY" | grep -qE 'echo[[:space:]]+.*\$\{?(RTMS_SERVICE_KEY|SEOUL_OPENAPI_KEY|ANTHROPIC_API_KEY)' \
    && deny "차단: 키 값을 출력하려 합니다. 로그에 남습니다."
fi

exit 0
