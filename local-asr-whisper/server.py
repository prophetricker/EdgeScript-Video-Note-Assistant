import logging
import os
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field

try:
    from opencc import OpenCC  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    OpenCC = None  # type: ignore


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, str(default)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)).strip())
    except Exception:
        return default


APP_TITLE = "Local Whisper ASR (OpenAI-compatible)"
APP_VERSION = "0.1.5"
logger = logging.getLogger("local_asr")

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_BEAM_SIZE = _env_int("WHISPER_BEAM_SIZE", 3)
WHISPER_VAD_FILTER = _env_bool("WHISPER_VAD_FILTER", True)
WHISPER_VAD_MIN_SILENCE_MS = _env_int("WHISPER_VAD_MIN_SILENCE_MS", 500)
LOCAL_ASR_API_KEY = os.getenv("LOCAL_ASR_API_KEY", "").strip()
CPU_FALLBACK_DEVICE = "cpu"
CPU_FALLBACK_COMPUTE_TYPE = "int8"
MAX_AUDIO_DOWNLOAD_BYTES = _env_int("MAX_AUDIO_DOWNLOAD_BYTES", 220 * 1024 * 1024)
BILIBILI_COOKIES_FILE = os.getenv("BILIBILI_COOKIES_FILE", "").strip()
YTDLP_SOCKET_TIMEOUT_SEC = _env_int("YTDLP_SOCKET_TIMEOUT_SEC", 20)
YTDLP_RETRIES = _env_int("YTDLP_RETRIES", 1)
URL_DOWNLOAD_STAGE_TIMEOUT_SEC = _env_int("URL_DOWNLOAD_STAGE_TIMEOUT_SEC", 150)
ZH_TEXT_CONVERT_MODE = os.getenv("ZH_TEXT_CONVERT_MODE", "t2s").strip().lower()
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_MODEL_LOCK = threading.Lock()
_MODEL_INSTANCE: Optional[WhisperModel] = None
_MODEL_RUNTIME = {
    "device": WHISPER_DEVICE,
    "compute_type": WHISPER_COMPUTE_TYPE,
    "fallback_used": False,
}

_OPENCC_CONVERTER = None
if OpenCC and ZH_TEXT_CONVERT_MODE not in {"", "off", "none"}:
    try:
        _OPENCC_CONVERTER = OpenCC(ZH_TEXT_CONVERT_MODE)
    except Exception:
        # Keep service available even if converter init fails.
        _OPENCC_CONVERTER = None


app = FastAPI(title=APP_TITLE, version=APP_VERSION)


class UrlTranscriptionRequest(BaseModel):
    video_url: str = Field(default="", description="Original video URL")
    audio_candidates: List[str] = Field(default_factory=list, description="Optional direct audio URLs")
    model: str = Field(default="whisper-1")
    language: Optional[str] = Field(default=None)
    response_format: str = Field(default="verbose_json")
    temperature: Optional[float] = Field(default=None)


def _auth_or_401(auth_header: Optional[str]) -> None:
    if not LOCAL_ASR_API_KEY:
        return
    token = ""
    if auth_header and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    if token != LOCAL_ASR_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def _is_cuda_runtime_error(error: Exception) -> bool:
    text = str(error or "").lower()
    if not text:
        return False
    markers = [
        "cublas64_12.dll",
        "cublas",
        "cudnn",
        "cuda",
        "cannot be loaded",
        "driver",
    ]
    return any(marker in text for marker in markers)


def _load_model(device: str, compute_type: str) -> WhisperModel:
    logger.info("Loading WhisperModel: model=%s, device=%s, compute_type=%s", WHISPER_MODEL, device, compute_type)
    return WhisperModel(
        WHISPER_MODEL,
        device=device,
        compute_type=compute_type,
    )


