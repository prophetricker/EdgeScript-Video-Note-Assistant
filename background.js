const DEFAULT_SETTINGS = {
  llmBaseUrl: "https://xlabapi.top/v1",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  llmTemperature: 0.3,
  llmMaxRetries: 2,
  noteDepth: "standard",
  enableAsrFallback: true,
  requireAsrWhenNoSubtitle: true,
  asrBaseUrl: "",
  asrApiKey: "",
  asrModel: "whisper-1",
  asrMaxAudioMB: 24,
  asrMaxChunks: 6,
  asrMaxCandidates: 16,
  autoImportToFeishu: true,
  feishuBaseUrl: "https://open.feishu.cn/open-apis",
  feishuAppId: "",
  feishuAppSecret: "",
  feishuWikiSpaceId: "",
  feishuParentNodeToken: "",
  feishuWikiObjType: "docx",
  enableStyleLearning: true,
  styleSamples: [],
  styleProfile: null
};

const RUN_STATE_KEY = "lastPipelineResult";
const RUN_LOG_HISTORY_KEY = "pipelineRunHistory";
const RUNNING_BY_TAB = new Map();
const ACTIVE_RUNS = new Map();
const RUNTIME_VERSION = "0.1.24";
const CONTENT_SCRIPT_REQUIRED_VERSION = "0.1.22";
const DEFAULT_DOC_TITLE_FALLBACK = "\u89c6\u9891\u7b14\u8bb0";
const DEFAULT_DOC_TITLE_SUFFIX = "\u5b66\u4e60\u7b14\u8bb0";
const TRANSCRIPT_DOC_TITLE_SUFFIX = "\u8f6c\u5199\u4e0e\u65f6\u95f4\u6233";
const RUN_LOG_HISTORY_LIMIT = 20;
const RUN_LOG_LINE_LIMIT = 400;
const ASR_MAX_CHUNKS = 6;
const ASR_CAPABILITY_SUCCESS_TTL_MS = 10 * 60 * 1000;
const ASR_CAPABILITY_FAIL_TTL_MS = 15 * 1000;
const ASR_PROBE_TIMEOUT_MS = 20000;
const FEISHU_HTTP_TIMEOUT_MS = 20000;
const FEISHU_HTTP_RETRIES = 2;
const FEISHU_APPEND_PROGRESS_INTERVAL = 8;
const NOTE_REWRITE_MAX_ROUNDS = 3;
const NOTE_PROGRESS_HEARTBEAT_MS = 20000;
const NOTE_STAGE_TIMEOUT_MS = 8 * 60 * 1000;
const PAGE_ASR_TIMEOUT_MS = 90000;
const LLM_HTTP_TIMEOUT_MS = 120000;
const RUN_CANCELLED_NAME = "PipelineForceStopped";
const ASR_BACKGROUND_TIMEOUT_MS = 180000;
const ASR_CANDIDATE_MAX_HARD = 8;
const LOCAL_ASR_URL_TRANSCRIBE_TIMEOUT_MS = 420000;
const LOCAL_ASR_PROGRESS_HEARTBEAT_MS = 20000;

