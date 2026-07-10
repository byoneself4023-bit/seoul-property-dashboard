# Changelog

All notable changes to this project are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.

---

## [Task 2: Newsletter Phase 1 MVP] — 2026-07-11

### Summary

Completed SPEC-NEWSLETTER-001 Phase 1 MVP with offline TDD core (129 tests), approval UI, real RSS integration, and real Claude E2E validation. Content quality fixes implemented: relevance gate, empty-comment guard, headline regeneration, verified RSS sources, HTML header styling, send-only headline regeneration, and favicon silence.

### Added

**Pipeline & Core**
- 5-stage pipeline architecture: collect → screen → comment → approve → send
- 3 seam interfaces: collector (RSS), provider (Claude), send adapter (preview/stibee/sendgrid)
- Structured JSON stage contracts: `collected.json` → `screened.json` → `draft.json` → `approved.json` → `newsletter_{date}.html` + `daily_{date}.json` (persistent)
- Independent stage re-execution (each stage accepts previous stage's JSON output)
- Deduplication: URL normalization (tracking/querystring cleanup) + title normalization with same-pubDate guard
- Relevance scoring & top-5 selection (3-5 articles per newsletter)
- Offline TDD core: 129 tests covering collect, screen, comment, compliance, pipeline branching, UI

**Collection & Filtering**
- RSS collector: 8 verified real-estate sources (언론사 + 국토부 보도자료)
- Time window: Asia/Seoul (KST) 18:00 previous day ~ 07:00 current day (development override: last 24h)
- Per-article pubDate normalization to KST before window filtering
- Source isolation: individual source failures skip with log; full failure triggers 0-item branch

**AI Screening & Generation (Claude Haiku)**
- 3-line factual summary (no original text quotes)
- Sensitivity classification (policies/litigation/unverified harm) within screening call (no extra API cost)
- Comment generation: 1–2 sentences per article (실무 관점)
- Checkpoint generation: 1-line guidance for real-estate professionals or consumers
- Sensitive cards: auto-flagged "검수 필수" (requires editor approval before send)
- Prompt files external to code: `prompts/screen.txt` and `prompts/comment.txt` (tone tuning via file edit only)
- Token logging per call: input/output tokens + estimated cost
- API error retry: exponential backoff up to 3 attempts; final failure logs and skips draft

**Data Snapshot**
- Trading volume: Seoul apt + non-apt weekly change (sourced from dashboard's `data.json`, RTMS)
- Base rate: value + as-of date from manual `snapshot_manual.json` (no change delta)
- Missing/parse-fail: "데이터 없음" + warning log + pipeline continues (non-blocking)

**Exception Handling**
- **1–2 articles + past output exists**: Follow-up corner (past 3 business days' `daily_{date}.json`) + headline notes reduced news
- **0 articles + past output exists**: Pure follow-up (no new news, headline notes "신규 뉴스 없음")
- **0 articles + no past output (cold-start)**: Skip with log
- **≥1 article + no past output (cold-start)**: Minimal issue (headline: "오늘은 주요 뉴스가 적은 날")

**Editor Approval UI**
- Localhost-only single page (no auth, no deployment)
- Draft cards list → inline edit (headline, 3 lines, comment, checkpoint)
- Sensitive flag badge ("⚠ 검수 필수")
- Approval button: per-card approval → `approved.json`
- Sensitive cards: require editor override checkbox ("위험을 인지하고 검수 필수 카드를 직접 승인합니다") before approval button activates
- Draft refresh detection: auto-invalidates prior approvals and shows re-approval warning

**Send Adapter**
- Preview (default): generates `newsletter_{date}.html` + opens in browser (no actual send)
- Stibee stub: interface + activation checklist (awaiting account/sender auth)
- SendGrid stub: interface + activation checklist (awaiting account/sender auth)
- Only approved cards included in HTML

**Compliance & Safety**
- N-gram validation (default 8-gram): summary and comments have 0 continuous matches vs. source text
- HTML escape/sanitize: feed-derived text (title, body, links) escaped before HTML render and approval UI
- "투자 조언 아님" footer notice in final HTML
- No original text quotes in 3-line summary or comments (enforced by prompt + validated by N-gram check)
- Source links per card

**Persistent Output**
- `daily_{date}.json` structure (forward hook for weekly/monthly re-aggregation):
  - publication date, headline, card details (source link, summary, comment, checkpoint), data snapshot, sensitivity flag, approver, send result

**Logging**
- Per-run log: collected count, screen/comment processing time, approver, send result
- Token/cost log per Claude call (input/output tokens + estimated USD)
- RSS failure per source (network/404/timeout/malformed XML)
- Stale snapshot warnings

### Changed

**Refinements from Audits (2-round gap-filling)**
- G1: Per-metric data representation (trading = change delta; base rate = value+as-of, no delta)
- G2: EARS purity recovery (REQ-SCRN-002 ubiquitous scoring + REQ-SCRN-003 unwanted top-5 selection)
- G3: Cold-start seam clarity (pure follow-up for 0 items REQ-EXC-002-0; skip only for 0+no-past)
- G4: Snapshot staleness detection out-of-scope for Phase 1 (as-of date ballast for manual detection)
- G5: Dedup title-only over-merge prevention (same-pubDate condition for title-exact match; prevents false positives across dates)
- G6: NFR-003 operational scope statement (1-person/small team, daily manual trigger, no auto-scheduler in Phase 1)

**Content Quality Fixes (commits 7f5ae99–f9360dd)**
- Relevance gate + empty-comment guard (no blank article comments)
- Headline generation basis refinement
- Real-estate RSS source verification in config (8 verified feeds)
- UI–send closed loop via `--send-only` flag + approval set change headline regeneration
- Email header text color contrast fix (unescaped font-family quotes bug)
- Email design polish (TOC, density, financial-research daily-note layout)
- Approval UI favicon 404 silence

### Testing

- **129 offline TDD tests**: collect (RSS, time window, source fail), screen (dedup, scoring, top-5), comment (mock Claude, snapshot), compliance (N-gram, HTML escape), pipeline (branching, cold-start), UI (approval state invalidation)
- **E2E demo**: real RSS (8 sources) → real Claude Haiku API → 1 full pipeline pass (collect → screen → comment → approve → HTML)
- Coverage: >95% core logic (lib/, pipeline/) + 100% compliance validation

### Excluded (Phase 2+)

- Kakao card-news with automatic image generation
- Web/in-app channel integration
- Weekly/monthly magazine auto-clustering (JSON structure forward-compatible)
- Kakao Talk / KakaoTalk notification template API
- Instagram card auto-generation
- Naver News API (Phase 1: RSS-only)
- Email actual send via Stibee/SendGrid (Phase 1: preview-only; activation info documented)
- User auth, multi-user editing, deployment/hosting
- B2B/B2C segment auto-personalization (Phase 1: tone via prompt file only)
- Lease-to-sale ratio indicator (Phase 2; source TBD)
- Auto-scheduler (Phase 1: manual daily trigger only; operational target not implementation scope)

### Non-Functional

- **Scale**: 1-person/small team operation, daily manual run, ~2–5 min per execution
- **Cost**: ~$0.01–0.015/day (Claude Haiku, 5 articles typical)
- **Maintainability**: provider/collector/send single-point-of-change architecture
- **Security**: API keys from `.env` only; no hardcoded credentials

### Operations

See [`newsletter/docs/뉴스레터_운영_가이드.md`](newsletter/docs/뉴스레터_운영_가이드.md) for:
- `.env` setup (ANTHROPIC_API_KEY required)
- Per-stage independent re-execution commands
- Approval UI (localhost:3456) usage
- Base rate manual file update (`snapshot_manual.json`)
- Stibee/SendGrid activation checklist (awaiting CEO confirmation)
- FAQ (sensitive cards, RSS failures, low-collection days)

---

## [Task 1: Seoul Transaction Dashboard with Real RTMS Data] — 2026-06

### Summary

Built single-file real-time Seoul transaction volume dashboard from RTMS API with mock fallback, light theme UI, and live data refresh (2-month recent window). Deprecated reference prototype.

### Added

- Real RTMS ingest pipeline (resultCode 000 format, English item tags, .env loader)
- Per-type transaction stats (apt sale, apt lease, non-apt sale, non-apt lease, officetel sale)
- Single-file dashboard component with Echarts visualization
- Light theme conversion
- Mock data fallback for offline testing
- Rate-limit defense + count accuracy hardening

### Changed

- Reference prototype relocated to `reference/` (preserved for historical docs)
- Dashboard rebuilt for live RTMS data integration

---

## [Unreleased]

(Future phases and pending work tracked in SPEC documents)

