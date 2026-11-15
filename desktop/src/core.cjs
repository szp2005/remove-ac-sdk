"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://remove.ac";
const MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_INPUT_PIXELS = 40_000_000; // 40 MP
const DIRECT_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MB Vercel payload threshold
const DIRECT_RGBA_PNG_PIXELS = 5_000_000;
const DIRECT_CROPPED_RGBA_PNG_PIXELS = 10_000_000;
const SUPPORTED_INPUT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const IGNORED_FILENAMES = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);
const PLAUSIBLE_API_KEY_RE = /^rac_live_[A-Za-z0-9_-]{4,128}$/;

const ALLOWED_SIZES = new Set(["auto", "full", "preview", "hd", "4k"]);
const ALLOWED_FORMATS = new Set(["png", "webp", "jpg", "zip"]);
const ALLOWED_BG_MODES = new Set(["transparent", "white", "color", "zip"]);
const ALLOWED_CROP_MARGINS = new Set(["0%", "5%", "10%", "15%"]);
const ALLOWED_SHADOW_TYPES = new Set(["auto", "drop", "car", "soft", "contact"]);
const ALLOWED_LANGUAGES = new Set(["auto", "zh-CN", "en"]);

class DesktopAppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "DesktopAppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isPlausibleApiKey(rawKey) {
  return typeof rawKey === "string" && PLAUSIBLE_API_KEY_RE.test(rawKey.trim());
}

