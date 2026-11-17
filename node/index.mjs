import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import {
  fetchWithoutRedirects,
  isDisallowedRemoteUrl,
  isLoopbackTestOrigin,
  validateHttpsEndpointUrl,
  validateRemoteImageUrl,
} from "./net-safety.mjs";

export const SDK_VERSION = "1.3.0";
export const USER_AGENT = `remove-ac-node-sdk/${SDK_VERSION}`;

export const VALID_SIZES = Object.freeze([
  "auto",
  "preview",
  "small",
  "regular",
  "medium",
  "hd",
  "4k",
  "25mp",
  "50mp",
  "full",
]);
export const VALID_FORMATS = Object.freeze(["auto", "png", "jpg", "jpeg", "webp", "zip"]);
export const VALID_CHANNELS = Object.freeze(["rgba", "alpha"]);
export const VALID_TYPES = Object.freeze([
  "auto",
  "person",
  "product",
  "car",
  "animal",
  "graphic",
  "transportation",
]);
export const VALID_SHADOW_TYPES = Object.freeze([
  "auto",
  "car",
  "drop",
  "soft",
  "contact",
  "reflection",
  "none",
]);

const VALID_SIZE_SET = new Set(VALID_SIZES);
const VALID_FORMAT_SET = new Set(VALID_FORMATS);
const VALID_CHANNEL_SET = new Set(VALID_CHANNELS);
const VALID_TYPE_SET = new Set(VALID_TYPES);
const VALID_SHADOW_SET = new Set(VALID_SHADOW_TYPES);

const DEFAULT_BASE_URL = "https://remove.ac";
const DIRECT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_COMBINED_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_DIMENSION = 50_000;
const MAX_IMPROVE_TAG_LEN = 64;
const MAX_IMPROVE_DESCRIPTION_LEN = 500;
const DIRECT_RGBA_PNG_PIXELS = 5_000_000;
const DIRECT_CROPPED_RGBA_PNG_PIXELS = 10_000_000;

function looksLikeUrlCandidate(raw) {
  const s = String(raw || "").trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(s) || /^(data|javascript|file):/i.test(s);
}

function assertValidImageDimensions(bytes, label) {
  const dims = parseImageDimensions(bytes);
  if (!dims) return;
  if (
    dims.width > MAX_IMAGE_DIMENSION ||
    dims.height > MAX_IMAGE_DIMENSION ||
    dims.width * dims.height > MAX_IMAGE_PIXELS
  ) {
    throw new RemoveAcError(
      400,
      `${label} resolution ${dims.width}x${dims.height} exceeds 50 MP / 50,000 px maximum`,
    );
  }
}

function assertValidBinaryEnvelope(bytes, label) {
  if (!bytes || bytes.byteLength === 0) {
    throw new RemoveAcError(400, `${label} must not be empty`);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new RemoveAcError(413, `${label} exceeds 25 MB maximum upload size (26214400 bytes)`);
  }
  assertValidImageDimensions(bytes, label);
}

function toNodeBuffer(val) {
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  if (val instanceof ArrayBuffer) return Buffer.from(val);
  return null;
}

function inferImageMimeType(bytes, fileName = "") {
  if (bytes && bytes.byteLength >= 12) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      return "image/jpeg";
    }
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return "image/gif";
    }
  }
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function decodeBase64Image(rawB64, label) {
  const trimmed = String(rawB64 || "").trim();
  const withoutPrefix = trimmed.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, "");
  const compact = withoutPrefix.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1) {
    throw new RemoveAcError(400, `Invalid ${label}: malformed base64 payload`);
  }
  const padded = compact.length % 4 === 0 ? compact : compact + "=".repeat(4 - (compact.length % 4));
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
    throw new RemoveAcError(400, `Invalid ${label}: malformed base64 payload`);
  }
  const bytes = Buffer.from(padded, "base64");
  if (bytes.byteLength === 0) {
    throw new RemoveAcError(400, `${label} must not be empty`);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new RemoveAcError(413, `${label} exceeds 25 MB maximum upload size (26214400 bytes)`);
  }
  return { cleanB64: trimmed, bytes };
}

