# 서울 부동산 거래량 대시보드

국토교통부 RTMS 실거래가 API에서 서울 25개 자치구의 주택 매매 건수를 수집해,
데이터가 인라인된 단일 HTML 파일로 만들고 GitHub Pages에 배포한다.
라이브: https://byoneself4023-bit.github.io/seoul-property-dashboard/

## 폴더

- `dashboard/` — 제품 전체
  - `ingest.mjs` — 수집·집계·주입. API 4종(apt/rh/sh/offi) × 25구 × 2022-01~현재
  - `dashboard.html` — 화면 코드. Chart.js와 Tailwind는 인라인(CDN 의존 없음), 데이터는 분리
  - `data.js` — 화면이 읽는 데이터. `window.__DASHBOARD_DATA__` 전역에 담긴다
  - `data.json` — 동일 내용의 표준 JSON. 다른 프로그램용 중간 재료 (gitignored)
  - `.cache/ingest/` — API 원본 응답 캐시 (gitignored, 백업 없음)
  - `scripts/` — `run-ingest.sh`(launchd 래퍼) → `deploy.sh`(origin 에 커밋·푸시)
- `.github/workflows/` — `pages.yml`(푸시되면 두 파일만 Pages 로 발행),
  `freshness.yml`(매일 라이브 수집일을 확인, 10일 넘으면 실패 + 이슈 생성)
  - `docs/실데이터_연동_가이드.md` — 운영 문서
- `docs/` — 기술 조사·작업 기록. 사업·기획 문서는 여기 넣지 않는다(아래 참조)

## 실행

```sh
node dashboard/ingest.mjs            # 수집 (캐시 활용). RTMS_SERVICE_KEY 필요
node dashboard/ingest.mjs --fresh    # 캐시 무시 전체 재수집
node dashboard/ingest.mjs --selftest # 픽스처로 파이프라인 검증
sh dashboard/scripts/deploy.sh       # 두 파일 커밋·푸시 후 라이브 반영 검증
npm run verify                       # puppeteer UI 품질 게이트
```

자동 실행: LaunchAgent `com.kuka.dashboard-ingest`, 매주 월 07:00 (`~/Library/LaunchAgents/`).

## 손대면 안 되는 것

- `dashboard.html`의 `<script src="data.js?v=...">` 참조 — `ingest.mjs`의 `inject()`가
  존재를 검사한다. 지우면 수집이 실패하고, 남아 있어도 파일이 없으면 목데이터로 뜬다.
  `?v=`는 `data.js` 내용의 sha256 앞 8자로 `inject()`가 자동 갱신한다(브라우저가 낡은
  데이터를 쓰는 것을 막는다). 손으로 고치지 말 것 — 다음 수집이 덮어쓴다.
- `dashboard.html`과 `data.js`는 **항상 함께** 다룬다(배포·전달·커밋). 하나만 최신이면
  화면과 데이터가 어긋난다. `deploy.sh`가 두 파일을 함께 올리고 각각 라이브 검증하며,
  `pages.yml`도 발행 전에 둘 다 있는지 점검한다.
- 배포는 **자기 저장소 Pages**다. 별도 배포 저장소도, 토큰도 없다. `main`에 푸시하면
  `pages.yml`이 두 파일만 `_site/`로 조립해 발행한다(저장소 전체가 서빙되지 않는다).
- 대시보드를 남에게 줄 때는 **파일이 아니라 라이브 링크**를 준다. 단일 파일 전달
  모델은 2026-08-12 데이터 분리로 폐기했다.
- `.cache/ingest/` — 443,363건 원본이 이 맥에만 있다. 지우면 5,500회 재수집이 필요하다.
- **이 저장소는 공개다.** 커밋하는 모든 것이 공개되고, 이력에 한 번 들어가면 재작성
  없이는 못 지운다. `.env`의 키는 당연히 커밋 금지.
- **사업·기획 문서는 저장소에 넣지 않는다.** 대표 녹취 정리, 서비스 기획서, 특허·IR
  자료, 타 제품 소스가 해당한다. 코드와 기술 문서만 둔다. 이 원칙을 어겨서
  `drive-docs/`와 `newsletter/`를 이력에서 제거한 적이 있다(2026-08-13).
- 캐시 스키마를 바꿀 때는 `cacheSave()`의 `schemaVersion`을 올린다. 그래야 전량 재수집된다.
