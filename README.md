# 서울 실거래 대시보드

서울 25개 자치구의 주택 매매 건수(국토부 실거래), 한국부동산원 주간 아파트 가격지수, 정비사업 지정·해제를 모아
정적 페이지 하나와 리포트 그림(PNG 5장)으로 발행한다.

- 사이트: https://stats.thebarunrealty.com
- 리포트 페이지(별도 저장소 `barun-realestate-site`): https://report.thebarunrealty.com — 이 저장소의 `reports/latest/*.png`, `data.js` 를 가져다 쓴다
- 자세한 구조와 작업 규칙: `CLAUDE.md`, `docs/`

## 어떻게 도나 (사람 손 없이)

GitHub Actions 가 모으고 GitHub Pages 가 보여 준다. 맥이나 PC 는 필요 없다.

| 워크플로 | 언제 (한국 시간) | 하는 일 |
|---|---|---|
| `ingest.yml` | 매주 월 07:00 | 거래량 수집 → 리포트 생성(`report.yml`) → 발행 |
| `ingest-price.yml` | 목 15:00·21:00, 금 09:00 | 부동산원 가격지수 |
| `ingest-rebuild.yml` | 매월 2일 05:00 | 정비사업 |
| `freshness.yml` | 매일 09:00 | 데이터가 오래됐는지 감시(실패하면 알림) |
| `pages.yml` | main 에 올릴 때 | 사이트 발행 |
| `verify.yml` | PR | 리포트 검증(2026-10-29부터 「workflow file issue」로 실패 중, 원인 미확인) |

## 키 (GitHub 저장소 Settings → Secrets and variables → Actions)

| 이름 | 무엇 | 발급처 |
|---|---|---|
| `RTMS_SERVICE_KEY` | 국토부 실거래 | 공공데이터포털 |
| `REB_SERVICE_KEY` | 부동산원 가격지수 | 한국부동산원 R-ONE |
| `SEOUL_OPENAPI_KEY` | 서울시 정비사업 | 서울 열린데이터광장 |
| `ANTHROPIC_API_KEY` | 이슈의 @claude 자동 수정(`claude.yml`). 수집에는 안 씀. 쓰는 만큼 과금 | Anthropic 콘솔 — 안 쓰면 지운다 |

## 넘겨받은 개발자가 알아 둘 것

- 실패 알림 메일은 **각 워크플로의 cron 줄을 마지막으로 고친 사람**에게 간다(GitHub 규칙). 이전 개발자가 마지막으로 고쳤으므로, 알림을 받으려면 cron 줄을 한 번 직접 고쳐 커밋한다.
- 공개 저장소의 예약 실행은 저장소에 60일 동안 활동이 없으면 GitHub 이 멈출 수 있다. 매주 데이터 커밋이 있어 보통은 괜찮지만, 멈췄으면 Actions 탭에서 다시 켠다.
- 2026-11-14 저장소를 개인 계정에서 조직 `thebarunrealty` 로 옮겼다. 사이트 주소(stats.)와 Secrets 는 그대로 따라왔다. DNS 의 stats. 연결 대상은 `thebarunrealty.github.io` 로 바꾸는 것이 맞다(DNS 는 Netlify 에서 관리).
- 로컬 실행 비밀값은 `.env`(GitHub 에 없음). 이전 개발자가 대표님께 암호 zip 으로 전달했다.
