import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://remove.ac";
const DIRECT_THRESHOLD_BYTES = 4 * 1024 * 1024;

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

export class RemoveAcClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.REMOVE_AC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey || process.env.REMOVE_AC_API_KEY || process.env.REMOVE_BG_API_KEY || "";
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  async getAccount() {
    if (!this.apiKey) throw new RemoveAcError(403, "Missing remove.ac API key");
    const res = await this.fetchImpl(`${this.baseUrl}/v1.0/account`, {
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
    const idem = options.idempotencyKey || `sdk-${crypto.randomUUID()}`;

    const runViaTicket = async (suffix) => {
      if (!sourceBytes) throw new RemoveAcError(413, "Ticket mode requires binary input");
      const ticketPayload = {
        foregroundSha256: sha256Hex(sourceBytes),
        foregroundByteLength: sourceBytes.byteLength,
        size,
        format,
        channels,
        ...(options.type ? { type: options.type } : {}),
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
      const tRes = await this.fetchImpl(`${this.baseUrl}/v1.0/removebg/ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
          "Idempotency-Key": `${idem}:${suffix}`,
        },
        body: JSON.stringify(ticketPayload),
      });
      if (!tRes.ok) throw new RemoveAcError(tRes.status, await tRes.text());
      const tJson = await tRes.json();
      const fd = new FormData();
      fd.set("image_file", new Blob([sourceBytes]), sourceName);
      const dRes = await this.fetchImpl(tJson.data.directEndpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${tJson.data.ticket}` },
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

    if (sourceBytes && (options.direct || sourceBytes.byteLength > DIRECT_THRESHOLD_BYTES)) {
      return runViaTicket("direct");
    }

    const fd = new FormData();
    if (sourceUrl) fd.set("image_url", sourceUrl);
    else fd.set("image_file", new Blob([sourceBytes]), sourceName);
    fd.set("size", size);
    fd.set("format", format);
    fd.set("channels", channels);
    if (options.type) fd.set("type", options.type);
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

    const res = await this.fetchImpl(`${this.baseUrl}/v1.0/removebg`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Idempotency-Key": idem },
      body: fd,
    });
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
  const client = new RemoveAcClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetch: opts.fetch });
  const out = await client.removeBackground(opts.path, opts);
  if (opts.outputFile) fs.writeFileSync(opts.outputFile, out.buffer);
  return { base64img: out.buffer.toString("base64"), ...out };
}

export async function removeBackgroundFromImageUrl(opts) {
  const client = new RemoveAcClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetch: opts.fetch });
  const out = await client.removeBackground(opts.url, opts);
  if (opts.outputFile) fs.writeFileSync(opts.outputFile, out.buffer);
  return { base64img: out.buffer.toString("base64"), ...out };
}

export default RemoveAcClient;