let runLogPersistQueue = Promise.resolve();
const asrCapabilityCache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await storageGet(Object.keys(DEFAULT_SETTINGS));
  await storageSet(withDefaults(current));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;

  if (action === "START_PIPELINE") {
    startPipelineForTab(message?.tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "SAVE_SETTINGS") {
    saveSettings(message?.settings || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "ADD_STYLE_SAMPLES") {
    addStyleSamples(message?.samples || [])
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "DELETE_STYLE_SAMPLE") {
    deleteStyleSample(message?.sampleId)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "REFRESH_STYLE_PROFILE") {
    refreshStyleProfile()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "GET_LAST_PIPELINE_RESULT") {
    storageGet(RUN_STATE_KEY)
      .then((result) => sendResponse({ ok: true, result: result[RUN_STATE_KEY] || null }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "GET_RUN_HISTORY") {
    getRunHistory(Number(message?.limit || 10))
      .then((runs) => sendResponse({ ok: true, runs }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "GET_PIPELINE_RUNTIME_STATE") {
    getPipelineRuntimeState()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "FORCE_STOP_PIPELINE") {
    forceStopPipeline({
      runId: message?.runId,
      tabId: message?.tabId,
      reason: message?.reason
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "RUN_PREFLIGHT") {
    runPreflightChecks(message?.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "FETCH_JSON") {
    fetchJsonByBackground(message?.url, message?.fetchOptions || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }

  if (action === "PING") {
    sendResponse({
      ok: true,
      alive: true,
      version: RUNTIME_VERSION,
      now: new Date().toISOString()
    });
    return true;
  }

  return false;
});

async function startPipelineForTab(requestedTabId) {
  const tabId = requestedTabId || (await getActiveTabId());
  if (!tabId) {
    throw new Error("未找到当前标签页，请在 B 站视频页面打开插件后重试。");
  }

  const existingRunId = RUNNING_BY_TAB.get(tabId);
  if (existingRunId && ACTIVE_RUNS.has(existingRunId)) {
    return { ok: false, error: "当前标签页已有任务正在执行，请稍后。" };
  }
  if (existingRunId && !ACTIVE_RUNS.has(existingRunId)) {
    RUNNING_BY_TAB.delete(tabId);
  }

  const runId = createRunId();
  ACTIVE_RUNS.set(runId, {
    runId,
    tabId,
    startedAt: new Date().toISOString(),
    cancelled: false,
    cancelReason: "",
    finalized: false
  });
  RUNNING_BY_TAB.set(tabId, runId);
  sendProgress({ runId, stage: "start", level: "info", message: "任务已启动。" });

  runPipeline({ runId, tabId })
    .catch((error) => {
      if (isRunCancelled(runId) || isRunCancelledError(error)) {
        return;
      }
      sendProgress({ runId, stage: "error", level: "error", message: formatError(error) });
      sendFinished({ runId, ok: false, error: formatError(error) });
    })
    .finally(() => {
      cleanupRunState(runId, tabId);
    });

  return { ok: true, runId };
}

async function runPipeline({ runId, tabId }) {
  throwIfRunCancelled(runId);
  const settings = await getSettings();
  throwIfRunCancelled(runId);

  sendProgress({ runId, stage: "extract", level: "info", message: "正在提取 B 站视频文本..." });
  const transcriptPayload = await requestBilibiliTranscript(tabId);
  throwIfRunCancelled(runId);
  if (transcriptPayload?.error) {
    throw new Error(transcriptPayload.error);
  }
  if (!transcriptPayload?.transcriptText) {
    throw new Error("提取视频文本失败：未获取到可用文本。");
  }
  if (transcriptPayload?.extractorVersion) {
    sendProgress({
      runId,
      stage: "extract",
      level: "info",
      message: `页面提取器版本：${transcriptPayload.extractorVersion}`
    });
  }

  let asrAttempt = null;
  if (transcriptPayload.source === "description_fallback") {
    asrAttempt = await tryAsrFallback({ runId, tabId, settings, transcriptPayload });
    throwIfRunCancelled(runId);
    if (transcriptPayload.source !== "audio_asr" && settings.requireAsrWhenNoSubtitle !== false) {
      const reason = asrAttempt?.error || "ASR 未返回可用文本。";
      throw new Error(`当前视频无可用字幕，且音频转写未成功。已按强制 ASR 策略终止任务：${reason}`);
    }
  }

  if (transcriptPayload.source === "subtitle") {
    const langLabel =
      transcriptPayload?.subtitleSelectionMeta?.langDoc ||
      transcriptPayload?.subtitleSelectionMeta?.lang ||
      transcriptPayload?.subtitleLang ||
      "\u672a\u77e5\u8bed\u8a00";
    const candidateCount = Number(transcriptPayload?.subtitleSelectionMeta?.candidateCount || 0);
    sendProgress({
      runId,
      stage: "extract",
      level: "success",
      message: `字幕提取完成（${langLabel}，候选 ${candidateCount}），共 ${transcriptPayload.segments?.length || 0} 个片段。`
    });
  } else if (transcriptPayload.source === "audio_asr") {
    sendProgress({
      runId,
      stage: "extract",
      level: "success",
      message: "音频转文字完成，已使用 ASR 文本继续流程。"
    });
  } else {
    sendProgress({
      runId,
      stage: "extract",
      level: "warning",
      message:
        settings.requireAsrWhenNoSubtitle !== false
          ? "当前视频无可用字幕，且已启用强制 ASR；请先修复 ASR 后重试。"
          : "当前视频无可用字幕，已回退使用视频简介作为文本来源。"
    });
  }

  const videoIdentity = buildVideoIdentityText(transcriptPayload?.video || {});
  if (videoIdentity) {
    sendProgress({
      runId,
      stage: "extract",
      level: "info",
      message: `已锁定视频：${videoIdentity}`
    });
  }

  sendProgress({ runId, stage: "style", level: "info", message: "正在匹配你的历史笔记风格..." });
  const styleContext = await buildStyleContext(settings, transcriptPayload.transcriptText);
  throwIfRunCancelled(runId);

  sendProgress({ runId, stage: "summarize", level: "info", message: "正在生成结构化笔记..." });
  let noteMarkdown = "";
  let noteMeta = null;
  const summarizeStartedAt = Date.now();
  const summarizeHeartbeat = setInterval(() => {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - summarizeStartedAt) / 1000));
    sendProgress({
      runId,
      stage: "summarize",
      level: "info",
      message: `结构化笔记生成中（已等待 ${elapsedSec} 秒）...`
    });
  }, NOTE_PROGRESS_HEARTBEAT_MS);
  try {
    const generationResult = await promiseWithTimeout(
      generateBestNoteMarkdown({
        runId,
        settings,
        transcriptPayload,
        styleContext
      }),
      NOTE_STAGE_TIMEOUT_MS,
      `结构化笔记生成超时（>${Math.floor(NOTE_STAGE_TIMEOUT_MS / 60000)} 分钟），请重试或更换模型。`
    );
    noteMarkdown = generationResult?.markdown || "";
    noteMeta = generationResult?.meta || null;
    const quality = generationResult?.quality || assessGeneratedNote(noteMarkdown, transcriptPayload, settings);
    throwIfRunCancelled(runId);

    if (!quality.ok) {
      throw new Error(`模型返回笔记质量不足：${quality.reason}`);
    }

    const plainLength = getMarkdownPlainLength(noteMarkdown);
    const usageText = formatUsageText(noteMeta?.usage);
    const modelText = noteMeta?.responseModel ? `，模型 ${noteMeta.responseModel}` : "";
    const usageSuffix = usageText ? `，${usageText}` : "";
    const bestSuffix = generationResult?.usedBest ? "，已自动采用最优候选版本" : "";
    sendProgress({
      runId,
      stage: "summarize",
      level: "success",
      message: `笔记生成完成（Markdown ${noteMarkdown.length} 字符，正文约 ${plainLength} 字${modelText}${usageSuffix}${bestSuffix}）。`
    });
  } catch (error) {
    if (isRunCancelledError(error) || isRunCancelled(runId)) {
      throw error;
    }
    sendProgress({
      runId,
      stage: "summarize",
      level: "warning",
      message: `模型生成未达预期，已切换应急草稿模式：${formatError(error)}`
    });
    noteMarkdown = buildEmergencyNoteMarkdown(transcriptPayload, formatError(error));
  } finally {
    clearInterval(summarizeHeartbeat);
  }

  let importResult = null;
  if (settings.autoImportToFeishu) {
    throwIfRunCancelled(runId);
    sendProgress({ runId, stage: "feishu", level: "info", message: "正在导入飞书知识库..." });
    try {
      importResult = await importToFeishuKnowledgeBase({
        runId,
        settings,
        transcriptPayload,
        noteMarkdown
      });
      throwIfRunCancelled(runId);
      if (importResult?.ok) {
        sendProgress({ runId, stage: "feishu", level: "success", message: "飞书知识库导入完成。" });
      } else {
        sendProgress({
          runId,
          stage: "feishu",
          level: "warning",
          message: `飞书文档已创建，但挂载知识库失败：${importResult?.wikiError || "未知错误"}`
        });
      }
    } catch (error) {
      importResult = { ok: false, error: formatError(error) };
      sendProgress({
        runId,
        stage: "feishu",
        level: "warning",
        message: `飞书导入失败，已保留本次笔记：${formatError(error)}`
      });
    }
  } else {
    sendProgress({ runId, stage: "feishu", level: "warning", message: "已关闭自动导入飞书。" });
  }

  const pipelineResult = {
    runId,
    ok: true,
    createdAt: new Date().toISOString(),
    transcriptPayload,
    noteMarkdown,
    noteMeta,
    importResult
  };

  throwIfRunCancelled(runId);
  await storageSet({ [RUN_STATE_KEY]: pipelineResult });
  sendFinished(pipelineResult);
}

async function getPipelineRuntimeState() {
  for (const [tabId, runId] of RUNNING_BY_TAB.entries()) {
    if (!ACTIVE_RUNS.has(String(runId || ""))) {
      RUNNING_BY_TAB.delete(tabId);
    }
  }

  const activeRuns = Array.from(ACTIVE_RUNS.values())
    .filter((item) => item && !item.cancelled)
    .map((item) => ({
      runId: item.runId,
      tabId: item.tabId,
      startedAt: item.startedAt || ""
    }))
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));

  const runningByTab = Array.from(RUNNING_BY_TAB.entries()).map(([tabId, runId]) => ({
    tabId: Number(tabId),
    runId: String(runId || "")
  }));

  return {
    activeRuns,
    runningByTab,
    now: new Date().toISOString()
  };
}

async function forceStopPipeline({ runId, tabId, reason }) {
  const stopReason = String(reason || "任务已被手动强制终止。").trim() || "任务已被手动强制终止。";
  let targetRunId = resolveRunIdForStop({ runId, tabId });

  if (!targetRunId) {
    const history = await getRunHistory(6);
    const running = history.find((item) => item?.status === "running" && item?.runId);
    targetRunId = String(running?.runId || "");
  }

  if (!targetRunId) {
    return {
      stopped: false,
      runId: "",
      active: false,
      message: "未检测到可终止的任务。"
    };
  }

  const context = ACTIVE_RUNS.get(targetRunId);
  if (context) {
    context.cancelled = true;
    context.cancelReason = stopReason;
    if (Number.isFinite(Number(context.tabId)) && RUNNING_BY_TAB.get(Number(context.tabId)) === targetRunId) {
      RUNNING_BY_TAB.delete(Number(context.tabId));
    }

    if (!context.finalized) {
      context.finalized = true;
      sendProgress(
        {
          runId: targetRunId,
          stage: "cancel",
          level: "warning",
          message: stopReason
        },
        { allowCancelled: true }
      );
      sendFinished(
        {
          runId: targetRunId,
          ok: false,
          error: stopReason,
          cancelled: true,
          createdAt: new Date().toISOString()
        },
        { allowCancelled: true }
      );
    }

    return {
      stopped: true,
      runId: targetRunId,
      active: true,
      message: stopReason
    };
  }

  for (const [mappedTabId, mappedRunId] of RUNNING_BY_TAB.entries()) {
    if (String(mappedRunId || "") === targetRunId) {
      RUNNING_BY_TAB.delete(mappedTabId);
    }
  }

  const marked = await markRunAsForceStoppedInHistory(targetRunId, stopReason);
  return {
    stopped: marked,
    runId: targetRunId,
    active: false,
    message: marked ? stopReason : "未找到可终止的运行记录。"
  };
}

function resolveRunIdForStop({ runId, tabId }) {
  const directRunId = String(runId || "").trim();
  if (directRunId) {
    return directRunId;
  }

  const normalizedTabId = Number(tabId);
  if (Number.isFinite(normalizedTabId)) {
    const byTab = String(RUNNING_BY_TAB.get(normalizedTabId) || "").trim();
    if (byTab) {
      return byTab;
    }
  }

  if (ACTIVE_RUNS.size === 1) {
    return Array.from(ACTIVE_RUNS.keys())[0];
  }
  return "";
}

function cleanupRunState(runId, fallbackTabId) {
  const key = String(runId || "").trim();
  if (!key) {
    return;
  }

  const context = ACTIVE_RUNS.get(key);
  ACTIVE_RUNS.delete(key);

  const tabId = Number.isFinite(Number(fallbackTabId))
    ? Number(fallbackTabId)
    : Number.isFinite(Number(context?.tabId))
    ? Number(context.tabId)
    : NaN;
  if (Number.isFinite(tabId) && RUNNING_BY_TAB.get(tabId) === key) {
    RUNNING_BY_TAB.delete(tabId);
  }
}

function getRunContext(runId) {
  const key = String(runId || "").trim();
  if (!key) {
    return null;
  }
  return ACTIVE_RUNS.get(key) || null;
}

function isRunCancelled(runId) {
  const context = getRunContext(runId);
  return Boolean(context?.cancelled);
}

function throwIfRunCancelled(runId) {
  const context = getRunContext(runId);
  if (!context?.cancelled) {
    return;
  }
  const error = new Error(context.cancelReason || "任务已被手动强制终止。");
  error.name = RUN_CANCELLED_NAME;
  throw error;
}

function isRunCancelledError(error) {
  if (!error) {
    return false;
  }
  if (error.name === RUN_CANCELLED_NAME) {
    return true;
  }
  return String(error.message || "").includes("强制终止");
}

async function markRunAsForceStoppedInHistory(runId, reason) {
  const targetRunId = String(runId || "").trim();
  if (!targetRunId) {
    return false;
  }

  let updated = false;
  runLogPersistQueue = runLogPersistQueue
    .then(async () => {
      const stored = await storageGet(RUN_LOG_HISTORY_KEY);
      const history = Array.isArray(stored?.[RUN_LOG_HISTORY_KEY]) ? [...stored[RUN_LOG_HISTORY_KEY]] : [];
      let entry = history.find((item) => item?.runId === targetRunId);

      if (!entry) {
        entry = {
          runId: targetRunId,
          startedAt: new Date().toISOString(),
          status: "running",
          logs: []
        };
        history.unshift(entry);
      }

      if (!Array.isArray(entry.logs)) {
        entry.logs = [];
      }

      const now = new Date().toISOString();
      entry.logs.push({
        timestamp: now,
        stage: "cancel",
        level: "warning",
        message: String(reason || "任务已被手动强制终止。")
      });

      entry.status = "failed";
      entry.finishedAt = now;
      entry.result = {
        ok: false,
        error: String(reason || "任务已被手动强制终止。"),
        cancelled: true,
        createdAt: now,
        importResult: entry?.result?.importResult || null
      };

      if (entry.logs.length > RUN_LOG_LINE_LIMIT) {
        entry.logs = entry.logs.slice(-RUN_LOG_LINE_LIMIT);
      }

      history.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
      const trimmed = history.slice(0, RUN_LOG_HISTORY_LIMIT);
      await storageSet({ [RUN_LOG_HISTORY_KEY]: trimmed });
      updated = true;
    })
    .catch((error) => {
      console.warn("markRunAsForceStoppedInHistory failed:", error);
    });

  await runLogPersistQueue;
  return updated;
}

async function tryAsrFallback({ runId, tabId, settings, transcriptPayload }) {
  if (!settings.enableAsrFallback) {
    return { attempted: false, ok: false, error: "ASR 兜底已关闭。" };
  }

  const auth = resolveAsrAuth(settings);
  if (!auth.baseUrl) {
    const message = "未配置 ASR Base URL，无法执行音频转文字。";
    sendProgress({
      runId,
      stage: "extract",
      level: "warning",
      message
    });
    return { attempted: false, ok: false, error: message };
  }
  if (!auth.apiKey && !isLocalAsrBaseUrl(auth.baseUrl)) {
    const message = "ASR 为非本地地址但未配置 API Key，无法执行音频转文字。";
    sendProgress({
      runId,
      stage: "extract",
      level: "warning",
      message
    });
    return { attempted: false, ok: false, error: message };
  }

  const asrCapability = await getAsrTranscriptionCapability(auth, settings.asrModel || "whisper-1");
  if (!asrCapability.supported) {
    const message = asrCapability.message || "当前 ASR 服务不支持音频转写接口。";
    sendProgress({
      runId,
      stage: "extract",
      level: "warning",
      message
    });
    return { attempted: true, ok: false, error: message };
  }

  const candidates = buildAudioCandidates(transcriptPayload);
  const plannedCandidates = Math.min(
    candidates.length,
    Math.min(Math.max(2, Number(settings?.asrMaxCandidates || 6)), ASR_CANDIDATE_MAX_HARD)
  );
  if (candidates.length === 0) {
    const message = "未获取到可下载音频地址，无法执行音频转文字。";
    sendProgress({
      runId,
      stage: "extract",
      level: "warning",
      message
    });
    return { attempted: true, ok: false, error: message };
  }

  sendProgress({
    runId,
    stage: "extract",
    level: "info",
    message: `无字幕，正在尝试音频转文字（可用候选 ${plannedCandidates}/${candidates.length}）...`
  });

  try {
    let asrResult = null;
    if (isLocalAsrBaseUrl(auth.baseUrl)) {
      sendProgress({
        runId,
        stage: "extract",
        level: "info",
        message: "检测到本地 ASR，使用服务端下载转写（已禁用浏览器侧回退）..."
      });
      asrResult = await transcribeAudioViaLocalAsrByUrl({
        runId,
        settings,
        auth,
        transcriptPayload,
        candidates
      });
    } else {
      try {
        asrResult = await transcribeAudioFromCandidates({
          runId,
          settings,
          candidates,
          sourcePageUrl: transcriptPayload.video?.url || "https://www.bilibili.com/",
          sourceDurationSec: Number(transcriptPayload?.video?.duration || 0),
          auth
        });
      } catch (error) {
        const reason = formatError(error);
        if (tabId && shouldTryPageAsrFallback(reason)) {
          sendProgress({
            runId,
            stage: "extract",
            level: "info",
            message: "后台拉取音频失败，正在切换页面内转写模式..."
          });
          asrResult = await transcribeAudioViaContentScript({
            runId,
            tabId,
            candidates,
            settings,
            sourceDurationSec: Number(transcriptPayload?.video?.duration || 0),
            auth
          });
        } else {
          throw error;
        }
      }
    }

    if (!asrResult?.text) {
      throw new Error("ASR 返回为空。");
    }

    transcriptPayload.source = "audio_asr";
    transcriptPayload.subtitleLang = "zh";
    transcriptPayload.transcriptText = asrResult.text;
    transcriptPayload.segments = Array.isArray(asrResult.segments) ? asrResult.segments : [];
    transcriptPayload.audioTrackUrl = asrResult.usedAudioUrl || transcriptPayload.audioTrackUrl || "";
    transcriptPayload.asrInfo = {
      model: settings.asrModel || "whisper-1",
      truncated: Boolean(asrResult.truncated),
      originalSize: Number(asrResult.originalSize || 0),
      usedAudioUrl: asrResult.usedAudioUrl || "",
      asrBaseUrl: auth.baseUrl,
      segmentCount: transcriptPayload.segments.length,
      mode: asrResult.mode || "background"
    };

    if (asrResult.truncated) {
      sendProgress({
        runId,
        stage: "extract",
        level: "warning",
        message: `音频过长，已按分段转写并截断超出部分（单段 ${settings.asrMaxAudioMB}MB，最多 ${settings.asrMaxChunks || ASR_MAX_CHUNKS} 段）。`
      });
    }
    return { attempted: true, ok: true, mode: asrResult.mode || "background", error: "" };
  } catch (error) {
    const reason = compactAsrErrorReason(formatError(error));
    sendProgress({
      runId,
      stage: "extract",
      level: "warning",
      message:
        settings.requireAsrWhenNoSubtitle !== false
          ? `音频转文字失败：${reason}`
          : `音频转文字失败，回退简介文本：${reason}`
    });
    return { attempted: true, ok: false, error: reason };
  }
}

function shouldTryPageAsrFallback(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("http 403") ||
    text.includes("http 404") ||
    text.includes("failed to fetch") ||
    text.includes("timeout") ||
    text.includes("超时") ||
    text.includes("download") ||
    text.includes("下载内容不是音频") ||
    text.includes("下载音频失败") ||
    text.includes("cors")
  );
}

async function transcribeAudioViaContentScript({ runId, tabId, candidates, settings, sourceDurationSec, auth }) {
  throwIfRunCancelled(runId);
  sendProgress({
    runId,
    stage: "extract",
    level: "info",
    message: `页面内转写进行中（最长 ${Math.ceil(PAGE_ASR_TIMEOUT_MS / 1000)} 秒）...`
  });

  const requestPayload = {
    action: "TRANSCRIBE_AUDIO_IN_PAGE_V2",
    payload: {
      settings,
      candidates,
      sourceDurationSec,
      auth
    }
  };

  const sendToPage = () =>
    promiseWithTimeout(
      chrome.tabs.sendMessage(tabId, requestPayload),
      PAGE_ASR_TIMEOUT_MS,
      "页面内转写超时，请减少候选音频数量后重试。"
    );

  let response = null;
  let firstError = null;
  try {
    throwIfRunCancelled(runId);
    response = await sendToPage();
  } catch (error) {
    firstError = error;
    response = null;
  }

  if (!response?.ok) {
    const firstReason = String(response?.error || formatError(firstError) || "").trim();
    const shouldRetryInject = shouldRetryPageAsrAfterInject(firstReason);
    if (!shouldRetryInject) {
      throw new Error(firstReason || "页面内转写失败。");
    }

    sendProgress({
      runId,
      stage: "extract",
      level: "info",
      message: "检测到页面脚本连接异常，正在重新注入并重试一次..."
    });

    throwIfRunCancelled(runId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
    throwIfRunCancelled(runId);
    try {
      response = await sendToPage();
    } catch (error) {
      throw new Error(formatError(error));
    }
  }

  throwIfRunCancelled(runId);
  if (!response?.ok) {
    throw new Error(response?.error || "页面内转写失败。");
  }
  return response;
}

async function transcribeAudioViaLocalAsrByUrl({ runId, settings, auth, transcriptPayload, candidates }) {
  throwIfRunCancelled(runId);
  const endpoint = `${trimSlash(auth.baseUrl)}/audio/transcriptions_by_url`;
  const candidateList = Array.isArray(candidates) ? candidates.slice(0, 12) : [];
  const payload = {
    video_url: String(transcriptPayload?.video?.url || "").trim(),
    audio_candidates: candidateList,
    model: settings.asrModel || "whisper-1",
    language: "zh",
    response_format: "verbose_json",
    temperature: 0
  };

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    sendProgress({
      runId,
      stage: "extract",
      level: "info",
      message: `本地 ASR 服务端转写进行中（已等待 ${elapsedSec} 秒）...`
    });
  }, LOCAL_ASR_PROGRESS_HEARTBEAT_MS);

  let response = null;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          ...buildAuthHeaders(auth.apiKey),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      LOCAL_ASR_URL_TRANSCRIBE_TIMEOUT_MS
    );
  } finally {
    clearInterval(heartbeat);
  }
  const result = await safeReadJson(response);
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new Error("本地 ASR 服务版本过旧，不支持 /audio/transcriptions_by_url。请更新 local-asr-whisper 到 0.1.3+ 并重启。");
    }
    throw new Error(`本地服务端 URL 转写失败（HTTP ${response.status}）：${extractApiError(result, response.status)}`);
  }

  const text = String(result?.text || result?.data?.text || result?.result?.text || "").trim();
  if (!text) {
    throw new Error("本地服务端 URL 转写返回空文本。");
  }

  const segments = Array.isArray(result?.segments)
    ? result.segments
    : Array.isArray(result?.data?.segments)
    ? result.data.segments
    : Array.isArray(result?.result?.segments)
    ? result.result.segments
    : [];
  const normalizedSegments = normalizeAsrSegments(segments, 0);
  const sourceAudioUrl = String(result?.source?.audio_url || "").trim();
  const sourceMode = String(result?.source?.mode || "url_service").trim();
  const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  sendProgress({
    runId,
    stage: "extract",
    level: "info",
    message: `本地服务端转写完成（来源 ${sourceMode}${sourceAudioUrl ? "，已锁定候选音频" : ""}，耗时 ${elapsedSec} 秒）。`
  });

  return {
    text,
    segments: normalizedSegments,
    truncated: false,
    originalSize: 0,
    usedAudioUrl: sourceAudioUrl || "",
    mode: "local_url_service"
  };
}

