const CONTENT_SCRIPT_VERSION = "0.1.22";

registerEdgeScriptMessageHandler();

function registerEdgeScriptMessageHandler() {
  const oldHandler = globalThis.__edgeScriptOnMessageHandler;
  const oldVersion = String(globalThis.__edgeScriptOnMessageHandlerVersion || "");
  if (oldHandler && oldVersion === CONTENT_SCRIPT_VERSION) {
    return;
  }

  if (oldHandler) {
    try {
      chrome.runtime.onMessage.removeListener(oldHandler);
    } catch (_) {
      // Ignore old handler cleanup errors.
    }
  }

  const handler = (message, sender, sendResponse) => {
    if (message?.action === "EXTRACT_BILIBILI_TRANSCRIPT") {
      extractBilibiliTranscript()
        .then((result) =>
          sendResponse({
            extractorVersion: CONTENT_SCRIPT_VERSION,
            ...result
          })
        )
        .catch((error) =>
          sendResponse({
            extractorVersion: CONTENT_SCRIPT_VERSION,
            error: error?.message || String(error)
          })
        );
      return true;
    }

    if (message?.action === "TRANSCRIBE_AUDIO_IN_PAGE" || message?.action === "TRANSCRIBE_AUDIO_IN_PAGE_V2") {
      transcribeAudioInPage(message?.payload || {})
        .then((result) => sendResponse({ ok: true, extractorVersion: CONTENT_SCRIPT_VERSION, ...result }))
        .catch((error) =>
          sendResponse({
            ok: false,
            extractorVersion: CONTENT_SCRIPT_VERSION,
            error: error?.message || String(error)
          })
        );
      return true;
    }

    return false;
  };

  globalThis.__edgeScriptOnMessageHandler = handler;
  globalThis.__edgeScriptOnMessageHandlerVersion = CONTENT_SCRIPT_VERSION;
  chrome.runtime.onMessage.addListener(handler);
}

async function extractBilibiliTranscript() {
  const pageUrl = new URL(window.location.href);
  const bvid = getBvidFromPath(pageUrl.pathname);
  if (!bvid) {
    throw new Error("当前页面不是 B 站 BV 视频页。");
  }

  const pageNumber = parsePageNumber(pageUrl.searchParams.get("p"));
  const viewData = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    referrer: window.location.href
  });
  if (viewData?.code !== 0 || !viewData?.data) {
    throw new Error(`获取视频信息失败：${viewData?.message || "未知错误"}`);
  }

  const videoData = viewData.data;
  const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
  const targetPage = pages[pageNumber - 1] || pages[0];
  const cid = targetPage?.cid;
  if (!cid) {
    throw new Error("未获取到视频分 P 的 cid。");
  }

  const subtitleMeta = await fetchJson(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`,
    {
      referrer: window.location.href
    }
  );
  if (subtitleMeta?.code !== 0) {
    throw new Error(`获取字幕元信息失败：${subtitleMeta?.message || "未知错误"}`);
  }

  const subtitles = subtitleMeta?.data?.subtitle?.subtitles || [];
  const subtitlePick = await pickBestSubtitleWithContent(subtitles, window.location.href);
  if (subtitlePick?.subtitle && subtitlePick?.segments?.length) {
    const transcriptText = subtitlePick.segments.map((segment) => segment.content).join("\n");

    return {
      extractorVersion: CONTENT_SCRIPT_VERSION,
      source: "subtitle",
      subtitleLang: subtitlePick.subtitle.lan_doc || subtitlePick.subtitle.lan || "",
      transcriptText,
      segments: subtitlePick.segments,
      subtitleSelectionMeta: subtitlePick.meta || null,
      audioTrackUrl: "",
      audioTrackUrls: [],
      video: {
        title: videoData.title || document.title || "",
        url: window.location.href,
        bvid,
        cid,
        p: pageNumber,
        owner: videoData?.owner?.name || "",
        desc: videoData?.desc || "",
        duration: Number(videoData?.duration || 0),
        pageTitle: targetPage?.part || ""
      }
    };
  }

  const audioTrackUrls = await tryGetAudioTrackUrls({
    bvid,
    cid,
    pageUrl: window.location.href
  });

  return buildDescriptionFallback(videoData, bvid, cid, pageNumber, audioTrackUrls);
}

async function tryGetAudioTrackUrls({ bvid, cid, pageUrl }) {
  const apiCandidates = [];
  const pageCandidates = [];
  const apiList = [
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(
      bvid
    )}&cid=${encodeURIComponent(String(cid))}&qn=64&fnval=16&fnver=0&fourk=0`,
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(
      bvid
    )}&cid=${encodeURIComponent(String(cid))}&qn=32&fnval=0&platform=html5&high_quality=0`,
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(
      bvid
    )}&cid=${encodeURIComponent(String(cid))}&qn=64&fnval=4048&fnver=0`
  ];

  for (const apiUrl of apiList) {
    try {
      const payload = await fetchJson(apiUrl, {
        referrer: pageUrl
      });
      if (payload?.code === 0 && payload?.data) {
        collectAudioUrlsFromPlayUrl(payload.data, apiCandidates);
      }
    } catch (_) {
      // Ignore one endpoint and continue.
    }
  }

  // Prefer API candidates bound to current bvid/cid. Use page playinfo only as a last resort.
  if (apiCandidates.length > 0) {
    return dedupeUrls(apiCandidates.map(normalizeUrl).filter(Boolean)).slice(0, 12);
  }

  collectAudioUrlsFromPlayInfo(pageCandidates);
  return dedupeUrls(pageCandidates.map(normalizeUrl).filter(Boolean)).slice(0, 8);
}

