const runBtn = document.getElementById("runBtn");
const checkBtn = document.getElementById("checkBtn");
const stopBtn = document.getElementById("stopBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");
const tabHint = document.getElementById("tabHint");
const logBox = document.getElementById("logBox");
const resultMeta = document.getElementById("resultMeta");
const copyNoteBtn = document.getElementById("copyNoteBtn");
const wikiLink = document.getElementById("wikiLink");

const state = {
  activeTabId: null,
  currentRunId: "",
  renderedRunId: "",
  lastNote: "",
  isBilibili: false,
  isRunning: false,
  isChecking: false
};

boot().catch((error) => appendLog(`初始化失败：${error.message || String(error)}`, "error"));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PIPELINE_PROGRESS") {
    const runId = String(message.runId || "");
    if (runId) {
      if (!state.currentRunId) {
        state.currentRunId = runId;
      }
      if (!state.isRunning) {
        setRunning(true);
      }
      ensureRunSection(runId, message.timestamp);
    }

    if (!state.currentRunId || state.currentRunId === runId) {
      appendLog(message.message || "", message.level || "info", message.timestamp);
    }
  }

  if (message?.type === "PIPELINE_FINISHED") {
    const runId = String(message.runId || "");
    ensureRunSection(runId, message.timestamp);

    if (!state.currentRunId || state.currentRunId === runId) {
      setRunning(false);
      state.currentRunId = "";
      if (message.ok) {
        appendLog("任务完成。", "success", message.timestamp);
        renderResult(message);
      } else {
        appendLog(`任务失败：${message.error || "未知错误"}`, "error", message.timestamp);
      }
    }
  }
});

openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
checkBtn.addEventListener("click", runPreflightOnly);
if (stopBtn) {
  stopBtn.addEventListener("click", forceStopCurrentRun);
}

runBtn.addEventListener("click", async () => {
  const tabState = await refreshActiveTabContext();
  if (!tabState.ok) {
    appendLog(tabState.message || "未找到当前标签页。", "error");
    return;
  }
  if (!tabState.isBilibili) {
    appendLog("当前活动标签页不是 B 站视频详情页，请切换后重试。", "error");
    return;
  }

  startNewAttemptSection();
  setRunning(true);

  appendLog("检查扩展后台连接...", "info");
  const ready = await ensureBackgroundReady();
  if (!ready.ok) {
    setRunning(false);
    appendLog(ready.error, "error");
    return;
  }

  appendLog(`后台连接正常（版本 ${ready.version || "unknown"}）。`, "success");
  appendLog("开始运行前自检...", "info");

  const preflight = await callRuntime("RUN_PREFLIGHT", { tabId: state.activeTabId });
  if (!preflight.ok) {
    setRunning(false);
    appendLog(`自检失败：${preflight.error || "未知错误"}`, "error");
    return;
  }

  renderPreflightResult(preflight.result);
  if (!preflight.result?.ok) {
    setRunning(false);
    appendLog("自检未通过，已阻止任务启动。请先修复失败项。", "error");
    return;
  }

  appendLog("自检通过，开始执行任务...", "info");
  const response = await callRuntime("START_PIPELINE", { tabId: state.activeTabId });
  if (!response.ok) {
    setRunning(false);
    appendLog(`启动失败：${response.error || "未知错误"}`, "error");
    return;
  }

  state.currentRunId = response.runId;
  ensureRunSection(state.currentRunId);
});

async function forceStopCurrentRun() {
  const targetRunId = String(state.currentRunId || state.renderedRunId || "").trim();
  if (!targetRunId) {
    appendLog("当前没有可终止的任务。", "warning");
    setRunning(false);
    return;
  }

  appendLog(`正在强制终止任务（Run ID: ${targetRunId}）...`, "warning");
  const response = await callRuntime("FORCE_STOP_PIPELINE", {
    runId: targetRunId,
    tabId: state.activeTabId,
    reason: "任务已由用户手动强制终止。"
  });

  if (!response.ok) {
    appendLog(`强制终止失败：${response.error || "未知错误"}`, "error");
    return;
  }

  if (response.stopped) {
    appendLog(`已终止任务（Run ID: ${response.runId || targetRunId}）。`, "success");
  } else {
    appendLog(response.message || "未检测到可终止任务。", "warning");
  }

  state.currentRunId = "";
  setRunning(false);
  await restoreRecentRunLogs();
}

copyNoteBtn.addEventListener("click", async () => {
  if (!state.lastNote) {
    appendLog("当前没有可复制的笔记。", "warning");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.lastNote);
    appendLog("笔记已复制到剪贴板。", "success");
  } catch (error) {
    appendLog(`复制失败：${error.message || String(error)}`, "error");
  }
});

async function boot() {
  await refreshActiveTabContext();

  await restoreRecentRunLogs();

  const last = await callRuntime("GET_LAST_PIPELINE_RESULT");
  if (last.ok && last.result) {
    renderResult(last.result);
  } else {
    resultMeta.textContent = "暂无历史结果。";
    wikiLink.classList.add("hidden");
  }
}