def _set_runtime(device: str, compute_type: str, fallback_used: bool) -> None:
    _MODEL_RUNTIME["device"] = device
    _MODEL_RUNTIME["compute_type"] = compute_type
    _MODEL_RUNTIME["fallback_used"] = fallback_used


def get_model() -> WhisperModel:
    global _MODEL_INSTANCE
    if _MODEL_INSTANCE is not None:
        return _MODEL_INSTANCE

    with _MODEL_LOCK:
        if _MODEL_INSTANCE is not None:
            return _MODEL_INSTANCE
        try:
            _MODEL_INSTANCE = _load_model(WHISPER_DEVICE, WHISPER_COMPUTE_TYPE)
            _set_runtime(WHISPER_DEVICE, WHISPER_COMPUTE_TYPE, False)
            return _MODEL_INSTANCE
        except Exception as error:
            if not str(WHISPER_DEVICE or "").lower().startswith("cuda"):
                raise
            logger.warning(
                "CUDA model init failed, fallback to CPU. reason=%s",
                error,
                exc_info=True,
            )
            _MODEL_INSTANCE = _load_model(CPU_FALLBACK_DEVICE, CPU_FALLBACK_COMPUTE_TYPE)
            _set_runtime(CPU_FALLBACK_DEVICE, CPU_FALLBACK_COMPUTE_TYPE, True)
            return _MODEL_INSTANCE


def switch_model_to_cpu(reason: Exception) -> WhisperModel:
    global _MODEL_INSTANCE
    with _MODEL_LOCK:
        if str(_MODEL_RUNTIME.get("device", "")).lower().startswith("cpu") and _MODEL_INSTANCE is not None:
            return _MODEL_INSTANCE
        logger.warning("Switching WhisperModel to CPU fallback due to runtime error: %s", reason, exc_info=True)
        _MODEL_INSTANCE = _load_model(CPU_FALLBACK_DEVICE, CPU_FALLBACK_COMPUTE_TYPE)
        _set_runtime(CPU_FALLBACK_DEVICE, CPU_FALLBACK_COMPUTE_TYPE, True)
        return _MODEL_INSTANCE


def _run_transcribe(
    whisper: WhisperModel,
    tmp_path: str,
    language: Optional[str],
    temperature: Optional[float],
) -> Tuple[str, List[Dict[str, Any]], Any]:
    vad_parameters = {"min_silence_duration_ms": WHISPER_VAD_MIN_SILENCE_MS}
    segments_iter, info = whisper.transcribe(
        tmp_path,
        language=(language or None),
        beam_size=max(1, WHISPER_BEAM_SIZE),
        vad_filter=WHISPER_VAD_FILTER,
        vad_parameters=vad_parameters,
        condition_on_previous_text=True,
        temperature=temperature if temperature is not None else 0.0,
        word_timestamps=False,
    )

    segments: List[Dict[str, Any]] = []
    text_parts: List[str] = []
    for seg in segments_iter:
        piece = _normalize_zh_text((seg.text or "").strip())
        if not piece:
            continue
        text_parts.append(piece)
        segments.append(
            {
                "id": len(segments),
                "start": float(seg.start),
                "end": float(seg.end),
                "text": piece,
            }
        )

    text = "\n".join(text_parts).strip()
    return text, segments, info


def _normalize_zh_text(text: str) -> str:
    value = str(text or "").strip()
    if not value or _OPENCC_CONVERTER is None:
        return value
    try:
        return str(_OPENCC_CONVERTER.convert(value) or "").strip()
    except Exception:
        return value


def _transcribe_with_runtime_fallback(
    file_path: str,
    language: Optional[str],
    temperature: Optional[float],
) -> Tuple[str, List[Dict[str, Any]], Any]:
    whisper = get_model()
    try:
        return _run_transcribe(whisper, file_path, language, temperature)
    except Exception as runtime_error:
        runtime_device = str(_MODEL_RUNTIME.get("device", WHISPER_DEVICE)).lower()
        if runtime_device.startswith("cuda") and _is_cuda_runtime_error(runtime_error):
            whisper = switch_model_to_cpu(runtime_error)
            return _run_transcribe(whisper, file_path, language, temperature)
        raise