async function pickBestSubtitleWithContent(subtitles, pageUrl) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    return null;
  }

  const tasks = subtitles.map(async (subtitle, index) => {
    const subtitleUrl = normalizeUrl(subtitle?.subtitle_url || "");
    if (!subtitleUrl) {
      return null;
    }

    try {
      const data = await fetchJsonWithRetry(
        subtitleUrl,
        {
          referrer: pageUrl
        },
        1
      );
      const segments = normalizeSubtitleSegments(data?.body || []);
      if (segments.length === 0) {
        return null;
      }

      const textLength = segments.reduce((sum, item) => sum + item.content.length, 0);
      const score = scoreSubtitleCandidate(subtitle, textLength, segments.length, index);

      return {
        subtitle,
        segments,
        index,
        textLength,
        score
      };
    } catch (_) {
      return null;
    }
  });

  const resolved = (await Promise.all(tasks)).filter(Boolean);
  if (resolved.length === 0) {
    return null;
  }

  resolved.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.textLength !== a.textLength) {
      return b.textLength - a.textLength;
    }
    return String(a.subtitle?.subtitle_url || "").localeCompare(String(b.subtitle?.subtitle_url || ""));
  });

  const winner = resolved[0];
  return {
    subtitle: winner.subtitle,
    segments: winner.segments,
    meta: {
      score: winner.score,
      textLength: winner.textLength,
      segments: winner.segments.length,
      lang: winner.subtitle?.lan || "",
      langDoc: winner.subtitle?.lan_doc || "",
      candidateCount: resolved.length
    }
  };
}

function normalizeSubtitleSegments(rawSegments) {
  return (rawSegments || [])
    .map((segment) => ({
      from: Number(segment.from || 0),
      to: Number(segment.to || 0),
      content: String(segment.content || "").trim()
    }))
    .filter((segment) => segment.content.length > 0);
}

function scoreSubtitleCandidate(subtitle, textLength, segmentCount, index) {
  const lan = String(subtitle?.lan || "").toLowerCase();
  const lanDoc = String(subtitle?.lan_doc || "").toLowerCase();
  const marker = `${lan} ${lanDoc}`;

  let langScore = 0;
  if (/^zh([_-](cn|hans|hant))?$/.test(lan) || lan.startsWith("zh-")) {
    langScore += 500;
  }
  if (/中文|简体|繁体|chinese|mandarin/.test(lanDoc)) {
    langScore += 450;
  }
  if (/auto|自动|ai/.test(marker)) {
    langScore -= 20;
  }
  if (/^es([_-]|$)|spanish|español/.test(marker)) {
    langScore -= 120;
  }
  if (/^en([_-]|$)|english/.test(marker)) {
    langScore -= 80;
  }

  return langScore * 100000 + textLength * 10 + segmentCount * 3 - Number(index || 0);
}

