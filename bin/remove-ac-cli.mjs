#!/usr/bin/env node
/**
 * remove.ac Official Zero-Dependency CLI (Node.js >= 18)
 * Compatible with POST https://remove.ac/v1.0/removebg, POST /v1.0/removebg/ticket, & GET /v1.0/account
 *
 * Usage:
 *   export REMOVE_AC_API_KEY="rac_live_..."
 *   node remove-ac-cli.mjs --account
 *   node remove-ac-cli.mjs photo.jpg --output photo-nobg.png
 *   node remove-ac-cli.mjs ./input-folder --output-dir ./cutouts --size auto --format png
 *   node remove-ac-cli.mjs ./hot-folder --output-dir ./cutouts --watch
 */
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWithoutRedirects,
  isLoopbackTestOrigin,
  validateHttpsEndpointUrl,
} from "../node/net-safety.mjs";

const DEFAULT_BASE_URL = "https://remove.ac";
const SUPPORTED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DIRECT_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
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

export function printHelp(out = console.log) {
  out(`remove.ac CLI — Cloud GPU Background Removal (v1.0 + Zero-Disk Direct Stream)

Usage:
  node remove-ac-cli.mjs --account [--api-key <key>]
  node remove-ac-cli.mjs <file-or-dir...> [options]
  node remove-ac-cli.mjs <dir> --output-dir <dir> --watch [options]

Options:
  --api-key <key>          API key (defaults to REMOVE_AC_API_KEY or REMOVE_BG_API_KEY)
  --output, -o <path>      Output file path (single input file only)
  --output-dir <dir>       Output directory for single, batch, or watched files
  --watch                  Continuously watch input directory(ies) for new/updated images
  --poll-ms <ms>           Watch polling interval in milliseconds (default: 2000)
  --size <value>           preview | small | regular | medium | hd | 4k | full | auto (default: auto)
  --format <value>         auto | png | jpg | webp | zip (default: png)
  --channels <value>       rgba | alpha (default: rgba)
  --type <value>           auto | person | product | car | animal | graphic | transportation
  --type-level <value>     none | 1 | 2 | latest
  --roi <box>              Region of interest, e.g. "0% 0% 100% 100%" or "10px 10px 800px 800px"
  --scale <value>          Subject scale, e.g. "original" or "85%"
  --position <value>       Subject position, e.g. "original", "center", or "50% 50%"
  --bg-color <hex>         Hex background color (e.g. ffffff)
  --bg-image <path-or-url> Composite over a local background image or https:// URL
  --crop                   Trim transparent margins
  --crop-margin <value>    Margin around cropped subject (e.g. "24px" or "5%")
  --shadow, --add-shadow   Add realistic shadow
  --shadow-type <value>    auto | car | drop | soft | contact | reflection | none
  --shadow-opacity <0-100> Shadow opacity percentage (0..100)
  --no-semitransparency    Disable semitransparency preservation on glass/tulle
  --direct                 Always stream via /v1.0/removebg/ticket -> GPU RAM (up to 25 MB)
  --idempotency-key <key>  Explicit Idempotency-Key (defaults to unique per-invocation key)
  --endpoint <url>         API origin (default: ${DEFAULT_BASE_URL})
  --account                Inspect remaining credit balance and rate limit
  --help, -h               Show this help message
`);
}