async function restoreRecentRunLogs() {
  const [history, runtime] = await Promise.all([
    callRuntime("GET_RUN_HISTORY", { limit: 6 }),
    callRuntime("GET_PIPELINE_RUNTIME_STATE")
  ]);
  if (!history.ok) {
    appendLog(`恢复历史日志失败：${history.error || "未知错误"}`, "warning");
    return;
  }

  let runs = Array.isArray(history.runs) ? [...history.runs] : [];
  if (runs.length === 0) {
    state.currentRunId = "";
    state.renderedRunId = "";
    setRunning(false);
    return;
  }

  const activeRunIds = new Set(
    runtime?.ok && Array.isArray(runtime.activeRuns)
      ? runtime.activeRuns.map((item) => String(item?.runId || "")).filter(Boolean)
      : []
  );

  const latestBeforeRender = runs[0];
  let autoRecovered = false;
  if (latestBeforeRender?.status === "running") {
    const latestRunId = String(latestBeforeRender.runId || "").trim();
    const isActive = latestRunId && activeRunIds.has(latestRunId);
    if (!isActive && latestRunId) {
      const stopResult = await callRuntime("FORCE_STOP_PIPELINE", {
        runId: latestRunId,
        reason: "检测到上次任务未正常结束，已自动终止。"
      });
      if (stopResult.ok && stopResult.stopped) {
        autoRecovered = true;
        const refreshedHistory = await callRuntime("GET_RUN_HISTORY", { limit: 6 });
        if (refreshedHistory.ok && Array.isArray(refreshedHistory.runs)) {
          runs = [...refreshedHistory.runs];
        }
      }
    }
  }

  logBox.textContent = "";
  const chronological = [...runs].reverse();
  chronological.forEach((run, index) => renderRunLogGroup(run, index + 1, chronological.length));

  const latest = runs[0];
  if (latest?.status === "running") {
    const latestRunId = String(latest.runId || "").trim();
    if (latestRunId && activeRunIds.has(latestRunId)) {
      state.currentRunId = latestRunId;
      state.renderedRunId = latestRunId;
      setRunning(true);
      appendLog("已恢复最近未完成任务日志，继续监听进度...", "info");
      return;
    }
  }

  state.currentRunId = "";
  state.renderedRunId = latest?.runId || "";
  setRunning(false);
  if (autoRecovered) {
    appendLog("检测到历史任务异常中断，已自动标记为终止，可重新执行。", "warning");
  }
}

function renderRunLogGroup(run, idx, total) {
  const runId = String(run?.runId || "");
  if (logBox.textContent.trim()) {
    appendDivider();
  }

  const startAt = run?.startedAt ? new Date(run.startedAt).toLocaleString() : "";
  appendLog(`任务 ${idx}/${total} | Run ID: ${runId || "unknown"}${startAt ? ` | 开始于 ${startAt}` : ""}`, "info");

  const logs = Array.isArray(run?.logs) ? run.logs : [];
  logs.forEach((item) => {
    appendLog(item.message || "", item.level || "info", item.timestamp || "");
  });

  if (run?.status === "success") {
    appendLog("该任务状态：已完成。", "success");
  } else if (run?.status === "failed") {
    appendLog(`该任务状态：失败${run?.result?.error ? `（${run.result.error}）` : ""}`, "error");
  } else {
    appendLog("该任务状态：运行中。", "info");
  }
}

function ensureRunSection(runId, timestamp) {
  const normalizedRunId = String(runId || "");
  if (!normalizedRunId || normalizedRunId === state.renderedRunId) {
    return;
  }
  appendDivider();
  appendLog(`新任务开始（Run ID: ${normalizedRunId}）`, "info", timestamp);
  state.renderedRunId = normalizedRunId;
}

function startNewAttemptSection() {
  appendDivider();
  appendLog("已提交任务，开始执行...", "info");
}

async function runPreflightOnly() {
  const tabState = await refreshActiveTabContext();
  if (!tabState.ok) {
    appendLog(tabState.message || "未找到当前标签页。", "error");
    return;
  }
  if (!tabState.isBilibili) {
    appendLog("当前活动标签页不是 B 站视频详情页，请切换后再运行自检。", "error");
    return;
  }

  setChecking(true);
  appendLog("检查扩展后台连接...", "info");

  const ready = await ensureBackgroundReady();
  if (!ready.ok) {
    setChecking(false);
    appendLog(ready.error, "error");
    return;
  }

  appendLog(`后台连接正常（版本 ${ready.version || "unknown"}）。`, "success");
  appendLog("开始运行前自检...", "info");

  const response = await callRuntime("RUN_PREFLIGHT", { tabId: state.activeTabId });
  setChecking(false);

  if (!response.ok) {
    appendLog(`自检失败：${response.error || "未知错误"}`, "error");
    return;
  }

  renderPreflightResult(response.result);
}

