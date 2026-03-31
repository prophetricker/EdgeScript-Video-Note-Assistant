# Local Whisper ASR (Windows, GTX 1660 Ti)

This service provides OpenAI-compatible ASR endpoints for your Edge extension:
- `GET /v1/models`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/transcriptions_by_url` (server-side audio fetch + transcribe)
- Compatibility aliases are also available without `/v1`:
  - `GET /models`
  - `POST /audio/transcriptions`
  - `POST /audio/transcriptions_by_url`

It is designed for quick iteration first, then quality mode.

## 1) Prerequisites

1. Windows 10/11
2. Python 3.10 or 3.11 (`py -3.11 --version`)
3. NVIDIA driver up to date (for CUDA mode)

## 2) Setup

Open PowerShell in this folder and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1 -PythonExe py -PythonVersionArg -3.11
```

If you have already set up once, rerun `.\setup.ps1` to install newly added dependencies (such as `yt-dlp` and `opencc-python-reimplemented`).

If `py -3.11` is not available, install Python 3.11 first, then rerun setup.

### One-click bootstrap (recommended)

Quick profile:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\bootstrap_and_start.ps1 -Profile quick
```

Quality profile:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\bootstrap_and_start.ps1 -Profile quality
```

You can also double-click:
- `bootstrap_and_start_quick.cmd`
- `bootstrap_and_start_quality.cmd`

## 3) Start Service

Quick iteration (recommended first):

```powershell
.\start_quick.ps1
```

Higher quality:

```powershell
.\start_quality.ps1
```

Service URL:
- Base URL (recommended): `http://127.0.0.1:8171/v1`
- Base URL (also supported): `http://127.0.0.1:8171`

Health check:

```powershell
curl http://127.0.0.1:8171/health
```

## 4) Configure Extension

In extension settings:

1. `Enable ASR fallback`: on
2. `ASR API Base URL`: `http://127.0.0.1:8171/v1`
3. `ASR API Key`: empty (or your local key if enabled)
4. `ASR Model`: `whisper-1`
5. `Max audio size MB`: 24 (or 32)

## 5) Notes for GTX 1660 Ti

- For first tests use `small + int8` (`start_quick.ps1`).
- For better quality switch to `medium + int8_float16` (`start_quality.ps1`).
- If CUDA fails, edit start script:
  - `WHISPER_DEVICE=cpu`
  - `WHISPER_COMPUTE_TYPE=int8`

## 6) Optional API Key

To enable auth, set `LOCAL_ASR_API_KEY` in start script and put the same key in extension `ASR API Key`.

## 7) Optional Bilibili Cookies (Recommended for Stability)

If yt-dlp fails on some videos due anonymous access limits, export your Bilibili cookies and set:

- `BILIBILI_COOKIES_FILE=.\bilibili_cookies.txt`

You can set it in `start_quick.ps1` / `start_quality.ps1`.

## 8) Download Timeout Tuning

To avoid long hangs when network/cdn is unstable, the server supports:

- `YTDLP_SOCKET_TIMEOUT_SEC` (default `20`)
- `YTDLP_RETRIES` (default `1`)
- `URL_DOWNLOAD_STAGE_TIMEOUT_SEC` (default `150`)

These are preconfigured in `start_quick.ps1` and `start_quality.ps1`.

## 9) Simplified Chinese Normalization

To keep transcript output in Simplified Chinese, the server supports:

- `ZH_TEXT_CONVERT_MODE=t2s` (default in start scripts)

If you want to disable conversion, set:

- `ZH_TEXT_CONVERT_MODE=off`