export function parseArgs(argv) {
  const opts = {
    inputs: [],
    apiKey: process.env.REMOVE_AC_API_KEY || process.env.REMOVE_BG_API_KEY || "",
    output: null,
    outputDir: null,
    watch: false,
    pollMs: 2000,
    size: "auto",
    format: "png",
    channels: "rgba",
    type: "auto",
    typeLevel: "",
    roi: "",
    scale: "",
    position: "",
    bgColor: "",
    bgImage: "",
    crop: false,
    cropMargin: "",
    shadow: false,
    shadowType: "",
    shadowOpacity: "",
    semitransparency: true,
    direct: false,
    idempotencyKey: "",
    account: false,
    help: false,
    endpoint: process.env.REMOVE_AC_BASE_URL || DEFAULT_BASE_URL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--account") opts.account = true;
    else if (arg === "--watch") opts.watch = true;
    else if (arg === "--poll-ms") opts.pollMs = Math.max(250, Number.parseInt(argv[++i] || "2000", 10) || 2000);
    else if (arg === "--crop") opts.crop = true;
    else if (arg === "--crop-margin") opts.cropMargin = argv[++i] || "";
    else if (arg === "--shadow" || arg === "--add-shadow") opts.shadow = true;
    else if (arg === "--shadow-type") opts.shadowType = argv[++i] || "";
    else if (arg === "--shadow-opacity") opts.shadowOpacity = argv[++i] || "";
    else if (arg === "--no-semitransparency") opts.semitransparency = false;
    else if (arg === "--direct") opts.direct = true;
    else if (arg === "--idempotency-key") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("--idempotency-key requires a non-empty key value.");
      }
      if (next.length > 255) {
        throw new Error("--idempotency-key must be 255 characters or fewer.");
      }
      opts.idempotencyKey = next;
    }
    else if (arg === "--api-key") opts.apiKey = argv[++i] || "";
    else if (arg === "--output" || arg === "-o") opts.output = argv[++i] || null;
    else if (arg === "--output-dir") opts.outputDir = argv[++i] || null;
    else if (arg === "--size") opts.size = argv[++i] || "auto";
    else if (arg === "--format") opts.format = argv[++i] || "png";
    else if (arg === "--channels") opts.channels = argv[++i] || "rgba";
    else if (arg === "--type") opts.type = argv[++i] || "auto";
    else if (arg === "--type-level") opts.typeLevel = argv[++i] || "";
    else if (arg === "--roi") opts.roi = argv[++i] || "";
    else if (arg === "--scale") opts.scale = argv[++i] || "";
    else if (arg === "--position") opts.position = argv[++i] || "";
    else if (arg === "--bg-color") opts.bgColor = argv[++i] || "";
    else if (arg === "--bg-image") opts.bgImage = argv[++i] || "";
    else if (arg === "--endpoint") opts.endpoint = argv[++i] || DEFAULT_BASE_URL;
    else if (!arg.startsWith("-")) opts.inputs.push(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

export function collectFiles(inputs) {
  const files = [];
  for (const target of inputs) {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(resolved).sort()) {
        const ext = path.extname(entry).toLowerCase();
        if (SUPPORTED_EXTS.has(ext) && !entry.includes("-nobg.")) {
          const full = path.join(resolved, entry);
          try {
            if (fs.statSync(full).isFile()) files.push(full);
          } catch {
            // ignore transient file races in watch folders
          }
        }
      }
    } else if (stat.isFile()) {
      files.push(resolved);
    }
  }
  return files;
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function deriveSubIdempotencyKey(idem, suffix) {
  const trimmed = String(idem || "").trim();
  if (!trimmed || trimmed.length > 255) {
    throw new Error("Idempotency-Key must be between 1 and 255 characters.");
  }
  const direct = `${trimmed}:${suffix}`;
  if (direct.length <= 255) return direct;
  const hash = sha256Hex(Buffer.from(trimmed, "utf8")).slice(0, 32);
  return `${trimmed.slice(0, 180)}:${hash}:${suffix}`;
}

function resolveBgInput(bgSpec) {
  if (!bgSpec) return null;
  if (/^https?:\/\//i.test(bgSpec)) {
    return { kind: "url", url: bgSpec };
  }
  const resolved = path.resolve(bgSpec);
  const bytes = fs.readFileSync(resolved);
  return {
    kind: "file",
    path: resolved,
    bytes,
    sha256: sha256Hex(bytes),
    mime: mimeForPath(resolved),
  };
}