function shouldRetryPageAsrAfterInject(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text) {
    return false;
  }

  if (
    text.includes("receiving end does not exist") ||
    text.includes("could not establish connection") ||
    text.includes("message port closed") ||
    text.includes("extension context invalidated") ||
    text.includes("no tab with id") ||
    text.includes("the tab was closed")
  ) {
    return true;
  }

  return false;
}

function resolveAsrAuth(settings) {
  const baseUrl = trimSlash(settings.asrBaseUrl || settings.llmBaseUrl || "");
  const explicitAsrKey = String(settings.asrApiKey || "").trim();
  const llmApiKey = String(settings.llmApiKey || "").trim();
  const apiKey = explicitAsrKey || (!isLocalAsrBaseUrl(baseUrl) ? llmApiKey : "");
  const probeRetries = Math.max(1, Math.min(3, Number(settings?.asrProbeRetries || 2)));
  return { baseUrl, apiKey, probeRetries };
}

async function getAsrTranscriptionCapability(auth, modelName) {
  const baseUrl = trimSlash(auth?.baseUrl || "");
  const apiKey = String(auth?.apiKey || "").trim();
  if (!baseUrl) {
    return { supported: false, message: "ASR 配置不完整（缺少 Base URL）。" };
  }

  const cacheKey = `${baseUrl}::${apiKey.slice(0, 12)}::${modelName || "whisper-1"}`;
  const now = Date.now();
  const cached = asrCapabilityCache.get(cacheKey);
  const cacheTtl = cached?.supported ? ASR_CAPABILITY_SUCCESS_TTL_MS : ASR_CAPABILITY_FAIL_TTL_MS;
  if (cached && now - cached.checkedAt < cacheTtl) {
    return cached;
  }

  const url = `${baseUrl}/audio/transcriptions`;
  const maxProbeRetries = Math.max(1, Math.min(3, Number(auth?.probeRetries || 2)));
  let lastError = null;

  for (let attempt = 0; attempt < maxProbeRetries; attempt += 1) {
    try {
      const form = new FormData();
      form.append("model", modelName || "whisper-1");
      // Use empty payload probe so local Whisper returns 400 quickly without loading model weights.
      form.append("file", new Blob([], { type: "audio/wav" }), "probe.wav");
      form.append("response_format", "json");

      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: buildAuthHeaders(apiKey),
          body: form
        },
        ASR_PROBE_TIMEOUT_MS
      );
      const payload = await safeReadJson(response);
      const result = classifyAsrProbeResponse(response.status, payload, url);
      asrCapabilityCache.set(cacheKey, { ...result, checkedAt: now });
      return { ...result };
    } catch (error) {
      lastError = error;
      if (attempt < maxProbeRetries - 1) {
        await sleep(300 * (attempt + 1));
      }
    }
  }

  const result = {
    supported: false,
    message:
      maybeBuildLocalAsrOfflineMessage(baseUrl, lastError, url, "ASR 转写接口探测失败") ||
      withEndpoint(`ASR 转写接口探测失败：${formatError(lastError)}`, url)
  };
  asrCapabilityCache.set(cacheKey, { ...result, checkedAt: now });
  return result;
}

function classifyAsrProbeResponse(status, payload, url) {
  if (status === 404 || status === 405) {
    return {
      supported: false,
      message: withEndpoint("ASR 转写接口不可用（/audio/transcriptions 返回 404/405）。", url)
    };
  }

  if ([200, 201, 400, 401, 403, 415, 422, 429, 500, 502, 503, 504].includes(status)) {
    return {
      supported: true,
      message: withEndpoint("ASR 转写接口可达。", url)
    };
  }

  if (status >= 200 && status < 500) {
    return {
      supported: true,
      message: withEndpoint(`ASR 转写接口可达（HTTP ${status}）。`, url)
    };
  }

  return {
    supported: false,
    message: withEndpoint(`ASR 转写接口不可用（HTTP ${status}）：${extractApiError(payload, status)}`, url)
  };
}

function buildAudioCandidates(transcriptPayload) {
  const list = [];
  const fromArray = Array.isArray(transcriptPayload?.audioTrackUrls) ? transcriptPayload.audioTrackUrls : [];
  const fromSingle = transcriptPayload?.audioTrackUrl ? [transcriptPayload.audioTrackUrl] : [];

  for (const raw of [...fromArray, ...fromSingle]) {
    const normalized = normalizeUrl(raw);
    if (normalized && !list.includes(normalized)) {
      list.push(normalized);
    }
  }
  return list;
}

async function transcribeAudioFromCandidates({ runId, settings, candidates, sourcePageUrl, sourceDurationSec, auth }) {
  throwIfRunCancelled(runId);
  const errors = [];
  const maxCandidates = Math.min(Math.max(2, Number(settings?.asrMaxCandidates || 6)), ASR_CANDIDATE_MAX_HARD);
  const candidateList = candidates.slice(0, maxCandidates);
  const deadlineAt = Date.now() + ASR_BACKGROUND_TIMEOUT_MS;

  for (let i = 0; i < candidateList.length; i += 1) {
    const audioUrl = candidateList[i];
    throwIfRunCancelled(runId);
    if (Date.now() >= deadlineAt - 1200) {
      break;
    }
    try {
      sendProgress({
        runId,
        stage: "extract",
        level: "info",
        message: `ASR 候选 ${i + 1}/${candidateList.length}：正在下载音频并提交转写...`
      });

      const blobInfo = await downloadAudioBlob(audioUrl, sourcePageUrl, deadlineAt);
      const transcription = await transcribeBlob({
        runId,
        settings,
        auth,
        audioBlob: blobInfo.blob,
        audioUrl,
        sourceDurationSec,
        deadlineAt,
        candidateIndex: i + 1,
        candidateCount: candidateList.length
      });
      return {
        ...transcription,
        usedAudioUrl: audioUrl
      };
    } catch (error) {
      errors.push(`${audioUrl} => ${formatError(error)}`);
    }
  }

  const timeoutHint =
    Date.now() >= deadlineAt - 1200 ? "后台 ASR 尝试超时，请稍后重试或切换页面内转写。" : "所有音频候选地址均失败。";
  throw new Error(`${timeoutHint}${errors.length ? ` ${errors.slice(0, 2).join(" | ")}` : ""}`);
}