function maskApiKey(rawKey) {
  if (typeof rawKey !== "string" || !rawKey.trim()) return "";
  const trimmed = rawKey.trim();
  if (trimmed.length <= 14) {
    return `${trimmed.slice(0, 4)}••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 9)}••••••••${trimmed.slice(-4)}`;
}

function normalizeHexColor(raw) {
  if (typeof raw !== "string") return "FFFFFF";
  const cleaned = raw.trim().replace(/^#+/, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(cleaned)) return cleaned;
  if (/^[0-9A-F]{3}$/.test(cleaned)) {
    return cleaned
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  return "FFFFFF";
}

function sanitizeSettings(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const size = ALLOWED_SIZES.has(input.size) ? input.size : "full";
  const bgMode = ALLOWED_BG_MODES.has(input.bgMode) ? input.bgMode : "transparent";
  let format = ALLOWED_FORMATS.has(input.format) ? input.format : "png";
  if (bgMode === "zip") {
    format = "zip";
  } else if (format === "zip") {
    format = "png";
  }
  const bgColor = normalizeHexColor(input.bgColor);
  const crop = Boolean(input.crop);
  const cropMargin = ALLOWED_CROP_MARGINS.has(input.cropMargin) ? input.cropMargin : "5%";
  const addShadow = Boolean(input.addShadow);
  const shadowType = ALLOWED_SHADOW_TYPES.has(input.shadowType) ? input.shadowType : "drop";
  const rawConcurrency = Number.parseInt(String(input.concurrency ?? 3), 10);
  const concurrency = Number.isFinite(rawConcurrency)
    ? Math.max(1, Math.min(8, rawConcurrency))
    : 3;
  const recursive = input.recursive !== undefined ? Boolean(input.recursive) : true;
  const skipExisting = input.skipExisting !== undefined ? Boolean(input.skipExisting) : false;
  const outputDir =
    typeof input.outputDir === "string" && input.outputDir.trim()
      ? path.resolve(input.outputDir.trim())
      : "";
  const language = ALLOWED_LANGUAGES.has(input.language) ? input.language : "auto";

  return {
    size,
    format,
    bgMode,
    bgColor,
    crop,
    cropMargin,
    addShadow,
    shadowType,
    concurrency,
    recursive,
    skipExisting,
    outputDir,
    language,
  };
}

function parseImageDimensions(input) {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : input instanceof Uint8Array
        ? input
        : Buffer.isBuffer(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : null;
  if (!bytes || bytes.byteLength < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return width > 0 && height > 0 && width <= 1_000_000 && height <= 1_000_000
      ? { width, height }
      : null;
  }

  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // WebP
  if (
    bytes.byteLength >= 25 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    if (
      bytes.byteLength >= 30 &&
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x20 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x4c &&
      bytes[20] === 0x2f
    ) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      const width = 1 + (b0 | ((b1 & 0x3f) << 8));
      const height = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (
      bytes.byteLength >= 30 &&
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x58
    ) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }

  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    for (let steps = 0; steps < 512 && pos + 3 < bytes.byteLength; steps++) {
      if (bytes[pos] !== 0xff) break;
      while (pos < bytes.byteLength && bytes[pos] === 0xff) pos++;
      if (pos >= bytes.byteLength) break;
      const marker = bytes[pos++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 1 >= bytes.byteLength) break;
      const segLen = (bytes[pos] << 8) | bytes[pos + 1];
      if (segLen < 2) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (pos + 6 >= bytes.byteLength) break;
        const height = (bytes[pos + 3] << 8) | bytes[pos + 4];
        const width = (bytes[pos + 5] << 8) | bytes[pos + 6];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      pos += segLen;
    }
  }

  return null;
}

function shouldPreFlightViaTicket(bytes, size, format, crop) {
  if (!bytes) return false;
  if (format !== "png" && format !== "zip") return false;
  const dims = parseImageDimensions(bytes);
  if (!dims) return false;
  const inputPixels = dims.width * dims.height;
  let effectivePixels = inputPixels;
  if (size === "preview") effectivePixels = Math.min(inputPixels, 250_000);
  else if (size === "hd") effectivePixels = Math.min(inputPixels, 4_000_000);
  else if (size === "4k") effectivePixels = Math.min(inputPixels, 10_000_000);
  else effectivePixels = Math.min(inputPixels, 25_000_000);
  return effectivePixels > (crop ? DIRECT_CROPPED_RGBA_PNG_PIXELS : DIRECT_RGBA_PNG_PIXELS);
}

function isAllowedFirstPartyHost(hostname) {
  return hostname === "remove.ac" || hostname.endsWith(".remove.ac");
}

function isAllowedDirectGpuHost(hostname) {
  return isAllowedFirstPartyHost(hostname) || hostname.endsWith(".modal.run");
}

function validateServiceEndpointUrl(rawUrl, options = {}) {
  const kind = options.kind === "direct" ? "direct" : "base";
  const allowLoopback = Boolean(options.allowLoopback);
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new DesktopAppError(400, "invalid_endpoint", `Malformed ${kind} endpoint URL`);
  }
  if (parsed.username || parsed.password) {
    throw new DesktopAppError(400, "invalid_endpoint", `Credentials are not allowed in ${kind} URL`);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    allowLoopback &&
    parsed.protocol === "http:" &&
    (host === "127.0.0.1" || host === "localhost")
  ) {
    return parsed.toString().replace(/\/+$/, "");
  }
  if (parsed.protocol !== "https:") {
    throw new DesktopAppError(400, "insecure_endpoint", `${kind} endpoint must use HTTPS`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new DesktopAppError(400, "invalid_endpoint_port", `Non-standard port disallowed on ${kind} endpoint`);
  }
  const hostAllowed =
    kind === "direct" ? isAllowedDirectGpuHost(host) : isAllowedFirstPartyHost(host);
  if (!hostAllowed) {
    throw new DesktopAppError(
      502,
      "untrusted_endpoint_host",
      `Refused untrusted ${kind} host: ${host}`
    );
  }
  return kind === "base" ? `${parsed.protocol}//${parsed.host}` : parsed.toString();
}

function deriveSubIdempotencyKey(idem, suffix) {
  const trimmed = String(idem || "").trim();
  const direct = `${trimmed}:${suffix}`;
  if (direct.length <= 255) return direct;
  const hash = sha256Hex(Buffer.from(trimmed, "utf8")).slice(0, 24);
  return `${trimmed.slice(0, 180)}:${hash}:${suffix}`;
}

function parseGatewayErrorMessage(status, rawText) {
  if (typeof rawText === "string" && rawText.trim()) {
    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
        const first = parsed.errors[0];
        if (typeof first?.title === "string" && first.title.trim()) {
          return {
            code: typeof first.code === "string" ? first.code : `http_${status}`,
            message: first.title.trim(),
          };
        }
      }
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        return { code: `http_${status}`, message: parsed.error.trim() };
      }
    } catch {
      // fall through to plain text truncation
    }
    return { code: `http_${status}`, message: rawText.trim().slice(0, 240) };
  }
  return { code: `http_${status}`, message: `HTTP ${status}` };
}

