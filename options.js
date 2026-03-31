const elements = {
  llmBaseUrl: document.getElementById("llmBaseUrl"),
  llmApiKey: document.getElementById("llmApiKey"),
  llmModel: document.getElementById("llmModel"),
  llmTemperature: document.getElementById("llmTemperature"),
  llmMaxRetries: document.getElementById("llmMaxRetries"),
  noteDepth: document.getElementById("noteDepth"),
  enableAsrFallback: document.getElementById("enableAsrFallback"),
  requireAsrWhenNoSubtitle: document.getElementById("requireAsrWhenNoSubtitle"),
  asrBaseUrl: document.getElementById("asrBaseUrl"),
  asrApiKey: document.getElementById("asrApiKey"),
  asrModel: document.getElementById("asrModel"),
  asrMaxAudioMB: document.getElementById("asrMaxAudioMB"),
  asrMaxChunks: document.getElementById("asrMaxChunks"),
  asrMaxCandidates: document.getElementById("asrMaxCandidates"),
  feishuBaseUrl: document.getElementById("feishuBaseUrl"),
  feishuAppId: document.getElementById("feishuAppId"),
  feishuAppSecret: document.getElementById("feishuAppSecret"),
  feishuWikiSpaceId: document.getElementById("feishuWikiSpaceId"),
  feishuParentNodeToken: document.getElementById("feishuParentNodeToken"),
  feishuWikiObjType: document.getElementById("feishuWikiObjType"),
  autoImportToFeishu: document.getElementById("autoImportToFeishu"),
  enableStyleLearning: document.getElementById("enableStyleLearning"),
  sampleTitle: document.getElementById("sampleTitle"),
  sampleContent: document.getElementById("sampleContent"),
  sampleFiles: document.getElementById("sampleFiles"),
  addSampleBtn: document.getElementById("addSampleBtn"),
  refreshStyleBtn: document.getElementById("refreshStyleBtn"),
  styleProfileBox: document.getElementById("styleProfileBox"),
  sampleList: document.getElementById("sampleList"),
  saveBtn: document.getElementById("saveBtn"),
  statusText: document.getElementById("statusText")
};

let cacheSettings = null;
init().catch((error) => setStatus(`初始化失败：${error.message || String(error)}`, true));

elements.saveBtn.addEventListener("click", async () => {
  try {
    const settings = collectSettingsFromForm();
    const response = await callRuntime("SAVE_SETTINGS", { settings });
    if (!response.ok) {
      throw new Error(response.error || "保存失败");
    }
    cacheSettings = response.settings;
    renderSettings(cacheSettings);
    setStatus("设置已保存。");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

elements.addSampleBtn.addEventListener("click", async () => {
  const title = elements.sampleTitle.value.trim();
  const content = elements.sampleContent.value.trim();
  if (!content) {
    setStatus("请先输入样本内容。", true);
    return;
  }

  const response = await callRuntime("ADD_STYLE_SAMPLES", {
    samples: [{ title, content }]
  });
  if (!response.ok) {
    setStatus(response.error || "添加样本失败", true);
    return;
  }

  cacheSettings = response.settings;
  elements.sampleTitle.value = "";
  elements.sampleContent.value = "";
  renderSettings(cacheSettings);
  setStatus("样本已添加。");
});

elements.sampleFiles.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) {
    return;
  }

  const samples = [];
  for (const file of files) {
    const text = await file.text();
    const content = text.trim();
    if (content) {
      samples.push({
        title: file.name,
        content
      });
    }
  }

  if (samples.length === 0) {
    setStatus("未读取到可用文本样本。", true);
    return;
  }

  const response = await callRuntime("ADD_STYLE_SAMPLES", { samples });
  if (!response.ok) {
    setStatus(response.error || "导入文件样本失败", true);
    return;
  }

  cacheSettings = response.settings;
  elements.sampleFiles.value = "";
  renderSettings(cacheSettings);
  setStatus(`已导入 ${samples.length} 条样本。`);
});

elements.refreshStyleBtn.addEventListener("click", async () => {
  setStatus("正在生成风格画像...");
  const response = await callRuntime("REFRESH_STYLE_PROFILE");
  if (!response.ok) {
    setStatus(response.error || "生成失败", true);
    return;
  }

  cacheSettings = response.settings;
  renderSettings(cacheSettings);
  setStatus("风格画像已更新。");
});

async function init() {
  const response = await callRuntime("GET_SETTINGS");
  if (!response.ok) {
    throw new Error(response.error || "读取设置失败");
  }
  cacheSettings = response.settings;
  renderSettings(cacheSettings);
  setStatus("设置加载完成。");
}