def _build_transcription_response(
    text: str,
    segments: List[Dict[str, Any]],
    info: Any,
    language: Optional[str],
    response_format: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if response_format == "verbose_json":
        payload: Dict[str, Any] = {
            "task": "transcribe",
            "language": getattr(info, "language", language or ""),
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
            "text": text,
            "segments": segments,
        }
    else:
        payload = {"text": text}

    if extra and isinstance(extra, dict):
        payload.update(extra)
    return payload


def _normalize_candidate_list(candidates: List[str]) -> List[str]:
    cleaned: List[str] = []
    for raw in candidates or []:
        value = str(raw or "").strip()
        if not value:
            continue
        if value.startswith("//"):
            value = f"https:{value}"
        if not (value.startswith("http://") or value.startswith("https://")):
            continue
        if value in cleaned:
            continue
        cleaned.append(value)
    return cleaned[:12]


def _resolve_cookie_file() -> str:
    if not BILIBILI_COOKIES_FILE:
        return ""

    candidate = BILIBILI_COOKIES_FILE
    if os.path.isabs(candidate) and os.path.exists(candidate):
        return candidate

    script_dir = os.path.dirname(os.path.abspath(__file__))
    in_script_dir = os.path.join(script_dir, candidate)
    if os.path.exists(in_script_dir):
        return in_script_dir
    return ""


def _run_with_timeout(callable_fn, timeout_sec: int, timeout_label: str):
    safe_timeout = max(5, int(timeout_sec or 0))
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr_timeout")
    future = pool.submit(callable_fn)
    try:
        return future.result(timeout=safe_timeout)
    except FutureTimeoutError as error:
        future.cancel()
        raise RuntimeError(f"{timeout_label} timeout after {safe_timeout}s") from error
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _download_with_ytdlp(video_url: str) -> Tuple[str, Dict[str, Any], str]:
    try:
        import yt_dlp  # type: ignore
    except Exception as error:
        raise RuntimeError(f"yt-dlp unavailable: {error}") from error

    tmp_dir = tempfile.mkdtemp(prefix="asr_yt_")
    outtmpl = os.path.join(tmp_dir, "%(id)s.%(ext)s")
    ydl_opts: Dict[str, Any] = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": max(5, int(YTDLP_SOCKET_TIMEOUT_SEC or 0)),
        "retries": max(0, int(YTDLP_RETRIES or 0)),
        "fragment_retries": max(0, int(YTDLP_RETRIES or 0)),
        "extractor_retries": max(0, int(YTDLP_RETRIES or 0)),
        "file_access_retries": 1,
        "skip_unavailable_fragments": True,
        "noprogress": True,
        "http_headers": {
            "Referer": "https://www.bilibili.com/",
            "User-Agent": DEFAULT_UA,
        },
    }

    cookie_file = _resolve_cookie_file()
    if cookie_file:
        ydl_opts["cookiefile"] = cookie_file

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True)

        files = [os.path.join(tmp_dir, name) for name in os.listdir(tmp_dir)]
        files = [path for path in files if os.path.isfile(path)]
        if not files:
            raise RuntimeError("yt-dlp did not produce audio file")
        files.sort(key=lambda path: os.path.getsize(path), reverse=True)
        picked = files[0]
        if os.path.getsize(picked) <= 1024:
            raise RuntimeError("yt-dlp downloaded file is too small")

        source_meta = {
            "mode": "yt_dlp",
            "video_url": video_url,
            "id": str(info.get("id", "")) if isinstance(info, dict) else "",
            "title": str(info.get("title", "")) if isinstance(info, dict) else "",
        }
        return picked, source_meta, tmp_dir
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise


def _looks_like_audio_blob(first_bytes: bytes, content_type: str) -> bool:
    ctype = (content_type or "").lower()
    if any(text in ctype for text in ["text/html", "text/plain", "application/json", "application/xml"]):
        return False
    if ctype.startswith("audio/") or ctype.startswith("video/"):
        return True

    header = first_bytes[:32]
    if len(header) < 12:
        return False

    try:
        as_text = header.decode("utf-8", errors="ignore").lower()
    except Exception:
        as_text = ""
    if "<html" in as_text or "<!doctype" in as_text or as_text.strip().startswith("{"):
        return False

    has_m4a_ftyp = header[4:8] == b"ftyp"
    has_riff = header[0:4] == b"RIFF"
    has_id3 = header[0:3] == b"ID3"
    has_ogg = header[0:4] == b"OggS"
    has_flac = header[0:4] == b"fLaC"
    looks_mp3 = len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0
    return has_m4a_ftyp or has_riff or has_id3 or has_ogg or has_flac or looks_mp3


def _download_candidate_to_temp(audio_url: str, referer: str) -> str:
    suffix = os.path.splitext(urlparse(audio_url).path)[1] or ".m4a"
    fd, tmp_path = tempfile.mkstemp(prefix="asr_cand_", suffix=suffix)
    os.close(fd)

    req = Request(
        audio_url,
        headers={
            "User-Agent": DEFAULT_UA,
            "Referer": referer or "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept": "*/*",
        },
    )

    wrote = 0
    first_chunk = b""
    content_type = ""
    try:
        with urlopen(req, timeout=20) as resp:
            content_type = str(resp.headers.get("Content-Type", ""))
            with open(tmp_path, "wb") as out_file:
                while True:
                    chunk = resp.read(1024 * 256)
                    if not chunk:
                        break
                    if not first_chunk:
                        first_chunk = chunk[:64]
                    out_file.write(chunk)
                    wrote += len(chunk)
                    if wrote > MAX_AUDIO_DOWNLOAD_BYTES:
                        raise RuntimeError("audio file too large")
    except HTTPError as error:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise RuntimeError(f"download http {error.code}") from error
    except URLError as error:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise RuntimeError(f"download url error: {error.reason}") from error
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise

    if wrote <= 1024:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise RuntimeError("downloaded file too small")

    if not _looks_like_audio_blob(first_chunk, content_type):
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise RuntimeError(f"not audio content-type={content_type or 'unknown'}")
    return tmp_path


def _download_audio_for_url(
    video_url: str,
    audio_candidates: List[str],
) -> Tuple[str, Dict[str, Any], Optional[str]]:
    errors: List[str] = []

    if video_url:
        try:
            return _run_with_timeout(
                lambda: _download_with_ytdlp(video_url),
                URL_DOWNLOAD_STAGE_TIMEOUT_SEC,
                "yt-dlp download",
            )
        except Exception as error:
            errors.append(f"yt-dlp: {error}")

    referer = video_url or "https://www.bilibili.com/"
    candidates = _normalize_candidate_list(audio_candidates)
    for item in candidates:
        try:
            path = _download_candidate_to_temp(item, referer=referer)
            return path, {"mode": "candidate", "audio_url": item, "video_url": video_url}, None
        except Exception as error:
            errors.append(f"{item} => {error}")

    short_errors = " | ".join(errors[:2]) if errors else "no downloadable candidates"
    raise RuntimeError(f"audio download failed: {short_errors}")