function collectAudioUrlsFromPlayInfo(collector) {
  const playInfo = parseEmbeddedPlayInfo();
  if (!playInfo?.data) {
    return;
  }
  collectAudioUrlsFromPlayUrl(playInfo.data, collector);
}

function parseEmbeddedPlayInfo() {
  try {
    if (window.__playinfo__?.data) {
      return window.__playinfo__;
    }
  } catch (_) {
    // Ignore sandbox access errors.
  }

  const scripts = Array.from(document.scripts || []);
  for (const script of scripts) {
    const text = script?.textContent || "";
    if (!text.includes("window.__playinfo__")) {
      continue;
    }
    const match = text.match(/window\.__playinfo__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!match?.[1]) {
      continue;
    }
    try {
      return JSON.parse(match[1]);
    } catch (_) {
      // Ignore and continue.
    }
  }
  return null;
}

function collectAudioUrlsFromPlayUrl(playData, collector) {
  if (!playData || !collector) {
    return;
  }

  const dashAudio = Array.isArray(playData?.dash?.audio) ? playData.dash.audio : [];
  for (const item of dashAudio) {
    pushUrl(collector, item?.base_url || item?.baseUrl || "");
    const backups = item?.backup_url || item?.backupUrl || [];
    if (Array.isArray(backups)) {
      for (const backup of backups) {
        pushUrl(collector, backup);
      }
    }
  }

  const dolbyAudio = Array.isArray(playData?.dash?.dolby?.audio) ? playData.dash.dolby.audio : [];
  for (const item of dolbyAudio) {
    pushUrl(collector, item?.base_url || item?.baseUrl || "");
    const backups = item?.backup_url || item?.backupUrl || [];
    if (Array.isArray(backups)) {
      for (const backup of backups) {
        pushUrl(collector, backup);
      }
    }
  }

  const durl = Array.isArray(playData?.durl) ? playData.durl : [];
  for (const item of durl) {
    pushUrl(collector, item?.url || "");
    const backups = item?.backup_url || item?.backupUrl || [];
    if (Array.isArray(backups)) {
      for (const backup of backups) {
        pushUrl(collector, backup);
      }
    }
  }
}

function buildDescriptionFallback(videoData, bvid, cid, pageNumber, audioTrackUrls) {
  const desc = (videoData?.desc || "").trim();
  const dynamic = (videoData?.dynamic || "").trim();
  const title = videoData?.title || document.title || "B 站视频";

  const blocks = [];
  if (title) {
    blocks.push(`标题：${title}`);
  }
  if (desc) {
    blocks.push(`简介：${desc}`);
  }
  if (dynamic) {
    blocks.push(`动态：${dynamic}`);
  }

  const list = Array.isArray(audioTrackUrls) ? audioTrackUrls : [];
  return {
    extractorVersion: CONTENT_SCRIPT_VERSION,
    source: "description_fallback",
    subtitleLang: "",
    transcriptText: blocks.join("\n\n"),
    segments: [],
    audioTrackUrl: list[0] || "",
    audioTrackUrls: list,
    video: {
      title,
      url: window.location.href,
      bvid,
      cid,
      p: pageNumber,
      owner: videoData?.owner?.name || "",
      desc,
      duration: Number(videoData?.duration || 0),
      pageTitle: ""
    }
  };
}

function getBvidFromPath(pathname) {
  const matched = pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  return matched ? matched[1] : "";
}

function parsePageNumber(value) {
  const num = Number.parseInt(value || "1", 10);
  if (Number.isNaN(num) || num <= 0) {
    return 1;
  }
  return num;
}

async function fetchJsonWithRetry(url, fetchOptions = {}, retries = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJson(url, fetchOptions);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep((attempt + 1) * 300);
      }
    }
  }
  throw lastError || new Error("请求失败");
}

function dedupeUrls(urls) {
  return [...new Set((urls || []).map((item) => String(item || "")).filter(Boolean))];
}

function pushUrl(list, value) {
  const normalized = normalizeUrl(value);
  if (normalized) {
    list.push(normalized);
  }
}

function normalizeUrl(url) {
  if (!url) {
    return "";
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return url;
  }
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  if (url.startsWith("/")) {
    return `https://api.bilibili.com${url}`;
  }
  return `https://${url}`;
}

