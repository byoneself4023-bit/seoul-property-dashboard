# 서울 부동산 거래량 대시보드

국토교통부 RTMS 실거래가 API에서 서울 25개 자치구의 주택 매매 건수를 수집·집계해
정적 페이지 하나로 만들고, GitHub Actions가 GitHub Pages에 발행한다. 주 1회 갱신.
라이브: https://byoneself4023-bit.github.io/seoul-property-dashboard/

**화면과 데이터는 분리돼 있다**(2026-08-12). `dashboard.html`이 `<script src="data.js">`로
`data.js`를 읽고, `data.js`는 `window.__DASHBOARD_DATA__`에 값을 담는다. `fetch`가 아니라
script 태그를 쓰는 이유는 `file://`로 열어도 동작하게 하기 위해서다.

## 폴더

- `dashboard/` — 제품 전체
  - `ingest.mjs` — 수집·집계·주입. API 4종(apt/rh/sh/offi) × 25구 × 2022-01(`START_YM`)~현재
  - `dashboard.html` — 화면. Chart.js와 Tailwind는 인라인(CDN 의존 없음)
  - `data.js` — 화면이 읽는 데이터. `window.__DASHBOARD_DATA__` 전역. `inject()`가 생성
  - `data.json` — 같은 내용의 표준 JSON. 다른 프로그램용 중간 재료 (gitignored)
  - `.cache/ingest/` — API 원본 응답 캐시 5,600개. **git 추적 대상이다**(러너와
    로컬이 같은 캐시를 봐야 한다)
  - `docs/실데이터_연동_가이드.md` — 운영 문서
  - `scripts/` — `run-ingest.sh` → `deploy.sh`. **수집 이관 후 평시에는 쓰지 않는다**
    (아래 규칙 참조). 로컬 디버깅용으로만 남겨 뒀다
- `.github/workflows/`
  - `pages.yml` — 화면·데이터가 푸시되면 두 파일만 `_site/`에 조립해 Pages로 발행
  - `freshness.yml` — 매일 라이브 수집일 확인, 7일 넘으면 실패 + 이슈 생성
  - `verify.yml` — 러너에서 `npm run verify` 통과 보장
  - `claude.yml` — 이슈·PR의 `@claude` 멘션으로 에이전트 실행
  - `ingest.yml` — **수집**. 매주 월 07:00 KST(`cron '0 22 * * 0'` UTC) + 수동 실행.
    성공했고 데이터가 바뀐 경우에만 PR 을 열어 병합하고 발행을 호출한다
- `.github/claude-ci-settings.json` — CI 전용 permissions. `ask`를 두지 않는다
  (CI엔 물어볼 사람이 없어 ask가 곧 거부가 된다). 훅 3개는 로컬과 동일하게 싣는다
- `docs/` — 기술 조사·작업 기록. 사업·기획 문서는 넣지 않는다(아래 참조)

## 실행

```sh
node dashboard/ingest.mjs            # 수집 (캐시 활용). RTMS_SERVICE_KEY 필요
node dashboard/ingest.mjs --fresh    # 캐시 무시 전체 재수집
node dashboard/ingest.mjs --selftest # 픽스처로 파이프라인 검증
sh dashboard/scripts/deploy.sh       # 두 파일 커밋·푸시 후 라이브 반영 검증
npm run verify                       # puppeteer UI 품질 게이트
```

자동 실행: **GitHub Actions `ingest.yml`**, 매주 월 07:00 KST. 로컬 LaunchAgent
`com.kuka.dashboard-ingest`는 2026-08-13 이관과 함께 내렸다(plist 는 `.disabled` 로
남겨 뒀다 — 되돌리는 법은 `docs/자동화-구축.md`).

## 손대면 안 되는 것