async function downloadAudioBlob(audioUrl, sourcePageUrl, deadlineAt = 0) {
  const referrers = [];
  if (sourcePageUrl && sourcePageUrl.startsWith("http")) {
    referrers.push(sourcePageUrl);
  }
  referrers.push("https://www.bilibili.com/");
  referrers.push("");

  let lastError = null;

  for (const referrer of referrers) {
    if (deadlineAt && Date.now() >= deadlineAt - 1200) {
      throw new Error("下载音频失败：后台 ASR 尝试超时。");
    }
    try {
      const remainMs = deadlineAt ? deadlineAt - Date.now() : 20000;
      if (deadlineAt && remainMs <= 1200) {
        throw new Error("下载音频失败：后台 ASR 尝试超时。");
      }
      const timeoutMs = Math.max(4000, Math.min(20000, remainMs - 400));
      const response = await fetchWithTimeout(
        audioUrl,
        {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          referrer: referrer || undefined,
          referrerPolicy: "origin-when-cross-origin"
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
        lastError = new Error("下载音频失败：内容为空。");
        continue;
      }
      if (blob.size < 1024) {
        lastError = new Error("下载音频失败：文件过小，疑似无效响应。");
        continue;
      }

      const blobCheck = await inspectAudioBlob(blob, contentType);
      if (!blobCheck.ok) {
        lastError = new Error(`下载音频失败：${blobCheck.reason}`);
        continue;
      }

      return { blob };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("下载音频失败。");
}

async function transcribeBlob({
  runId,
  settings,
  auth,
  audioBlob,
  audioUrl,
  sourceDurationSec,
  deadlineAt,
  candidateIndex,
  candidateCount
}) {
  throwIfRunCancelled(runId);
  const maxMB = Math.max(1, Number(settings.asrMaxAudioMB || 24));
  const maxBytes = Math.floor(maxMB * 1024 * 1024);

  const originalSize = audioBlob.size;
  const maxChunkCount = Math.max(1, Math.min(12, Number(settings.asrMaxChunks || ASR_MAX_CHUNKS)));
  const chunkBlobs = splitAudioBlobIntoChunks(audioBlob, maxBytes, maxChunkCount);
  const textParts = [];
  const mergedSegments = [];
  let anyTruncated = chunkBlobs.truncated;

  sendProgress({
    runId,
    stage: "extract",
    level: "info",
    message: `ASR 候选 ${candidateIndex}/${candidateCount}：音频 ${(originalSize / 1024 / 1024).toFixed(1)}MB，分段 ${chunkBlobs.chunks.length}。`
  });

  for (let i = 0; i < chunkBlobs.chunks.length; i += 1) {
    throwIfRunCancelled(runId);
    if (deadlineAt && Date.now() >= deadlineAt - 1200) {
      throw new Error("音频转写失败：后台 ASR 尝试超时。");
    }
    const chunkInfo = chunkBlobs.chunks[i];
    sendProgress({
      runId,
      stage: "extract",
      level: "info",
      message: `ASR 候选 ${candidateIndex}/${candidateCount}：转写分段 ${i + 1}/${chunkBlobs.chunks.length}...`
    });
    const chunkResult = await transcribeBlobChunk({
      runId,
      settings,
      auth,
      audioBlob: chunkInfo.blob,
      audioUrl,
      chunkIndex: i,
      chunkCount: chunkBlobs.chunks.length,
      deadlineAt
    });
    if (chunkResult.text) {
      textParts.push(chunkResult.text);
    }

    const chunkOffsetSec =
      sourceDurationSec > 0 && originalSize > 0 ? (Number(sourceDurationSec) * chunkInfo.startByte) / originalSize : 0;
    const normalizedSegments = normalizeAsrSegments(chunkResult.segments, chunkOffsetSec);
    if (normalizedSegments.length) {
      mergedSegments.push(...normalizedSegments);
    }
  }

  const text = textParts.join("\n").trim();
  if (!text) {
    throw new Error("音频转写失败：响应中未返回 text 字段。");
  }

  return { text, segments: mergedSegments, truncated: anyTruncated, originalSize };
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

  const truncated = audioBlob.size > maxBytes * maxChunkCount;
  return { chunks, truncated };
}

async function transcribeBlobChunk({ runId, settings, auth, audioBlob, audioUrl, chunkIndex, chunkCount, deadlineAt = 0 }) {
  throwIfRunCancelled(runId);
  const form = new FormData();
  form.append("model", settings.asrModel || "whisper-1");
  form.append("language", "zh");
  form.append("response_format", "verbose_json");
  form.append("file", audioBlob, inferAudioFilename(audioUrl, audioBlob.type));

  const url = `${trimSlash(auth.baseUrl)}/audio/transcriptions`;
  const remainMs = deadlineAt ? deadlineAt - Date.now() : 60000;
  if (remainMs <= 1200) {
    throw new Error("音频转写失败：后台 ASR 尝试超时。");
  }
  const timeoutMs = Math.max(4000, Math.min(60000, remainMs - 400));
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: buildAuthHeaders(auth.apiKey),
      body: form
    },
    timeoutMs
  );

  const payload = await safeReadJson(response);
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

async function buildStyleContext(settings, transcriptText) {
  if (!settings.enableStyleLearning || !Array.isArray(settings.styleSamples) || settings.styleSamples.length === 0) {
    return { styleProfile: null, topSamples: [] };
  }

  let styleProfile = settings.styleProfile;
  if (!styleProfile && settings.styleSamples.length >= 2) {
    try {
      styleProfile = await generateStyleProfile(settings, settings.styleSamples);
      await saveSettings({ styleProfile });
    } catch (error) {
      console.warn("鑷姩鐢熸垚椋庢牸鐢诲儚澶辫触:", error);
    }
  }

  const topSamples = selectTopSamplesBySimilarity(settings.styleSamples, transcriptText, 3);
  return { styleProfile, topSamples };
}

function getTranscriptSourceHint(transcriptPayload) {
  return transcriptPayload.source === "description_fallback"
    ? "注意：本次文本来自视频简介，而非字幕或转写，请在笔记中标注信息局限。"
    : transcriptPayload.source === "audio_asr"
    ? "注意：本次文本来自音频自动转写，可能存在同音字误差。"
    : "本次文本来自字幕。";
}

function getNoteDepthStrategy(noteDepth, transcriptPayload) {
  const depth = String(noteDepth || "standard");
  const transcriptLength = getMarkdownPlainLength(transcriptPayload?.transcriptText || "");
  const baseMap = {
    short: { label: "简版", minChars: 480, maxTokens: 1400, transcriptChars: 12000 },
    standard: { label: "标准", minChars: 900, maxTokens: 2200, transcriptChars: 22000 },
    deep: { label: "深度", minChars: 1400, maxTokens: 3200, transcriptChars: 32000 }
  };
  const picked = baseMap[depth] || baseMap.standard;
  const lengthBoost = transcriptLength > 20000 ? 300 : transcriptLength > 12000 ? 180 : 0;
  return {
    label: picked.label,
    minChars: picked.minChars + lengthBoost,
    maxTokens: picked.maxTokens,
    transcriptChars: picked.transcriptChars
  };
}

function buildVideoIdentityText(video) {
  if (!video || typeof video !== "object") {
    return "";
  }
  const title = String(video.title || "").trim();
  const bvid = String(video.bvid || "").trim();
  const cid = String(video.cid || "").trim();
  const owner = String(video.owner || "").trim();
  const pageTitle = String(video.pageTitle || "").trim();
  const parts = [title || "无标题"];
  if (owner) {
    parts.push(`UP: ${owner}`);
  }
  if (bvid) {
    parts.push(`BV: ${bvid}`);
  }
  if (cid) {
    parts.push(`CID: ${cid}`);
  }
  if (pageTitle) {
    parts.push(`分P: ${pageTitle}`);
  }
  return parts.join(" | ");
}

function selectRepresentativeTranscriptLines(lines, targetCount) {
  const source = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (source.length <= targetCount) {
    return source;
  }

  const safeTarget = Math.max(40, Math.min(targetCount, source.length));
  const headCount = Math.max(12, Math.floor(safeTarget * 0.35));
  const tailCount = Math.max(12, Math.floor(safeTarget * 0.25));
  const middleCount = Math.max(0, safeTarget - headCount - tailCount);

  const head = source.slice(0, headCount);
  const tail = source.slice(Math.max(headCount, source.length - tailCount));
  const middleStart = headCount;
  const middleEnd = Math.max(middleStart, source.length - tailCount);
  const middlePool = source.slice(middleStart, middleEnd);
  const middle = [];

  if (middleCount > 0 && middlePool.length > 0) {
    const step = middlePool.length / middleCount;
    for (let i = 0; i < middleCount; i += 1) {
      const index = Math.min(middlePool.length - 1, Math.floor(i * step));
      middle.push(middlePool[index]);
    }
  }

  return [...head, ...middle, ...tail];
}

function buildTranscriptPromptContext(transcriptPayload, maxChars = 22000) {
  const segments = Array.isArray(transcriptPayload?.segments) ? transcriptPayload.segments : [];
  if (segments.length > 0) {
    const lines = segments
      .map((segment) => {
        const text = String(segment?.content || "").trim();
        if (!text) {
          return "";
        }
        const from = formatSecondsToClock(segment?.from || 0);
        return `[${from}] ${text}`;
      })
      .filter(Boolean);

    if (lines.length > 0) {
      const sample = lines.slice(0, Math.min(40, lines.length));
      const avgLen = sample.reduce((sum, line) => sum + line.length, 0) / sample.length;
      const targetCount = Math.max(80, Math.min(420, Math.floor(maxChars / Math.max(24, Math.floor(avgLen || 32)))));
      const selected = selectRepresentativeTranscriptLines(lines, targetCount);
      return safeSlice(selected.join("\n"), maxChars);
    }
  }
  return safeSlice(String(transcriptPayload?.transcriptText || "").trim(), maxChars);
}

function buildTranscriptAnchors(transcriptPayload, count = 8) {
  const context = buildTranscriptPromptContext(transcriptPayload, 2800);
  const lines = String(context || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= count) {
    return lines;
  }
  const picked = [];
  const step = (lines.length - 1) / Math.max(1, count - 1);
  for (let i = 0; i < count; i += 1) {
    const idx = Math.min(lines.length - 1, Math.floor(i * step));
    picked.push(lines[idx]);
  }
  return picked;
}

function buildStyleHints(styleContext) {
  const profileText = styleContext?.styleProfile ? safeSlice(JSON.stringify(styleContext.styleProfile, null, 2), 1200) : "无";
  const samplesText = (styleContext?.topSamples || [])
    .slice(0, 2)
    .map((sample, idx) => {
      const title = String(sample?.title || "无标题").trim();
      const excerpt = safeSlice(String(sample?.content || "").replace(/\s+/g, " ").trim(), 260);
      return `样例${idx + 1}（${title}）：${excerpt}`;
    })
    .join("\n");
  return {
    profileText,
    samplesText: samplesText || "无"
  };
}

function extractSignificantTerms(text, limit = 40) {
  const raw = String(text || "").toLowerCase();
  const matches = raw.match(/[\u4e00-\u9fa5]{2,8}|[a-z0-9][a-z0-9_-]{3,}/g) || [];
  const stopwords = new Set([
    "这个",
    "那个",
    "我们",
    "你们",
    "他们",
    "她们",
    "自己",
    "就是",
    "然后",
    "因为",
    "所以",
    "但是",
    "如果",
    "已经",
    "可以",
    "进行",
    "通过",
    "以及",
    "内容",
    "视频",
    "字幕",
    "转写",
    "学习",
    "笔记",
    "今天",
    "一个"
  ]);

  const freq = new Map();
  for (const token of matches) {
    const normalized = token.trim();
    if (!normalized || normalized.length < 2) {
      continue;
    }
    if (/^\d+$/.test(normalized)) {
      continue;
    }
    if (stopwords.has(normalized)) {
      continue;
    }
    freq.set(normalized, Number(freq.get(normalized) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, Math.max(8, limit))
    .map((item) => item[0]);
}

function isNoteFactuallyGrounded(markdown, transcriptText) {
  const noteText = String(markdown || "").toLowerCase();
  const transcript = String(transcriptText || "");
  if (!noteText || transcript.length < 200) {
    return true;
  }
  const terms = extractSignificantTerms(transcript, 42);
  if (terms.length < 10) {
    return true;
  }
  const matched = terms.filter((term) => noteText.includes(term)).length;
  const ratio = matched / terms.length;
  return matched >= 3 || ratio >= 0.08;
}

function hasRequiredNoteSections(markdown) {
  const text = String(markdown || "");
  const hasTitle = /(^|\n)#\s*\S+/.test(text);
  if (!hasTitle) {
    return false;
  }
  const required = ["## 核心结论", "## 关键知识点梳理", "## 可执行清单", "## 我的反思与延展"];
  return required.every((marker) => text.includes(marker));
}

function getMarkdownPlainLength(markdown) {
  if (!markdown) {
    return 0;
  }
  return String(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*_~\[\]()|-]/g, " ")
    .replace(/\s+/g, "")
    .length;
}

function assessGeneratedNote(markdown, transcriptPayload, settings) {
  if (!isGeneratedNoteUsable(markdown)) {
    return { ok: false, reason: "内容过短或为空。" };
  }
  if (!hasRequiredNoteSections(markdown)) {
    return { ok: false, reason: "缺少必要章节标题。" };
  }

  const strategy = getNoteDepthStrategy(settings?.noteDepth, transcriptPayload);
  const plainLength = getMarkdownPlainLength(markdown);
  if (plainLength < strategy.minChars) {
    return { ok: false, reason: `正文长度不足（${plainLength}/${strategy.minChars}）。` };
  }

  if (!isNoteFactuallyGrounded(markdown, transcriptPayload?.transcriptText || "")) {
    return { ok: false, reason: "与原始转录关键词重合度过低，疑似偏题。" };
  }

  return { ok: true, reason: "", plainLength, minChars: strategy.minChars };
}

function scoreGeneratedNoteQuality(markdown, transcriptPayload, settings) {
  if (!isGeneratedNoteUsable(markdown)) {
    return -100;
  }

  const strategy = getNoteDepthStrategy(settings?.noteDepth, transcriptPayload);
  const plainLength = getMarkdownPlainLength(markdown);
  const hasSections = hasRequiredNoteSections(markdown);
  const grounded = isNoteFactuallyGrounded(markdown, transcriptPayload?.transcriptText || "");
  const hasTimestamps = /\[[0-9]{2}:[0-9]{2}(?::[0-9]{2})?\]/.test(String(markdown || ""));

  let score = 0;
  score += Math.min(1.15, plainLength / Math.max(1, strategy.minChars)) * 40;
  score += hasSections ? 25 : 0;
  score += grounded ? 25 : 0;
  score += hasTimestamps ? 10 : 0;
  return Math.round(score);
}

async function buildTranscriptEvidenceDigest({ settings, transcriptPayload }) {
  const strategy = getNoteDepthStrategy(settings.noteDepth, transcriptPayload);
  const transcriptPreview = buildTranscriptPromptContext(
    transcriptPayload,
    Math.min(34000, Math.max(strategy.transcriptChars + 6000, 18000))
  );
  const anchors = buildTranscriptAnchors(transcriptPayload, 14);

  const messages = [
    {
      role: "system",
      content: [
        "你是中文信息抽取助手。",
        "只可基于给定视频文本提取事实，不可发挥，不可引入外部知识。",
        "仅输出合法 JSON，不要解释。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "请输出 JSON，结构如下：",
        "{",
        '  "topic": "视频主题一句话",',
        '  "core_points": [{"point":"要点","anchor":"[mm:ss]","evidence":"原句或近似原句"}],',
        '  "action_items": ["可执行动作1"],',
        '  "keywords": ["关键词1"]',
        "}",
        "",
        "要求：",
        "1) core_points 至少 10 条，最多 18 条。",
        "2) anchor 必须使用文本中出现过的时间戳格式。",
        "3) evidence 必须贴近原文，不得虚构。",
        "",
        "视频身份：",
        JSON.stringify(transcriptPayload.video || {}, null, 2),
        "",
        "已抽取时间锚点：",
        ...(anchors.length ? anchors.map((item, idx) => `${idx + 1}. ${item}`) : ["无"]),
        "",
        "视频文本（抽样）：",
        transcriptPreview
      ].join("\n")
    }
  ];

  const response = await callChatCompletionWithMeta({
    settings,
    messages,
    temperature: 0,
    maxTokens: 1600
  });

  const parsed = parseJsonSafely(response.content || "");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("事实摘要解析失败：模型未返回合法 JSON。");
  }

  const points = Array.isArray(parsed.core_points) ? parsed.core_points : [];
  const actionItems = Array.isArray(parsed.action_items) ? parsed.action_items : [];
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  if (points.length === 0) {
    throw new Error("事实摘要解析失败：未提取到核心要点。");
  }

  const pointLines = points
    .slice(0, 18)
    .map((item, idx) => {
      const point = String(item?.point || "").trim();
      const anchor = String(item?.anchor || "").trim();
      const evidence = String(item?.evidence || "").trim();
      if (!point) {
        return "";
      }
      const anchorText = anchor || "[未标注时间]";
      return `${idx + 1}. ${point} ${anchorText}${evidence ? ` | 证据：${safeSlice(evidence, 80)}` : ""}`;
    })
    .filter(Boolean);

  const actionLines = actionItems
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((item) => `- ${item}`);

  const keywordLine = keywords
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 18)
    .join(" / ");

  const digestText = [
    `主题：${String(parsed.topic || "").trim() || "未提取"}`,
    "核心事实：",
    ...pointLines,
    actionLines.length ? "行动建议：" : "",
    ...actionLines,
    keywordLine ? `关键词：${keywordLine}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return {
    digestText,
    meta: {
      responseModel: response.responseModel || "",
      usage: response.usage || null
    }
  };
}

async function generateBestNoteMarkdown({ runId, settings, transcriptPayload, styleContext }) {
  let evidenceDigest = "";
  try {
    sendProgress({
      runId,
      stage: "summarize",
      level: "info",
      message: "正在抽取事实要点（阶段 1/2）..."
    });
    const evidenceResult = await buildTranscriptEvidenceDigest({ settings, transcriptPayload });
    evidenceDigest = String(evidenceResult?.digestText || "").trim();
    sendProgress({
      runId,
      stage: "summarize",
      level: "info",
      message: `事实要点提取完成（约 ${evidenceDigest.length} 字），正在生成笔记（阶段 2/2）...`
    });
  } catch (error) {
    sendProgress({
      runId,
      stage: "summarize",
      level: "warning",
      message: `事实要点提取失败，回退单阶段生成：${formatError(error)}`
    });
  }

  let noteResult = await generateNoteMarkdown({ settings, transcriptPayload, styleContext, evidenceDigest });
  let noteMarkdown = noteResult?.markdown || "";
  let noteMeta = noteResult?.meta || null;
  let quality = assessGeneratedNote(noteMarkdown, transcriptPayload, settings);
  let best = {
    markdown: noteMarkdown,
    meta: noteMeta,
    quality,
    score: scoreGeneratedNoteQuality(noteMarkdown, transcriptPayload, settings)
  };

  for (let round = 0; round < NOTE_REWRITE_MAX_ROUNDS && !quality.ok; round += 1) {
    sendProgress({
      runId,
      stage: "summarize",
      level: "warning",
      message: `笔记质量不足（${quality.reason}），正在执行第 ${round + 1}/${NOTE_REWRITE_MAX_ROUNDS} 轮重写...`
    });
    noteResult = await generateNoteMarkdownQualityRewrite({
      settings,
      transcriptPayload,
      styleContext,
      previousMarkdown: noteMarkdown,
      qualityReason: quality.reason,
      evidenceDigest,
      round: round + 1
    });
    noteMarkdown = noteResult?.markdown || "";
    noteMeta = noteResult?.meta || noteMeta;
    quality = assessGeneratedNote(noteMarkdown, transcriptPayload, settings);
    const score = scoreGeneratedNoteQuality(noteMarkdown, transcriptPayload, settings);
    if (score > best.score) {
      best = {
        markdown: noteMarkdown,
        meta: noteMeta,
        quality,
        score
      };
    }
  }

  if (quality.ok) {
    return {
      markdown: noteMarkdown,
      meta: noteMeta,
      quality,
      usedBest: false
    };
  }

  if (best.score >= 56 && isGeneratedNoteUsable(best.markdown)) {
    return {
      markdown: best.markdown,
      meta: best.meta,
      quality: { ok: true, reason: `未完全达标，已采用最优候选（score=${best.score}）` },
      usedBest: true
    };
  }

  throw new Error(`模型返回笔记质量不足：${quality.reason}`);
}

async function generateNoteMarkdown({ settings, transcriptPayload, styleContext, evidenceDigest = "" }) {
  if (!settings.llmApiKey) {
    throw new Error("请先在设置页填写第三方模型 API Key。");
  }

  const strategy = getNoteDepthStrategy(settings.noteDepth, transcriptPayload);
  const transcriptPreview = buildTranscriptPromptContext(transcriptPayload, strategy.transcriptChars);
  const anchors = buildTranscriptAnchors(transcriptPayload, 8);
  const styleHints = buildStyleHints(styleContext);
  const sourceHint = getTranscriptSourceHint(transcriptPayload);

  const systemPrompt = [
    "你是一名资深中文学习笔记编辑。",
    "只允许基于“视频信息”和“视频文本”生成内容。",
    "历史风格样例只能影响语气和排版，不能借用其中事实、观点、案例或人物。"
  ].join("\n");

  const userPrompt = [
    `请基于以下视频文本生成${strategy.label}学习笔记。`,
    "",
    "硬性要求：",
    "1) 使用 Markdown，且仅输出最终 Markdown。",
    "2) 必须包含以下章节（标题名称保持一致）：",
    "- # 标题",
    "- ## 核心结论",
    "- ## 关键知识点梳理",
    "- ## 可执行清单",
    "- ## 时间点索引（如果有时间戳）",
    "- ## 我的反思与延展",
    `3) 正文（去掉 Markdown 符号后）不少于 ${strategy.minChars} 字。`,
    "4) 语言精炼、结论先行，避免空话与模板化套话。",
    "5) 不得引用风格样例中的事实，不得编造视频文本中未出现的细节。",
    "6) 每个二级章节至少包含 1 个来自原文的时间锚点（如 [02:31]），且锚点必须与叙述一致。",
    "7) 在“关键知识点梳理”章节中，至少列出 6 条带时间锚点的事实要点。",
    "",
    "来源约束：",
    sourceHint,
    "",
    "视频身份：",
    JSON.stringify(transcriptPayload.video || {}, null, 2),
    "",
    "事实锚点（必须围绕这些内容展开，不得偏题）：",
    ...(anchors.length ? anchors.map((item, idx) => `${idx + 1}. ${item}`) : ["无"]),
    "",
    "事实摘要（优先依据以下要点展开）：",
    evidenceDigest || "无",
    "",
    "风格画像（仅用于语气与结构，不得借用事实）：",
    styleHints.profileText,
    "",
    "历史风格样例（仅学习表达方式）：",
    styleHints.samplesText,
    "",
    "视频文本（抽样）：",
    transcriptPreview
  ].join("\n");

  const response = await callChatCompletionWithMeta({
    settings,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.2,
    maxTokens: strategy.maxTokens
  });

  return {
    markdown: String(response.content || "").trim(),
    meta: {
      responseModel: response.responseModel || "",
      usage: response.usage || null
    }
  };
}

async function generateNoteMarkdownQualityRewrite({
  settings,
  transcriptPayload,
  styleContext,
  previousMarkdown,
  qualityReason,
  evidenceDigest,
  round
}) {
  const strategy = getNoteDepthStrategy(settings.noteDepth, transcriptPayload);
  const targetMinChars = strategy.minChars + 200;
  const transcriptPreview = buildTranscriptPromptContext(transcriptPayload, Math.max(strategy.transcriptChars, 26000));
  const anchors = buildTranscriptAnchors(transcriptPayload, 10);
  const styleHints = buildStyleHints(styleContext);
  const sourceHint = getTranscriptSourceHint(transcriptPayload);

  const messages = [
    {
      role: "system",
      content: [
        "你是一名资深中文编辑，擅长在不改变事实的前提下重写笔记。",
        "必须严格基于视频文本，禁止引入外部信息。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `请对上一版笔记进行第 ${round} 轮高质量重写。`,
        `需要修复的问题：${qualityReason}`,
        "",
        "重写要求：",
        "1) 保持 Markdown 输出，且仅输出最终 Markdown。",
        "2) 保留并完善章节：# 标题 / ## 核心结论 / ## 关键知识点梳理 / ## 可执行清单 / ## 时间点索引（如果有时间戳） / ## 我的反思与延展。",
        `3) 正文不少于 ${targetMinChars} 字，内容要具体，不能空泛。`,
        "4) 历史样例仅可借鉴语气，不得借用其中事实或案例。",
        "5) 每个二级章节至少包含 1 个时间锚点（如 [02:31]）。",
        "6) 在“关键知识点梳理”中至少给出 6 条带时间锚点的事实。",
        "",
        "来源约束：",
        sourceHint,
        "",
        "视频身份：",
        JSON.stringify(transcriptPayload.video || {}, null, 2),
        "",
        "事实锚点：",
        ...(anchors.length ? anchors.map((item, idx) => `${idx + 1}. ${item}`) : ["无"]),
        "",
        "事实摘要（优先依据以下要点展开）：",
        evidenceDigest || "无",
        "",
        "风格画像（仅语气参考）：",
        styleHints.profileText,
        "",
        "历史样例（仅表达方式参考）：",
        styleHints.samplesText,
        "",
        "上一版草稿：",
        safeSlice(String(previousMarkdown || "").trim(), 3600),
        "",
        "视频文本（抽样）：",
        transcriptPreview
      ].join("\n")
    }
  ];

  const response = await callChatCompletionWithMeta({
    settings,
    messages,
    temperature: 0.1,
    maxTokens: Math.min(4200, strategy.maxTokens + 700)
  });

  return {
    markdown: String(response.content || "").trim(),
    meta: {
      responseModel: response.responseModel || "",
      usage: response.usage || null
    }
  };
}

function buildEmergencyNoteMarkdown(transcriptPayload, errorText) {
  const title = transcriptPayload?.video?.title || "视频学习笔记";
  const lines = (transcriptPayload?.transcriptText || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const topLines = lines.slice(0, 12);

  const keyPoints = topLines.map((line) => `- ${line}`).join("\n");
  const checklist = topLines.slice(0, 6).map((line) => `- [ ] ${line}`).join("\n");

  return [
    `# ${title}`,
    "",
    "## 核心结论",
    "- 模型服务暂时不可用，以下为自动整理草稿。",
    `- 错误信息：${safeSlice(errorText, 220)}`,
    "",
    "## 关键知识点梳理",
    keyPoints || "- 暂无可提取内容",
    "",
    "## 可执行清单",
    checklist || "- [ ] 待补充",
    "",
    "## 时间点索引（如果有时间戳）",
    transcriptPayload?.segments?.length ? "- 已有字幕分段，可后续补充时间索引。" : "- 当前无时间戳分段。",
    "",
    "## 我的反思与延展",
    "- 等模型服务恢复后，建议重新生成高质量版本。"
  ].join("\n");
}