async function transcribeAudioInPage(payload) {
  const candidates = dedupeUrls(Array.isArray(payload?.candidates) ? payload.candidates : []);
  const settings = payload?.settings || {};
  const auth = payload?.auth || {};
  const sourceDurationSec = Math.max(0, Number(payload?.sourceDurationSec || 0));
  const deadlineAt = Date.now() + 80_000;

  if (!auth?.baseUrl) {
    throw new Error("ASR 配置不完整（缺少 Base URL）。");
  }
  if (!auth?.apiKey && !isLocalAsrBaseUrl(auth.baseUrl)) {
    throw new Error("ASR 配置不完整（非本地地址缺少 API Key）。");
  }
  if (candidates.length === 0) {
    throw new Error("无可用音频候选地址。");
  }

  // Page-mode fallback should fail fast to avoid long "running" hangs in popup.
  const maxCandidates = Math.max(2, Math.min(6, Number(settings?.asrMaxCandidates || 4)));
  const candidateList = candidates.slice(0, maxCandidates);
  const errors = [];

  for (const rawUrl of candidateList) {
    if (Date.now() >= deadlineAt - 1200) {
      errors.push("页面内转写超时（候选音频尝试超出预算）");
      break;
    }

    const url = normalizeUrl(rawUrl);
    if (!url) {
      continue;
    }

    try {
      const audio = await downloadAudioForPage(url, deadlineAt);
      const result = await transcribeBlobForPage({
        baseUrl: auth.baseUrl,
        apiKey: auth.apiKey,
        model: settings.asrModel || "whisper-1",
        maxMB: Number(settings.asrMaxAudioMB || 24),
        maxChunks: Number(settings.asrMaxChunks || 6),
        sourceDurationSec,
        deadlineAt,
        audioBlob: audio.blob,
        audioUrl: url
      });

      return {
        ...result,
        usedAudioUrl: url,
        mode: "page"
      };
    } catch (error) {
      errors.push(`${url} => ${error?.message || String(error)}`);
    }
  }

  throw new Error(`页面内转写失败：${errors.slice(0, 2).join(" | ") || "无可用候选地址"}`);
}

