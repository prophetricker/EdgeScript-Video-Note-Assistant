$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$VenvPy = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $VenvPy)) {
  throw "venv not found. Run .\\setup.ps1 first."
}

# Quick profile: prioritize compatibility and stable first-run experience.
$env:WHISPER_MODEL = "small"
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
$env:WHISPER_BEAM_SIZE = "2"
$env:WHISPER_VAD_FILTER = "true"
$env:WHISPER_VAD_MIN_SILENCE_MS = "500"
$env:YTDLP_SOCKET_TIMEOUT_SEC = "20"
$env:YTDLP_RETRIES = "1"
$env:URL_DOWNLOAD_STAGE_TIMEOUT_SEC = "150"
$env:ZH_TEXT_CONVERT_MODE = "t2s"

# Optional local API key. Keep empty to disable auth.
# $env:LOCAL_ASR_API_KEY = "local-dev-key"
# Optional cookies file for yt-dlp (recommended when Bilibili rate-limits or blocks anonymous requests).
# $env:BILIBILI_COOKIES_FILE = ".\\bilibili_cookies.txt"

& $VenvPy -m uvicorn server:app --host 127.0.0.1 --port 8171