async function refreshStyleProfile() {
  const settings = await getSettings();
  if (!settings.llmApiKey) {
    throw new Error("请先填写模型 API Key，再生成风格画像。");
  }
  if (!Array.isArray(settings.styleSamples) || settings.styleSamples.length === 0) {
    throw new Error("请先添加至少一条历史笔记样例。");
  }

  const profile = await generateStyleProfile(settings, settings.styleSamples);
  return saveSettings({ styleProfile: profile });
}

async function generateStyleProfile(settings, styleSamples) {
  const sampleText = styleSamples
    .slice(0, 12)
    .map((sample, idx) => `样例${idx + 1} 标题: ${sample.title || "无标题"}\n内容:\n${safeSlice(sample.content, 1000)}`)
    .join("\n\n");

  const messages = [
    { role: "system", content: "你是一名中文写作风格分析助手。只输出严格 JSON，不要输出额外解释。" },
    {
      role: "user",
      content: [
        "请分析以下中文笔记样例，提炼统一写作风格，并输出 JSON：",
        "{",
        '  "tone": "语气概述",',
        '  "structure_preferences": ["结构偏好1"],',
        '  "wording_preferences": ["措辞偏好1"],',
        '  "do_list": ["应该做什么"],',
        '  "dont_list": ["避免什么"],',
        '  "template": "建议沿用的简短模板"',
        "}",
        "",
        "样例：",
        sampleText
      ].join("\n")
    }
  ];

  const raw = await callChatCompletion({ settings, messages, temperature: 0.1 });
  const parsed = parseJsonSafely(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("风格画像生成失败：模型返回无法解析为 JSON。");
  }
  return parsed;
}

async function importToFeishuKnowledgeBase({ runId, settings, transcriptPayload, noteMarkdown }) {
  ensureFeishuConfigured(settings);
  const accessToken = await getFeishuTenantAccessToken(settings);
  const title = buildDocumentTitle(transcriptPayload.video?.title || DEFAULT_DOC_TITLE_FALLBACK);
  if (runId) {
    sendProgress({
      runId,
      stage: "feishu",
      level: "info",
      message: `正在创建飞书文档：${title}`
    });
  }
  const document = await createFeishuDocxDocument(settings, accessToken, title);
  await ensureFeishuDocumentTitleBestEffort(settings, accessToken, document.documentId, title);
  if (runId) {
    sendProgress({
      runId,
      stage: "feishu",
      level: "info",
      message: `文档已创建，ID：${document.documentId}，正在写入正文...`
    });
  }
  const writeResult = await appendMarkdownAsParagraphs(settings, accessToken, document.documentId, noteMarkdown, {
    runId,
    stage: "feishu",
    label: "主笔记文档"
  });
  if (runId) {
    const verifyText =
      writeResult.verifiedTextLength >= 0 ? `，校验文本长度 ${writeResult.verifiedTextLength}` : "";
    const warningText =
      Array.isArray(writeResult.warnings) && writeResult.warnings.length
        ? `，注意：${writeResult.warnings.join("；")}`
        : "";
    sendProgress({
      runId,
      stage: "feishu",
      level: Array.isArray(writeResult.warnings) && writeResult.warnings.length ? "warning" : "info",
      message: `文档写入完成（${writeResult.writtenLines} 行，${writeResult.writtenChars} 字符${verifyText}${warningText}）。`
    });
  }

  const noteWikiBinding = await attachAndSyncDocumentToWiki({
    runId,
    settings,
    accessToken,
    documentId: document.documentId,
    title,
    markdown: noteMarkdown,
    stage: "feishu",
    logPrefix: "主笔记"
  });

  let transcriptImport = null;
  try {
    transcriptImport = await importTranscriptArchiveToFeishu({
      runId,
      settings,
      accessToken,
      transcriptPayload
    });
  } catch (error) {
    transcriptImport = { ok: false, error: formatError(error) };
    if (runId) {
      sendProgress({
        runId,
        stage: "feishu",
        level: "warning",
        message: `转写文档导入失败：${formatError(error)}`
      });
    }
  }

  return {
    ok: !noteWikiBinding.wikiError,
    title,
    documentId: noteWikiBinding.effectiveDocumentId,
    rawDocumentId: document.documentId,
    writeResult,
    wikiNodeInfo: noteWikiBinding.wikiNodeInfo,
    wikiError: noteWikiBinding.wikiError,
    nodeToken: noteWikiBinding.nodeToken,
    documentUrl: `https://feishu.cn/docx/${noteWikiBinding.effectiveDocumentId}`,
    wikiUrl: noteWikiBinding.nodeToken ? `https://feishu.cn/wiki/${noteWikiBinding.nodeToken}` : "",
    transcriptImport
  };
}

function ensureFeishuConfigured(settings) {
  if (!settings.feishuAppId || !settings.feishuAppSecret) {
    throw new Error("请先在设置页填写飞书 App ID 和 App Secret。");
  }
  if (!settings.feishuWikiSpaceId) {
    throw new Error("请先在设置页填写飞书知识库 Space ID。");
  }
}

async function getFeishuTenantAccessToken(settings) {
  const url = `${trimSlash(settings.feishuBaseUrl)}/auth/v3/tenant_access_token/internal`;
  const response = await feishuFetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: settings.feishuAppId,
        app_secret: settings.feishuAppSecret
      })
    },
    FEISHU_HTTP_TIMEOUT_MS,
    0
  );

  const payload = await safeReadJson(response);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`获取飞书 tenant_access_token 失败：${extractApiError(payload, response.status)}`);
  }
  return payload.tenant_access_token;
}

async function createFeishuDocxDocument(settings, accessToken, title) {
  const url = `${trimSlash(settings.feishuBaseUrl)}/docx/v1/documents`;
  const response = await feishuFetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title })
    },
    FEISHU_HTTP_TIMEOUT_MS,
    0
  );

  const payload = await safeReadJson(response);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`创建飞书文档失败：${extractApiError(payload, response.status)}`);
  }
  const documentId = payload?.data?.document?.document_id;
  if (!documentId) {
    throw new Error("创建飞书文档失败：响应中缺少 document_id。");
  }
  return { documentId };
}

async function ensureFeishuDocumentTitleBestEffort(settings, accessToken, documentId, title) {
  if (!documentId || !title) {
    return;
  }

  const base = trimSlash(settings.feishuBaseUrl);
  const attempts = [
    { method: "PATCH", url: `${base}/docx/v1/documents/${documentId}` },
    { method: "PUT", url: `${base}/docx/v1/documents/${documentId}` }
  ];

  for (const attempt of attempts) {
    try {
      const response = await feishuFetchWithRetry(
        attempt.url,
        {
        method: attempt.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ title })
        },
        FEISHU_HTTP_TIMEOUT_MS,
        0
      );
      const payload = await safeReadJson(response);
      if (response.ok && payload?.code === 0) {
        return;
      }
      if (response.status === 404 || response.status === 405) {
        continue;
      }
      // Best effort only. Do not block main pipeline.
      return;
    } catch (_) {
      // Best effort only.
    }
  }
}

