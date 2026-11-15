"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
} = require("electron");
const {
  CredentialManager,
  DesktopApiClient,
  DesktopAppError,
  collectInputItems,
  isPlausibleApiKey,
  resolveOutputTarget,
  runBatchQueue,
  sanitizeSettings,
  writeFileAtomically,
} = require("./core.cjs");
const pkg = require("../package.json");

const IS_SMOKE_TEST =
  process.argv.includes("--smoke-test") || process.env.REMOVE_AC_DESKTOP_SMOKE_TEST === "1";

const EXTERNAL_LINKS = Object.freeze({
  dashboard: "https://remove.ac/dashboard",
  pricing: "https://remove.ac/pricing",
  apiDocs: "https://remove.ac/api-info",
  desktopDocs: "https://remove.ac/plugins/desktop",
  privacy: "https://remove.ac/privacy",
});

const INDEX_HTML_PATH = path.resolve(__dirname, "renderer", "index.html");

function isExpectedRendererUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("file:")) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "file:") return false;
    const resolved = path.resolve(fileURLToPath(parsed));
    return process.platform === "win32"
      ? resolved.toLowerCase() === INDEX_HTML_PATH.toLowerCase()
      : resolved === INDEX_HTML_PATH;
  } catch {
    return false;
  }
}

let mainWindow = null;
let credentialManager = null;
let activeBatchController = null;

// Session allowlists so renderer IPC can only preview/reveal user-selected or app-generated paths.
// Maps resolved file path -> trusted { rootDir, relSubdir } recorded at scan/selection time.
const allowedFilePaths = new Map();
const allowedDirectoryPaths = new Set();

function registerAllowedFile(filePath, meta = null) {
  if (typeof filePath !== "string" || !filePath.trim()) return;
  const resolved = path.resolve(filePath);
  if (meta && typeof meta === "object") {
    allowedFilePaths.set(resolved, {
      rootDir:
        typeof meta.rootDir === "string" && meta.rootDir.trim()
          ? path.resolve(meta.rootDir)
          : null,
      relSubdir: typeof meta.relSubdir === "string" ? meta.relSubdir : "",
    });
  } else if (!allowedFilePaths.has(resolved)) {
    allowedFilePaths.set(resolved, { rootDir: null, relSubdir: "" });
  }
}

function registerAllowedDirectory(dirPath) {
  if (typeof dirPath !== "string" || !dirPath.trim()) return;
  allowedDirectoryPaths.add(path.resolve(dirPath));
}

function assertTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new DesktopAppError(403, "window_closed", "Main window is unavailable");
  }
  const frame = event?.senderFrame;
  if (!frame || frame !== mainWindow.webContents.mainFrame) {
    throw new DesktopAppError(403, "untrusted_sender", "Blocked untrusted IPC frame");
  }
  const currentUrl = frame.url || "";
  if (!isExpectedRendererUrl(currentUrl)) {
    throw new DesktopAppError(403, "untrusted_origin", "Blocked unexpected IPC origin");
  }
}

function getElectronFetch() {
  if (net && typeof net.fetch === "function") {
    return (url, init) => net.fetch(url, init);
  }
  return globalThis.fetch;
}

function sendBatchEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:batch-event", payload);
  }
}

