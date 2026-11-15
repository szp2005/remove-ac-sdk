"use strict";

(() => {
  const bridge = window.removeAcDesktop;

  const I18N = {
    en: {
      toggleLangLabel: "简体中文",
      creditsUnconnected: "API Key Required",
      creditsBalance: (n) => `${n} Credits`,
      buyCredits: "Get Credits",
      dropTitle: "Drag & drop images or entire folders here",
      dropSub: "PNG, JPG, WebP up to 25 MB & 40 MP per image · Zero disk storage on Cloud GPU",
      selectImages: "+ Select Images",
      selectFolder: "+ Select Folder",
      imagesCount: (n) => `${n} ${n === 1 ? "image" : "images"}`,
      queueReadyHint: "Ready for batch processing",
      openOutputFolder: "Open Output Folder",
      clearFinished: "Clear Finished",
      clearAll: "Clear All",
      emptyQueueDesc:
        "No images in queue yet. Drop product photos, portraits, or multi-level folders above to start.",
      statusIdle: "Idle",
      statusRunning: (done, total) => `Processing ${done} / ${total}…`,
      statusCompleted: (ok, skip, fail) =>
        `Finished: ${ok} cutout${ok === 1 ? "" : "s"}${skip ? `, ${skip} skipped` : ""}${fail ? `, ${fail} failed` : ""}`,
      creditsUsed: (c) => `${c} credits used`,
      cancelBatch: "Stop",
      startBatch: "Start Batch Cutout",
      apiKeyHeading: "Cloud GPU API Key",
      getFreeKey: "Get Key (1 Free Credit) ↗",
      replaceKey: "Change",
      clearKey: "Clear",
      saveVerifyKey: "Save & Verify",
      apiKeyHint: "Encrypted locally via Windows DPAPI / macOS Keychain.",
      apiKeySessionOnly: "Session-only memory mode (OS keyring unavailable).",
      apiKeyVerified: (c) => `Connected · ${c} credits available`,
      keyBadgeEncrypted: "Encrypted in OS Keychain",
      keyBadgeSession: "Session Memory Only",
      outputSettingsHeading: "Cutout & Export Settings",
      bgLabel: "Background",
      bgTransparent: "Transparent",
      bgWhite: "Pure White (#FFFFFF)",
      bgCustom: "Custom Solid Color",
      bgZip: "4-File Editable Layer Pack (.zip)",
      customColorLabel: "Background Hex",
      formatLabel: "Format",
      resolutionLabel: "Resolution",
      sizeFull: "Full (up to 25 MP)",
      sizePreview: "Preview (0.25 MP)",
      size4k: "4K (up to 10 MP)",
      sizeHd: "HD (up to 4 MP)",
      autoCropLabel: "Trim transparent bounds (Auto-Crop)",
      cropMarginLabel: "Padding",
      addShadowLabel: "Add realistic ground/drop shadow",
      shadowStyleLabel: "Style",
      shadowDrop: "Drop",
      shadowAuto: "Auto",
      shadowCar: "Car / Vehicle",
      shadowSoft: "Soft",
      shadowContact: "Contact",
      workflowHeading: "Output Folder & Concurrency",
      outputFolderLabel: "Destination Folder",
      defaultOutputDir: "Auto (remove-ac-output next to source)",
      chooseBtn: "Choose…",
      resetBtn: "Reset",
      concurrencyLabel: "Parallel GPU Workers",
      recursiveLabel: "Scan subfolders & preserve folder tree",
      skipExistingLabel: "Skip images that already have cutouts",
      previewCutout: "Cutout Result",
      previewOriginal: "Original",
      revealInFolder: "Show in Folder",
      badgeQueued: "Queued",
      badgeProcessing: "Processing…",
      badgeDone: "Done",
      badgeSkipped: "Skipped",
      badgeCancelled: "Cancelled",
      badgeError: "Failed",
      btnPreview: "Preview",
      btnReveal: "Folder",
      btnRemove: "✕",
      needApiKeyAlert: "Please paste and verify your remove.ac API Key on the right panel first.",
    },
    "zh-CN": {
      toggleLangLabel: "English",
      creditsUnconnected: "未配置 API 密钥",
      creditsBalance: (n) => `余额 ${n} 积分`,
      buyCredits: "充值 / 获取积分",
      dropTitle: "拖拽图片或整个文件夹到此处",
      dropSub: "支持 PNG、JPG、WebP（单张最高 25 MB / 4000 万像素）· 云端 GPU 内存流式零落盘",
      selectImages: "+ 选择多张图片",
      selectFolder: "+ 选择整个文件夹",
      imagesCount: (n) => `共 ${n} 张图片`,
      queueReadyHint: "就绪，可随时开始批量抠图",
      openOutputFolder: "打开输出目录",
      clearFinished: "清理已完成",
      clearAll: "清空队列",
      emptyQueueDesc: "队列为空。将商品图、人像或包含多级子目录的文件夹拖入上方框内即可批量抠图。",
      statusIdle: "待命",
      statusRunning: (done, total) => `正在批量处理 ${done} / ${total}…`,
      statusCompleted: (ok, skip, fail) =>
        `处理完成：成功 ${ok} 张${skip ? `，跳过 ${skip} 张` : ""}${fail ? `，失败 ${fail} 张` : ""}`,
      creditsUsed: (c) => `本次消耗 ${c} 积分`,
      cancelBatch: "停止",
      startBatch: "开始批量抠图",
      apiKeyHeading: "Cloud GPU API 密钥",
      getFreeKey: "免费领密钥 (送 1 积分) ↗",
      replaceKey: "更换",
      clearKey: "清除",
      saveVerifyKey: "保存并验证",
      apiKeyHint: "使用系统级加密（Windows DPAPI / macOS 钥匙串）安全存储于本机。",
      apiKeySessionOnly: "当前系统密钥环不可用，密钥仅保存在本次内存会话中。",
      apiKeyVerified: (c) => `已连接 · 当前可用 ${c} 积分`,
      keyBadgeEncrypted: "系统钥匙串已加密",
      keyBadgeSession: "仅当前会话内存",
      outputSettingsHeading: "抠图与导出参数",
      bgLabel: "背景模式",
      bgTransparent: "透明背景 (Alpha)",
      bgWhite: "纯白电商底 (#FFFFFF)",
      bgCustom: "自定义纯色背景",
      bgZip: "4 文件可编辑图层包 (.zip)",
      customColorLabel: "背景色号",
      formatLabel: "导出格式",
      resolutionLabel: "输出分辨率",
      sizeFull: "原图全高清 (最高 25MP)",
      sizePreview: "预览尺寸 (0.25MP · 0.25积分)",
      size4k: "4K 超清 (最高 10MP)",
      sizeHd: "HD 高清 (最高 4MP)",
      autoCropLabel: "自动裁切四周多余透明边",
      cropMarginLabel: "留白边距",
      addShadowLabel: "添加自然落地阴影 / 投影",
      shadowStyleLabel: "阴影样式",
      shadowDrop: "标准投影",
      shadowAuto: "智能自适应",
      shadowCar: "汽车接地阴影",
      shadowSoft: "柔和漫射",
      shadowContact: "底部接触阴影",
      workflowHeading: "输出目录与并发加速",
      outputFolderLabel: "保存目录",
      defaultOutputDir: "自动（原图旁新建 remove-ac-output）",
      chooseBtn: "选择目录…",
      resetBtn: "恢复默认",
      concurrencyLabel: "GPU 并发线程数",
      recursiveLabel: "递归扫描子文件夹并保持目录层级",
      skipExistingLabel: "跳过已存在抠图结果的图片",
      previewCutout: "抠图结果",
      previewOriginal: "原图对比",
      revealInFolder: "在文件夹中显示",
      badgeQueued: "排队中",
      badgeProcessing: "抠图中…",
      badgeDone: "已完成",
      badgeSkipped: "已跳过",
      badgeCancelled: "已取消",
      badgeError: "失败",
      btnPreview: "对比预览",
      btnReveal: "定位文件",
      btnRemove: "✕",
      needApiKeyAlert: "请先在右侧面板粘贴并验证您的 remove.ac API 密钥。",
    },
  };

  const state = {
    lang: "en",
    hasApiKey: false,
    maskedKey: "",
    encryptionAvailable: true,
    persistedKey: false,
    credits: null,
    creditsUsedLastRun: 0,
    isRunning: false,
    settings: {
      size: "full",
      format: "png",
      bgMode: "transparent",
      bgColor: "FFFFFF",
      crop: false,
      cropMargin: "5%",
      addShadow: false,
      shadowType: "drop",
      concurrency: 3,
      recursive: true,
      skipExisting: false,
      outputDir: "",
      language: "auto",
    },
    queue: [],
    lastOutputDir: "",
    previewItem: null,
    previewMode: "after",
  };

  const el = (id) => document.getElementById(id);

  function t(key, ...args) {
    const dict = I18N[state.lang] || I18N.en;
    const val = dict[key] ?? I18N.en[key] ?? key;
    return typeof val === "function" ? val(...args) : val;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function resolveLanguage(pref, osLocale) {
    if (pref === "zh-CN" || pref === "en") return pref;
    return String(osLocale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function applyTranslations() {
    document.documentElement.lang = state.lang;
    el("langToggleBtn").textContent = t("toggleLangLabel");
    const nodes = document.querySelectorAll("[data-i18n]");
    for (const node of nodes) {
      const key = node.getAttribute("data-i18n");
      if (key) {
        node.textContent = t(key);
      }
    }
    if (!state.isRunning) {
      el("creditsUsedText").textContent = t("creditsUsed", state.creditsUsedLastRun);
    }
    renderHeaderCredits();
    renderKeySection();
    renderSettingsControls();
    renderQueue();
  }

  function renderHeaderCredits() {
    const dot = el("creditDot");
    const label = el("creditLabel");
    dot.className = "credit-dot";
    if (!state.hasApiKey) {
      label.textContent = t("creditsUnconnected");
      return;
    }
    if (state.credits !== null && Number.isFinite(state.credits)) {
      label.textContent = t("creditsBalance", state.credits);
      dot.classList.add(state.credits > 0 ? "connected" : "low");
    } else {
      label.textContent = state.maskedKey || "Connected";
      dot.classList.add("connected");
    }
  }

  function renderKeySection() {
    const savedBox = el("savedKeyBox");
    const editorBox = el("keyEditorBox");
    const badge = el("keyStorageBadge");
    const note = el("apiKeyFeedback");
    if (!note.classList.contains("error") && !note.classList.contains("ok")) {
      note.textContent = state.encryptionAvailable ? t("apiKeyHint") : t("apiKeySessionOnly");
    }
    if (state.hasApiKey) {
      savedBox.hidden = false;
      editorBox.hidden = true;
      el("maskedKeyText").textContent = state.maskedKey;
      badge.textContent = state.encryptionAvailable
        ? t("keyBadgeEncrypted")
        : t("keyBadgeSession");
    } else {
      savedBox.hidden = true;
      editorBox.hidden = false;
    }
  }

  function renderSettingsControls() {
    const s = state.settings;
    el("bgModeSelect").value = s.bgMode;
    el("customColorRow").hidden = s.bgMode !== "color";
    const hexWithHash = `#${s.bgColor || "FFFFFF"}`;
    el("bgColorPicker").value = hexWithHash.toLowerCase();
    el("bgColorHexInput").value = hexWithHash.toUpperCase();

    const formatSelect = el("formatSelect");
    if (s.bgMode === "zip") {
      formatSelect.value = "zip";
      formatSelect.disabled = true;
    } else {
      formatSelect.disabled = false;
      if (s.format === "zip") s.format = "png";
      formatSelect.value = s.format;
    }

    el("sizeSelect").value = s.size;
    el("cropCheckbox").checked = Boolean(s.crop);
    el("cropMarginRow").hidden = !s.crop;
    el("cropMarginSelect").value = s.cropMargin;

    el("shadowCheckbox").checked = Boolean(s.addShadow);
    el("shadowTypeRow").hidden = !s.addShadow;
    el("shadowTypeSelect").value = s.shadowType;

    el("concurrencyRange").value = String(s.concurrency);
    el("concurrencyValue").textContent = `${s.concurrency}×`;
    el("recursiveCheckbox").checked = Boolean(s.recursive);
    el("skipExistingCheckbox").checked = Boolean(s.skipExisting);

    if (s.outputDir) {
      el("outputDirLabel").textContent = s.outputDir;
      el("outputDirLabel").title = s.outputDir;
      el("resetOutputDirBtn").hidden = false;
    } else {
      el("outputDirLabel").textContent = t("defaultOutputDir");
      el("outputDirLabel").title = "";
      el("resetOutputDirBtn").hidden = true;
    }

    const effectiveOutDir = s.outputDir || state.lastOutputDir;
    el("openOutputFolderBtn").hidden = !effectiveOutDir;
  }

  function updateRunButtons() {
    const actionableCount = state.queue.filter(
      (item) => item.status === "queued" || item.status === "error" || item.status === "cancelled"
    ).length;
    el("startBatchBtn").disabled = state.isRunning || actionableCount === 0;
    el("cancelBatchBtn").hidden = !state.isRunning;
  }

  function renderQueue() {
    el("queueCountText").textContent = t("imagesCount", state.queue.length);
    const emptyEl = el("queueEmptyState");
    const listEl = el("queueList");
    listEl.replaceChildren();

    if (state.queue.length === 0) {
      emptyEl.hidden = false;
      updateRunButtons();
      return;
    }
    emptyEl.hidden = true;

    const fragment = document.createDocumentFragment();
    for (const item of state.queue) {
      const row = document.createElement("div");
      row.className = "queue-row";
      row.dataset.id = item.id;

      const mainDiv = document.createElement("div");
      mainDiv.className = "item-main";

      const nameLine = document.createElement("div");
      nameLine.className = "item-name-line";
      const nameSpan = document.createElement("span");
      nameSpan.className = "item-name";
      nameSpan.textContent = item.relSubdir
        ? `${item.relSubdir}/${item.fileName}`
        : item.fileName;
      nameSpan.title = item.inputPath;
      nameLine.appendChild(nameSpan);
      mainDiv.appendChild(nameLine);

      const subDiv = document.createElement("div");
      subDiv.className = "item-sub";
      if (item.status === "error" && item.errorMessage) {
        subDiv.classList.add("error-text");
        subDiv.textContent = `${formatBytes(item.byteLength)} · ${item.errorMessage}`;
      } else if (item.status === "done") {
        const dimPart = item.width && item.height ? ` · ${item.width}×${item.height}` : "";
        const timePart = item.elapsedMs ? ` · ${(item.elapsedMs / 1000).toFixed(1)}s` : "";
        subDiv.textContent = `${formatBytes(item.byteLength)}${dimPart}${timePart}`;
      } else {
        subDiv.textContent = formatBytes(item.byteLength);
      }
      mainDiv.appendChild(subDiv);

      const badge = document.createElement("span");
      badge.className = `status-badge ${item.status}`;
      const statusMap = {
        queued: "badgeQueued",
        processing: "badgeProcessing",
        done: "badgeDone",
        skipped: "badgeSkipped",
        cancelled: "badgeCancelled",
        error: "badgeError",
      };
      badge.textContent = t(statusMap[item.status] || "badgeQueued");

      const actionsDiv = document.createElement("div");
      actionsDiv.className = "item-actions";

      if (
        (item.status === "done" || item.status === "skipped") &&
        item.outputPath &&
        !item.outputPath.toLowerCase().endsWith(".zip")
      ) {
        const previewBtn = document.createElement("button");
        previewBtn.type = "button";
        previewBtn.className = "text-btn";
        previewBtn.textContent = t("btnPreview");
        previewBtn.addEventListener("click", () => openPreviewModal(item));
        actionsDiv.appendChild(previewBtn);
      }

      if (item.outputPath && (item.status === "done" || item.status === "skipped")) {
        const revealBtn = document.createElement("button");
        revealBtn.type = "button";
        revealBtn.className = "text-btn";
        revealBtn.textContent = t("btnReveal");
        revealBtn.addEventListener("click", () => bridge.revealFile(item.outputPath));
        actionsDiv.appendChild(revealBtn);
      }

      if (!state.isRunning) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "text-btn danger";
        removeBtn.textContent = t("btnRemove");
        removeBtn.addEventListener("click", () => {
          state.queue = state.queue.filter((q) => q.id !== item.id);
          renderQueue();
        });
        actionsDiv.appendChild(removeBtn);
      }

      row.appendChild(mainDiv);
      row.appendChild(badge);
      row.appendChild(actionsDiv);
      fragment.appendChild(row);
    }

    listEl.appendChild(fragment);
    updateRunButtons();
  }

  function appendScannedItems(scannedItems) {
    if (!Array.isArray(scannedItems) || scannedItems.length === 0) return;
    const existingPaths = new Set(state.queue.map((item) => item.inputPath));
    for (const raw of scannedItems) {
      if (existingPaths.has(raw.inputPath)) continue;
      existingPaths.add(raw.inputPath);
      state.queue.push({
        ...raw,
        status: "queued",
        outputPath: "",
        width: 0,
        height: 0,
        creditsCharged: 0,
        elapsedMs: 0,
        errorMessage: "",
      });
    }
    renderQueue();
  }

  async function persistSettings(partial) {
    Object.assign(state.settings, partial);
    const res = await bridge.saveSettings(state.settings);
    if (res?.ok && res.settings) {
      state.settings = res.settings;
    }
    renderSettingsControls();
  }

  async function openPreviewModal(item) {
    state.previewItem = item;
    state.previewMode = "after";
    el("previewModalTitle").textContent = item.fileName;
    el("previewMetaText").textContent = item.outputPath || "";
    el("previewModal").hidden = false;
    await refreshPreviewStage();
  }

  async function refreshPreviewStage() {
    const item = state.previewItem;
    if (!item) return;
    el("previewTabAfter").classList.toggle("active", state.previewMode === "after");
    el("previewTabBefore").classList.toggle("active", state.previewMode === "before");
    const targetPath = state.previewMode === "after" ? item.outputPath : item.inputPath;
    const imgEl = el("previewImageEl");
    imgEl.removeAttribute("src");
    const res = await bridge.readPreviewDataUrl(targetPath);
    if (res?.ok && res.dataUrl) {
      imgEl.src = res.dataUrl;
    }
  }

  function wireEvents() {
    el("langToggleBtn").addEventListener("click", async () => {
      state.lang = state.lang === "zh-CN" ? "en" : "zh-CN";
      await persistSettings({ language: state.lang });
      applyTranslations();
    });

    el("buyCreditsBtn").addEventListener("click", () => bridge.openExternalLink("pricing"));
    el("getApiKeyLinkBtn").addEventListener("click", () => bridge.openExternalLink("dashboard"));

    el("refreshAccountBtn").addEventListener("click", async () => {
      const res = await bridge.fetchAccount();
      if (res?.ok && res.account) {
        state.credits = res.account.totalCredits;
        renderHeaderCredits();
      }
    });

    el("saveApiKeyBtn").addEventListener("click", async () => {
      const raw = el("apiKeyInput").value.trim();
      const note = el("apiKeyFeedback");
      note.className = "panel-note";
      if (!raw) return;
      el("saveApiKeyBtn").disabled = true;
      try {
        const res = await bridge.setApiKey(raw);
        if (!res?.ok) {
          note.classList.add("error");
          note.textContent = res?.message || "Verification failed";
          return;
        }
        el("apiKeyInput").value = "";
        state.hasApiKey = res.keyStatus.hasApiKey;
        state.maskedKey = res.keyStatus.maskedKey;
        state.encryptionAvailable = res.keyStatus.encryptionAvailable;
        state.credits = res.account ? res.account.totalCredits : null;
        note.classList.add("ok");
        note.textContent = t("apiKeyVerified", state.credits ?? 0);
        renderHeaderCredits();
        renderKeySection();
      } finally {
        el("saveApiKeyBtn").disabled = false;
      }
    });

    el("changeKeyBtn").addEventListener("click", () => {
      el("savedKeyBox").hidden = true;
      el("keyEditorBox").hidden = false;
      el("apiKeyInput").focus();
    });

    el("removeKeyBtn").addEventListener("click", async () => {
      const res = await bridge.clearApiKey();
      if (res?.ok) {
        state.hasApiKey = false;
        state.maskedKey = "";
        state.credits = null;
        el("apiKeyFeedback").className = "panel-note";
        el("apiKeyFeedback").textContent = t("apiKeyHint");
        renderHeaderCredits();
        renderKeySection();
      }
    });

    el("pickFilesBtn").addEventListener("click", async () => {
      const res = await bridge.pickInputs("files");
      if (res?.ok && !res.canceled) appendScannedItems(res.items);
    });

    el("pickFoldersBtn").addEventListener("click", async () => {
      const res = await bridge.pickInputs("folders");
      if (res?.ok && !res.canceled) appendScannedItems(res.items);
    });

    // Drag and drop on dropzone + entire window
    const dz = el("dropzone");
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("drag-over");
    });
    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null) {
        dz.classList.remove("drag-over");
      }
    });
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      dz.classList.remove("drag-over");
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      const droppedPaths = bridge.extractDroppedPaths(files);
      if (droppedPaths.length > 0) {
        const res = await bridge.scanPaths(droppedPaths, {
          recursive: state.settings.recursive,
        });
        if (res?.ok) appendScannedItems(res.items);
      }
    });

    // Settings controls
    el("bgModeSelect").addEventListener("change", (e) => {
      const bgMode = e.target.value;
      const patch = { bgMode };
      if (bgMode === "zip") patch.format = "zip";
      else if (state.settings.format === "zip") patch.format = "png";
      persistSettings(patch);
    });

    el("bgColorPicker").addEventListener("input", (e) => {
      const hex = e.target.value.replace(/^#/, "").toUpperCase();
      el("bgColorHexInput").value = `#${hex}`;
      persistSettings({ bgColor: hex });
    });

    el("bgColorHexInput").addEventListener("change", (e) => {
      const cleaned = e.target.value.trim().replace(/^#/, "");
      if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        persistSettings({ bgColor: cleaned.toUpperCase() });
      } else {
        renderSettingsControls();
      }
    });

    el("formatSelect").addEventListener("change", (e) => {
      const format = e.target.value;
      const patch = { format };
      if (format === "zip") patch.bgMode = "zip";
      persistSettings(patch);
    });

    el("sizeSelect").addEventListener("change", (e) => persistSettings({ size: e.target.value }));
    el("cropCheckbox").addEventListener("change", (e) => persistSettings({ crop: e.target.checked }));
    el("cropMarginSelect").addEventListener("change", (e) =>
      persistSettings({ cropMargin: e.target.value })
    );
    el("shadowCheckbox").addEventListener("change", (e) =>
      persistSettings({ addShadow: e.target.checked })
    );
    el("shadowTypeSelect").addEventListener("change", (e) =>
      persistSettings({ shadowType: e.target.value })
    );

    el("concurrencyRange").addEventListener("input", (e) => {
      el("concurrencyValue").textContent = `${e.target.value}×`;
    });
    el("concurrencyRange").addEventListener("change", (e) =>
      persistSettings({ concurrency: Number.parseInt(e.target.value, 10) || 3 })
    );

    el("recursiveCheckbox").addEventListener("change", (e) =>
      persistSettings({ recursive: e.target.checked })
    );
    el("skipExistingCheckbox").addEventListener("change", (e) =>
      persistSettings({ skipExisting: e.target.checked })
    );

    el("chooseOutputDirBtn").addEventListener("click", async () => {
      const res = await bridge.pickOutputDir();
      if (res?.ok && !res.canceled && res.settings) {
        state.settings = res.settings;
        renderSettingsControls();
      }
    });

    el("resetOutputDirBtn").addEventListener("click", () => persistSettings({ outputDir: "" }));

    el("openOutputFolderBtn").addEventListener("click", () => {
      const dir = state.settings.outputDir || state.lastOutputDir;
      if (dir) bridge.openFolder(dir);
    });

    el("clearDoneBtn").addEventListener("click", () => {
      if (state.isRunning) return;
      state.queue = state.queue.filter(
        (item) => item.status !== "done" && item.status !== "skipped"
      );
      renderQueue();
    });

    el("clearAllBtn").addEventListener("click", () => {
      if (state.isRunning) return;
      state.queue = [];
      state.creditsUsedLastRun = 0;
      el("progressFill").style.width = "0%";
      el("progressStatusText").textContent = t("statusIdle");
      el("creditsUsedText").textContent = t("creditsUsed", 0);
      renderQueue();
    });

    el("startBatchBtn").addEventListener("click", async () => {
      if (state.isRunning) return;
      if (!state.hasApiKey) {
        const note = el("apiKeyFeedback");
        note.className = "panel-note error";
        note.textContent = t("needApiKeyAlert");
        el("apiKeyInput").focus();
        return;
      }

      const toRun = [];
      for (const item of state.queue) {
        if (
          item.status === "queued" ||
          item.status === "error" ||
          item.status === "cancelled"
        ) {
          item.status = "queued";
          item.errorMessage = "";
          toRun.push({
            id: item.id,
            inputPath: item.inputPath,
            relSubdir: item.relSubdir,
          });
        }
      }
      if (toRun.length === 0) return;

      state.isRunning = true;
      el("progressFill").style.width = "0%";
      el("progressStatusText").textContent = t("statusRunning", 0, toRun.length);
      el("creditsUsedText").textContent = t("creditsUsed", 0);
      renderQueue();

      const res = await bridge.startBatch({
        items: toRun,
        settings: state.settings,
      });

      state.isRunning = false;
      if (res?.ok && res.summary) {
        const s = res.summary;
        state.creditsUsedLastRun = s.creditsUsed || 0;
        el("progressFill").style.width = "100%";
        el("progressStatusText").textContent = t(
          "statusCompleted",
          s.completed,
          s.skipped,
          s.failed
        );
        el("creditsUsedText").textContent = t("creditsUsed", s.creditsUsed);
        if (res.account) {
          state.credits = res.account.totalCredits;
          renderHeaderCredits();
        }
      } else if (res && !res.ok) {
        el("progressStatusText").textContent = res.message || "Batch failed";
      }
      renderSettingsControls();
      renderQueue();
    });

    el("cancelBatchBtn").addEventListener("click", () => {
      bridge.cancelBatch();
    });

    // Live batch events
    bridge.onBatchEvent((evt) => {
      if (!evt) return;
      if (evt.type === "item" && evt.item) {
        const target = state.queue.find((q) => q.id === evt.item.id);
        if (target) {
          target.status = evt.item.status;
          if (evt.item.outputPath) {
            target.outputPath = evt.item.outputPath;
            const sepIdx = Math.max(
              evt.item.outputPath.lastIndexOf("/"),
              evt.item.outputPath.lastIndexOf("\\")
            );
            if (sepIdx > 0) {
              state.lastOutputDir = evt.item.outputPath.slice(0, sepIdx);
            }
          }
          if (evt.item.width) target.width = evt.item.width;
          if (evt.item.height) target.height = evt.item.height;
          if (evt.item.elapsedMs) target.elapsedMs = evt.item.elapsedMs;
          if (evt.item.errorMessage) target.errorMessage = evt.item.errorMessage;
          renderQueue();
        }
      } else if (evt.type === "progress" && evt.progress) {
        const p = evt.progress;
        const done = p.completed + p.skipped + p.failed + p.cancelled;
        const pct = p.total > 0 ? Math.min(100, Math.round((done / p.total) * 100)) : 0;
        el("progressFill").style.width = `${pct}%`;
        el("progressStatusText").textContent = t("statusRunning", done, p.total);
        el("creditsUsedText").textContent = t("creditsUsed", p.creditsUsed || 0);
      }
    });

    // Preview Modal events
    el("closePreviewModalBtn").addEventListener("click", () => {
      el("previewModal").hidden = true;
      state.previewItem = null;
    });
    el("previewModal").addEventListener("click", (e) => {
      if (e.target === el("previewModal")) {
        el("previewModal").hidden = true;
        state.previewItem = null;
      }
    });
    el("previewTabAfter").addEventListener("click", () => {
      state.previewMode = "after";
      refreshPreviewStage();
    });
    el("previewTabBefore").addEventListener("click", () => {
      state.previewMode = "before";
      refreshPreviewStage();
    });
    el("previewRevealBtn").addEventListener("click", () => {
      if (state.previewItem?.outputPath) {
        bridge.revealFile(state.previewItem.outputPath);
      }
    });
  }

  async function init() {
    wireEvents();
    const boot = await bridge.getBootstrap();
    if (boot?.ok) {
      el("appVersionBadge").textContent = `Desktop v${boot.version}`;
      state.settings = boot.settings || state.settings;
      state.lang = resolveLanguage(state.settings.language, boot.osLocale);
      state.hasApiKey = Boolean(boot.keyStatus?.hasApiKey);
      state.maskedKey = boot.keyStatus?.maskedKey || "";
      state.encryptionAvailable = Boolean(boot.keyStatus?.encryptionAvailable);
      if (!state.encryptionAvailable) {
        el("apiKeyFeedback").textContent = t("apiKeySessionOnly");
      }
    }
    applyTranslations();

    if (state.hasApiKey) {
      const acc = await bridge.fetchAccount();
      if (acc?.ok && acc.account) {
        state.credits = acc.account.totalCredits;
        renderHeaderCredits();
      }
    }
  }

  init();
})();