function inferImageMimeType(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathInsideOrEqual(candidatePath, parentPath) {
  if (!candidatePath || !parentPath) return false;
  const rel = path.relative(parentPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Expands dropped/selected file and folder paths into a deterministic list of image items.
 * Skips hidden files, symbolic links, and output folders (`remove-ac-output` or `outputDir`)
 * so re-running a folder never re-ingests previously generated cutouts.
 */
function collectInputItems(inputPaths, options = {}) {
  const recursive = options.recursive !== undefined ? Boolean(options.recursive) : true;
  const excludedRealDirs = new Set();
  if (typeof options.outputDir === "string" && options.outputDir.trim()) {
    excludedRealDirs.add(safeRealpath(options.outputDir.trim()));
  }

  const seenRealFiles = new Set();
  const items = [];
  let skippedUnsupported = 0;

  const visitDir = (dirPath, rootDir, depth) => {
    if (depth > 32) return;
    let dirReal;
    try {
      const st = fs.lstatSync(dirPath);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      dirReal = fs.realpathSync(dirPath);
    } catch {
      return;
    }
    const baseName = path.basename(dirPath);
    if (depth > 0 && (baseName.startsWith(".") || baseName.toLowerCase() === "remove-ac-output")) {
      return;
    }
    for (const excl of excludedRealDirs) {
      if (isPathInsideOrEqual(dirReal, excl)) return;
    }

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const entry of entries) {
      const nameLower = entry.name.toLowerCase();
      if (entry.name.startsWith(".") || IGNORED_FILENAMES.has(nameLower)) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (recursive && nameLower !== "remove-ac-output") {
          visitDir(fullPath, rootDir, depth + 1);
        }
      } else if (entry.isFile()) {
        addCandidateFile(fullPath, rootDir);
      }
    }
  };

  const addCandidateFile = (filePath, rootDir) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_INPUT_EXTENSIONS.has(ext)) {
      skippedUnsupported += 1;
      return;
    }
    let st;
    let realFile;
    try {
      st = fs.lstatSync(filePath);
      if (st.isSymbolicLink() || !st.isFile()) return;
      realFile = fs.realpathSync(filePath);
    } catch {
      return;
    }
    for (const excl of excludedRealDirs) {
      if (isPathInsideOrEqual(realFile, excl)) return;
    }
    if (seenRealFiles.has(realFile)) return;
    seenRealFiles.add(realFile);

    let relSubdir = "";
    if (rootDir) {
      const relDir = path.relative(rootDir, path.dirname(filePath));
      if (relDir && !relDir.startsWith("..") && !path.isAbsolute(relDir)) {
        relSubdir = relDir;
      }
    }

    items.push({
      id: `item_${crypto.randomUUID()}`,
      inputPath: path.resolve(filePath),
      fileName: path.basename(filePath),
      byteLength: st.size,
      relSubdir,
    });
  };

  if (Array.isArray(inputPaths)) {
    for (const rawPath of inputPaths) {
      if (typeof rawPath !== "string" || !rawPath.trim()) continue;
      const resolved = path.resolve(rawPath.trim());
      let st;
      try {
        st = fs.lstatSync(resolved);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        visitDir(resolved, resolved, 0);
      } else if (st.isFile()) {
        addCandidateFile(resolved, null);
      }
    }
  }

  return { items, skippedUnsupported };
}