async function appendMarkdownAsParagraphs(settings, accessToken, documentId, markdown, progress = null) {
  if (progress?.runId) {
    throwIfRunCancelled(progress.runId);
  }
  const normalized = String(markdown || "").replace(/\u0000/g, "");
  const cleanLines = normalized
    .split(/\r?\n/)
    .map((line) => (line.trim().length === 0 ? "\u200B" : line))
    .flatMap((line) => splitLongLine(line, 480));

  if (cleanLines.length === 0) {
    cleanLines.push("（未生成到可用笔记内容，请稍后重试）");
  }

  const blocks = cleanLines.map((line) => buildFeishuParagraphBlock(line));
  let batchSize = 40;
  const minBatchSize = 8;
  let index = 0;
  let writtenLines = 0;
  let writtenChars = 0;
  let batchCount = 0;
  let rateLimitHits = 0;

  if (progress?.runId) {
    sendProgress({
      runId: progress.runId,
      stage: progress.stage || "feishu",
      level: "info",
      message: `${progress.label || "文档"}正文写入开始（共 ${blocks.length} 行）。`
    });
  }

  while (index < blocks.length) {
    if (progress?.runId) {
      throwIfRunCancelled(progress.runId);
    }
    const batch = blocks.slice(index, index + batchSize);
    try {
      await appendFeishuBlocks(settings, accessToken, documentId, index, batch);
      rateLimitHits = 0;
    } catch (error) {
      const errorText = formatError(error);
      if (isFeishuRateLimitError(errorText)) {
        rateLimitHits += 1;
        if (batchSize > minBatchSize) {
          batchSize = Math.max(minBatchSize, Math.floor(batchSize * 0.6));
        }
        const backoffMs = Math.min(15000, 1000 * 2 ** Math.min(rateLimitHits, 4));
        if (progress?.runId) {
          sendProgress({
            runId: progress.runId,
            stage: progress.stage || "feishu",
            level: "warning",
            message: `${progress.label || "文档"}写入触发限流（429），${Math.ceil(backoffMs / 1000)} 秒后重试（批量 ${batchSize} 行）。`
          });
        }
        await sleep(backoffMs);
        continue;
      }
      throw error;
    }

    index += batch.length;
    batchCount += 1;
    writtenLines += batch.length;
    writtenChars += batch.reduce((sum, block) => sum + getBlockTextLength(block), 0);

    if (progress?.runId) {
      const shouldReport =
        writtenLines >= blocks.length ||
        batchCount === 1 ||
        batchCount % FEISHU_APPEND_PROGRESS_INTERVAL === 0;
      if (shouldReport) {
        sendProgress({
          runId: progress.runId,
          stage: progress.stage || "feishu",
          level: "info",
          message: `${progress.label || "文档"}写入进度：${writtenLines}/${blocks.length} 行。`
        });
      }
    }
  }

  const warnings = [];
  let verifiedTextLength = -1;
  if (progress?.runId) {
    throwIfRunCancelled(progress.runId);
  }
  const verifyResult = await getFeishuDocRawContentLength(settings, accessToken, documentId);
  if (verifyResult.supported) {
    verifiedTextLength = verifyResult.length;
    if (verifiedTextLength === 0 && writtenChars > 0) {
      warnings.push("文档校验文本长度为 0，已执行兜底写入");
      const fallbackText = normalized.replace(/\s+/g, " ").trim() || "（原文为空）";
      const fallbackBlocks = [
        buildFeishuParagraphBlock("【系统提示】检测到文档正文为空，已写入兜底内容。"),
        buildFeishuParagraphBlock(safeSlice(fallbackText, 300))
      ];
      if (progress?.runId) {
        throwIfRunCancelled(progress.runId);
      }
      await appendFeishuBlocks(settings, accessToken, documentId, 0, fallbackBlocks);
      const verifyAgain = await getFeishuDocRawContentLength(settings, accessToken, documentId);
      if (verifyAgain.supported) {
        verifiedTextLength = verifyAgain.length;
      }
    }
  }

  return {
    writtenLines,
    writtenChars,
    verifiedTextLength,
    warnings
  };
}

function buildFeishuParagraphBlock(text) {
  return {
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text } }]
    }
  };
}

function getBlockTextLength(block) {
  const content = String(block?.text?.elements?.[0]?.text_run?.content || "");
  return content.replace(/\u200B/g, "").length;
}

function isFeishuRateLimitError(text) {
  const raw = String(text || "").toLowerCase();
  return raw.includes("http 429") || raw.includes("too many requests") || raw.includes("rate limit");
}

async function appendFeishuBlocks(settings, accessToken, documentId, index, children) {
  const url = `${trimSlash(settings.feishuBaseUrl)}/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
  const response = await feishuFetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ index, children })
    },
    FEISHU_HTTP_TIMEOUT_MS,
    1
  );

  const payload = await safeReadJson(response);
  if (!response.ok || payload?.code !== 0) {
    const firstChildPreview = safeSlice(JSON.stringify(children?.[0] || {}), 220);
    throw new Error(
      `写入飞书文档内容失败：${extractApiError(payload, response.status)}（index=${index}，first_child=${firstChildPreview}）`
    );
  }
}

async function getFeishuDocRawContentLength(settings, accessToken, documentId) {
  const url = `${trimSlash(settings.feishuBaseUrl)}/docx/v1/documents/${documentId}/raw_content`;
  try {
    const response = await feishuFetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }, FEISHU_HTTP_TIMEOUT_MS, 0);
    const payload = await safeReadJson(response);
    if (response.status === 404) {
      return { supported: false, length: -1 };
    }
    if (!response.ok || payload?.code !== 0) {
      return { supported: false, length: -1 };
    }
    const raw =
      payload?.data?.content ??
      payload?.data?.raw_content ??
      payload?.data?.text ??
      payload?.data?.markdown ??
      "";
    const text = typeof raw === "string" ? raw : JSON.stringify(raw || "");
    return {
      supported: true,
      length: text.replace(/\s+/g, "").length
    };
  } catch (_) {
    return { supported: false, length: -1 };
  }
}

async function attachDocxToWikiSpace(settings, accessToken, documentId, title) {
  const url = `${trimSlash(settings.feishuBaseUrl)}/wiki/v2/spaces/${settings.feishuWikiSpaceId}/nodes`;
  const body = {
    obj_type: settings.feishuWikiObjType || "docx",
    obj_token: documentId,
    node_type: "origin"
  };
  if (settings.feishuParentNodeToken) {
    body.parent_node_token = settings.feishuParentNodeToken;
  }
  const response = await feishuFetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    FEISHU_HTTP_TIMEOUT_MS,
    0
  );

  const payload = await safeReadJson(response);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`挂载到飞书知识库失败：${extractApiError(payload, response.status)}`);
  }

  return { nodeToken: payload?.data?.node?.node_token || "" };
}

async function getFeishuWikiNodeInfo(settings, accessToken, nodeToken) {
  if (!nodeToken) {
    return null;
  }
  const url = `${trimSlash(settings.feishuBaseUrl)}/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`;
  const response = await feishuFetchWithRetry(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }, FEISHU_HTTP_TIMEOUT_MS, 0);
  const payload = await safeReadJson(response);
  if (!response.ok || payload?.code !== 0) {
    return null;
  }
  const node = payload?.data?.node || {};
  return {
    nodeToken: String(node?.node_token || nodeToken),
    objToken: String(node?.obj_token || ""),
    objType: String(node?.obj_type || ""),
    title: String(node?.title || "")
  };
}

async function updateFeishuWikiNodeTitleBestEffort(settings, accessToken, nodeToken, title) {
  if (!nodeToken || !title) {
    return;
  }
  const url = `${trimSlash(settings.feishuBaseUrl)}/wiki/v2/spaces/${settings.feishuWikiSpaceId}/nodes/${nodeToken}/update_title`;
  try {
    const response = await feishuFetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: String(title).slice(0, 120) })
    }, FEISHU_HTTP_TIMEOUT_MS, 0);
    const payload = await safeReadJson(response);
    if (!response.ok || payload?.code !== 0) {
      return;
    }
  } catch (_) {
    // best effort only
  }
}

async function attachAndSyncDocumentToWiki({
  runId,
  settings,
  accessToken,
  documentId,
  title,
  markdown,
  stage,
  logPrefix
}) {
  let wikiNode = null;
  let wikiError = "";
  let effectiveDocumentId = documentId;
  let wikiNodeInfo = null;

  try {
    wikiNode = await attachDocxToWikiSpace(settings, accessToken, documentId, title);
    if (wikiNode?.nodeToken) {
      wikiNodeInfo = await getFeishuWikiNodeInfo(settings, accessToken, wikiNode.nodeToken);
      await updateFeishuWikiNodeTitleBestEffort(settings, accessToken, wikiNode.nodeToken, title);

      const mountedObjToken = String(wikiNodeInfo?.objToken || "");
      const mountedObjType = String(wikiNodeInfo?.objType || "").toLowerCase();
      if (mountedObjToken) {
        effectiveDocumentId = mountedObjToken;
      }

      if (
        mountedObjToken &&
        mountedObjToken !== documentId &&
        (mountedObjType.includes("doc") || mountedObjType.includes("docx"))
      ) {
        await ensureFeishuDocumentTitleBestEffort(settings, accessToken, mountedObjToken, title);
        if (markdown) {
          await appendMarkdownAsParagraphs(settings, accessToken, mountedObjToken, markdown, {
            runId,
            stage: stage || "feishu",
            label: logPrefix ? `${logPrefix}文档（同步）` : "文档同步"
          });
        }
      }

      if (runId) {
        const linked = mountedObjToken || "unknown";
        const mismatchNote =
          mountedObjToken && mountedObjToken !== documentId ? `，与初始文档 ID 不同（${documentId}）` : "";
        const label = logPrefix ? `${logPrefix}知识库节点校验` : "知识库节点校验";
        sendProgress({
          runId,
          stage: stage || "feishu",
          level: "info",
          message: `${label}：node=${wikiNode.nodeToken}，obj_token=${linked}${mismatchNote}。`
        });
      }
    }
  } catch (error) {
    wikiError = formatError(error);
  }

  return {
    nodeToken: wikiNode?.nodeToken || "",
    wikiError,
    wikiNodeInfo,
    effectiveDocumentId
  };
}

async function importTranscriptArchiveToFeishu({ runId, settings, accessToken, transcriptPayload }) {
  const transcriptTitle = buildTranscriptDocumentTitle(transcriptPayload?.video?.title || DEFAULT_DOC_TITLE_FALLBACK);
  const transcriptMarkdown = buildTranscriptArchiveMarkdown(transcriptPayload);

  if (runId) {
    sendProgress({
      runId,
      stage: "feishu",
      level: "info",
      message: `正在创建转写文档：${transcriptTitle}`
    });
  }

  const document = await createFeishuDocxDocument(settings, accessToken, transcriptTitle);
  await ensureFeishuDocumentTitleBestEffort(settings, accessToken, document.documentId, transcriptTitle);

  const binding = await attachAndSyncDocumentToWiki({
    runId,
    settings,
    accessToken,
    documentId: document.documentId,
    title: transcriptTitle,
    // The transcript can be very long; avoid writing twice when wiki mount maps to a different doc token.
    markdown: "",
    stage: "feishu",
    logPrefix: "转写文档"
  });

  const targetDocumentId = binding.effectiveDocumentId || document.documentId;
  if (targetDocumentId && targetDocumentId !== document.documentId) {
    await ensureFeishuDocumentTitleBestEffort(settings, accessToken, targetDocumentId, transcriptTitle);
  }
  const writeResult = await appendMarkdownAsParagraphs(settings, accessToken, targetDocumentId, transcriptMarkdown, {
    runId,
    stage: "feishu",
    label: "转写文档"
  });

  if (runId) {
    sendProgress({
      runId,
      stage: "feishu",
      level: binding.wikiError ? "warning" : "info",
      message: binding.wikiError
        ? `转写文档已创建，但挂载失败：${binding.wikiError}`
        : `转写文档导入完成（${writeResult.writtenLines} 行）。`
    });
  }

  return {
    ok: !binding.wikiError,
    title: transcriptTitle,
    documentId: targetDocumentId,
    rawDocumentId: document.documentId,
    writeResult,
    wikiNodeInfo: binding.wikiNodeInfo,
    wikiError: binding.wikiError,
    nodeToken: binding.nodeToken,
    documentUrl: `https://feishu.cn/docx/${targetDocumentId}`,
    wikiUrl: binding.nodeToken ? `https://feishu.cn/wiki/${binding.nodeToken}` : ""
  };
}

function buildTranscriptDocumentTitle(videoTitle) {
  const dateLabel = new Date().toISOString().slice(0, 10);
  const connector = " - ";
  const suffix = `${TRANSCRIPT_DOC_TITLE_SUFFIX} ${dateLabel}`;
  const base = String(videoTitle || DEFAULT_DOC_TITLE_FALLBACK)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedBase = base || DEFAULT_DOC_TITLE_FALLBACK;
  const maxBaseLength = Math.max(8, 120 - connector.length - suffix.length);
  const clippedBase = normalizedBase.slice(0, maxBaseLength);
  return `${clippedBase}${connector}${suffix}`;
}

