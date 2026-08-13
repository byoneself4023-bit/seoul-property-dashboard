#!/bin/sh
# deploy.sh — dashboard.html + data.js 를 origin(main) 에 커밋·푸시한다.
#
# 푸시하면 .github/workflows/pages.yml 이 두 파일만 골라 Pages 로 발행한다.
# 이 스크립트는 발행을 직접 하지 않고, 푸시하고 라이브에 반영됐는지 확인만 한다.
#
# 2026-08-13 전환: 배포 저장소 분리 모델을 폐기했다. 자기 저장소 발행이므로
#   - 배포 repo clone/fetch/reset       → 없음
#   - 배포 repo 로의 별도 commit/push   → 없음
#   - gh 인증·토큰                      → 없음 (git 자격증명만 쓴다)
#   - Pages 빌드 상태 폴링              → 없음 (아래 라이브 검증이 대신한다)
# 114줄 → 이 파일.
#
# 앞으로: 수집을 GitHub Actions 로 옮기면(캐시 133MB 설계가 정해진 뒤)
# 워크플로가 수집·커밋·푸시를 모두 하므로 이 스크립트는 통째로 없어질 수 있다.
#
# run-ingest.sh 끝에서 호출되거나 수동 실행(`sh dashboard/scripts/deploy.sh`).
# launchd 는 PATH 가 최소이므로 아래에서 표준 bin 경로를 보강한다.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$PROJECT/dashboard/dashboard.html"
SRC_DATA="$PROJECT/dashboard/data.js"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy] 실패: $*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || fail "git 미발견 (PATH=$PATH)"
command -v curl >/dev/null 2>&1 || fail "curl 미발견"
[ -f "$SRC" ]      || fail "원본 없음: $SRC"
[ -f "$SRC_DATA" ] || fail "데이터 없음: $SRC_DATA (node dashboard/ingest.mjs 먼저 실행)"

# 라이브 주소는 origin 에서 유도한다 — 저장소 이름이 바뀌어도 따라간다.
# https://host/owner/repo(.git) 와 git@host:owner/repo(.git) 를 모두 받는다.
# sed -E 의 lazy 수량자는 BSD(macOS)에서 안 되므로 파라미터 확장만 쓴다.
ORIGIN="$(git -C "$PROJECT" remote get-url origin 2>/dev/null)" || fail "origin 미설정"
_P="${ORIGIN%.git}"
REPO="${_P##*/}"
_REST="${_P%/*}"
OWNER="${_REST##*[/:]}"
[ -n "$OWNER" ] && [ -n "$REPO" ] || fail "origin 에서 소유자/저장소 이름 추출 실패: $ORIGIN"
LIVE_URL="https://${OWNER}.github.io/${REPO}/"

# 수집일(generatedAt) 추출 — 커밋 메시지에 쓴다.
# 데이터 분리 후 generatedAt 은 dashboard.html 이 아니라 data.js 에 있다.
DATA_DATE="$(grep -oE '"generatedAt"[[:space:]]*:[[:space:]]*"[0-9]{4}-[0-9]{2}-[0-9]{2}' "$SRC_DATA" \
             | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)"
[ -n "$DATA_DATE" ] || fail "generatedAt(수집일) 추출 실패 — data.js 확인"

# no-op: 두 파일 모두 커밋된 것과 같으면 스킵(빈 커밋 방지).
# 하나라도 다르면 둘 다 커밋한다 — 화면과 데이터가 어긋난 채 라이브에 남지 않게.
if git -C "$PROJECT" diff --quiet HEAD -- dashboard/dashboard.html dashboard/data.js; then
  log "변경 없음 — 배포 스킵 (수집일 $DATA_DATE)"
  exit 0
fi

WANT_SHA="$(shasum -a 256 "$SRC" | awk '{print $1}')"
WANT_SHA_DATA="$(shasum -a 256 "$SRC_DATA" | awk '{print $1}')"

git -C "$PROJECT" add dashboard/dashboard.html dashboard/data.js || fail "add 실패"
git -C "$PROJECT" \
  -c user.name="쿠카" -c user.email="223078465+byoneself4023-bit@users.noreply.github.com" \
  commit -q -m "chore(dashboard): 데이터 갱신 — 수집일 ${DATA_DATE}" || fail "commit 실패"
git -C "$PROJECT" push -q origin HEAD:main || fail "push 실패"
SRC_HASH="$(git -C "$PROJECT" rev-parse --short HEAD)"
log "푸시 완료 — 수집일 ${DATA_DATE} (커밋 ${SRC_HASH}). Pages 워크플로 대기..."

# 라이브 검증: 화면(index.html)과 데이터(data.js) 각각 HTTP 200 + sha 일치.
# data.js 까지 봐야 수집일이 실제로 반영됐는지 확인된다 — 데이터 분리 후
# index.html 에는 generatedAt 이 없다.
# Actions 빌드 + 엣지 전파를 감안해 최대 6분 재시도한다.
TMP_LIVE="${TMPDIR:-/tmp}/deploy-live.$$"
i=0; ok=0; code=""; code_data=""
while [ "$i" -lt 36 ]; do
  sleep 10
  code="$(curl -s -o "$TMP_LIVE" -w '%{http_code}' -L "$LIVE_URL")"
  if [ "$code" = "200" ] && [ "$(shasum -a 256 "$TMP_LIVE" | awk '{print $1}')" = "$WANT_SHA" ]; then
    code_data="$(curl -s -o "$TMP_LIVE" -w '%{http_code}' -L "${LIVE_URL}data.js")"
    if [ "$code_data" = "200" ] \
       && [ "$(shasum -a 256 "$TMP_LIVE" | awk '{print $1}')" = "$WANT_SHA_DATA" ]; then
      ok=1; break
    fi
  fi
  i=$((i + 1))
done
rm -f "$TMP_LIVE"
[ "$ok" -eq 1 ] || fail "라이브 검증 실패 (index.html HTTP=$code, data.js HTTP=$code_data, 수집일 ${DATA_DATE} 반영 미확인). Actions 탭의 '대시보드 발행' 실행 로그를 확인할 것"

log "배포 완료 ✅ ${LIVE_URL} — index.html + data.js 반영 확인, 수집일 ${DATA_DATE} (커밋 ${SRC_HASH})"
exit 0
