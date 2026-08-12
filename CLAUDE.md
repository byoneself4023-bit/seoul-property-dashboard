# 서울 부동산 거래량 대시보드

국토교통부 RTMS 실거래가 API에서 서울 25개 자치구의 주택 매매 건수를 수집해,
데이터가 인라인된 단일 HTML 파일로 만들고 GitHub Pages에 배포한다.
라이브: https://byoneself4023-bit.github.io/seoul-property-dashboard/

## 폴더

- `dashboard/` — 제품 전체
  - `ingest.mjs` — 수집·집계·주입. API 4종(apt/rh/sh/offi) × 25구 × 2022-01~현재
  - `dashboard.html` — 산출물. Chart.js와 Tailwind가 인라인된 자기완결형 단일 파일
  - `data.json` — 집계 결과 (gitignored)
  - `.cache/ingest/` — API 원본 응답 캐시 (gitignored, 백업 없음)
  - `scripts/` — `run-ingest.sh`(launchd 래퍼) → `deploy.sh`(Pages 배포)
  - `docs/실데이터_연동_가이드.md` — 운영 문서
- `docs/`, `drive-docs/` — 기획·조사 문서

## 실행

```sh
node dashboard/ingest.mjs            # 수집 (캐시 활용). RTMS_SERVICE_KEY 필요
node dashboard/ingest.mjs --fresh    # 캐시 무시 전체 재수집
node dashboard/ingest.mjs --selftest # 픽스처로 파이프라인 검증
sh dashboard/scripts/deploy.sh       # 배포만 단독 실행 (gh 인증 필요)
npm run verify                       # puppeteer UI 품질 게이트
```

자동 실행: LaunchAgent `com.kuka.dashboard-ingest`, 매주 월 07:00 (`~/Library/LaunchAgents/`).

## 손대면 안 되는 것

- `dashboard.html`의 `<script type="application/json" id="real-data">` 슬롯 —
  `ingest.mjs`의 `inject()`가 정규식으로 찾는다. 태그가 바뀌면 수집이 실패한다.
- `.cache/ingest/` — 443,363건 원본이 이 맥에만 있다. 지우면 5,500회 재수집이 필요하다.
- `.env`의 `RTMS_SERVICE_KEY` — 커밋 금지. 이 저장소는 원격이 없고 public이면 안 된다.
- 캐시 스키마를 바꿀 때는 `cacheSave()`의 `schemaVersion`을 올린다. 그래야 전량 재수집된다.