function buildTranscriptArchiveMarkdown(transcriptPayload) {
  const video = transcriptPayload?.video || {};
  const source = String(transcriptPayload?.source || "unknown");
  const sourceMap = {
    subtitle: "字幕",
    audio_asr: "音频转写",
    description_fallback: "视频简介回退"
  };

  const lines = [
    `# ${video?.title || DEFAULT_DOC_TITLE_FALLBACK} - 转写与时间戳`,
    "",
    "## 来源信息",
    `- 来源类型：${sourceMap[source] || source}`,
    `- 视频链接：${video?.url || ""}`,
    `- BV：${video?.bvid || ""}`,
    `- CID：${video?.cid || ""}`,
    ""
  ];

  const segments = Array.isArray(transcriptPayload?.segments) ? transcriptPayload.segments : [];
  if (segments.length > 0) {
    lines.push("## 时间戳转写");
    segments.forEach((segment, index) => {
      const from = formatSecondsToClock(segment?.from || 0);
      const to = formatSecondsToClock(segment?.to || 0);
      const text = String(segment?.content || "").trim();
      if (!text) {
        return;
      }
      lines.push(`${index + 1}. [${from} - ${to}] ${text}`);
    });
  } else {
    lines.push("## 转写正文");
    lines.push("当前未获取到逐句时间戳，以下为可用文本：");
    lines.push("");
    lines.push(safeSlice(String(transcriptPayload?.transcriptText || "").trim(), 60000) || "（无可用文本）");
  }

  return lines.join("\n");
}

function formatSecondsToClock(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0)));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function requestBilibiliTranscript(tabId) {
  await injectContentScriptBestEffort(tabId);

  try {
    let result = await chrome.tabs.sendMessage(tabId, { action: "EXTRACT_BILIBILI_TRANSCRIPT" });
    if (isStaleTranscriptExtractorResult(result)) {
      await resetLegacyContentScriptState(tabId);
      await injectContentScriptBestEffort(tabId);
      result = await chrome.tabs.sendMessage(tabId, { action: "EXTRACT_BILIBILI_TRANSCRIPT" });
    }
    if (isStaleTranscriptExtractorResult(result)) {
      throw new Error(
        `页面提取器版本异常（expected ${CONTENT_SCRIPT_REQUIRED_VERSION}）。请刷新视频页面后重试。`
      );
    }
    return result;
  } catch (firstError) {
    await resetLegacyContentScriptState(tabId);
    await injectContentScriptBestEffort(tabId);
    try {
      const result = await chrome.tabs.sendMessage(tabId, { action: "EXTRACT_BILIBILI_TRANSCRIPT" });
      if (isStaleTranscriptExtractorResult(result)) {
        throw new Error(
          `页面提取器版本异常（expected ${CONTENT_SCRIPT_REQUIRED_VERSION}）。请刷新视频页面后重试。`
        );
      }
      return result;
    } catch (secondError) {
      throw secondError || firstError;
    }
  }
}

function isStaleTranscriptExtractorResult(payload) {
  const version = String(payload?.extractorVersion || "").trim();
  if (!version) {
    return true;
  }
  return version !== CONTENT_SCRIPT_REQUIRED_VERSION;
}

async function injectContentScriptBestEffort(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
  } catch (_) {
    // Ignore and let sendMessage surface a concrete error.
  }
}

async function resetLegacyContentScriptState(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const oldHandler = globalThis.__edgeScriptOnMessageHandler;
          if (oldHandler && chrome?.runtime?.onMessage?.removeListener) {
            chrome.runtime.onMessage.removeListener(oldHandler);
          }
        } catch (_) {
          // ignore
        }

        try {
          delete globalThis.__edgeScriptOnMessageHandler;
        } catch (_) {
          globalThis.__edgeScriptOnMessageHandler = undefined;
        }
        try {
          delete globalThis.__edgeScriptOnMessageHandlerVersion;
        } catch (_) {
          globalThis.__edgeScriptOnMessageHandlerVersion = "";
        }
      }
    });
  } catch (_) {
    // Ignore cleanup failure; next inject/send may still succeed.
  }
}

async function runPreflightChecks(requestedTabId) {
  const settings = await getSettings();
  const checks = [];
  const tabId = requestedTabId || (await getActiveTabId());

  await pushCheck(checks, "页面检查", async () => {
    if (!tabId) {
      return fail("未检测到当前标签页。");
    }
    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || "");
    if (!/^https:\/\/www\.bilibili\.com\/video\//.test(url)) {
      return fail("当前不是 B 站视频页，请切到视频详情页后再运行。");
    }
    return pass("当前页面可用。");
  });

  await pushCheck(checks, "模型接口", async () => {
    if (!settings.llmApiKey) {
      return fail("未配置模型 API Key。");
    }
    if (!settings.llmBaseUrl) {
      return fail("未配置模型 Base URL。");
    }

    const probe = await probeChatApi(settings);
    if (probe.ok) {
      return pass(probe.message || "模型接口连通。");
    }
    return fail(probe.message || "模型接口不可用。");
  });

  await pushCheck(checks, "ASR 接口", async () => {
    if (!settings.enableAsrFallback) {
      return settings.requireAsrWhenNoSubtitle !== false ? fail("ASR 已关闭，但你启用了“无字幕必须 ASR 成功”。") : warn("ASR 兜底已关闭。");
    }

    const auth = resolveAsrAuth(settings);
    if (!auth.baseUrl) {
      return settings.requireAsrWhenNoSubtitle !== false
        ? fail("ASR 配置不完整（缺少 Base URL），且已启用“无字幕必须 ASR 成功”。")
        : warn("ASR 配置不完整（缺少 Base URL），运行时将跳过音频转写。");
    }

    if (!auth.apiKey && !isLocalAsrBaseUrl(auth.baseUrl)) {
      return settings.requireAsrWhenNoSubtitle !== false
        ? fail("ASR 未配置 API Key（非本地地址通常需要 Key），且已启用“无字幕必须 ASR 成功”。")
        : warn("ASR 未配置 API Key（非本地地址通常需要 Key），运行时可能转写失败。");
    }

    const probe = await probeAsrApi(auth);
    if (probe.level === "pass") {
      return pass(probe.message);
    }
    if (probe.level === "warn") {
      return warn(probe.message);
    }
    if (settings.requireAsrWhenNoSubtitle !== false) {
      return fail(`${probe.message} 当前已启用“无字幕必须 ASR 成功”，请先修复 ASR。`);
    }
    return warn(`${probe.message} 将降级为“仅字幕/简介模式”，不阻止任务启动。`);
  });

  await pushCheck(checks, "飞书导入", async () => {
    if (!settings.autoImportToFeishu) {
      return warn("已关闭自动导入飞书。");
    }
    if (!settings.feishuAppId || !settings.feishuAppSecret || !settings.feishuWikiSpaceId) {
      return fail("飞书配置不完整（App ID / App Secret / Space ID）。");
    }

    const accessToken = await getFeishuTenantAccessToken(settings);
    const readProbe = await probeFeishuSpaceReadable(settings, accessToken);
    if (!readProbe.ok) {
      return fail(readProbe.message);
    }

    const writeProbe = await probeFeishuSpaceWritable(settings, accessToken);
    if (writeProbe.level === "fail") {
      return fail(writeProbe.message);
    }
    if (writeProbe.level === "warn") {
      return warn(writeProbe.message);
    }
    return pass(writeProbe.message);
  });

  const failCount = checks.filter((item) => item.level === "fail").length;
  const warnCount = checks.filter((item) => item.level === "warn").length;
  return {
    ok: failCount === 0,
    failCount,
    warnCount,
    checks
  };
}

async function probeChatApi(settings) {
  const url = `${trimSlash(settings.llmBaseUrl)}/chat/completions`;
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.llmApiKey}`
        },
        body: JSON.stringify({
          model: settings.llmModel || "gpt-4o-mini",
          temperature: 0,
          max_tokens: 4,
          messages: [{ role: "user", content: "reply ok" }]
        })
      },
      12000
    );

    const payload = await safeReadJson(response);
    if (!response.ok) {
      return {
        ok: false,
        message: withEndpoint(`模型接口失败（HTTP ${response.status}）：${extractApiError(payload, response.status)}`, url)
      };
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      return {
        ok: false,
        message: withEndpoint("模型接口返回成功，但响应中无内容。", url)
      };
    }

    return { ok: true, message: withEndpoint("模型接口连通。", url) };
  } catch (error) {
    return {
      ok: false,
      message: withEndpoint(`模型接口请求失败：${formatError(error)}`, url)
    };
  }
}

async function probeAsrApi(auth) {
  const url = `${trimSlash(auth.baseUrl)}/models`;
  let responseStatus = 0;
  try {
    const response = await fetchWithTimeout(
      url,
      {
      method: "GET",
      headers: buildAuthHeaders(auth.apiKey)
      },
      10000
    );
    responseStatus = Number(response?.status || 0);
    const payload = await safeReadJson(response);
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      return {
        level: "fail",
        message: withEndpoint(`ASR 接口失败（HTTP ${response.status}）：${extractApiError(payload, response.status)}`, url)
      };
    }
  } catch (error) {
    const localHint = maybeBuildLocalAsrOfflineMessage(auth.baseUrl, error, url, "ASR 接口请求失败");
    if (localHint) {
      return { level: "fail", message: localHint };
    }
    return { level: "fail", message: withEndpoint(`ASR 接口请求失败：${formatError(error)}`, url) };
  }

  const capability = await getAsrTranscriptionCapability(auth, "whisper-1");
  if (!capability.supported) {
    return { level: "fail", message: capability.message };
  }

  return {
    level: "pass",
    message:
      responseStatus === 404 || responseStatus === 405
        ? withEndpoint("ASR 转写接口连通（/models 不可用但不影响转写）。", url)
        : withEndpoint("ASR 服务连通，转写接口可用。", url)
  };
}

async function probeFeishuSpaceReadable(settings, accessToken) {
  const base = trimSlash(settings.feishuBaseUrl);
  const url = `${base}/wiki/v2/spaces/${settings.feishuWikiSpaceId}/nodes?page_size=1`;
  const response = await fetchWithTimeout(
    url,
    {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
    },
    12000
  );

  const payload = await safeReadJson(response);
  if (!response.ok || payload?.code !== 0) {
    return {
      ok: false,
      message: withEndpoint(`知识库读取检查失败：${extractApiError(payload, response.status)}`, url)
    };
  }

  return { ok: true };
}

async function probeFeishuSpaceWritable(settings, accessToken) {
  const base = trimSlash(settings.feishuBaseUrl);
  const spaceId = settings.feishuWikiSpaceId;
  const spaceUrl = `${base}/wiki/v2/spaces/${spaceId}`;
  const spaceResponse = await fetchWithTimeout(
    spaceUrl,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    12000
  );
  const spacePayload = await safeReadJson(spaceResponse);
  if (!spaceResponse.ok || spacePayload?.code !== 0) {
    return {
      level: "fail",
      message: withEndpoint(`知识库空间检查失败：${extractApiError(spacePayload, spaceResponse.status)}`, spaceUrl)
    };
  }

  if (settings.feishuParentNodeToken) {
    const nodeUrl = `${base}/wiki/v2/spaces/get_node?token=${encodeURIComponent(settings.feishuParentNodeToken)}`;
    const nodeResponse = await fetchWithTimeout(
      nodeUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      },
      12000
    );
    const nodePayload = await safeReadJson(nodeResponse);
    if (!nodeResponse.ok || nodePayload?.code !== 0) {
      return {
        level: "fail",
        message: withEndpoint(`父节点检查失败：${extractApiError(nodePayload, nodeResponse.status)}`, nodeUrl)
      };
    }
  }

  return {
    level: "warn",
    message: withEndpoint(
      "已验证空间/节点可读。为避免产生测试文档，未执行写入探测；首次导入时仍可能因 edit permission 失败。",
      spaceUrl
    )
  };
}

async function pushCheck(checks, name, fn) {
  try {
    const result = await fn();
    checks.push({
      name,
      level: result?.level || "warn",
      message: result?.message || "无信息"
    });
  } catch (error) {
    checks.push({
      name,
      level: "fail",
      message: formatError(error)
    });
  }
}

function pass(message) {
  return { level: "pass", message };
}

function warn(message) {
  return { level: "warn", message };
}

function fail(message) {
  return { level: "fail", message };
}

async function callChatCompletionWithMeta({ settings, messages, temperature, maxTokens }) {
  const baseUrl = trimSlash(settings.llmBaseUrl || "https://xlabapi.top/v1");
  const url = `${baseUrl}/chat/completions`;
  const retries = Math.max(0, Number(settings.llmMaxRetries || 2));
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const bodyPayload = {
        model: settings.llmModel || "gpt-4o-mini",
        temperature: typeof temperature === "number" ? temperature : settings.llmTemperature ?? 0.3,
        messages
      };
      if (Number.isFinite(maxTokens) && Number(maxTokens) > 0) {
        bodyPayload.max_tokens = Math.floor(Number(maxTokens));
      }

      const response = await promiseWithTimeout(
        fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${settings.llmApiKey}`
            },
            body: JSON.stringify(bodyPayload)
          },
          LLM_HTTP_TIMEOUT_MS
        ),
        LLM_HTTP_TIMEOUT_MS + 4000,
        `模型请求超时（>${Math.floor(LLM_HTTP_TIMEOUT_MS / 1000)} 秒）`
      );

      const payload = await safeReadJson(response);
      if (!response.ok) {
        const err = new Error(`模型调用失败（HTTP ${response.status}）：${extractApiError(payload, response.status)}`);
        if (attempt < retries && isRetryableStatus(response.status)) {
          lastError = err;
          await sleep((attempt + 1) * 1200);
          continue;
        }
        throw err;
      }

      const content = extractChatCompletionText(payload);
      if (!content) {
        const err = new Error("模型调用失败：响应中缺少可用内容。");
        if (attempt < retries) {
          lastError = err;
          await sleep((attempt + 1) * 1200);
          continue;
        }
        throw err;
      }
      return {
        content,
        usage: payload?.usage || payload?.data?.usage || null,
        responseModel: payload?.model || settings.llmModel || "",
        endpoint: url
      };
    } catch (error) {
      const maybeNetwork = String(error?.message || "").toLowerCase();
      if (
        attempt < retries &&
        (maybeNetwork.includes("failed to fetch") ||
          maybeNetwork.includes("networkerror") ||
          maybeNetwork.includes("timeout") ||
          maybeNetwork.includes("timed out"))
      ) {
        lastError = error;
        await sleep((attempt + 1) * 1200);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`模型调用失败：${formatError(lastError)}（已重试 ${retries + 1} 次）`);
}

