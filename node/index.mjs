import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import {
  fetchWithoutRedirects,
  isLoopbackTestOrigin,
  validateHttpsEndpointUrl,
} from "./net-safety.mjs";

const DEFAULT_BASE_URL = "https://remove.ac";
const DIRECT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const DIRECT_RGBA_PNG_PIXELS = 5_000_000;
const DIRECT_CROPPED_RGBA_PNG_PIXELS = 10_000_000;

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
    try {
      return await fetchWithoutRedirects(this.fetchImpl, url, init);
    } catch (err) {
      if (err && typeof err.statusCode === "number") {
        throw new RemoveAcError(err.statusCode, err.message);
      }
      throw err;
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
    let sourceBytes = null;
    let sourceName = "image.png";
    let sourceUrl = null;

    if (typeof input === "string") {
      if (/^https?:\/\//i.test(input)) {
        sourceUrl = input;
      } else {
        sourceBytes = fs.readFileSync(input);
        sourceName = path.basename(input);
      }
    } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      sourceBytes = Buffer.from(input);
    } else if (input instanceof ArrayBuffer) {
      sourceBytes = Buffer.from(input);
    } else {
      throw new RemoveAcError(400, "Unsupported input source");
    }

    const size = options.size || "auto";
    const format = options.format || "png";
    const channels = options.channels || "rgba";
    if (options.idempotencyKey !== undefined) {
      const trimmedIdem = String(options.idempotencyKey).trim();
      if (!trimmedIdem || trimmedIdem.length > 255) {
        throw new RemoveAcError(400, "idempotencyKey must be between 1 and 255 characters");
      }
    }
    const idem = options.idempotencyKey ? String(options.idempotencyKey).trim() : `sdk-${crypto.randomUUID()}`;

    const runViaTicket = async (suffix) => {
      if (!sourceBytes) throw new RemoveAcError(413, "Ticket mode requires binary input");
      const ticketPayload = {
        foregroundSha256: sha256Hex(sourceBytes),
        foregroundByteLength: sourceBytes.byteLength,
        size,
        format,
        channels,
        ...(options.type ? { type: options.type } : {}),
        ...(options.typeLevel ? { type_level: options.typeLevel } : {}),
        ...(options.roi ? { roi: options.roi } : {}),
        ...(options.scale ? { scale: options.scale } : {}),
        ...(options.position ? { position: options.position } : {}),
        ...(options.bgColor ? { bg_color: options.bgColor } : {}),
        ...(options.bgImageUrl ? { bg_image_url: options.bgImageUrl } : {}),
        ...(options.crop !== undefined ? { crop: options.crop } : {}),
        ...(options.cropMargin ? { crop_margin: options.cropMargin } : {}),
        ...(options.addShadow !== undefined ? { add_shadow: options.addShadow } : {}),
        ...(options.shadowType ? { shadow_type: options.shadowType } : {}),
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
      const ticketToken = tJson?.data?.ticket;
      const directEndpoint = tJson?.data?.directEndpoint;
      if (
        typeof ticketToken !== "string" ||
        !ticketToken.trim() ||
        typeof directEndpoint !== "string" ||
        !directEndpoint.trim()
      ) {
        throw new RemoveAcError(502, "Missing ticket or directEndpoint in /v1.0/removebg/ticket response");
      }
      const epErr = await validateHttpsEndpointUrl(directEndpoint, {
        lookupFn: this.lookupImpl,
        allowLoopbackOrigin: isLoopbackTestOrigin(this.baseUrl),
        label: "directEndpoint",
      });
      if (epErr) {
        throw new RemoveAcError(502, epErr);
      }
      const fd = new FormData();
      fd.set("image_file", new Blob([sourceBytes]), sourceName);
      const dRes = await this._request(directEndpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${ticketToken}` },
        body: fd,
      });
      if (!dRes.ok) throw new RemoveAcError(dRes.status, await dRes.text());
      return {
        buffer: Buffer.from(await dRes.arrayBuffer()),
        width: Number.parseInt(dRes.headers.get("X-Width") || "0", 10),
        height: Number.parseInt(dRes.headers.get("X-Height") || "0", 10),
        creditsCharged: Number.parseFloat(dRes.headers.get("X-Credits-Charged") || "0"),
        mediaType: dRes.headers.get("Content-Type") || "image/png",
      };
    };

    if (
      sourceBytes &&
      (options.direct ||
        sourceBytes.byteLength > DIRECT_THRESHOLD_BYTES ||
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
      if (options.type) fd.set("type", options.type);
      if (options.typeLevel) fd.set("type_level", options.typeLevel);
      if (options.roi) fd.set("roi", options.roi);
      if (options.scale) fd.set("scale", options.scale);
      if (options.position) fd.set("position", options.position);
      if (options.bgColor) fd.set("bg_color", options.bgColor);
      if (options.bgImageUrl) fd.set("bg_image_url", options.bgImageUrl);
      if (options.crop !== undefined) fd.set("crop", String(options.crop));
      if (options.cropMargin) fd.set("crop_margin", options.cropMargin);
      if (options.addShadow !== undefined) fd.set("add_shadow", String(options.addShadow));
      if (options.shadowType) fd.set("shadow_type", options.shadowType);
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
