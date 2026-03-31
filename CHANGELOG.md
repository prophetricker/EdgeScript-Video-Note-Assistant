# Changelog

All notable changes to this project will be documented in this file.

## [0.1.24] - 2026-03-31

### Added

- Two-stage note generation pipeline (fact extraction + note drafting).
- Better runtime logs for long tasks (ASR and note generation heartbeat).
- Forced content-script version handshake to prevent stale page listeners.
- Release helper scripts:
  - `publish_github.ps1`
  - `publish_github.cmd`
  - `publish_github_double_click.vbs`

### Changed

- Improved note quality fallback strategy:
  - More rewrite rounds.
  - Best-candidate preservation before emergency draft fallback.
- Improved Feishu write stability:
  - 429 handling with backoff.
  - Dynamic batch size reduction.
- Local ASR URL transcription timeout and progress reporting behavior.

### Fixed

- Resolved mismatched transcript/note content caused by stale content-script handlers.
- Resolved long-running "stuck" experience by adding visible stage progress updates.

## [local-asr-whisper 0.1.5] - 2026-03-31

### Added

- Simplified Chinese normalization support in ASR output via `ZH_TEXT_CONVERT_MODE=t2s`.
- Health endpoint now reports Chinese conversion mode.
- Added optional dependency:
  - `opencc-python-reimplemented`

### Changed

- URL download/transcription path hardening and timeout tuning for yt-dlp flow.