@app.get("/v1/models")
@app.get("/models", include_in_schema=False)
def list_models(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _auth_or_401(authorization)
    runtime_device = str(_MODEL_RUNTIME.get("device", WHISPER_DEVICE))
    runtime_compute_type = str(_MODEL_RUNTIME.get("compute_type", WHISPER_COMPUTE_TYPE))
    fallback_used = bool(_MODEL_RUNTIME.get("fallback_used", False))
    return {
        "object": "list",
        "data": [
            {
                "id": "whisper-1",
                "object": "model",
                "owned_by": "local-whisper",
                "metadata": {
                    "backend_model": WHISPER_MODEL,
                    "device": runtime_device,
                    "compute_type": runtime_compute_type,
                    "fallback_used": fallback_used,
                    "preferred_device": WHISPER_DEVICE,
                },
            }
        ],
    }


@app.post("/v1/audio/transcriptions")
@app.post("/audio/transcriptions", include_in_schema=False)
async def audio_transcriptions(
    file: UploadFile = File(...),
    model: str = Form("whisper-1"),
    language: Optional[str] = Form(default=None),
    response_format: str = Form("json"),
    temperature: Optional[float] = Form(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _auth_or_401(authorization)

    if model and model != "whisper-1":
        # Keep OpenAI-compatible request shape while using local backend model.
        pass

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")

    suffix = os.path.splitext(file.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        text, segments, info = _transcribe_with_runtime_fallback(tmp_path, language, temperature)

        if not text:
            return {"text": ""}

        return _build_transcription_response(
            text=text,
            segments=segments,
            info=info,
            language=language,
            response_format=response_format,
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {error}") from error
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


@app.post("/v1/audio/transcriptions_by_url")
@app.post("/audio/transcriptions_by_url", include_in_schema=False)
async def audio_transcriptions_by_url(
    payload: UrlTranscriptionRequest,
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _auth_or_401(authorization)

    video_url = str(payload.video_url or "").strip()
    candidates = payload.audio_candidates or []
    model = str(payload.model or "whisper-1").strip()
    language = payload.language
    response_format = str(payload.response_format or "verbose_json").strip() or "verbose_json"
    temperature = payload.temperature

    if model and model != "whisper-1":
        # Keep OpenAI-compatible request shape while using local backend model.
        pass

    local_file = ""
    local_dir = ""
    source_meta: Dict[str, Any] = {}
    try:
        local_file, source_meta, local_dir = _download_audio_for_url(video_url, candidates)
        text, segments, info = _transcribe_with_runtime_fallback(local_file, language, temperature)
        if not text:
            return {"text": "", "source": source_meta}

        return _build_transcription_response(
            text=text,
            segments=segments,
            info=info,
            language=language,
            response_format=response_format,
            extra={"source": source_meta},
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Transcription by URL failed")
        raise HTTPException(status_code=500, detail=f"Transcription by URL failed: {error}") from error
    finally:
        if local_file and os.path.exists(local_file):
            try:
                os.remove(local_file)
            except Exception:
                pass
        if local_dir and os.path.exists(local_dir):
            shutil.rmtree(local_dir, ignore_errors=True)


@app.get("/health")
def health() -> Dict[str, Any]:
    runtime_device = str(_MODEL_RUNTIME.get("device", WHISPER_DEVICE))
    runtime_compute_type = str(_MODEL_RUNTIME.get("compute_type", WHISPER_COMPUTE_TYPE))
    fallback_used = bool(_MODEL_RUNTIME.get("fallback_used", False))
    return {
        "ok": True,
        "service": APP_TITLE,
        "version": APP_VERSION,
        "backend_model": WHISPER_MODEL,
        "device": runtime_device,
        "compute_type": runtime_compute_type,
        "fallback_used": fallback_used,
        "preferred_device": WHISPER_DEVICE,
        "ytdlp_socket_timeout_sec": max(5, int(YTDLP_SOCKET_TIMEOUT_SEC or 0)),
        "ytdlp_retries": max(0, int(YTDLP_RETRIES or 0)),
        "url_download_stage_timeout_sec": max(5, int(URL_DOWNLOAD_STAGE_TIMEOUT_SEC or 0)),
        "zh_text_convert_mode": ZH_TEXT_CONVERT_MODE if _OPENCC_CONVERTER is not None else "off",
    }