- `dashboard.html`의 `<script src="data.js?v=...">` 참조 — `ingest.mjs`의 `inject()`가
  정규식으로 존재를 검사하고, 없으면 **예외를 던져 수집이 실패한다**. 태그가 남아 있어도
  파일이 없으면 화면이 목데이터로 뜬다. `?v=`는 `data.js` 내용의 sha256 앞 8자로
  `inject()`가 자동 갱신한다(브라우저가 낡은 데이터를 쓰는 것을 막는다. 수집일 기준으로
  하면 같은 날 재수집 시 버전이 그대로라 무효화에 실패한다). 손으로 고치지 말 것.
- `dashboard.html`과 `data.js`는 **항상 함께** 다룬다(배포·전달·커밋). 하나만 최신이면
  화면과 데이터가 어긋난다. `deploy.sh`가 두 파일을 함께 올리고 각각 라이브 검증하며,
  `pages.yml`도 발행 전에 둘 다 있는지 점검한다.
- 배포는 **자기 저장소 Pages**다. 별도 배포 저장소도, 토큰도 없다. `main`에 푸시하면
  `pages.yml`이 두 파일만 `_site/`로 조립해 발행한다(저장소 전체가 서빙되지 않는다).
- 대시보드를 남에게 줄 때는 **파일이 아니라 라이브 링크**를 준다. 단일 파일 전달
  모델은 2026-08-12 데이터 분리로 폐기했다.
- **수집은 러너가 한다. 로컬 실행은 디버깅용이며 커밋하지 않는다.** 정본은
  `origin/main` 하나다. 양쪽에서 수집하면 같은 캐시 파일 200개를 두 곳이 고쳐
  충돌하고, 신고 지연 때문에 과거 월의 값까지 갈라진다. 둘 다 정상 종료하므로
  어느 쪽이 맞는지 판단할 근거가 없다. 로컬에서 돌렸으면 `git checkout` 으로 되돌린다.
- `.cache/ingest/` — 원본 응답 5,600개. 지우면 전량 재수집(API 5,600회)이다.
  이제 git 에 있으므로 실수로 지워도 `git checkout` 으로 돌아온다.
- **이 저장소는 공개다.** 커밋하는 모든 것이 공개되고, 이력에 한 번 들어가면 재작성
  없이는 못 지운다. `.env`의 키는 당연히 커밋 금지.
- **사업·기획 문서는 저장소에 넣지 않는다.** 대표 녹취 정리, 서비스 기획서, 특허·IR
  자료, 타 제품 소스가 해당한다. 코드와 기술 문서만 둔다. 이 원칙을 어겨서
  `drive-docs/`와 `newsletter/`를 이력에서 제거한 적이 있다(2026-08-13).
- **작업 기록 문서도 사업 정보를 인용하면 같은 규칙을 받는다.** 조사·회고처럼
  "코드 문서" 얼굴을 하고 있어도, 사업 문서의 **파일명·브랜드명·목차·크기**를 적으면
  본문이 없어도 사업 정보가 공개된다. `docs/저장소-현황-조사.md`가 그래서
  이력에서 제거됐다(2026-08-13). 무엇이 있었는지 적어야 할 때는 이름 대신 성격만
  적는다 — 제품명·문서 제목을 그대로 적지 말고 "타 제품 기획 문서" 처럼 성격만 쓴다.
- **공개 전 점검은 이스케이프 없는 방식으로 한다.** `git ls-files`는 한글 파일명을
  `"docs/\354\240\200…"` 로 인용해서 내보내므로, 한글 이름을 노린 grep이 조용히
  0건을 반환한다. 위 파일을 처음 확인에서 놓친 원인이 이것이다.
  **`git log --name-only`·`git ls-tree` 도 똑같이 인용한다.** 검사할 때는
  `git -c core.quotepath=false <명령>` 을 붙이거나 `git ls-files -z | tr '\0' '\n'`
  을 쓴다. **0건이 나오면 "깨끗하다"로 읽지 말고, 반드시 있어야 할 경로를
  같은 명령으로 한 번 찾아 검사가 닿는지부터 확인한다**(대조군).
- 캐시 스키마를 바꿀 때는 `ingest.mjs`의 `CACHE_SCHEMA_VERSION` 상수를 올린다
  (현재 3). 그래야 구버전 캐시가 무효가 되어 전량 재수집된다.