async function downloadAudioForPage(url, deadlineAt = 0) {
  const referrers = [window.location.href, "https://www.bilibili.com/", ""];
  const credentialsList = ["include", "omit"];
  let lastError = null;

  for (const referrer of referrers) {
    for (const credentials of credentialsList) {
      if (deadlineAt && Date.now() >= deadlineAt - 800) {
        throw new Error("页面内转写超时（下载阶段超出预算）");
      }

      try {
        const remainMs = deadlineAt ? deadlineAt - Date.now() : 12_000;
        if (deadlineAt && remainMs <= 1200) {
          throw new Error("页面内转写超时（下载阶段超出预算）");
        }
        const timeoutMs = Math.max(2500, Math.min(10_000, remainMs - 300));
        const response = await fetchWithTimeout(
          url,
          {
            method: "GET",
            mode: "cors",
            credentials,
            cache: "no-store",
            referrer: referrer || undefined,
            referrerPolicy: "strict-origin-when-cross-origin"
          },
          timeoutMs
        );

        if (!response.ok) {
          lastError = new Error(`下载音频失败（HTTP ${response.status}）。`);
          continue;
        }

        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (
          contentType.includes("text/html") ||
          contentType.includes("text/plain") ||
          contentType.includes("application/json")
        ) {
          lastError = new Error(`下载内容不是音频（content-type=${contentType || "unknown"}）。`);
          continue;
        }

        const blob = await response.blob();
        if (!blob || blob.size === 0) {
          lastError = new Error("下载音频内容为空。");
          continue;
        }
        if (blob.size < 1024) {
          lastError = new Error("下载音频内容过小，疑似无效响应。");
          continue;
        }

        const check = await inspectAudioBlob(blob, contentType);
        if (!check.ok) {
          lastError = new Error(`下载内容校验失败：${check.reason}`);
          continue;
        }

        return { blob };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("下载音频失败。");
}

async function transcribeBlobForPage({
  baseUrl,
  apiKey,
  model,
  maxMB,
  maxChunks,
  sourceDurationSec,
  deadlineAt,
  audioBlob,
  audioUrl,
}) {
  const maxBytes = Math.max(1, Math.floor(maxMB || 24)) * 1024 * 1024;
  const originalSize = Number(audioBlob?.size || 0);
  const chunked = splitAudioBlobIntoChunks(audioBlob, maxBytes, Math.max(1, Math.min(12, Number(maxChunks || 6))));

  const textParts = [];
  const mergedSegments = [];

  for (let i = 0; i < chunked.chunks.length; i += 1) {
    if (deadlineAt && Date.now() >= deadlineAt - 1200) {
      throw new Error("页面内转写超时（ASR 分段阶段超出预算）");
    }
    const chunkInfo = chunked.chunks[i];
    const chunkResult = await transcribeChunkForPage({
      baseUrl,
      apiKey,
      model,
      audioBlob: chunkInfo.blob,
      audioUrl,
      chunkIndex: i,
      chunkCount: chunked.chunks.length,
      deadlineAt,
    });

    if (chunkResult.text) {
      textParts.push(chunkResult.text);
    }

    const offsetSec =
      sourceDurationSec > 0 && originalSize > 0 ? (Number(sourceDurationSec) * chunkInfo.startByte) / originalSize : 0;
    const segments = normalizeAsrSegments(chunkResult.segments, offsetSec);
    if (segments.length) {
      mergedSegments.push(...segments);
    }
  }

  const text = textParts.join("\n").trim();
  if (!text) {
    throw new Error("音频转写失败：响应中没有可用文本。");
  }

  return {
    text,
    segments: mergedSegments,
    truncated: chunked.truncated,
    originalSize
  };
}

function splitAudioBlobIntoChunks(audioBlob, maxBytes, maxChunkCount) {
  if (!audioBlob || audioBlob.size <= maxBytes) {
    return {
      chunks: [
        {
          blob: audioBlob,
          startByte: 0,
          endByte: Number(audioBlob?.size || 0)
        }
      ],
      truncated: false
    };
  }

  const chunks = [];
  for (let start = 0; start < audioBlob.size && chunks.length < maxChunkCount; start += maxBytes) {
    const end = Math.min(start + maxBytes, audioBlob.size);
    chunks.push({
      blob: audioBlob.slice(start, end, audioBlob.type || "audio/mp4"),
      startByte: start,
      endByte: end
    });
  }

  return {
    chunks,
    truncated: audioBlob.size > maxBytes * maxChunkCount
  };
}

async function transcribeChunkForPage({ baseUrl, apiKey, model, audioBlob, audioUrl, chunkIndex, chunkCount, deadlineAt = 0 }) {
  const form = new FormData();
  form.append("model", model || "whisper-1");
  form.append("language", "zh");
  form.append("response_format", "verbose_json");
  form.append("file", audioBlob, inferAudioFilename(audioUrl, audioBlob.type));

  const url = `${trimSlash(baseUrl)}/audio/transcriptions`;
  const remainMs = deadlineAt ? deadlineAt - Date.now() : 45_000;
  if (remainMs <= 1200) {
    throw new Error("页面内转写超时（ASR 阶段超出预算）");
  }
  const timeoutMs = Math.max(3000, Math.min(45_000, remainMs - 300));
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: buildAuthHeaders(apiKey),
      body: form
    },
    timeoutMs
  );

  const payload = await safeReadJsonResponse(response);
  if (!response.ok) {
    throw new Error(`音频转写失败（HTTP ${response.status}）：${extractApiError(payload, response.status)}`);
  }

  const text = String(payload?.text || payload?.data?.text || payload?.result?.text || "").trim();
  if (!text) {
    throw new Error(`音频转写失败：第 ${chunkIndex + 1}/${chunkCount} 段返回为空。`);
  }

  const segments = Array.isArray(payload?.segments)
    ? payload.segments
    : Array.isArray(payload?.data?.segments)
    ? payload.data.segments
    : Array.isArray(payload?.result?.segments)
    ? payload.result.segments
    : [];

  return { text, segments };
}

function normalizeAsrSegments(rawSegments, chunkOffsetSec = 0) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return [];
  }

  const offset = Number.isFinite(chunkOffsetSec) ? Number(chunkOffsetSec) : 0;
  return rawSegments
    .map((item) => {
      const from = Number(item?.start ?? item?.from ?? item?.begin ?? 0) + offset;
      const to = Number(item?.end ?? item?.to ?? item?.finish ?? from) + offset;
      const content = String(item?.text ?? item?.content ?? "").trim();
      return {
        from: Number.isFinite(from) ? Math.max(0, from) : 0,
        to: Number.isFinite(to) ? Math.max(0, to) : 0,
        content
      };
    })
    .filter((item) => item.content.length > 0);
}