function resolveOutputExtension(format) {
  if (format === "webp") return ".webp";
  if (format === "jpg") return ".jpg";
  if (format === "zip") return ".zip";
  return ".png";
}

function resolveOutputTarget({
  item,
  outputDir,
  format,
  skipExisting = false,
  reservedPaths = new Set(),
}) {
  const baseRoot =
    typeof outputDir === "string" && outputDir.trim()
      ? path.resolve(outputDir.trim())
      : path.join(path.dirname(item.inputPath), "remove-ac-output");

  let targetDir = baseRoot;
  if (item.relSubdir) {
    const candidateDir = path.resolve(baseRoot, item.relSubdir);
    if (isPathInsideOrEqual(candidateDir, baseRoot)) {
      targetDir = candidateDir;
    }
  }

  const ext = resolveOutputExtension(format);
  const rawStem = path.basename(item.inputPath, path.extname(item.inputPath)).trim() || "image";
  const safeStem = rawStem.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const primaryCandidate = path.join(targetDir, `${safeStem}-nobg${ext}`);
  const normalizedPrimary = primaryCandidate.toLowerCase();

  if (skipExisting && !reservedPaths.has(normalizedPrimary) && fs.existsSync(primaryCandidate)) {
    return { skip: true, outputPath: primaryCandidate };
  }

  let chosen = primaryCandidate;
  if (reservedPaths.has(normalizedPrimary) || primaryCandidate === item.inputPath) {
    let suffix = 1;
    do {
      chosen = path.join(targetDir, `${safeStem}-nobg-${suffix}${ext}`);
      suffix += 1;
    } while (reservedPaths.has(chosen.toLowerCase()) || fs.existsSync(chosen));
  }
  reservedPaths.add(chosen.toLowerCase());
  return { skip: false, outputPath: chosen };
}

function writeFileAtomically(destPath, buffer) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, buffer, { mode: 0o644 });
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

class CredentialManager {
  constructor(options = {}) {
    this.storageDir = path.resolve(options.storageDir);
    this.safeStorage = options.safeStorage || null;
    this.credentialsFile = path.join(this.storageDir, "credentials.json");
    this.settingsFile = path.join(this.storageDir, "settings.json");
    this.sessionApiKey = "";
  }

  async isEncryptionAvailable() {
    if (!this.safeStorage) return false;
    try {
      if (typeof this.safeStorage.isAsyncEncryptionAvailable === "function") {
        return Boolean(await this.safeStorage.isAsyncEncryptionAvailable());
      }
      if (typeof this.safeStorage.isEncryptionAvailable === "function") {
        return Boolean(this.safeStorage.isEncryptionAvailable());
      }
      return false;
    } catch {
      return false;
    }
  }

