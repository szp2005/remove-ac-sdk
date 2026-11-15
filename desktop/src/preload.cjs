"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

/**
 * Extracts real filesystem paths strictly from native Chromium File objects via Electron's
 * C++-backed `webUtils.getPathForFile(file)`. Plain JS objects with spoofed `.path` properties
 * are rejected, and raw string-array scan IPC is never exposed to the renderer world.
 */
function extractTrustedDroppedPaths(fileList) {
  if (!fileList || !webUtils || typeof webUtils.getPathForFile !== "function") {
    return [];
  }
  const out = [];
  const length = typeof fileList.length === "number" ? fileList.length : 0;
  for (let i = 0; i < length; i++) {
    const file = fileList[i];
    if (!file || typeof file !== "object") continue;
    try {
      const resolved = webUtils.getPathForFile(file);
      if (typeof resolved === "string" && resolved.trim()) {
        out.push(resolved.trim());
      }
    } catch {
      // Reject non-native File objects
    }
  }
  return out;
}

contextBridge.exposeInMainWorld("removeAcDesktop", {
  getBootstrap: () => ipcRenderer.invoke("desktop:get-bootstrap"),
  setApiKey: (apiKey) => ipcRenderer.invoke("desktop:set-api-key", String(apiKey ?? "")),
  clearApiKey: () => ipcRenderer.invoke("desktop:clear-api-key"),
  fetchAccount: () => ipcRenderer.invoke("desktop:fetch-account"),
  saveSettings: (partial) => ipcRenderer.invoke("desktop:save-settings", partial || {}),
  pickInputs: (mode) =>
    ipcRenderer.invoke("desktop:pick-inputs", mode === "folders" ? "folders" : "files"),
  pickOutputDir: () => ipcRenderer.invoke("desktop:pick-output-dir"),
  scanDroppedFiles: async (fileList, options) => {
    const paths = extractTrustedDroppedPaths(fileList);
    if (paths.length === 0) {
      return { ok: true, items: [], skippedUnsupported: 0 };
    }
    return ipcRenderer.invoke("desktop:scan-paths", {
      paths,
      options: options || {},
    });
  },
  startBatch: (payload) => ipcRenderer.invoke("desktop:start-batch", payload || {}),
  cancelBatch: () => ipcRenderer.invoke("desktop:cancel-batch"),
  readPreviewDataUrl: (filePath) =>
    ipcRenderer.invoke("desktop:read-preview-data-url", String(filePath ?? "")),
  revealFile: (filePath) => ipcRenderer.invoke("desktop:reveal-file", String(filePath ?? "")),
  openFolder: (folderPath) => ipcRenderer.invoke("desktop:open-folder", String(folderPath ?? "")),
  openExternalLink: (targetKey) =>
    ipcRenderer.invoke("desktop:open-external", String(targetKey ?? "")),
  onBatchEvent: (listener) => {
    if (typeof listener !== "function") return () => {};
    const wrapped = (_event, data) => listener(data);
    ipcRenderer.on("desktop:batch-event", wrapped);
    return () => ipcRenderer.removeListener("desktop:batch-event", wrapped);
  },
});