export async function processImageBuffer({
  bytes,
  fileName,
  mimeType,
  opts,
  baseUrl,
  bgInput = null,
  fetchImpl = globalThis.fetch,
  lookupFn = dns.promises.lookup,
}) {
  const safeFetch = async (url, init = {}) => fetchWithoutRedirects(fetchImpl, url, init);
  const fgSha = sha256Hex(bytes);
  const bgTag = bgInput
    ? bgInput.kind === "url"
      ? `bgurl:${sha256Hex(Buffer.from(bgInput.url)).slice(0, 12)}`
      : `bg:${bgInput.sha256.slice(0, 12)}`
    : "";
  const paramFingerprint = sha256Hex(
    Buffer.from(
      JSON.stringify({
        fgSha,
        size: opts.size,
        format: opts.format,
        channels: opts.channels,
        type: opts.type,
        roi: opts.roi,
        scale: opts.scale,
        position: opts.position,
        bgColor: opts.bgColor,
        bgTag,
        crop: opts.crop,
        cropMargin: opts.cropMargin,
        shadow: opts.shadow,
        shadowType: opts.shadowType,
        shadowOpacity: opts.shadowOpacity,
        semitransparency: opts.semitransparency,
        typeLevel: opts.typeLevel,
      }),
    ),
  ).slice(0, 16);
  if (opts.idempotencyKey && opts.idempotencyKey.length > 255) {
    throw new Error("Idempotency-Key must be between 1 and 255 characters.");
  }
  const idemKey = opts.idempotencyKey || `cli:${paramFingerprint}:${crypto.randomUUID()}`;

  const runViaTicket = async (idemSuffix = "ticket") => {
    const ticketBody = {
      foregroundSha256: fgSha,
      foregroundByteLength: bytes.byteLength,
      size: opts.size,
      format: opts.format,
      channels: opts.channels,
      semitransparency: opts.semitransparency,
    };
    if (opts.type && opts.type !== "auto") ticketBody.type = opts.type;
    if (opts.typeLevel) ticketBody.type_level = opts.typeLevel;
    if (opts.roi) ticketBody.roi = opts.roi;
    if (opts.scale) ticketBody.scale = opts.scale;
    if (opts.position) ticketBody.position = opts.position;
    if (opts.bgColor) ticketBody.bg_color = opts.bgColor;
    if (bgInput?.kind === "url") ticketBody.bg_image_url = bgInput.url;
    if (bgInput?.kind === "file") {
      ticketBody.bgImageSha256 = bgInput.sha256;
      ticketBody.bgImageByteLength = bgInput.bytes.byteLength;
    }
    if (opts.crop) ticketBody.crop = true;
    if (opts.cropMargin) ticketBody.crop_margin = opts.cropMargin;
    if (opts.shadow) ticketBody.add_shadow = true;
    if (opts.shadowType) ticketBody.shadow_type = opts.shadowType;
    if (opts.shadowOpacity !== "") ticketBody.shadow_opacity = opts.shadowOpacity;

    let ticketRes;
    try {
      ticketRes = await safeFetch(`${baseUrl}/v1.0/removebg/ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": opts.apiKey,
          "Idempotency-Key": deriveSubIdempotencyKey(idemKey, idemSuffix),
        },
        body: JSON.stringify(ticketBody),
      });
    } catch (err) {
      if (err && typeof err.statusCode === "number") {
        return { ok: false, status: err.statusCode, errorText: err.message };
      }
      throw err;
    }
    if (!ticketRes.ok) {
      return { ok: false, status: ticketRes.status, errorText: await ticketRes.text() };
    }
    const ticketJson = await ticketRes.json();
    const ticket = ticketJson?.data?.ticket;
    const directEndpoint = ticketJson?.data?.directEndpoint;
    if (
      typeof ticket !== "string" ||
      !ticket.trim() ||
      typeof directEndpoint !== "string" ||
      !directEndpoint.trim()
    ) {
      return { ok: false, status: 502, errorText: "Missing ticket or directEndpoint in response" };
    }
    const epErr = await validateHttpsEndpointUrl(directEndpoint, {
      lookupFn,
      allowLoopbackOrigin: isLoopbackTestOrigin(baseUrl),
      label: "directEndpoint",
    });
    if (epErr) {
      return { ok: false, status: 502, errorText: epErr };
    }

    const directForm = new FormData();
    directForm.set("image_file", new Blob([bytes], { type: mimeType }), fileName);
    if (bgInput?.kind === "file") {
      directForm.set(
        "bg_image_file",
        new Blob([bgInput.bytes], { type: bgInput.mime }),
        path.basename(bgInput.path),
      );
    }
    let directRes;
    try {
      directRes = await safeFetch(directEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ticket}`,
        },
        body: directForm,
      });
    } catch (err) {
      if (err && typeof err.statusCode === "number") {
        return { ok: false, status: err.statusCode, errorText: err.message };
      }
      throw err;
    }
    if (!directRes.ok) {
      return { ok: false, status: directRes.status, errorText: await directRes.text() };
    }
    return {
      ok: true,
      buffer: Buffer.from(await directRes.arrayBuffer()),
      charged:
        directRes.headers.get("x-credits-charged") ??
        String(ticketJson?.data?.creditsHeld ?? ticketJson?.creditsHeld ?? "?"),
      via: "direct-stream",
    };
  };

  const needsDirect =
    opts.direct ||
    bytes.byteLength > DIRECT_STREAM_THRESHOLD_BYTES ||
    (bgInput?.kind === "file" && bgInput.bytes.byteLength > DIRECT_STREAM_THRESHOLD_BYTES) ||
    shouldPreFlightViaTicket(bytes, opts.size, opts.format, opts.channels, Boolean(opts.crop));

  if (needsDirect) {
    return runViaTicket("direct");
  }

  const buildFormData = () => {
    const form = new FormData();
    form.set("image_file", new Blob([bytes], { type: mimeType }), fileName);
    form.set("size", opts.size);
    form.set("format", opts.format);
    form.set("channels", opts.channels);
    if (opts.type && opts.type !== "auto") form.set("type", opts.type);
    if (opts.typeLevel) form.set("type_level", opts.typeLevel);
    if (opts.roi) form.set("roi", opts.roi);
    if (opts.scale) form.set("scale", opts.scale);
    if (opts.position) form.set("position", opts.position);
    if (opts.bgColor) form.set("bg_color", opts.bgColor);
    if (bgInput?.kind === "url") form.set("bg_image_url", bgInput.url);
    if (bgInput?.kind === "file") {
      form.set("bg_image_file", new Blob([bgInput.bytes], { type: bgInput.mime }), path.basename(bgInput.path));
    }
    if (opts.crop) form.set("crop", "true");
    if (opts.cropMargin) form.set("crop_margin", opts.cropMargin);
    if (opts.shadow) form.set("add_shadow", "true");
    if (opts.shadowType) form.set("shadow_type", opts.shadowType);
    if (opts.shadowOpacity !== "") form.set("shadow_opacity", String(opts.shadowOpacity));
    if (!opts.semitransparency) form.set("semitransparency", "false");
    return form;
  };

  let res;
  try {
    res = await safeFetch(`${baseUrl}/v1.0/removebg`, {
      method: "POST",
      headers: {
        "X-Api-Key": opts.apiKey,
        "Idempotency-Key": idemKey,
      },
      body: buildFormData(),
    });
  } catch (err) {
    if (err && typeof err.statusCode === "number") {
      return { ok: false, status: err.statusCode, errorText: err.message };
    }
    throw err;
  }

  if (res.status === 409 && !opts.idempotencyKey) {
    const errText = await res.text();
    if (errText.includes("idempotency_replay_unavailable")) {
      try {
        res = await safeFetch(`${baseUrl}/v1.0/removebg`, {
          method: "POST",
          headers: {
            "X-Api-Key": opts.apiKey,
            "Idempotency-Key": `cli:${paramFingerprint}:${crypto.randomUUID()}`,
          },
          body: buildFormData(),
        });
      } catch (err) {
        if (err && typeof err.statusCode === "number") {
          return { ok: false, status: err.statusCode, errorText: err.message };
        }
        throw err;
      }
    } else {
      return { ok: false, status: 409, errorText: errText };
    }
  }

  if (res.status === 413) {
    // High-resolution output exceeded serverless gateway cap (0 credits charged) — upgrade to direct GPU stream
    return runViaTicket("fallback413");
  }

  if (!res.ok) {
    return { ok: false, status: res.status, errorText: await res.text() };
  }

  return {
    ok: true,
    buffer: Buffer.from(await res.arrayBuffer()),
    charged: res.headers.get("x-credits-charged") ?? "?",
    via: "gateway",
  };
}