function renderPreflightResult(result) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  if (checks.length === 0) {
    appendLog("自检完成：未返回检查项。", "warning");
    return;
  }

  checks.forEach((item) => {
    const level = item?.level === "pass" ? "success" : item?.level === "warn" ? "warning" : "error";
    appendLog(`[自检] ${item?.name || "检查项"}：${item?.message || "无信息"}`, level);
  });

  if (result.ok) {
    appendLog("自检通过。", "success");
  } else {
    appendLog(`自检未通过：${result.failCount || 0} 项失败。`, "error");
  }
}

function renderResult(result) {
  const videoTitle = result?.transcriptPayload?.video?.title || "未知标题";
  const createdAt = result?.createdAt || result?.timestamp || "";
  const importResult = result?.importResult || {};
  const transcriptImport = importResult?.transcriptImport || null;

  state.lastNote = result?.noteMarkdown || "";

  const lines = [
    `视频：${videoTitle}`,
    createdAt ? `时间：${new Date(createdAt).toLocaleString()}` : "",
    importResult.wikiUrl
      ? "主笔记已导入飞书知识库"
      : importResult.documentUrl
      ? "主笔记文档已创建（未挂载知识库）"
      : "主笔记未导入飞书",
    transcriptImport?.wikiUrl
      ? "转写文档已导入飞书知识库"
      : transcriptImport?.documentUrl
      ? "转写文档已创建（未挂载知识库）"
      : ""
  ];

  resultMeta.textContent = lines.filter(Boolean).join("\n");

  if (importResult.wikiUrl) {
    wikiLink.href = importResult.wikiUrl;
    wikiLink.classList.remove("hidden");
  } else if (importResult.documentUrl) {
    wikiLink.href = importResult.documentUrl;
    wikiLink.classList.remove("hidden");
  } else if (transcriptImport?.wikiUrl) {
    wikiLink.href = transcriptImport.wikiUrl;
    wikiLink.classList.remove("hidden");
  } else if (transcriptImport?.documentUrl) {
    wikiLink.href = transcriptImport.documentUrl;
    wikiLink.classList.remove("hidden");
  } else {
    wikiLink.classList.add("hidden");
  }
}

function setRunning(flag) {
  state.isRunning = Boolean(flag);
  applyActionButtonState();
}

function setChecking(flag) {
  state.isChecking = Boolean(flag);
  applyActionButtonState();
}

function applyActionButtonState() {
  const canRunOrCheck = state.isBilibili && !state.isRunning && !state.isChecking;
  runBtn.disabled = !canRunOrCheck;
  checkBtn.disabled = !canRunOrCheck;
  if (stopBtn) {
    stopBtn.disabled = !state.isRunning;
  }
}

function appendLog(text, level = "info", timestamp = "") {
  const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  const levelText = level === "error" ? "错误" : level === "success" ? "完成" : level === "warning" ? "提示" : "信息";
  const line = `[${time}] [${levelText}] ${text}`;
  logBox.textContent = `${logBox.textContent}\n${line}`.trim();
  logBox.scrollTop = logBox.scrollHeight;
}

function appendDivider() {
  const line = "------------------------------------------------------------";
  logBox.textContent = `${logBox.textContent}\n${line}`.trim();
  logBox.scrollTop = logBox.scrollHeight;
}

function callRuntime(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        const message = String(runtimeError.message || "");
        if (message.includes("The message port closed before a response was received")) {
          resolve({
            ok: false,
            code: "PORT_CLOSED",
            error: "扩展后台未返回响应（message port closed）。请刷新扩展后重试。"
          });
          return;
        }
        resolve({ ok: false, code: "RUNTIME_ERROR", error: message || "运行时错误" });
        return;
      }
      resolve(response || { ok: false, error: "空响应" });
    });
  });
}

async function refreshActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTabId = tab?.id || null;
  const isBilibili = Boolean(tab?.url && /https:\/\/www\.bilibili\.com\/video\//.test(tab.url));
  state.isBilibili = isBilibili;

  if (isBilibili) {
    tabHint.textContent = "当前页面已支持，可先运行前自检再一键执行。";
  } else {
    tabHint.textContent = "请先切换到 B 站视频详情页。";
  }
  applyActionButtonState();

  if (!tab) {
    return { ok: false, isBilibili: false, message: "未检测到活动标签页。" };
  }
  return { ok: true, isBilibili, tabId: state.activeTabId, url: tab.url || "" };
}

async function ensureBackgroundReady() {
  const first = await callRuntime("PING");
  if (first?.ok) {
    return { ok: true, version: first.version };
  }

  if (first?.code === "PORT_CLOSED") {
    await sleep(250);
    const second = await callRuntime("PING");
    if (second?.ok) {
      return { ok: true, version: second.version };
    }
  }

  return {
    ok: false,
    error:
      "扩展后台连接失败：Service Worker 可能未启动或已崩溃。请到 edge://extensions 刷新本扩展，并查看 Service Worker 控制台错误。"
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