function inferAudioFilename(url, mimeType) {
  const extByMime = mimeType && mimeType.includes("mpeg") ? "mp3" : "m4a";
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").pop() || "";
    if (name.includes(".")) {
      return name.slice(0, 80);
    }
  } catch (_) {
    // Ignore URL parse errors.
  }
  return `audio.${extByMime}`;
}

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function inspectAudioBlob(blob, contentType = "") {
  if (!blob || Number(blob.size || 0) <= 0) {
    return { ok: false, reason: "音频内容为空" };
  }

  const type = String(contentType || blob.type || "").toLowerCase();
  if (
    type.includes("text/html") ||
    type.includes("text/plain") ||
    type.includes("application/json") ||
    type.includes("application/xml")
  ) {
    return { ok: false, reason: `响应类型异常（${type || "unknown"}）` };
  }
  if (type.startsWith("audio/") || type.startsWith("video/")) {
    return { ok: true, reason: "" };
  }

  try {
    const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    if (header.length < 12) {
      return { ok: false, reason: "文件头过短" };
    }

    const asText = new TextDecoder("utf-8", { fatal: false }).decode(header).toLowerCase();
    if (asText.includes("<html") || asText.includes("<!doctype") || asText.trim().startsWith("{")) {
      return { ok: false, reason: "疑似网页或 JSON 响应，不是音频数据" };
    }

    const hasM4aFtyp = header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
    const hasRiff =
      header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46;
    const hasId3 = header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33;
    const hasOgg =
      header[0] === 0x4f && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53;
    const hasFlac =
      header[0] === 0x66 && header[1] === 0x4c && header[2] === 0x61 && header[3] === 0x43;
    const looksLikeMp3Frame = header[0] === 0xff && (header[1] & 0xe0) === 0xe0;

    if (hasM4aFtyp || hasRiff || hasId3 || hasOgg || hasFlac || looksLikeMp3Frame) {
      return { ok: true, reason: "" };
    }
  } catch (_) {
    // ignore and use fallback result below
  }

  return { ok: false, reason: "无法识别为常见音频容器格式" };
}

function buildAuthHeaders(apiKey) {
  const token = String(apiKey || "").trim();
  if (!token) {
    return {};
  }
  return {
    Authorization: `Bearer ${token}`
  };
}

function isLocalAsrBaseUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch (_) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(raw);
  }
}

async function fetchJson(url, fetchOptions = {}) {
  const proxied = await fetchJsonViaBackground(url, fetchOptions);
  if (proxied.ok) {
    return proxied.data;
  }

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: fetchOptions.method || "GET",
        headers: fetchOptions.headers || {},
        credentials: fetchOptions.credentials || "include",
        referrer: fetchOptions.referrer || window.location.href,
        referrerPolicy: fetchOptions.referrerPolicy || "strict-origin-when-cross-origin"
      },
      15000
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!text) {
      return {};
    }
    return JSON.parse(text);
  } catch (error) {
    const reason = proxied.error || error?.message || "未知错误";
    throw new Error(`请求失败：${reason} (${url})`);
  }
}

function fetchJsonViaBackground(url, fetchOptions) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: "FETCH_JSON",
        url,
        fetchOptions: fetchOptions || {}
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({ ok: false, error: runtimeError.message });
          return;
        }
        resolve(response || { ok: false, error: "空响应" });
      }
    );
  });
}

async function safeReadJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

function extractApiError(payload, status) {
  const msg =
    payload?.error?.message ||
    payload?.message ||
    payload?.msg ||
    payload?.detail ||
    payload?.error_description ||
    payload?.raw ||
    "未知错误";

  const text = String(msg || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return `HTTP ${status}`;
  }
  if (/<!doctype html/i.test(text)) {
    return `HTTP ${status}（返回了 HTML 页面）`;
  }
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...(options || {}),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