function resolveDestPath(filePath, opts) {
  const outExt = opts.format === "auto" ? "png" : opts.format === "jpeg" ? "jpg" : opts.format;
  const stem = path.basename(filePath, path.extname(filePath));
  return opts.output
    ? path.resolve(opts.output)
    : path.join(opts.outputDir ? path.resolve(opts.outputDir) : path.dirname(filePath), `${stem}-nobg.${outExt}`);
}

async function processSingleFile(filePath, opts, baseUrl, bgInput) {
  const bytes = fs.readFileSync(filePath);
  const outcome = await processImageBuffer({
    bytes,
    fileName: path.basename(filePath),
    mimeType: mimeForPath(filePath),
    opts,
    baseUrl,
    bgInput,
  });
  if (!outcome.ok) {
    console.error(`[FAIL] ${path.basename(filePath)} -> HTTP ${outcome.status}: ${outcome.errorText}`);
    return false;
  }
  const destPath = resolveDestPath(filePath, opts);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, outcome.buffer);
  console.log(`[OK] ${path.basename(filePath)} -> ${destPath} (${outcome.charged} credits, ${outcome.via})`);
  return true;
}

export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.account && opts.inputs.length === 0)) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }
  if (!opts.apiKey) {
    console.error("Error: Missing API key. Pass --api-key <key> or set REMOVE_AC_API_KEY.");
    process.exit(2);
  }
  if (!opts.account && opts.watch) {
    if (opts.idempotencyKey) {
      console.error("Error: --idempotency-key cannot be used with --watch (each watched file requires a distinct key).");
      process.exit(2);
    }
    if (opts.output) {
      console.error("Error: --watch requires --output-dir instead of --output.");
      process.exit(2);
    }
  }

  let precollectedFiles = null;
  if (!opts.account && !opts.watch) {
    precollectedFiles = collectFiles(opts.inputs);
    if (precollectedFiles.length === 0) {
      console.error("No supported image files (.jpg, .jpeg, .png, .webp) found.");
      process.exit(1);
    }
    if (opts.idempotencyKey && precollectedFiles.length > 1) {
      console.error("Error: --idempotency-key can only be used with a single input file.");
      process.exit(2);
    }
    if (opts.output && precollectedFiles.length > 1) {
      console.error("Error: --output can only be used with a single input file. Use --output-dir for batches.");
      process.exit(2);
    }
  }

  const baseUrl = opts.endpoint.replace(/\/+$/, "");
  const endpointErr = await validateHttpsEndpointUrl(baseUrl, {
    allowLoopbackOrigin: isLoopbackTestOrigin(baseUrl),
    label: "endpoint",
  });
  if (endpointErr) {
    console.error(`Error: ${endpointErr}`);
    process.exit(2);
  }

  if (opts.account) {
    const res = await fetchWithoutRedirects(fetch, `${baseUrl}/v1.0/account`, {
      headers: { "X-Api-Key": opts.apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${text}`);
      process.exit(1);
    }
    console.log(text);
    return;
  }

  const bgInput = resolveBgInput(opts.bgImage);

  if (opts.watch) {
    if (opts.outputDir) {
      fs.mkdirSync(path.resolve(opts.outputDir), { recursive: true });
    }
    const seen = new Map();
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`[WATCH] Monitoring ${opts.inputs.join(", ")} (poll=${opts.pollMs}ms). Press Ctrl+C to stop.`);

    while (!stopping) {
      const candidates = collectFiles(opts.inputs);
      for (const filePath of candidates) {
        if (stopping) break;
        if (opts.outputDir && path.resolve(path.dirname(filePath)) === path.resolve(opts.outputDir)) {
          if (filePath.includes("-nobg.")) continue;
        }
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (stat.size === 0) continue;
        const sig = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
        if (seen.get(filePath) === sig) continue;
        const ok = await processSingleFile(filePath, opts, baseUrl, bgInput);
        if (ok) {
          seen.set(filePath, sig);
        }
      }
      if (stopping) break;
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
    }
    console.log("[WATCH] Stopped.");
    return;
  }

  const files = precollectedFiles;
  if (opts.outputDir) {
    fs.mkdirSync(path.resolve(opts.outputDir), { recursive: true });
  }

  let failed = 0;
  for (const filePath of files) {
    const ok = await processSingleFile(filePath, opts, baseUrl, bgInput);
    if (!ok) failed += 1;
  }

  if (failed > 0) process.exit(1);
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