function renderSettings(settings) {
  elements.llmBaseUrl.value = settings.llmBaseUrl || "";
  elements.llmApiKey.value = settings.llmApiKey || "";
  elements.llmModel.value = settings.llmModel || "";
  elements.llmTemperature.value = settings.llmTemperature ?? 0.3;
  elements.llmMaxRetries.value = settings.llmMaxRetries ?? 2;
  elements.noteDepth.value = settings.noteDepth || "standard";

  elements.enableAsrFallback.checked = Boolean(settings.enableAsrFallback);
  elements.requireAsrWhenNoSubtitle.checked = settings.requireAsrWhenNoSubtitle !== false;
  elements.asrBaseUrl.value = settings.asrBaseUrl || "";
  elements.asrApiKey.value = settings.asrApiKey || "";
  elements.asrModel.value = settings.asrModel || "whisper-1";
  elements.asrMaxAudioMB.value = settings.asrMaxAudioMB ?? 24;
  elements.asrMaxChunks.value = settings.asrMaxChunks ?? 6;
  elements.asrMaxCandidates.value = settings.asrMaxCandidates ?? 16;

  elements.feishuBaseUrl.value = settings.feishuBaseUrl || "";
  elements.feishuAppId.value = settings.feishuAppId || "";
  elements.feishuAppSecret.value = settings.feishuAppSecret || "";
  elements.feishuWikiSpaceId.value = settings.feishuWikiSpaceId || "";
  elements.feishuParentNodeToken.value = settings.feishuParentNodeToken || "";
  elements.feishuWikiObjType.value = settings.feishuWikiObjType || "docx";
  elements.autoImportToFeishu.checked = Boolean(settings.autoImportToFeishu);

  elements.enableStyleLearning.checked = Boolean(settings.enableStyleLearning);
  elements.styleProfileBox.textContent = settings.styleProfile
    ? JSON.stringify(settings.styleProfile, null, 2)
    : "暂无风格画像";

  renderSampleList(settings.styleSamples || []);
}

function renderSampleList(samples) {
  if (!samples.length) {
    elements.sampleList.innerHTML = "<p>暂无样本。</p>";
    return;
  }

  elements.sampleList.innerHTML = samples
    .map((sample) => {
      const title = escapeHtml(sample.title || "未命名样本");
      const content = escapeHtml(sample.content || "");
      const createdAt = sample.createdAt ? new Date(sample.createdAt).toLocaleString() : "";
      return `
        <article class="sample-item">
          <div class="sample-head">
            <span class="sample-title">${title}</span>
            <button class="btn" data-action="delete" data-id="${sample.id}">删除</button>
          </div>
          <div class="sample-content">${content}</div>
          <small>${escapeHtml(createdAt)}</small>
        </article>
      `;
    })
    .join("");

  const deleteButtons = elements.sampleList.querySelectorAll('[data-action="delete"]');
  deleteButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const sampleId = button.getAttribute("data-id");
      const response = await callRuntime("DELETE_STYLE_SAMPLE", { sampleId });
      if (!response.ok) {
        setStatus(response.error || "删除失败", true);
        return;
      }
      cacheSettings = response.settings;
      renderSettings(cacheSettings);
      setStatus("样本已删除。");
    });
  });
}

function collectSettingsFromForm() {
  return {
    llmBaseUrl: elements.llmBaseUrl.value.trim(),
    llmApiKey: elements.llmApiKey.value.trim(),
    llmModel: elements.llmModel.value.trim(),
    llmTemperature: toNumber(elements.llmTemperature.value, 0.3),
    llmMaxRetries: toInt(elements.llmMaxRetries.value, 2),
    noteDepth: elements.noteDepth.value,
    enableAsrFallback: elements.enableAsrFallback.checked,
    requireAsrWhenNoSubtitle: elements.requireAsrWhenNoSubtitle.checked,
    asrBaseUrl: elements.asrBaseUrl.value.trim(),
    asrApiKey: elements.asrApiKey.value.trim(),
    asrModel: elements.asrModel.value.trim() || "whisper-1",
    asrMaxAudioMB: toInt(elements.asrMaxAudioMB.value, 24),
    asrMaxChunks: toInt(elements.asrMaxChunks.value, 6),
    asrMaxCandidates: toInt(elements.asrMaxCandidates.value, 16),
    feishuBaseUrl: elements.feishuBaseUrl.value.trim(),
    feishuAppId: elements.feishuAppId.value.trim(),
    feishuAppSecret: elements.feishuAppSecret.value.trim(),
    feishuWikiSpaceId: elements.feishuWikiSpaceId.value.trim(),
    feishuParentNodeToken: elements.feishuParentNodeToken.value.trim(),
    feishuWikiObjType: elements.feishuWikiObjType.value.trim() || "docx",
    autoImportToFeishu: elements.autoImportToFeishu.checked,
    enableStyleLearning: elements.enableStyleLearning.checked
  };
}

function toNumber(input, fallback) {
  const value = Number.parseFloat(input);
  return Number.isNaN(value) ? fallback : value;
}

function toInt(input, fallback) {
  const value = Number.parseInt(input, 10);
  return Number.isNaN(value) ? fallback : value;
}

function setStatus(text, isError = false) {
  elements.statusText.textContent = text;
  elements.statusText.style.color = isError ? "#b4232f" : "#58655f";
}

function callRuntime(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ ok: false, error: runtimeError.message });
        return;
      }
      resolve(response || { ok: false, error: "空响应" });
    });
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
