#!/bin/sh
# deploy.sh — dashboard.html + data.js 를 seoul-property-dashboard(GitHub Pages) repo에 배포한다.
#
# 2026-08-12 데이터 분리: 화면(dashboard.html)과 데이터(data.js)가 분리되어 배포 대상이 2개다.
#   dashboard.html → index.html      data.js → data.js
# 둘 중 하나만 올라가면 화면이 목데이터로 떨어지거나 낡은 데이터를 보여주므로 항상 함께 배포한다.
#
# 흐름: 배포 repo 클론/갱신 → 두 파일 모두 동일하면 no-op 스킵(빈 커밋 방지) →
#       index.html + data.js 갱신 → commit(수집일 + 원본 커밋 해시) → push →
#       Pages 빌드 완료 폴링 → 라이브 URL 2개 각각 HTTP 200 + sha 일치 검증.
#
# run-ingest.sh 끝에서 호출되거나 수동 실행(`sh dashboard/scripts/deploy.sh`).
# 인증은 gh(keyring)에 의존한다 — `gh auth login`이 되어 있어야 한다.
# launchd 는 PATH 가 최소이므로 아래에서 표준 bin 경로를 보강한다.
set -u

OWNER="byoneself4023-bit"
REPO="seoul-property-dashboard"
LIVE_URL="https://byoneself4023-bit.github.io/seoul-property-dashboard/"
CACHE_DIR="${DEPLOY_CACHE_DIR:-$HOME/.cache/$REPO}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$PROJECT/dashboard/dashboard.html"
SRC_DATA="$PROJECT/dashboard/data.js"

# launchd 최소 PATH 보강 (homebrew/usr-local 우선)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy] 실패: $*" >&2; exit 1; }

command -v gh   >/dev/null 2>&1 || fail "gh 미발견 (PATH=$PATH) — gh 설치/인증 필요"
command -v git  >/dev/null 2>&1 || fail "git 미발견"
command -v curl >/dev/null 2>&1 || fail "curl 미발견"
[ -f "$SRC" ]      || fail "원본 없음: $SRC"
[ -f "$SRC_DATA" ] || fail "데이터 없음: $SRC_DATA (node dashboard/ingest.mjs 먼저 실행)"

# 데이터 수집일(generatedAt) 추출 — 커밋 메시지에 사용
# 데이터 분리 후 generatedAt 은 dashboard.html 이 아니라 data.js 에 있다.
DATA_DATE="$(grep -oE '"generatedAt"[[:space:]]*:[[:space:]]*"[0-9]{4}-[0-9]{2}-[0-9]{2}' "$SRC_DATA" \
             | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)"
[ -n "$DATA_DATE" ] || fail "generatedAt(수집일) 추출 실패 — data.js 확인"

# 원본 커밋 해시(provenance). dashboard.html 이 미커밋이면 -dirty 표기.
SRC_HASH="$(git -C "$PROJECT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$PROJECT" diff --quiet -- dashboard/dashboard.html dashboard/data.js 2>/dev/null || SRC_HASH="${SRC_HASH}-dirty"

# gh 를 git 자격증명 헬퍼로 설정(멱등) — 토큰을 인자/설정에 노출하지 않고 push
gh auth setup-git >/dev/null 2>&1 || fail "gh auth setup-git 실패 — gh auth login 필요"

# 배포 repo 준비 (캐시 클론 재사용; public repo 라 클론/페치는 무인증)
if [ -d "$CACHE_DIR/.git" ]; then
  git -C "$CACHE_DIR" fetch -q origin main       || fail "fetch 실패"
  git -C "$CACHE_DIR" reset -q --hard origin/main || fail "reset 실패"
else
  rm -rf "$CACHE_DIR"
  git clone -q --depth 1 "https://github.com/${OWNER}/${REPO}.git" "$CACHE_DIR" || fail "clone 실패"
fi

DEST="$CACHE_DIR/index.html"
DEST_DATA="$CACHE_DIR/data.js"

# no-op: 두 파일 모두 배포본과 동일할 때만 스킵 (빈 커밋 방지)
# 하나라도 다르면 둘 다 올린다 — 화면과 데이터가 어긋난 상태로 라이브에 남지 않게.
if [ -f "$DEST" ] && [ -f "$DEST_DATA" ] \
   && cmp -s "$SRC" "$DEST" && cmp -s "$SRC_DATA" "$DEST_DATA"; then
  log "변경 없음 — 배포 스킵 (수집일 $DATA_DATE, 원본 $SRC_HASH)"
  exit 0
fi

WANT_SHA="$(shasum -a 256 "$SRC" | awk '{print $1}')"
WANT_SHA_DATA="$(shasum -a 256 "$SRC_DATA" | awk '{print $1}')"
cp "$SRC" "$DEST"
cp "$SRC_DATA" "$DEST_DATA"
git -C "$CACHE_DIR" add index.html data.js
git -C "$CACHE_DIR" \
  -c user.name="쿠카" -c user.email="223078465+byoneself4023-bit@users.noreply.github.com" \
  commit -q -m "chore: 대시보드 갱신 — 수집일 ${DATA_DATE} (원본 ${SRC_HASH})" || fail "commit 실패"
git -C "$CACHE_DIR" push -q origin main || fail "push 실패 (gh 인증 확인)"
log "푸시 완료 — 수집일 ${DATA_DATE}, 원본 ${SRC_HASH}"

# Pages 빌드 완료 폴링 (최대 ~240초)
log "Pages 빌드 대기..."
i=0; built=0
while [ "$i" -lt 24 ]; do
  st="$(gh api "repos/${OWNER}/${REPO}/pages" 2>/dev/null \
        | grep -oE '"status"[[:space:]]*:[[:space:]]*"[a-z]+"' | grep -oE '[a-z]+"$' | tr -d '"' | head -1)"
  [ "$st" = "built" ] && { built=1; break; }
  i=$((i + 1)); sleep 10
done
[ "$built" -eq 1 ] || fail "Pages 빌드 미완료(timeout)"

# 라이브 검증: 화면(index.html)과 데이터(data.js) 각각 HTTP 200 + sha 일치.
# data.js 까지 봐야 수집일이 실제로 라이브에 반영됐는지 확인된다 —
# 데이터 분리 후 index.html 에는 generatedAt 이 없다. 엣지 전파 재시도 포함.
TMP_LIVE="${TMPDIR:-/tmp}/deploy-live.$$"
i=0; ok=0; code=""; code_data=""
while [ "$i" -lt 18 ]; do
  code="$(curl -s -o "$TMP_LIVE" -w '%{http_code}' -L "$LIVE_URL")"
  if [ "$code" = "200" ] && [ "$(shasum -a 256 "$TMP_LIVE" | awk '{print $1}')" = "$WANT_SHA" ]; then
    code_data="$(curl -s -o "$TMP_LIVE" -w '%{http_code}' -L "${LIVE_URL}data.js")"
    if [ "$code_data" = "200" ] \
       && [ "$(shasum -a 256 "$TMP_LIVE" | awk '{print $1}')" = "$WANT_SHA_DATA" ]; then
      ok=1; break
    fi
  fi
  i=$((i + 1)); sleep 5
done
rm -f "$TMP_LIVE"
[ "$ok" -eq 1 ] || fail "라이브 검증 실패 (index.html HTTP=$code, data.js HTTP=$code_data, 수집일 ${DATA_DATE} 반영 미확인)"

log "배포 완료 ✅ ${LIVE_URL} — index.html + data.js 반영 확인, 수집일 ${DATA_DATE} (원본 ${SRC_HASH})"
exit 0