function serializeError(err) {
  if (err instanceof DesktopAppError) {
    return {
      ok: false,
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
    };
  }
  return {
    ok: false,
    statusCode: 500,
    code: "unexpected_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function setupIpcHandlers() {
  ipcMain.handle("desktop:get-bootstrap", async (event) => {
    assertTrustedSender(event);
    const settings = credentialManager.loadSettings();
    if (settings.outputDir) {
      registerAllowedDirectory(settings.outputDir);
    }
    const keyStatus = await credentialManager.getKeyStatus();
    return {
      ok: true,
      version: pkg.version,
      platform: process.platform,
      arch: process.arch,
      osLocale: app.getLocale() || "en",
      keyStatus,
      settings,
    };
  });

  ipcMain.handle("desktop:set-api-key", async (event, rawKey) => {
    assertTrustedSender(event);
    try {
      const trimmed = typeof rawKey === "string" ? rawKey.trim() : "";
      if (!trimmed) {
        const keyStatus = await credentialManager.clearApiKey();
        return { ok: true, keyStatus, account: null };
      }
      if (!isPlausibleApiKey(trimmed)) {
        throw new DesktopAppError(
          400,
          "invalid_api_key_format",
          "API Key must start with 'rac_live_'"
        );
      }
      // Verify against /v1.0/account BEFORE persisting so an invalid/typo key never clobbers a saved valid key.
      const client = new DesktopApiClient({
        apiKey: trimmed,
        fetch: getElectronFetch(),
      });
      const account = await client.getAccount();
      const keyStatus = await credentialManager.setApiKey(trimmed);
      return { ok: true, keyStatus, account };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle("desktop:clear-api-key", async (event) => {
    assertTrustedSender(event);
    const keyStatus = await credentialManager.clearApiKey();
    return { ok: true, keyStatus };
  });

  ipcMain.handle("desktop:fetch-account", async (event) => {
    assertTrustedSender(event);
    try {
      const apiKey = await credentialManager.getApiKey();
      const keyStatus = await credentialManager.getKeyStatus();
      if (!apiKey) {
        return { ok: true, keyStatus, account: null };
      }
      const client = new DesktopApiClient({
        apiKey,
        fetch: getElectronFetch(),
      });
      const account = await client.getAccount();
      return { ok: true, keyStatus, account };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle("desktop:save-settings", (event, partial) => {
    assertTrustedSender(event);
    const settings = credentialManager.saveSettings(partial);
    if (settings.outputDir) {
      registerAllowedDirectory(settings.outputDir);
    }
    return { ok: true, settings };
  });

  ipcMain.handle("desktop:pick-inputs", async (event, mode) => {
    assertTrustedSender(event);
    const properties =
      mode === "folders"
        ? ["openDirectory", "multiSelections"]
        : ["openFile", "multiSelections"];
    const dialogOpts = {
      properties,
      ...(mode === "folders"
        ? {}
        : {
            filters: [
              {
                name: "Images (PNG, JPG, WebP)",
                extensions: ["png", "jpg", "jpeg", "webp"],
              },
            ],
          }),
    };
    const res = await dialog.showOpenDialog(mainWindow, dialogOpts);
    if (res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
      return { ok: true, canceled: true, items: [], skippedUnsupported: 0 };
    }
    const settings = credentialManager.loadSettings();
    const scanned = collectInputItems(res.filePaths, {
      recursive: settings.recursive,
      outputDir: settings.outputDir,
    });
    for (const item of scanned.items) {
      registerAllowedFile(item.inputPath, {
        rootDir: item.rootDir,
        relSubdir: item.relSubdir,
      });
    }
    return { ok: true, canceled: false, ...scanned };
  });

  ipcMain.handle("desktop:pick-output-dir", async (event) => {
    assertTrustedSender(event);
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !Array.isArray(res.filePaths) || !res.filePaths[0]) {
      return { ok: true, canceled: true };
    }
    const selected = path.resolve(res.filePaths[0]);
    registerAllowedDirectory(selected);
    const settings = credentialManager.saveSettings({ outputDir: selected });
    return { ok: true, canceled: false, outputDir: selected, settings };
  });

  ipcMain.handle("desktop:scan-paths", (event, payload) => {
    assertTrustedSender(event);
    const rawPaths = Array.isArray(payload?.paths) ? payload.paths : [];
    const saved = credentialManager.loadSettings();
    const scanned = collectInputItems(rawPaths, {
      recursive:
        payload?.options?.recursive !== undefined
          ? Boolean(payload.options.recursive)
          : saved.recursive,
      outputDir: saved.outputDir,
    });
    for (const item of scanned.items) {
      registerAllowedFile(item.inputPath, {
        rootDir: item.rootDir,
        relSubdir: item.relSubdir,
      });
    }
    return { ok: true, ...scanned };
  });

  ipcMain.handle("desktop:start-batch", async (event, payload) => {
    assertTrustedSender(event);
    if (activeBatchController) {
      return {
        ok: false,
        statusCode: 409,
        code: "batch_already_running",
        message: "A batch job is already running.",
      };
    }
    const apiKey = await credentialManager.getApiKey();
    if (!apiKey) {
      return {
        ok: false,
        statusCode: 403,
        code: "missing_api_key",
        message: "Please configure your remove.ac API Key before starting.",
      };
    }

    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const verifiedItems = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw.inputPath !== "string") continue;
      const resolvedInput = path.resolve(raw.inputPath);
      const trustedMeta = allowedFilePaths.get(resolvedInput);
      if (!trustedMeta) continue;
      verifiedItems.push({
        id: String(raw.id || ""),
        inputPath: resolvedInput,
        fileName: path.basename(resolvedInput),
        rootDir: trustedMeta.rootDir,
        relSubdir: trustedMeta.relSubdir,
      });
    }

    if (verifiedItems.length === 0) {
      return {
        ok: false,
        statusCode: 400,
        code: "empty_queue",
        message: "No valid images in queue.",
      };
    }

    const settings = sanitizeSettings({
      ...credentialManager.loadSettings(),
      ...(payload?.settings || {}),
    });
    credentialManager.saveSettings(settings);

    const controller = new AbortController();
    activeBatchController = controller;
    const reservedPaths = new Set();
    const client = new DesktopApiClient({
      apiKey,
      fetch: getElectronFetch(),
    });

    try {
      const summary = await runBatchQueue(
        verifiedItems,
        async (item, { signal }) => {
          const startedAt = Date.now();
          const target = resolveOutputTarget({
            item,
            outputDir: settings.outputDir,
            format: settings.bgMode === "zip" ? "zip" : settings.format,
            skipExisting: settings.skipExisting,
            reservedPaths,
          });
          registerAllowedDirectory(target.outputRootDir);
          registerAllowedDirectory(path.dirname(target.outputPath));
          if (target.skip) {
            registerAllowedFile(target.outputPath);
            return {
              skipped: true,
              outputPath: target.outputPath,
              outputRootDir: target.outputRootDir,
            };
          }
          const out = await client.removeBackgroundFile(item.inputPath, settings, {
            signal,
            idempotencyKey: `desk-${item.id}-${startedAt}`,
          });
          writeFileAtomically(target.outputPath, out.buffer);
          registerAllowedFile(target.outputPath);
          return {
            skipped: false,
            outputPath: target.outputPath,
            outputRootDir: target.outputRootDir,
            width: out.width,
            height: out.height,
            creditsCharged: out.creditsCharged,
            elapsedMs: Date.now() - startedAt,
          };
        },
        {
          concurrency: settings.concurrency,
          signal: controller.signal,
          onItemUpdate: (itemEvent) =>
            sendBatchEvent({ type: "item", item: itemEvent }),
          onProgress: (progress) =>
            sendBatchEvent({ type: "progress", progress }),
        }
      );

      let account = null;
      try {
        account = await client.getAccount();
      } catch {
        // non-fatal balance refresh
      }
      return { ok: true, summary, account };
    } catch (err) {
      return serializeError(err);
    } finally {
      if (activeBatchController === controller) {
        activeBatchController = null;
      }
    }
  });

  ipcMain.handle("desktop:cancel-batch", (event) => {
    assertTrustedSender(event);
    if (activeBatchController) {
      activeBatchController.abort();
      return { ok: true, cancelling: true };
    }
    return { ok: true, cancelling: false };
  });

  ipcMain.handle("desktop:read-preview-data-url", async (event, rawFilePath) => {
    assertTrustedSender(event);
    const resolved = path.resolve(String(rawFilePath || ""));
    if (!allowedFilePaths.has(resolved)) {
      return { ok: false, code: "forbidden_path", message: "Preview path is not authorized" };
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".zip") {
      return { ok: false, code: "zip_no_preview", message: "ZIP archive cannot be previewed inline" };
    }
    try {
      const st = await fs.promises.stat(resolved);
      if (!st.isFile() || st.size <= 0 || st.size > 30 * 1024 * 1024) {
        return { ok: false, code: "invalid_preview_size", message: "Preview unavailable" };
      }
      const img = nativeImage.createFromPath(resolved);
      if (!img.isEmpty()) {
        const sz = img.getSize();
        const previewImg = sz.width > 960 ? img.resize({ width: 960, quality: "good" }) : img;
        return {
          ok: true,
          dataUrl: previewImg.toDataURL(),
          width: sz.width,
          height: sz.height,
        };
      }
      if (st.size <= 15 * 1024 * 1024) {
        const buf = await fs.promises.readFile(resolved);
        const mime =
          ext === ".webp"
            ? "image/webp"
            : ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : "image/png";
        return {
          ok: true,
          dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
          width: 0,
          height: 0,
        };
      }
      return { ok: false, code: "decode_failed", message: "Preview unavailable" };
    } catch {
      return { ok: false, code: "read_error", message: "Preview unavailable" };
    }
  });

  ipcMain.handle("desktop:reveal-file", (event, rawFilePath) => {
    assertTrustedSender(event);
    const resolved = path.resolve(String(rawFilePath || ""));
    if (!allowedFilePaths.has(resolved) || !fs.existsSync(resolved)) {
      return { ok: false, code: "forbidden_path", message: "File path is not available" };
    }
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.handle("desktop:open-folder", async (event, rawFolderPath) => {
    assertTrustedSender(event);
    const resolved = path.resolve(String(rawFolderPath || ""));
    if (!allowedDirectoryPaths.has(resolved) || !fs.existsSync(resolved)) {
      return { ok: false, code: "forbidden_path", message: "Folder path is not available" };
    }
    let st;
    try {
      st = fs.lstatSync(resolved);
    } catch {
      return { ok: false, code: "missing_folder", message: "Folder does not exist" };
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, code: "invalid_folder", message: "Refused non-directory target" };
    }
    const errMsg = await shell.openPath(resolved);
    return errMsg ? { ok: false, code: "open_failed", message: errMsg } : { ok: true };
  });

  ipcMain.handle("desktop:open-external", async (event, targetKey) => {
    assertTrustedSender(event);
    const targetUrl = EXTERNAL_LINKS[targetKey];
    if (!targetUrl) {
      return { ok: false, code: "unknown_link", message: "Unsupported external link" };
    }
    await shell.openExternal(targetUrl);
    return { ok: true };
  });
}

function buildApplicationMenu() {
  if (process.platform === "darwin") {
    const template = [
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
}

function createMainWindow() {
  const iconCandidate = path.join(__dirname, "..", "build", "icon-256.png");
  const windowOpts = {
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    show: false,
    title: "Remove.ac — Bulk Background Remover",
    backgroundColor: "#F4F6FA",
    autoHideMenuBar: true,
    ...(fs.existsSync(iconCandidate) ? { icon: iconCandidate } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  };

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isExpectedRendererUrl(targetUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!IS_SMOKE_TEST && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  if (IS_SMOKE_TEST) {
    const failTimer = setTimeout(() => {
      console.error("[smoke-test] Timed out waiting for renderer bootstrap");
      app.exit(1);
    }, 15_000);

    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const probe = await mainWindow.webContents.executeJavaScript(
          `(async () => {
            const hasBridge = Boolean(window.removeAcDesktop && typeof window.removeAcDesktop.getBootstrap === "function");
            const boot = hasBridge ? await window.removeAcDesktop.getBootstrap() : null;
            return {
              hasBridge,
              ipcOk: Boolean(boot && boot.ok),
              version: boot ? boot.version : null,
              hasDropzone: Boolean(document.getElementById("dropzone")),
              title: document.title
            };
          })()`
        );
        clearTimeout(failTimer);
        if (probe && probe.hasBridge && probe.ipcOk && probe.hasDropzone) {
          console.log(`[smoke-test] OK (${JSON.stringify(probe)})`);
          app.exit(0);
        } else {
          console.error("[smoke-test] Renderer probe incomplete:", probe);
          app.exit(1);
        }
      } catch (err) {
        clearTimeout(failTimer);
        console.error("[smoke-test] Renderer probe failed:", err);
        app.exit(1);
      }
    });
  }

  mainWindow.loadFile(INDEX_HTML_PATH);
}

if (!IS_SMOKE_TEST) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}

app.whenReady().then(() => {
  if (IS_SMOKE_TEST && app.dock && typeof app.dock.hide === "function") {
    app.dock.hide();
  }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  credentialManager = new CredentialManager({
    storageDir: app.getPath("userData"),
    safeStorage: IS_SMOKE_TEST ? null : safeStorage,
  });

  buildApplicationMenu();
  setupIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || IS_SMOKE_TEST) {
    app.quit();
  }
});