  async getApiKey() {
    if (this.sessionApiKey) return this.sessionApiKey;
    if (!fs.existsSync(this.credentialsFile)) {
      const envKey = (process.env.REMOVE_AC_API_KEY || "").trim();
      return isPlausibleApiKey(envKey) ? envKey : "";
    }
    if (!(await this.isEncryptionAvailable())) {
      return "";
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.credentialsFile, "utf8"));
      if (raw?.scheme === "safeStorage" && typeof raw.ciphertextBase64 === "string") {
        const decrypted = this.safeStorage.decryptString(
          Buffer.from(raw.ciphertextBase64, "base64")
        );
        if (typeof decrypted === "string" && decrypted.trim()) {
          this.sessionApiKey = decrypted.trim();
          return this.sessionApiKey;
        }
      }
    } catch {
      return "";
    }
    return "";
  }

  async getKeyStatus() {
    // Fast cold-boot path: avoid touching OS Keychain/DPAPI until credentials.json exists or a key is set.
    if (!this.sessionApiKey && !fs.existsSync(this.credentialsFile)) {
      const envKey = (process.env.REMOVE_AC_API_KEY || "").trim();
      const validEnv = isPlausibleApiKey(envKey) ? envKey : "";
      return {
        hasApiKey: Boolean(validEnv),
        maskedKey: validEnv ? maskApiKey(validEnv) : "",
        encryptionAvailable: Boolean(this.safeStorage),
        persisted: false,
      };
    }
    const key = await this.getApiKey();
    const encAvail = await this.isEncryptionAvailable();
    return {
      hasApiKey: Boolean(key),
      maskedKey: key ? maskApiKey(key) : "",
      encryptionAvailable: encAvail,
      persisted: Boolean(key && fs.existsSync(this.credentialsFile) && encAvail),
    };
  }

  async setApiKey(rawKey) {
    const trimmed = String(rawKey || "").trim();
    if (!trimmed) {
      return this.clearApiKey();
    }
    if (!isPlausibleApiKey(trimmed)) {
      throw new DesktopAppError(
        400,
        "invalid_api_key_format",
        "API Key must start with 'rac_live_' (copy it from remove.ac/dashboard)."
      );
    }
    this.sessionApiKey = trimmed;
    fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    if (await this.isEncryptionAvailable()) {
      try {
        const encrypted = this.safeStorage.encryptString(trimmed);
        const payload = JSON.stringify(
          {
            version: 1,
            scheme: "safeStorage",
            ciphertextBase64: Buffer.from(encrypted).toString("base64"),
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        );
        const tmp = `${this.credentialsFile}.tmp-${crypto.randomBytes(4).toString("hex")}`;
        fs.writeFileSync(tmp, payload, { mode: 0o600 });
        fs.renameSync(tmp, this.credentialsFile);
        return {
          hasApiKey: true,
          maskedKey: maskApiKey(trimmed),
          encryptionAvailable: true,
          persisted: true,
        };
      } catch {
        // User declined OS Keychain prompt or keyring locked: fall back cleanly to session memory
      }
    }
    // Never write plaintext API keys to disk if OS keychain/DPAPI is unavailable.
    return {
      hasApiKey: true,
      maskedKey: maskApiKey(trimmed),
      encryptionAvailable: false,
      persisted: false,
    };
  }

  async clearApiKey() {
    this.sessionApiKey = "";
    try {
      if (fs.existsSync(this.credentialsFile)) {
        fs.unlinkSync(this.credentialsFile);
      }
    } catch {
      // ignore
    }
    return {
      hasApiKey: false,
      maskedKey: "",
      encryptionAvailable: Boolean(this.safeStorage),
      persisted: false,
    };
  }

  loadSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
        return sanitizeSettings(parsed);
      }
    } catch {
      // fall back to clean defaults
    }
    return sanitizeSettings({});
  }

  saveSettings(partial) {
    const merged = sanitizeSettings({ ...this.loadSettings(), ...(partial || {}) });
    fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.settingsFile}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.settingsFile);
    return merged;
  }
}

