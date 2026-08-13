#!/usr/bin/env bash
# 에이전트 브랜치에 Draft PR 을 연다. 이미 열린 PR 이 있으면 만들지 않는다.
#
# 두 곳에서 쓴다:
#   - claude.yml  — 에이전트 실행 직후 (주 경로)
#   - auto-pr.yml — 사람이 claude/** 브랜치를 push 했을 때, 또는 수동 실행 (백스톱)
#
# 필요한 환경변수: GH_TOKEN, BRANCH.  ISSUE 는 없으면 브랜치 이름에서 뽑는다.
#
# 자동 머지는 하지 않는다. Draft 는 "PR 은 보이되 아직 아니다"를 표시하기 위한 것이다.
set -uo pipefail

: "${BRANCH:?BRANCH 가 필요하다}"
: "${GH_TOKEN:?GH_TOKEN 이 필요하다}"

# 이미 열린 PR 이 있으면 새로 만들지 않는다 — 같은 브랜치에 커밋이 추가될 때마다
# PR 이 쌓이는 것을 막는다.
open_prs=$(gh pr list --head "$BRANCH" --state open --json number --jq 'length' 2>/dev/null || echo 0)
if [ "${open_prs:-0}" -gt 0 ]; then
  echo "이미 열린 PR 이 있다 — 새로 만들지 않는다:"
  gh pr list --head "$BRANCH" --state open --json number,url --jq '.[] | "  #\(.number)  \(.url)"'
  exit 0
fi

git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>/dev/null || true
AHEAD=$(git rev-list --count "origin/main..origin/$BRANCH" 2>/dev/null || echo 0)
if [ "$AHEAD" -eq 0 ]; then
  echo "main 대비 새 커밋이 없다 — PR 생략"
  exit 0
fi

ISSUE="${ISSUE:-$(printf '%s' "$BRANCH" | sed -n 's|^claude/issue-\([0-9][0-9]*\)-.*|\1|p')}"
TITLE=$(git log -1 --format=%s "origin/$BRANCH")
CHANGED=$(git diff --stat "origin/main..origin/$BRANCH")

BODY=$(mktemp)
{
  echo "에이전트가 \`$BRANCH\` 에 올린 작업이다. **Draft 로 열렸고 자동 머지하지 않는다.**"
  echo
  echo "## 변경 (커밋 ${AHEAD}개)"
  echo '```'
  echo "$CHANGED"
  echo '```'
  echo
  [ -n "$ISSUE" ] && { echo "Closes #$ISSUE"; echo; }
  echo "## 검토 전 확인"
  echo
  echo "- 품질 게이트는 화면·데이터(\`dashboard.html\`, \`data.js\`)가 바뀐 경우에만 돈다."
  echo "  이 PR 에서 돌았는지는 에이전트 실행 로그의 \`품질 게이트 (에이전트 브랜치)\` 단계를 본다"
  echo "- 산출물이 의도 없이 바뀌지 않았는지"
  echo "- \`dashboard.html\` 과 \`data.js\` 는 항상 함께 다룬다 — 하나만 바뀌었으면 의심할 것"
  echo
  echo "---"
  echo "\`.github/scripts/open-draft-pr.sh\` 가 자동 생성했다."
} > "$BODY"

# Draft PR 은 비공개 저장소에서 유료 플랜 기능이다. 실패하면 일반 PR 로 열되
# 제목에 표시해 검토 전임을 남긴다.
if gh pr create --draft --base main --head "$BRANCH" --title "$TITLE" --body-file "$BODY"; then
  echo "Draft PR 생성 완료"
elif gh pr create --base main --head "$BRANCH" --title "[검토 전] $TITLE" --body-file "$BODY"; then
  echo "Draft 생성 실패 → 일반 PR 로 대체 (비공개 저장소의 Draft 는 유료 플랜 기능)"
else
  echo "PR 생성 실패"; rm -f "$BODY"; exit 1
fi

rm -f "$BODY"
gh pr list --head "$BRANCH" --state open --json number,url,isDraft \
  --jq '.[] | "결과: #\(.number)  draft=\(.isDraft)  \(.url)"'