export function parseImageDimensions(input) {
  const bytes =
    input instanceof ArrayBuffer ? new Uint8Array(input) : input instanceof Uint8Array ? input : null;
  if (!bytes || bytes.byteLength < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
    return width > 0 && height > 0 && width <= 1_000_000 && height <= 1_000_000 ? { width, height } : null;
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return width > 0 && height > 0 ? { width, height } : null;
  }
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
    if (bytes.byteLength >= 30 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c && bytes[20] === 0x2f) {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
      const width = 1 + (b0 | ((b1 & 0x3f) << 8));
      const height = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (bytes.byteLength >= 30 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
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
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
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

function shouldPreFlightViaTicket(bytes, size, format, channels, crop) {
  if (!bytes) return false;
  if (format !== "png" && format !== "auto" && format !== "zip") return false;
  if (channels === "alpha") return false;
  const dims = parseImageDimensions(bytes);
  if (!dims) return false;
  const inputPixels = dims.width * dims.height;
  let effectivePixels = inputPixels;
  if (size === "preview" || size === "small" || size === "regular") effectivePixels = Math.min(inputPixels, 250_000);
  else if (size === "medium") effectivePixels = Math.min(inputPixels, 1_500_000);
  else if (size === "hd") effectivePixels = Math.min(inputPixels, 4_000_000);
  else if (size === "4k") effectivePixels = Math.min(inputPixels, 10_000_000);
  else if (size === "25mp") effectivePixels = Math.min(inputPixels, 25_000_000);
  else if (size === "50mp") effectivePixels = Math.min(inputPixels, 50_000_000);
  return effectivePixels > (crop ? DIRECT_CROPPED_RGBA_PNG_PIXELS : DIRECT_RGBA_PNG_PIXELS);
}

export class RemoveAcError extends Error {
  constructor(statusCode, message) {
    super(`[HTTP ${statusCode}] ${message}`);
    this.name = "RemoveAcError";
    this.statusCode = statusCode;
  }
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function mergeWithUserAgent(rawHeaders, defaultUa) {
  const out = {};
  if (rawHeaders instanceof Headers) {
    for (const [k, v] of rawHeaders.entries()) {
      out[k] = v;
    }
  } else if (Array.isArray(rawHeaders)) {
    for (const entry of rawHeaders) {
      if (Array.isArray(entry) && entry.length >= 2) out[entry[0]] = entry[1];
    }
  } else if (rawHeaders && typeof rawHeaders === "object") {
    Object.assign(out, rawHeaders);
  }
  const hasUa = Object.keys(out).some((k) => k.toLowerCase() === "user-agent");
  if (!hasUa) {
    out["User-Agent"] = defaultUa;
  }
  return out;
}

export function deriveSubIdempotencyKey(idem, suffix) {
  const trimmed = String(idem || "").trim();
  if (!trimmed || trimmed.length > 255) {
    throw new RemoveAcError(400, "idempotencyKey must be between 1 and 255 characters");
  }
  const direct = `${trimmed}:${suffix}`;
  if (direct.length <= 255) return direct;
  const hash = sha256Hex(Buffer.from(trimmed, "utf8")).slice(0, 32);
  return `${trimmed.slice(0, 180)}:${hash}:${suffix}`;
}

export class RemoveAcClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.REMOVE_AC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey || process.env.REMOVE_AC_API_KEY || process.env.REMOVE_BG_API_KEY || "";
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.lookupImpl = options.lookup || dns.promises.lookup;
  }

  async _request(url, init = {}) {
    const mergedInit = {
      ...init,
      headers: mergeWithUserAgent(init.headers, USER_AGENT),
    };
    try {
      return await fetchWithoutRedirects(this.fetchImpl, url, mergedInit);
    } catch (err) {
      if (err && typeof err.statusCode === "number") {
        throw new RemoveAcError(err.statusCode, err.message);
      }
      throw err;
    }
  }

  async _releaseTicketHold(holdId, releaseToken) {
    if (!holdId || !releaseToken || !this.apiKey) return false;
    try {
      const res = await this._request(`${this.baseUrl}/v1.0/removebg/ticket/release`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
        },
        body: JSON.stringify({ holdId, releaseToken }),
        signal: AbortSignal.timeout(5000),
      });
      return Boolean(res && res.ok);
    } catch {
      return false;
    }
  }

  async getAccount() {
    if (!this.apiKey) throw new RemoveAcError(403, "Missing remove.ac API key");
    const res = await this._request(`${this.baseUrl}/v1.0/account`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) throw new RemoveAcError(res.status, await res.text());
    return res.json();
  }

  async removeBackground(input, options = {}) {
    if (!this.apiKey) throw new RemoveAcError(403, "Missing remove.ac API key");

    const size = String(options.size || "auto").trim().toLowerCase();
    if (!VALID_SIZE_SET.has(size)) {
      throw new RemoveAcError(400, `Unsupported size '${options.size}'. Expected one of: ${VALID_SIZES.join(", ")}`);
    }
    const format = String(options.format || "png").trim().toLowerCase();
    if (!VALID_FORMAT_SET.has(format)) {
      throw new RemoveAcError(400, `Unsupported format '${options.format}'. Expected one of: ${VALID_FORMATS.join(", ")}`);
    }
    const channels = String(options.channels || "rgba").trim().toLowerCase();
    if (!VALID_CHANNEL_SET.has(channels)) {
      throw new RemoveAcError(400, `Unsupported channels '${options.channels}'. Expected one of: ${VALID_CHANNELS.join(", ")}`);
    }
    let fgType = "";
    if (options.type !== undefined && options.type !== null && String(options.type).trim() !== "") {
      fgType = String(options.type).trim().toLowerCase();
      if (!VALID_TYPE_SET.has(fgType)) {
        throw new RemoveAcError(400, `Unsupported type '${options.type}'. Expected one of: ${VALID_TYPES.join(", ")}`);
      }
    }
    let shadowType = "";
    if (options.shadowType !== undefined && options.shadowType !== null && String(options.shadowType).trim() !== "") {
      shadowType = String(options.shadowType).trim().toLowerCase();
      if (!VALID_SHADOW_SET.has(shadowType)) {
        throw new RemoveAcError(
          400,
          `Unsupported shadowType '${options.shadowType}'. Expected one of: ${VALID_SHADOW_TYPES.join(", ")}`,
        );
      }
    }

    const rawBgColor =
      options.bgColor !== undefined && options.bgColor !== null ? String(options.bgColor).trim() : "";
    const rawBgImageUrl =
      options.bgImageUrl !== undefined && options.bgImageUrl !== null ? String(options.bgImageUrl).trim() : "";
    const hasBgImageFile = options.bgImageFile !== undefined && options.bgImageFile !== null;
    const hasBgImageFileB64Arg = options.bgImageFileB64 !== undefined && options.bgImageFileB64 !== null;
    if (hasBgImageFileB64Arg && typeof options.bgImageFileB64 !== "string") {
      throw new RemoveAcError(400, "bgImageFileB64 must be a base64 string");
    }
    const rawBgImageFileB64 = hasBgImageFileB64Arg ? options.bgImageFileB64.trim() : "";
    if (hasBgImageFileB64Arg && !rawBgImageFileB64) {
      throw new RemoveAcError(400, "bgImageFileB64 must not be empty");
    }

    const bgSourceCount =
      (rawBgColor ? 1 : 0) +
      (rawBgImageUrl ? 1 : 0) +
      (hasBgImageFile ? 1 : 0) +
      (rawBgImageFileB64 ? 1 : 0);
    if (bgSourceCount > 1) {
      throw new RemoveAcError(
        400,
        "Specify at most one of bgColor, bgImageUrl, bgImageFile, or bgImageFileB64",
      );
    }

    if (options.idempotencyKey !== undefined) {
      const trimmedIdem = String(options.idempotencyKey).trim();
      if (!trimmedIdem || trimmedIdem.length > 255) {
        throw new RemoveAcError(400, "idempotencyKey must be between 1 and 255 characters");
      }
    }
    const idem = options.idempotencyKey ? String(options.idempotencyKey).trim() : `sdk-${crypto.randomUUID()}`;

    let bgFileBytes = null;
    let bgFileName = "bg-image.png";
    let bgFileMime = "application/octet-stream";
    let bgB64Clean = "";
    let bgB64DecodedBytes = null;

    if (rawBgImageUrl) {
      const bgUrlErr = await validateRemoteImageUrl(rawBgImageUrl, this.lookupImpl);
      if (bgUrlErr) {
        throw new RemoveAcError(400, `Disallowed bgImageUrl (${bgUrlErr})`);
      }
    }

    if (hasBgImageFile) {
      if (typeof options.bgImageFile === "string") {
        const trimmedBgPath = options.bgImageFile.trim();
        if (!trimmedBgPath || trimmedBgPath.includes("\0")) {
          throw new RemoveAcError(400, "bgImageFile path must not be empty");
        }
        if (looksLikeUrlCandidate(trimmedBgPath)) {
          throw new RemoveAcError(
            400,
            "bgImageFile expects a local file path or byte buffer; use bgImageUrl for remote URLs",
          );
        }
        bgFileBytes = await fs.promises.readFile(trimmedBgPath);
        bgFileName = path.basename(trimmedBgPath) || "bg-image.png";
      } else {
        const convertedBg = toNodeBuffer(options.bgImageFile);
        if (!convertedBg) {
          throw new RemoveAcError(
            400,
            "Unsupported bgImageFile source; expected file path string, Buffer, Uint8Array, or ArrayBuffer",
          );
        }
        bgFileBytes = convertedBg;
      }
      assertValidBinaryEnvelope(bgFileBytes, "bgImageFile");
      bgFileMime = inferImageMimeType(bgFileBytes, bgFileName);
    } else if (rawBgImageFileB64) {
      const decodedBg = decodeBase64Image(rawBgImageFileB64, "bgImageFileB64");
      assertValidImageDimensions(decodedBg.bytes, "bgImageFileB64");
      bgB64Clean = decodedBg.cleanB64;
      bgB64DecodedBytes = decodedBg.bytes;
      bgFileMime = inferImageMimeType(bgB64DecodedBytes, bgFileName);
    }

    let sourceBytes = null;
    let sourceName = "image.png";
    let sourceUrl = null;

    if (typeof input === "string") {
      const trimmedInput = input.trim();
      if (!trimmedInput || input.includes("\0")) {
        throw new RemoveAcError(400, "Unsupported input source");
      }
      if (looksLikeUrlCandidate(trimmedInput)) {
        const srcUrlErr = await validateRemoteImageUrl(trimmedInput, this.lookupImpl);
        if (srcUrlErr) {
          throw new RemoveAcError(400, `Disallowed image_url (${srcUrlErr})`);
        }
        sourceUrl = trimmedInput;
      } else {
        sourceBytes = fs.readFileSync(trimmedInput);
        sourceName = path.basename(trimmedInput) || "image.png";
      }
    } else {
      const convertedInput = toNodeBuffer(input);
      if (convertedInput) {
        sourceBytes = convertedInput;
      } else {
        throw new RemoveAcError(400, "Unsupported input source");
      }
    }

    if (sourceBytes !== null) {
      assertValidBinaryEnvelope(sourceBytes, "Foreground image");
    }

    const ticketBgBytes = bgFileBytes || bgB64DecodedBytes;
    if (
      sourceBytes !== null &&
      ticketBgBytes !== null &&
      sourceBytes.byteLength + ticketBgBytes.byteLength > MAX_COMBINED_UPLOAD_BYTES
    ) {
      throw new RemoveAcError(
        413,
        "Combined foreground and background upload size exceeds 30 MB maximum envelope (31457280 bytes)",
      );
    }

    const runViaTicket = async (suffix) => {
      if (!sourceBytes) throw new RemoveAcError(413, "Ticket mode requires binary input");
      const ticketPayload = {
        foregroundSha256: sha256Hex(sourceBytes),
        foregroundByteLength: sourceBytes.byteLength,
        size,
        format,
        channels,
        ...(fgType && fgType !== "auto" ? { type: fgType } : {}),
        ...(options.typeLevel ? { type_level: options.typeLevel } : {}),
        ...(options.roi ? { roi: options.roi } : {}),
        ...(options.scale ? { scale: options.scale } : {}),
        ...(options.position ? { position: options.position } : {}),
        ...(rawBgColor ? { bg_color: rawBgColor } : {}),
        ...(rawBgImageUrl ? { bg_image_url: rawBgImageUrl } : {}),
        ...(ticketBgBytes
          ? {
              bgImageSha256: sha256Hex(ticketBgBytes),
              bgImageByteLength: ticketBgBytes.byteLength,
            }
          : {}),
        ...(options.crop !== undefined ? { crop: options.crop } : {}),
        ...(options.cropMargin ? { crop_margin: options.cropMargin } : {}),
        ...(options.addShadow !== undefined ? { add_shadow: options.addShadow } : {}),
        ...(shadowType ? { shadow_type: shadowType } : {}),
        ...(options.shadowOpacity !== undefined ? { shadow_opacity: options.shadowOpacity } : {}),
        ...(options.semitransparency !== undefined ? { semitransparency: options.semitransparency } : {}),
      };
      const tRes = await this._request(`${this.baseUrl}/v1.0/removebg/ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
          "Idempotency-Key": deriveSubIdempotencyKey(idem, suffix),
        },
        body: JSON.stringify(ticketPayload),
      });
      if (!tRes.ok) throw new RemoveAcError(tRes.status, await tRes.text());
      const tJson = await tRes.json();
      const tData = tJson?.data;
      const ticketToken = tData?.ticket;
      const directEndpoint = tData?.directEndpoint;
      const rawHoldId = tData?.holdId ?? tData?.hold_id ?? tData?.lock_id;
      const rawReleaseToken = tData?.releaseToken ?? tData?.release_token;
      const holdId = typeof rawHoldId === "string" ? rawHoldId.trim() : "";
      const releaseToken = typeof rawReleaseToken === "string" ? rawReleaseToken.trim() : "";

      if (
        typeof ticketToken !== "string" ||
        !ticketToken.trim() ||
        typeof directEndpoint !== "string" ||
        !directEndpoint.trim()
      ) {
        await this._releaseTicketHold(holdId, releaseToken);
        throw new RemoveAcError(502, "Missing ticket or directEndpoint in /v1.0/removebg/ticket response");
      }
      const epErr = await validateHttpsEndpointUrl(directEndpoint, {
        lookupFn: this.lookupImpl,
        allowLoopbackOrigin: isLoopbackTestOrigin(this.baseUrl),
        label: "directEndpoint",
      });
      if (epErr) {
        await this._releaseTicketHold(holdId, releaseToken);
        throw new RemoveAcError(502, epErr);
      }
      const fd = new FormData();
      fd.set("image_file", new Blob([sourceBytes]), sourceName);
      if (ticketBgBytes) {
        fd.set("bg_image_file", new Blob([ticketBgBytes], { type: bgFileMime }), bgFileName);
      }
      let dRes;
      try {
        dRes = await this._request(directEndpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${ticketToken}` },
          body: fd,
        });
      } catch (err) {
        await this._releaseTicketHold(holdId, releaseToken);
        throw err;
      }
      if (!dRes.ok) {
        const errBody = await dRes.text();
        await this._releaseTicketHold(holdId, releaseToken);
        throw new RemoveAcError(dRes.status, errBody);
      }
      return {
        buffer: Buffer.from(await dRes.arrayBuffer()),
        width: Number.parseInt(dRes.headers.get("X-Width") || "0", 10),
        height: Number.parseInt(dRes.headers.get("X-Height") || "0", 10),
        creditsCharged: Number.parseFloat(dRes.headers.get("X-Credits-Charged") || "0"),
        mediaType: dRes.headers.get("Content-Type") || "image/png",
      };
    };

    const syncBgWireBytes = bgFileBytes
      ? bgFileBytes.byteLength
      : bgB64Clean
        ? Buffer.byteLength(bgB64Clean, "utf8")
        : 0;

    if (
      sourceBytes &&
      (options.direct ||
        sourceBytes.byteLength > DIRECT_THRESHOLD_BYTES ||
        (ticketBgBytes && ticketBgBytes.byteLength > DIRECT_THRESHOLD_BYTES) ||
        sourceBytes.byteLength + syncBgWireBytes > DIRECT_THRESHOLD_BYTES ||
        shouldPreFlightViaTicket(sourceBytes, size, format, channels, Boolean(options.crop)))
    ) {
      return runViaTicket("direct");
    }

    const buildFormData = () => {
      const fd = new FormData();
      if (sourceUrl) fd.set("image_url", sourceUrl);
      else fd.set("image_file", new Blob([sourceBytes]), sourceName);
      fd.set("size", size);
      fd.set("format", format);
      fd.set("channels", channels);
      if (fgType && fgType !== "auto") fd.set("type", fgType);
      if (options.typeLevel) fd.set("type_level", options.typeLevel);
      if (options.roi) fd.set("roi", options.roi);
      if (options.scale) fd.set("scale", options.scale);
      if (options.position) fd.set("position", options.position);
      if (rawBgColor) fd.set("bg_color", rawBgColor);
      if (rawBgImageUrl) fd.set("bg_image_url", rawBgImageUrl);
      if (bgFileBytes) {
        fd.set("bg_image_file", new Blob([bgFileBytes], { type: bgFileMime }), bgFileName);
      }
      if (bgB64Clean) fd.set("bg_image_file_b64", bgB64Clean);
      if (options.crop !== undefined) fd.set("crop", String(options.crop));
      if (options.cropMargin) fd.set("crop_margin", options.cropMargin);
      if (options.addShadow !== undefined) fd.set("add_shadow", String(options.addShadow));
      if (shadowType) fd.set("shadow_type", shadowType);
      if (options.shadowOpacity !== undefined) fd.set("shadow_opacity", String(options.shadowOpacity));
      if (options.semitransparency !== undefined) fd.set("semitransparency", String(options.semitransparency));
      return fd;
    };

    let res = await this._request(`${this.baseUrl}/v1.0/removebg`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Idempotency-Key": idem },
      body: buildFormData(),
    });
    if (res.status === 409 && !options.idempotencyKey) {
      const errBody = await res.text();
      if (errBody.includes("idempotency_replay_unavailable")) {
        res = await this._request(`${this.baseUrl}/v1.0/removebg`, {
          method: "POST",
          headers: { "X-Api-Key": this.apiKey, "Idempotency-Key": `sdk-${crypto.randomUUID()}` },
          body: buildFormData(),
        });
      } else {
        throw new RemoveAcError(409, errBody);
      }
    }
    if (res.status === 413 && sourceBytes) {
      return runViaTicket("fallback413");
    }
    if (!res.ok) throw new RemoveAcError(res.status, await res.text());
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      width: Number.parseInt(res.headers.get("X-Width") || "0", 10),
      height: Number.parseInt(res.headers.get("X-Height") || "0", 10),
      creditsCharged: Number.parseFloat(res.headers.get("X-Credits-Charged") || "0"),
      mediaType: res.headers.get("Content-Type") || "image/png",
    };
  }

  async submitImprove(input, options = {}) {
    if (!this.apiKey) throw new RemoveAcError(403, "Missing remove.ac API key");
    const opts = options && typeof options === "object" ? options : {};

    let cleanTag = "";
    if (opts.tag !== undefined && opts.tag !== null) {
      if (typeof opts.tag !== "string") {
        throw new RemoveAcError(400, "tag must be a string");
      }
      cleanTag = opts.tag.trim();
      if (cleanTag.includes("\0") || cleanTag.length > MAX_IMPROVE_TAG_LEN) {
        throw new RemoveAcError(400, `tag must be ${MAX_IMPROVE_TAG_LEN} characters or fewer`);
      }
    }

    let cleanDescription = "";
    if (opts.description !== undefined && opts.description !== null) {
      if (typeof opts.description !== "string") {
        throw new RemoveAcError(400, "description must be a string");
      }
      cleanDescription = opts.description.trim();
      if (cleanDescription.includes("\0") || cleanDescription.length > MAX_IMPROVE_DESCRIPTION_LEN) {
        throw new RemoveAcError(
          400,
          `description must be ${MAX_IMPROVE_DESCRIPTION_LEN} characters or fewer`,
        );
      }
    }

    let imageBytes = null;
    let imageName =
      typeof opts.filename === "string" && opts.filename.trim()
        ? path.basename(opts.filename.trim())
        : "image.png";
    let imageUrl = null;

    if (typeof input === "string") {
      const trimmed = input.trim();
      if (!trimmed || input.includes("\0")) {
        throw new RemoveAcError(400, "Unsupported input source");
      }
      if (looksLikeUrlCandidate(trimmed)) {
        const urlErr = await validateRemoteImageUrl(trimmed, this.lookupImpl);
        if (urlErr) {
          throw new RemoveAcError(400, `Disallowed image_url (${urlErr})`);
        }
        imageUrl = trimmed;
      } else {
        imageBytes = await fs.promises.readFile(trimmed);
        if (!(typeof opts.filename === "string" && opts.filename.trim())) {
          imageName = path.basename(trimmed) || "image.png";
        }
      }
    } else {
      const converted = toNodeBuffer(input);
      if (!converted) {
        throw new RemoveAcError(400, "Unsupported input source");
      }
      imageBytes = converted;
    }

    if (imageBytes !== null) {
      assertValidBinaryEnvelope(imageBytes, "Image input");
    }

    const fd = new FormData();
    if (imageUrl) {
      fd.set("image_url", imageUrl);
    } else {
      fd.set(
        "image_file",
        new Blob([imageBytes], { type: inferImageMimeType(imageBytes, imageName) }),
        imageName,
      );
    }
    if (cleanTag) {
      fd.set("tag", cleanTag);
    }
    if (cleanDescription) {
      fd.set("description", cleanDescription);
    }

    const res = await this._request(`${this.baseUrl}/v1.0/improve`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey },
      body: fd,
    });
    if (!res.ok) throw new RemoveAcError(res.status, await res.text());
    const json = await res.json();
    const unwrapped =
      json && typeof json === "object" && json.data && typeof json.data === "object"
        ? json.data
        : json;
    return {
      ...(unwrapped && typeof unwrapped === "object" ? unwrapped : {}),
      id: String(unwrapped?.id ?? ""),
      status: String(unwrapped?.status ?? "submitted"),
    };
  }
}

export async function removeBackgroundFromImageFile(opts) {
  const client = new RemoveAcClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    lookup: opts.lookup,
  });
  const out = await client.removeBackground(opts.path, opts);
  if (opts.outputFile) fs.writeFileSync(opts.outputFile, out.buffer);
  return { base64img: out.buffer.toString("base64"), ...out };
}

export async function removeBackgroundFromImageUrl(opts) {
  if (!opts || typeof opts.url !== "string" || !opts.url.trim()) {
    throw new RemoveAcError(400, "Missing image URL");
  }
  const syncUrlErr = isDisallowedRemoteUrl(opts.url.trim());
  if (syncUrlErr) {
    throw new RemoveAcError(400, `Disallowed image_url (${syncUrlErr})`);
  }
  const client = new RemoveAcClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    lookup: opts.lookup,
  });
  const out = await client.removeBackground(opts.url, opts);
  if (opts.outputFile) fs.writeFileSync(opts.outputFile, out.buffer);
  return { base64img: out.buffer.toString("base64"), ...out };
}

export default RemoveAcClient;