async function callChatCompletion(args) {
  const result = await callChatCompletionWithMeta(args);
  return result.content;
}

function extractChatCompletionText(payload) {
  const choice = payload?.choices?.[0] || payload?.data?.choices?.[0] || null;
  const message = choice?.message || {};

  const fromMessage = normalizeChatContent(message?.content);
  if (fromMessage) {
    return fromMessage;
  }

  const reasoning = normalizeChatContent(message?.reasoning_content || choice?.reasoning_content);
  if (reasoning) {
    return reasoning;
  }

  const fromText = normalizeChatContent(choice?.text || payload?.text || payload?.data?.text);
  if (fromText) {
    return fromText;
  }

  return "";
}

function normalizeChatContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        if (typeof part?.content === "string") {
          return part.content;
        }
        if (typeof part?.text?.value === "string") {
          return part.text.value;
        }
        return "";
      })
      .join("\n")
      .trim();
    return text;
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text.trim();
    }
    if (typeof content.content === "string") {
      return content.content.trim();
    }
  }
  return "";
}

function selectTopSamplesBySimilarity(samples, text, limit) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return [];
  }

  const targetTokens = buildTokenSet(text);
  return [...samples]
    .map((sample) => {
      const sampleTokens = buildTokenSet(sample.content || "");
      return { ...sample, score: jaccardSimilarity(targetTokens, sampleTokens) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildTokenSet(text) {
  const lower = (text || "").toLowerCase();
  const enTokens = lower.match(/[a-z0-9]{2,}/g) || [];
  const hanChars = (text || "").match(/[\u4e00-\u9fa5]/g) || [];
  const biGrams = [];
  for (let i = 0; i < hanChars.length - 1; i += 1) {
    biGrams.push(hanChars[i] + hanChars[i + 1]);
  }
  return new Set([...enTokens, ...biGrams]);
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) {
    return 0;
  }
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

async function getSettings() {
  const stored = await storageGet(Object.keys(DEFAULT_SETTINGS));
  return withDefaults(stored);
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = withDefaults({ ...current, ...partial });
  await storageSet(next);
  return next;
}

async function addStyleSamples(samples) {
  const current = await getSettings();
  const cleaned = (samples || [])
    .map((sample) => ({
      id: sample.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: (sample.title || "").trim(),
      content: (sample.content || "").trim(),
      createdAt: sample.createdAt || new Date().toISOString()
    }))
    .filter((sample) => sample.content.length > 0);

  if (cleaned.length === 0) {
    return current;
  }
  const styleSamples = [...(current.styleSamples || []), ...cleaned].slice(-100);
  return saveSettings({ styleSamples });
}

async function deleteStyleSample(sampleId) {
  const current = await getSettings();
  const styleSamples = (current.styleSamples || []).filter((sample) => sample.id !== sampleId);
  return saveSettings({ styleSamples });
}

function withDefaults(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value || {}),
    styleSamples: Array.isArray(value?.styleSamples) ? value.styleSamples : [],
    styleProfile: value?.styleProfile ?? null
  };
}

function createRunId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sendProgress(event, options = {}) {
  const runId = String(event?.runId || "").trim();
  if (runId && isRunCancelled(runId) && !options.allowCancelled) {
    return;
  }
  const payload = {
    type: "PIPELINE_PROGRESS",
    timestamp: new Date().toISOString(),
    ...event
  };
  chrome.runtime.sendMessage(payload);
  persistRunHistoryEvent("progress", payload);
}

function sendFinished(result, options = {}) {
  const runId = String(result?.runId || "").trim();
  const context = runId ? ACTIVE_RUNS.get(runId) : null;

  if (context?.finalized && !options.allowCancelled) {
    return;
  }
  if (runId && isRunCancelled(runId) && !options.allowCancelled) {
    return;
  }
  if (context) {
    context.finalized = true;
  }

  const payload = {
    type: "PIPELINE_FINISHED",
    timestamp: new Date().toISOString(),
    ...result
  };
  chrome.runtime.sendMessage(payload);
  persistRunHistoryEvent("finished", payload);
}

async function getRunHistory(limit = 10) {
  const cappedLimit = Math.max(1, Math.min(50, Number(limit || 10)));
  const stored = await storageGet(RUN_LOG_HISTORY_KEY);
  const history = Array.isArray(stored?.[RUN_LOG_HISTORY_KEY]) ? stored[RUN_LOG_HISTORY_KEY] : [];
  return history.slice(0, cappedLimit);
}

function persistRunHistoryEvent(kind, payload) {
  runLogPersistQueue = runLogPersistQueue
    .then(async () => {
      const runId = String(payload?.runId || "").trim();
      if (!runId) {
        return;
      }

      const stored = await storageGet(RUN_LOG_HISTORY_KEY);
      const history = Array.isArray(stored?.[RUN_LOG_HISTORY_KEY]) ? [...stored[RUN_LOG_HISTORY_KEY]] : [];
      let entry = history.find((item) => item.runId === runId);
      if (!entry) {
        entry = {
          runId,
          startedAt: payload.timestamp || new Date().toISOString(),
          status: "running",
          logs: []
        };
        history.unshift(entry);
      }

      if (!Array.isArray(entry.logs)) {
        entry.logs = [];
      }

      if (kind === "progress") {
        entry.logs.push({
          timestamp: payload.timestamp || new Date().toISOString(),
          stage: payload.stage || "",
          level: payload.level || "info",
          message: String(payload.message || "")
        });
        if (payload.level === "error" || payload.stage === "error") {
          entry.status = "failed";
        } else if (entry.status !== "failed" && entry.status !== "success") {
          entry.status = "running";
        }
      } else if (kind === "finished") {
        entry.finishedAt = payload.timestamp || new Date().toISOString();
        entry.status = payload.ok ? "success" : "failed";
        entry.result = {
          ok: Boolean(payload.ok),
          error: payload.error || "",
          createdAt: payload.createdAt || payload.timestamp || "",
          importResult: payload.importResult || null
        };
      }

      if (entry.logs.length > RUN_LOG_LINE_LIMIT) {
        entry.logs = entry.logs.slice(-RUN_LOG_LINE_LIMIT);
      }

      history.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
      const trimmed = history.slice(0, RUN_LOG_HISTORY_LIMIT);
      await storageSet({ [RUN_LOG_HISTORY_KEY]: trimmed });
    })
    .catch((error) => {
      console.warn("persistRunHistoryEvent failed:", error);
    });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

function parseJsonSafely(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    const matched = text.match(/\{[\s\S]*\}/);
    if (!matched) {
      return null;
    }
    try {
      return JSON.parse(matched[0]);
    } catch (_) {
      return null;
    }
  }
}

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function storageSet(data) {
  return chrome.storage.local.set(data);
}

function trimSlash(url) {
  return (url || "").replace(/\/+$/, "");
}

function safeSlice(text, maxLength) {
  if (!text) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n\n[内容过长，已截断]` : text;
}

function splitLongLine(line, maxLength) {
  if (!line || line.length <= maxLength) {
    return [line || ""];
  }
  const pieces = [];
  for (let index = 0; index < line.length; index += maxLength) {
    pieces.push(line.slice(index, index + maxLength));
  }
  return pieces;
}

function isGeneratedNoteUsable(markdown) {
  if (typeof markdown !== "string") {
    return false;
  }

  const normalized = markdown.replace(/\u200B/g, "").trim();
  if (normalized.length < 60) {
    return false;
  }

  const plain = normalized
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*_~\[\]()|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length < 40) {
    return false;
  }

  return /[A-Za-z\u4e00-\u9fa5]/.test(plain);
}

function formatUsageText(usage) {
  if (!usage || typeof usage !== "object") {
    return "";
  }

  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  const total = Number(usage.total_tokens || prompt + completion || 0);
  const parts = [];

  if (prompt > 0) {
    parts.push(`输入 ${prompt}`);
  }
  if (completion > 0) {
    parts.push(`输出 ${completion}`);
  }
  if (total > 0) {
    parts.push(`总计 ${total} tokens`);
  }

  return parts.join("，");
}

function buildDocumentTitle(videoTitle) {
  const dateLabel = new Date().toISOString().slice(0, 10);
  const connector = " - ";
  const suffix = `${DEFAULT_DOC_TITLE_SUFFIX} ${dateLabel}`;
  const base = String(videoTitle || DEFAULT_DOC_TITLE_FALLBACK)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedBase = base || DEFAULT_DOC_TITLE_FALLBACK;
  const maxBaseLength = Math.max(8, 120 - connector.length - suffix.length);
  const clippedBase = normalizedBase.slice(0, maxBaseLength);
  return `${clippedBase}${connector}${suffix}`;
}

async function safeReadJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

function extractApiError(payload, statusCode) {
  if (!payload) {
    return `HTTP ${statusCode}`;
  }
  if (payload.detail) {
    if (typeof payload.detail === "string") {
      return payload.detail;
    }
    if (Array.isArray(payload.detail)) {
      const joined = payload.detail
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item?.msg) {
            return String(item.msg);
          }
          return JSON.stringify(item);
        })
        .filter(Boolean)
        .join("; ");
      if (joined) {
        return joined;
      }
    }
    if (typeof payload.detail === "object") {
      const msg = payload.detail?.message || payload.detail?.msg;
      if (msg) {
        return String(msg);
      }
    }
  }
  if (payload.msg) {
    return payload.msg;
  }
  if (payload.message) {
    return payload.message;
  }
  if (payload.error?.message) {
    return payload.error.message;
  }
  if (payload.raw) {
    return summarizeRawError(payload.raw, statusCode);
  }
  return `code=${payload.code ?? "unknown"}, http=${statusCode}`;
}

function summarizeRawError(raw, statusCode) {
  const text = String(raw || "");
  if (!text) {
    return `HTTP ${statusCode}`;
  }
  if (/<html/i.test(text)) {
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || "HTML Error Page";
    const rayId = text.match(/Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/i)?.[1]?.trim();
    return rayId ? `${title}（Ray ID: ${rayId}）` : title;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
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
    // ignore
  }
  return `audio.${extByMime}`;
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
    // ignore and use fallback heuristics
  }

  return { ok: false, reason: "无法识别为常见音频容器格式" };
}

function formatError(error) {
  if (!error) {
    return "鏈煡閿欒";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || String(error);
}

function compactAsrErrorReason(reason, maxLength = 520) {
  let text = String(reason || "").trim();
  if (!text) {
    return "";
  }
  text = text.replace(/https?:\/\/\S+/g, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
    } catch (_) {
      return raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
    }
  });
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}...`;
  }
  return text;
}

function withEndpoint(message, url) {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) {
    return message;
  }
  return `${message}（URL: ${cleanUrl}）`;
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

function isLikelyFetchConnectivityError(error) {
  const text = String(formatError(error) || "").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("network error") ||
    text.includes("err_connection_refused") ||
    text.includes("err_connection_timed_out") ||
    text.includes("timeout") ||
    text.includes("abort")
  );
}

function localAsrStartupHint() {
  return "请先在 EdgeScript/local-asr-whisper 目录执行 .\\start_quick.ps1，并保持该终端窗口运行。";
}

function maybeBuildLocalAsrOfflineMessage(baseUrl, error, url, prefix) {
  if (!isLocalAsrBaseUrl(baseUrl) || !isLikelyFetchConnectivityError(error)) {
    return "";
  }
  const reason = formatError(error);
  return withEndpoint(`${prefix}：${reason}。本地 ASR 服务可能未启动。${localAsrStartupHint()}`, url);
}

async function safeDrainResponse(response) {
  if (!response) {
    return;
  }
  try {
    await response.text();
  } catch (_) {
    // ignore
  }
}

async function feishuFetchWithRetry(url, options, timeoutMs = FEISHU_HTTP_TIMEOUT_MS, retries = FEISHU_HTTP_RETRIES) {
  let lastError = null;
  const maxRetries = Math.max(0, Number(retries || 0));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (attempt < maxRetries && isRetryableStatus(response.status)) {
        await safeDrainResponse(response);
        await sleep(500 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isLikelyFetchConnectivityError(error)) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("飞书接口请求失败：未知网络错误。");
}

async function promiseWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage || "请求超时。")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, {
      ...(options || {}),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonByBackground(url, fetchOptions) {
  if (!url) {
    return { ok: false, error: "缂哄皯璇锋眰 URL銆" };
  }

  const response = await fetch(url, {
    method: fetchOptions?.method || "GET",
    headers: fetchOptions?.headers || {},
    credentials: fetchOptions?.credentials || "include",
    mode: fetchOptions?.mode || "cors",
    cache: fetchOptions?.cache || "default",
    referrer: fetchOptions?.referrer || undefined,
    referrerPolicy: fetchOptions?.referrerPolicy || "strict-origin-when-cross-origin"
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.message || payload?.msg || summarizeRawError(text, response.status),
      raw: text
    };
  }

  if (payload === null) {
    return {
      ok: false,
      status: response.status,
      error: "鎺ュ彛杩斿洖闈?JSON 鍐呭銆",
      raw: text
    };
  }

  return { ok: true, status: response.status, data: payload };
}




