# Changelog

All notable changes to this project are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.

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

