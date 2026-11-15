"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function extractDroppedPaths(fileList) {
  if (!fileList) return [];
  const out = [];
  const length = typeof fileList.length === "number" ? fileList.length : 0;
  for (let i = 0; i < length; i++) {
    const file = fileList[i];
    if (!file) continue;
    let resolved = "";
    if (webUtils && typeof webUtils.getPathForFile === "function") {
      try {
        resolved = webUtils.getPathForFile(file) || "";
      } catch {
        resolved = "";
      }
    }
    if (!resolved && typeof file.path === "string") {
      resolved = file.path;
    }
    if (resolved) {
      out.push(resolved);
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
  pickInputs: (mode) => ipcRenderer.invoke("desktop:pick-inputs", mode === "folders" ? "folders" : "files"),
  pickOutputDir: () => ipcRenderer.invoke("desktop:pick-output-dir"),
  scanPaths: (paths, options) =>
    ipcRenderer.invoke("desktop:scan-paths", {
      paths: Array.isArray(paths) ? paths : [],
      options: options || {},
    }),
  extractDroppedPaths,
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