function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DesktopAppError(499, "aborted", "Batch cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DesktopAppError(499, "aborted", "Batch cancelled"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

class DesktopApiClient {
  constructor(options = {}) {
    const allowLoopback =
      Boolean(options.allowLoopback) || process.env.REMOVE_AC_DESKTOP_ALLOW_LOOPBACK === "1";
    this.allowLoopback = allowLoopback;
    this.baseUrl = validateServiceEndpointUrl(
      options.baseUrl || process.env.REMOVE_AC_DESKTOP_BASE_URL || DEFAULT_BASE_URL,
      { kind: "base", allowLoopback }
    );
    this.apiKey = String(options.apiKey || "").trim();
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 2;
    this.retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
      ? options.retryBaseDelayMs
      : 650;
  }

  async _fetchNoRedirect(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", "RemoveAcDesktop/1.0.0");
    }
    return this.fetchImpl(url, {
      ...init,
      headers,
      redirect: "error",
    });
  }

  async getAccount(signal) {
    if (!this.apiKey) {
      throw new DesktopAppError(403, "missing_api_key", "Missing remove.ac API Key");
    }
    const res = await this._fetchNoRedirect(`${this.baseUrl}/v1.0/account`, {
      method: "GET",
      headers: { "X-Api-Key": this.apiKey },
      signal,
    });
    if (!res.ok) {
      const parsed = parseGatewayErrorMessage(res.status, await res.text());
      throw new DesktopAppError(res.status, parsed.code, parsed.message);
    }
    const json = await res.json();
    const attrs = json?.data?.attributes || {};
    const credits = attrs.credits || {};
    return {
      totalCredits: Number(credits.total ?? 0),
      subscriptionCredits: Number(credits.subscription ?? 0),
      paygCredits: Number(credits.payg ?? 0),
      enterpriseCredits: Number(credits.enterprise ?? 0),
      rateLimitPerMinute: Number(attrs.api?.rate_limit_per_minute ?? 0),
    };
  }

  async removeBackgroundBuffer(sourceBytes, sourceName, rawSettings = {}, runtimeOpts = {}) {
    if (!this.apiKey) {
      throw new DesktopAppError(403, "missing_api_key", "Missing remove.ac API Key");
    }
    const signal = runtimeOpts.signal;
    if (signal?.aborted) {
      throw new DesktopAppError(499, "aborted", "Batch cancelled");
    }
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      throw new DesktopAppError(400, "empty_file", "Image file is empty (0 bytes)");
    }
    if (sourceBytes.byteLength > MAX_INPUT_BYTES) {
      throw new DesktopAppError(
        413,
        "file_too_large",
        `File exceeds 25 MB limit (${(sourceBytes.byteLength / (1024 * 1024)).toFixed(1)} MB)`
      );
    }

    const dims = parseImageDimensions(sourceBytes);
    if (dims && dims.width * dims.height > MAX_INPUT_PIXELS) {
      const mp = ((dims.width * dims.height) / 1_000_000).toFixed(1);
      throw new DesktopAppError(
        400,
        "resolution_too_large",
        `Image resolution ${dims.width}x${dims.height} (${mp} MP) exceeds 40 MP maximum`
      );
    }

    const settings = sanitizeSettings(rawSettings);
    const size = settings.size;
    const format = settings.bgMode === "zip" ? "zip" : settings.format;
    const bgColor =
      settings.bgMode === "white"
        ? "FFFFFF"
        : settings.bgMode === "color"
          ? settings.bgColor
          : null;
    const mimeType = inferImageMimeType(sourceName);
    const baseIdemKey =
      typeof runtimeOpts.idempotencyKey === "string" && runtimeOpts.idempotencyKey.trim()
        ? runtimeOpts.idempotencyKey.trim()
        : `desktop-${crypto.randomUUID()}`;

    const executeViaTicket = async (suffix) => {
      const ticketPayload = {
        foregroundSha256: sha256Hex(sourceBytes),
        foregroundByteLength: sourceBytes.byteLength,
        mime_type: mimeType,
        size,
        format,
        channels: "rgba",
        ...(bgColor ? { bg_color: bgColor } : {}),
        ...(settings.crop ? { crop: true, crop_margin: settings.cropMargin } : {}),
        ...(settings.addShadow ? { add_shadow: true, shadow_type: settings.shadowType } : {}),
      };
      const tRes = await this._fetchNoRedirect(`${this.baseUrl}/v1.0/remove/ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
          "Idempotency-Key": deriveSubIdempotencyKey(baseIdemKey, suffix),
        },
        body: JSON.stringify(ticketPayload),
        signal,
      });
      if (!tRes.ok) {
        const parsed = parseGatewayErrorMessage(tRes.status, await tRes.text());
        throw new DesktopAppError(tRes.status, parsed.code, parsed.message);
      }
      const tJson = await tRes.json();
      const ticketToken = tJson?.data?.ticket;
      const rawDirectUrl = tJson?.data?.directEndpoint || tJson?.data?.directUrl;
      if (
        typeof ticketToken !== "string" ||
        !ticketToken.trim() ||
        typeof rawDirectUrl !== "string" ||
        !rawDirectUrl.trim()
      ) {
        throw new DesktopAppError(
          502,
          "invalid_ticket_response",
          "Missing ticket or directEndpoint in /v1.0/remove/ticket response"
        );
      }
      const safeDirectEndpoint = validateServiceEndpointUrl(rawDirectUrl, {
        kind: "direct",
        allowLoopback: this.allowLoopback,
      });

      const fd = new FormData();
      fd.set("image_file", new Blob([sourceBytes], { type: mimeType }), sourceName);
      const dRes = await this._fetchNoRedirect(safeDirectEndpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${ticketToken.trim()}` },
        body: fd,
        signal,
      });
      if (!dRes.ok) {
        const parsed = parseGatewayErrorMessage(dRes.status, await dRes.text());
        throw new DesktopAppError(dRes.status, parsed.code, parsed.message);
      }
      return {
        buffer: Buffer.from(await dRes.arrayBuffer()),
        width: Number.parseInt(dRes.headers.get("X-Width") || "0", 10),
        height: Number.parseInt(dRes.headers.get("X-Height") || "0", 10),
        creditsCharged: Number.parseFloat(dRes.headers.get("X-Credits-Charged") || "0"),
        mediaType: dRes.headers.get("Content-Type") || "image/png",
      };
    };

    const useDirectTicket =
      sourceBytes.byteLength > DIRECT_THRESHOLD_BYTES ||
      shouldPreFlightViaTicket(sourceBytes, size, format, settings.crop);

    let activeIdemKey = baseIdemKey;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new DesktopAppError(499, "aborted", "Batch cancelled");
      }
      try {
        if (useDirectTicket) {
          return await executeViaTicket(`direct-${attempt}`);
        }

        const buildForm = () => {
          const fd = new FormData();
          fd.set("image_file", new Blob([sourceBytes], { type: mimeType }), sourceName);
          fd.set("size", size);
          fd.set("format", format);
          fd.set("channels", "rgba");
          if (bgColor) fd.set("bg_color", bgColor);
          if (settings.crop) {
            fd.set("crop", "true");
            fd.set("crop_margin", settings.cropMargin);
          }
          if (settings.addShadow) {
            fd.set("add_shadow", "true");
            fd.set("shadow_type", settings.shadowType);
          }
          return fd;
        };

        let res = await this._fetchNoRedirect(`${this.baseUrl}/v1.0/remove`, {
          method: "POST",
          headers: {
            "X-Api-Key": this.apiKey,
            "Idempotency-Key": activeIdemKey,
          },
          body: buildForm(),
          signal,
        });

        if (res.status === 409) {
          const errText = await res.text();
          if (errText.includes("idempotency_replay_unavailable")) {
            activeIdemKey = `desktop-${crypto.randomUUID()}`;
            res = await this._fetchNoRedirect(`${this.baseUrl}/v1.0/remove`, {
              method: "POST",
              headers: {
                "X-Api-Key": this.apiKey,
                "Idempotency-Key": activeIdemKey,
              },
              body: buildForm(),
              signal,
            });
          } else {
            const parsed = parseGatewayErrorMessage(409, errText);
            throw new DesktopAppError(409, parsed.code, parsed.message);
          }
        }

        if (res.status === 413) {
          return await executeViaTicket(`fallback413-${attempt}`);
        }

        if (!res.ok) {
          const retryAfterHeader = res.headers.get("Retry-After");
          const parsed = parseGatewayErrorMessage(res.status, await res.text());
          const err = new DesktopAppError(res.status, parsed.code, parsed.message);
          if (retryAfterHeader) {
            const sec = Number.parseFloat(retryAfterHeader);
            if (Number.isFinite(sec) && sec > 0) {
              err.retryAfterMs = Math.min(15_000, Math.ceil(sec * 1000));
            }
          }
          throw err;
        }

        return {
          buffer: Buffer.from(await res.arrayBuffer()),
          width: Number.parseInt(res.headers.get("X-Width") || "0", 10),
          height: Number.parseInt(res.headers.get("X-Height") || "0", 10),
          creditsCharged: Number.parseFloat(res.headers.get("X-Credits-Charged") || "0"),
          mediaType: res.headers.get("Content-Type") || "image/png",
        };
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError" || err?.code === "aborted") {
          throw new DesktopAppError(499, "aborted", "Batch cancelled");
        }
        const status = typeof err?.statusCode === "number" ? err.statusCode : 0;
        const isTransientNetworkError =
          status === 0 && !(err instanceof DesktopAppError);
        if (attempt < this.maxRetries && (isRetryableStatus(status) || isTransientNetworkError)) {
          const delayMs =
            err?.retryAfterMs ||
            Math.min(8_000, this.retryBaseDelayMs * Math.pow(2, attempt));
          await sleepWithAbort(delayMs, signal);
          continue;
        }
        if (err instanceof DesktopAppError) throw err;
        throw new DesktopAppError(
          503,
          "network_error",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    throw new DesktopAppError(503, "max_retries_exceeded", "Request failed after retries");
  }

  async removeBackgroundFile(filePath, settings = {}, runtimeOpts = {}) {
    let sourceBytes;
    try {
      sourceBytes = await fs.promises.readFile(filePath);
    } catch (err) {
      throw new DesktopAppError(
        400,
        "read_failed",
        `Cannot read input file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return this.removeBackgroundBuffer(
      sourceBytes,
      path.basename(filePath),
      settings,
      runtimeOpts
    );
  }
}

async function runBatchQueue(items, workerFn, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(
    1,
    Math.min(8, Number.parseInt(String(options.concurrency ?? 3), 10) || 3)
  );
  const signal = options.signal || null;
  const onItemUpdate = typeof options.onItemUpdate === "function" ? options.onItemUpdate : () => {};
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const summary = {
    total: list.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    creditsUsed: 0,
  };

  if (list.length === 0) {
    onProgress({ ...summary });
    return summary;
  }

  let cursor = 0;
  const emitProgress = () => onProgress({ ...summary });

  const workerLoop = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) return;
      const item = list[idx];
      if (signal?.aborted) {
        summary.cancelled += 1;
        onItemUpdate({ id: item.id, status: "cancelled" });
        emitProgress();
        continue;
      }

      onItemUpdate({ id: item.id, status: "processing" });
      try {
        const result = await workerFn(item, { signal, index: idx });
        if (result?.skipped) {
          summary.skipped += 1;
          onItemUpdate({
            id: item.id,
            status: "skipped",
            outputPath: result.outputPath,
          });
        } else {
          summary.completed += 1;
          const credits = Number.isFinite(result?.creditsCharged) ? result.creditsCharged : 0;
          summary.creditsUsed = Math.round((summary.creditsUsed + credits) * 1000) / 1000;
          onItemUpdate({
            id: item.id,
            status: "done",
            outputPath: result.outputPath,
            width: result.width || 0,
            height: result.height || 0,
            creditsCharged: credits,
            elapsedMs: result.elapsedMs || 0,
          });
        }
      } catch (err) {
        if (signal?.aborted || err?.code === "aborted" || err?.name === "AbortError") {
          summary.cancelled += 1;
          onItemUpdate({ id: item.id, status: "cancelled" });
        } else {
          summary.failed += 1;
          onItemUpdate({
            id: item.id,
            status: "error",
            errorCode: err?.code || "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }
      emitProgress();
    }
  };

  const workerCount = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  return summary;
}

module.exports = {
  DEFAULT_BASE_URL,
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXELS,
  DIRECT_THRESHOLD_BYTES,
  SUPPORTED_INPUT_EXTENSIONS,
  DesktopAppError,
  isPlausibleApiKey,
  maskApiKey,
  normalizeHexColor,
  sanitizeSettings,
  parseImageDimensions,
  validateServiceEndpointUrl,
  deriveSubIdempotencyKey,
  collectInputItems,
  resolveOutputTarget,
  writeFileAtomically,
  CredentialManager,
  DesktopApiClient,
  runBatchQueue,
};
