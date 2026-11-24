#!/usr/bin/env node
/**
 * remove.ac Official Zero-Dependency CLI v1.3.2 (Node.js >= 18)
 * Compatible with POST https://remove.ac/v1.0/removebg, POST /v1.0/removebg/ticket, & GET /v1.0/account
 *
 * Usage:
 *   export REMOVE_AC_API_KEY="rac_live_..."
 *   node remove-ac-cli.mjs --account
 *   node remove-ac-cli.mjs photo.jpg --output photo-nobg.png
 *   node remove-ac-cli.mjs ./input-folder --output-dir ./cutouts --concurrency=4 --size=50mp
 *   node remove-ac-cli.mjs ./hot-folder --output-dir ./cutouts --watch --format=webp --crop
 */
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWithoutRedirects,
  isLoopbackTestOrigin,
  validateDirectEndpointUrl,
  validateHttpsEndpointUrl,
  validateRemoteImageUrl,
} from "../node/net-safety.mjs";

export const CLI_VERSION = "1.3.2";
export const USER_AGENT = `remove-ac-cli/${CLI_VERSION}`;
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
  "maximum",
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
const SUPPORTED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DIRECT_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_COMBINED_UPLOAD_BYTES = 30 * 1024 * 1024 - 512 * 1024; // 29.5 MB (30,932,992 bytes)
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_DIMENSION = 50_000;
const DIRECT_RGBA_PNG_PIXELS = 5_000_000;
const DIRECT_CROPPED_RGBA_PNG_PIXELS = 10_000_000;
const MAX_CONCURRENCY = 8;

function detectSupportedImageMime(bytes) {
  if (!bytes || bytes.byteLength < 4) return null;
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
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
  return null;
}

function assertCliBinaryBounds(bytes, label) {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`${label} exceeds 25 MB maximum upload size (26214400 bytes).`);
  }
  const dims = parseImageDimensions(bytes);
  if (
    dims &&
    (dims.width > MAX_IMAGE_DIMENSION ||
      dims.height > MAX_IMAGE_DIMENSION ||
      dims.width * dims.height > MAX_IMAGE_PIXELS)
  ) {
    throw new Error(
      `${label} resolution ${dims.width}x${dims.height} exceeds 50 MP / 50,000 px maximum.`,
    );
  }
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

function mergeWithUserAgent(rawHeaders) {
  const out = { ...(rawHeaders || {}) };
  if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) {
    out["User-Agent"] = USER_AGENT;
  }
  return out;
}

function normalizeAndValidateCliEnums(opts) {
  opts.size = String(opts.size || "auto").trim().toLowerCase();
  if (!VALID_SIZE_SET.has(opts.size)) {
    throw new Error(`Unsupported --size '${opts.size}'. Expected one of: ${VALID_SIZES.join(", ")}`);
  }
  opts.format = String(opts.format || "png").trim().toLowerCase();
  if (!VALID_FORMAT_SET.has(opts.format)) {
    throw new Error(`Unsupported --format '${opts.format}'. Expected one of: ${VALID_FORMATS.join(", ")}`);
  }
  opts.channels = String(opts.channels || "rgba").trim().toLowerCase();
  if (!VALID_CHANNEL_SET.has(opts.channels)) {
    throw new Error(`Unsupported --channels '${opts.channels}'. Expected one of: ${VALID_CHANNELS.join(", ")}`);
  }
  opts.type = String(opts.type || "auto").trim().toLowerCase();
  if (!VALID_TYPE_SET.has(opts.type)) {
    throw new Error(`Unsupported --type '${opts.type}'. Expected one of: ${VALID_TYPES.join(", ")}`);
  }
  if (opts.shadowType !== undefined && opts.shadowType !== null && String(opts.shadowType).trim() !== "") {
    opts.shadowType = String(opts.shadowType).trim().toLowerCase();
    if (!VALID_SHADOW_SET.has(opts.shadowType)) {
      throw new Error(
        `Unsupported --shadow-type '${opts.shadowType}'. Expected one of: ${VALID_SHADOW_TYPES.join(", ")}`,
      );
    }
  } else {
    opts.shadowType = "";
  }
  opts.bgColor = opts.bgColor !== undefined && opts.bgColor !== null ? String(opts.bgColor).trim() : "";
  opts.bgImage = opts.bgImage !== undefined && opts.bgImage !== null ? String(opts.bgImage).trim() : "";
  if (opts.bgColor && opts.bgImage) {
    throw new Error("Cannot combine --bg-color and --bg-image; specify at most one background option.");
  }
}

export function printHelp(out = console.log) {
  out(`remove.ac CLI v${CLI_VERSION} — Cloud GPU Background Removal (up to 25 MB / 50 MP Zero-Disk Stream)

Usage:
  node remove-ac-cli.mjs --account [--api-key <key>]
  node remove-ac-cli.mjs <file-or-dir...> [options]
  node remove-ac-cli.mjs <dir> --output-dir <dir> --concurrency 4 --size 50mp
  node remove-ac-cli.mjs <dir> --output-dir <dir> --watch [options]

Options:
  --api-key <key>          API key (defaults to REMOVE_AC_API_KEY or REMOVE_BG_API_KEY)
  --output, -o <path>      Output file path (single input file only)
  --output-dir <dir>       Output directory for single, batch, or watched files
  --concurrency <1..8>     Parallel worker count for batch runs (default: 1)
  --watch                  Continuously watch input directory(ies) for new/updated images
  --poll-ms <ms>           Watch polling interval in milliseconds (default: 2000)
  --size <value>           preview | small | regular | medium | hd | 4k | 25mp | 50mp | full | maximum | auto (default: auto)
  --format <value>         auto | png | jpg | jpeg | webp | zip (default: png)
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
  --direct                 Always stream via /v1.0/removebg/ticket -> GPU RAM (up to 25 MB / 50 MP)
  --idempotency-key <key>  Explicit Idempotency-Key (defaults to unique per-invocation key)
  --endpoint <url>         API origin (default: ${DEFAULT_BASE_URL})
  --account                Inspect remaining credit balance and rate limit
  --version, -v            Print CLI version (${CLI_VERSION}) and exit
  --help, -h               Show this help message
`);
}

export function parseArgs(argv) {
  const opts = {
    inputs: [],
    apiKey: process.env.REMOVE_AC_API_KEY || process.env.REMOVE_BG_API_KEY || "",
    output: null,
    outputDir: null,
    concurrency: 1,
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
    version: false,
    help: false,
    endpoint: process.env.REMOVE_AC_BASE_URL || DEFAULT_BASE_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const rawArg = argv[i];
    if (!rawArg.startsWith("-")) {
      opts.inputs.push(rawArg);
      continue;
    }

    const eqIdx = rawArg.indexOf("=");
    const hasInline = eqIdx !== -1;
    const arg = hasInline ? rawArg.slice(0, eqIdx) : rawArg;
    const inlineVal = hasInline ? rawArg.slice(eqIdx + 1) : undefined;

    const assertNoInline = () => {
      if (hasInline) {
        throw new Error(`Boolean option ${arg} does not take a value.`);
      }
    };
    const nextValue = () => (hasInline ? inlineVal : argv[++i]);

    if (arg === "--help" || arg === "-h") {
      assertNoInline();
      opts.help = true;
    } else if (arg === "--version" || arg === "-v") {
      assertNoInline();
      opts.version = true;
    } else if (arg === "--account") {
      assertNoInline();
      opts.account = true;
    } else if (arg === "--watch") {
      assertNoInline();
      opts.watch = true;
    } else if (arg === "--poll-ms") {
      opts.pollMs = Math.max(250, Number.parseInt(nextValue() || "2000", 10) || 2000);
    } else if (arg === "--concurrency") {
      const rawConc = String(nextValue() ?? "").trim();
      const parsedConc = Number(rawConc);
      if (!rawConc || !Number.isInteger(parsedConc) || parsedConc < 1 || parsedConc > MAX_CONCURRENCY) {
        throw new Error(`--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}.`);
      }
      opts.concurrency = parsedConc;
    } else if (arg === "--crop") {
      assertNoInline();
      opts.crop = true;
    } else if (arg === "--crop-margin") {
      opts.cropMargin = nextValue() || "";
    } else if (arg === "--shadow" || arg === "--add-shadow") {
      assertNoInline();
      opts.shadow = true;
    } else if (arg === "--shadow-type") {
      opts.shadowType = nextValue() || "";
    } else if (arg === "--shadow-opacity") {
      opts.shadowOpacity = nextValue() || "";
    } else if (arg === "--no-semitransparency") {
      assertNoInline();
      opts.semitransparency = false;
    } else if (arg === "--direct") {
      assertNoInline();
      opts.direct = true;
    } else if (arg === "--idempotency-key") {
      const next = nextValue();
      if (!next || (!hasInline && next.startsWith("-"))) {
        throw new Error("--idempotency-key requires a non-empty key value.");
      }
      if (next.length > 255) {
        throw new Error("--idempotency-key must be 255 characters or fewer.");
      }
      opts.idempotencyKey = next;
    } else if (arg === "--api-key") {
      opts.apiKey = nextValue() || "";
    } else if (arg === "--output" || arg === "-o") {
      opts.output = nextValue() || null;
    } else if (arg === "--output-dir") {
      opts.outputDir = nextValue() || null;
    } else if (arg === "--size") {
      opts.size = nextValue() || "auto";
    } else if (arg === "--format") {
      opts.format = nextValue() || "png";
    } else if (arg === "--channels") {
      opts.channels = nextValue() || "rgba";
    } else if (arg === "--type") {
      opts.type = nextValue() || "auto";
    } else if (arg === "--type-level") {
      opts.typeLevel = nextValue() || "";
    } else if (arg === "--roi") {
      opts.roi = nextValue() || "";
    } else if (arg === "--scale") {
      opts.scale = nextValue() || "";
    } else if (arg === "--position") {
      opts.position = nextValue() || "";
    } else if (arg === "--bg-color") {
      const next = nextValue();
      if (!next || !String(next).trim() || (!hasInline && String(next).startsWith("-"))) {
        throw new Error("--bg-color requires a non-empty hex color value.");
      }
      opts.bgColor = String(next).trim();
    } else if (arg === "--bg-image") {
      const next = nextValue();
      if (!next || !String(next).trim() || (!hasInline && String(next).startsWith("-"))) {
        throw new Error("--bg-image requires a non-empty local file path or http(s):// URL.");
      }
      opts.bgImage = String(next).trim();
    } else if (arg === "--endpoint") {
      opts.endpoint = nextValue() || DEFAULT_BASE_URL;
    } else {
      throw new Error(`Unknown option: ${rawArg}`);
    }
  }

  normalizeAndValidateCliEnums(opts);
  return opts;
}

export function collectFiles(inputs, { excludeCanonicalPath = "" } = {}) {
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
            if (fs.statSync(full).isFile()) {
              if (excludeCanonicalPath && fs.realpathSync(full) === excludeCanonicalPath) {
                continue;
              }
              files.push(full);
            }
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

function looksLikeCliUrlCandidate(raw) {
  const s = String(raw || "").trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(s) || /^(data|javascript|file):/i.test(s);
}

export async function resolveBgInput(bgSpec, { lookupFn = dns.promises.lookup } = {}) {
  const trimmed = bgSpec !== undefined && bgSpec !== null ? String(bgSpec).trim() : "";
  if (!trimmed) return null;
  if (trimmed.includes("\0")) {
    throw new Error("Invalid --bg-image value.");
  }
  if (looksLikeCliUrlCandidate(trimmed)) {
    const ssrfErr = await validateRemoteImageUrl(trimmed, lookupFn);
    if (ssrfErr) {
      throw new Error(`Disallowed --bg-image URL (${ssrfErr})`);
    }
    return { kind: "url", url: trimmed };
  }
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error(`--bg-image file does not exist: ${resolved}`);
  }
  const st = fs.statSync(resolved);
  if (!st.isFile()) {
    throw new Error(`--bg-image must point to a regular image file: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(
      `Unsupported --bg-image extension '${ext || "(none)"}'. Expected .png, .jpg, .jpeg, or .webp.`,
    );
  }
  if (st.size <= 0) {
    throw new Error(`--bg-image file must not be empty: ${resolved}`);
  }
  if (st.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `--bg-image file exceeds 25 MB maximum upload size (26214400 bytes): ${resolved}`,
    );
  }
  const bytes = fs.readFileSync(resolved);
  assertCliBinaryBounds(bytes, "--bg-image file");
  const detectedMime = detectSupportedImageMime(bytes);
  if (!detectedMime) {
    throw new Error(`--bg-image file is not a valid PNG, JPEG, or WebP image: ${resolved}`);
  }
  return {
    kind: "file",
    path: resolved,
    bytes,
    sha256: sha256Hex(bytes),
    mime: detectedMime,
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
  const validatedOpts = { ...opts };
  normalizeAndValidateCliEnums(validatedOpts);
  assertCliBinaryBounds(bytes, "Foreground image");

  let effectiveBgInput = null;
  if (bgInput !== null && bgInput !== undefined) {
    if (validatedOpts.bgColor) {
      throw new Error("Cannot combine --bg-color and --bg-image; specify at most one background option.");
    }
    if (bgInput.kind === "url") {
      const ssrfErr = await validateRemoteImageUrl(bgInput.url, lookupFn);
      if (ssrfErr) {
        throw new Error(`Disallowed --bg-image URL (${ssrfErr})`);
      }
      effectiveBgInput = { kind: "url", url: String(bgInput.url).trim() };
    } else if (bgInput.kind === "file") {
      assertCliBinaryBounds(bgInput.bytes, "--bg-image file");
      const detectedMime = detectSupportedImageMime(bgInput.bytes);
      if (!detectedMime) {
        throw new Error("--bg-image file is not a valid PNG, JPEG, or WebP image.");
      }
      effectiveBgInput = {
        ...bgInput,
        mime: detectedMime,
        sha256: bgInput.sha256 || sha256Hex(bgInput.bytes),
      };
    } else {
      throw new Error("Invalid bgInput descriptor.");
    }
  } else if (validatedOpts.bgImage) {
    effectiveBgInput = await resolveBgInput(validatedOpts.bgImage, { lookupFn });
  }

  if (
    effectiveBgInput?.kind === "file" &&
    bytes.byteLength + effectiveBgInput.bytes.byteLength > MAX_COMBINED_UPLOAD_BYTES
  ) {
    throw new Error(
      "Combined foreground and --bg-image size exceeds 29.5 MB raw image limit (30932992 bytes; 30 MB multipart envelope).",
    );
  }

  const safeFetch = async (url, init = {}) =>
    fetchWithoutRedirects(fetchImpl, url, {
      ...init,
      headers: mergeWithUserAgent(init.headers),
    });

  const releaseTicketHold = async (holdId, releaseToken) => {
    if (!holdId || !releaseToken || !validatedOpts.apiKey) return false;
    try {
      const rRes = await safeFetch(`${baseUrl}/v1.0/removebg/ticket/release`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": validatedOpts.apiKey,
        },
        body: JSON.stringify({ holdId, releaseToken }),
        signal: AbortSignal.timeout(5000),
      });
      return Boolean(rRes && rRes.ok);
    } catch {
      return false;
    }
  };

  const fgSha = sha256Hex(bytes);
  const bgTag = effectiveBgInput
    ? effectiveBgInput.kind === "url"
      ? `bgurl:${sha256Hex(Buffer.from(effectiveBgInput.url)).slice(0, 12)}`
      : `bg:${effectiveBgInput.sha256.slice(0, 12)}`
    : "";
  const paramFingerprint = sha256Hex(
    Buffer.from(
      JSON.stringify({
        fgSha,
        size: validatedOpts.size,
        format: validatedOpts.format,
        channels: validatedOpts.channels,
        type: validatedOpts.type,
        roi: validatedOpts.roi,
        scale: validatedOpts.scale,
        position: validatedOpts.position,
        bgColor: validatedOpts.bgColor,
        bgTag,
        crop: validatedOpts.crop,
        cropMargin: validatedOpts.cropMargin,
        shadow: validatedOpts.shadow,
        shadowType: validatedOpts.shadowType,
        shadowOpacity: validatedOpts.shadowOpacity,
        semitransparency: validatedOpts.semitransparency,
        typeLevel: validatedOpts.typeLevel,
      }),
    ),
  ).slice(0, 16);
  if (validatedOpts.idempotencyKey && validatedOpts.idempotencyKey.length > 255) {
    throw new Error("Idempotency-Key must be between 1 and 255 characters.");
  }
  const idemKey = validatedOpts.idempotencyKey || `cli:${paramFingerprint}:${crypto.randomUUID()}`;

  const runViaTicket = async (idemSuffix = "ticket") => {
    const ticketBody = {
      foregroundSha256: fgSha,
      foregroundByteLength: bytes.byteLength,
      size: validatedOpts.size,
      format: validatedOpts.format,
      channels: validatedOpts.channels,
      semitransparency: validatedOpts.semitransparency,
    };
    if (validatedOpts.type && validatedOpts.type !== "auto") ticketBody.type = validatedOpts.type;
    if (validatedOpts.typeLevel) ticketBody.type_level = validatedOpts.typeLevel;
    if (validatedOpts.roi) ticketBody.roi = validatedOpts.roi;
    if (validatedOpts.scale) ticketBody.scale = validatedOpts.scale;
    if (validatedOpts.position) ticketBody.position = validatedOpts.position;
    if (validatedOpts.bgColor) ticketBody.bg_color = validatedOpts.bgColor;
    if (effectiveBgInput?.kind === "url") ticketBody.bg_image_url = effectiveBgInput.url;
    if (effectiveBgInput?.kind === "file") {
      ticketBody.bgImageSha256 = effectiveBgInput.sha256;
      ticketBody.bgImageByteLength = effectiveBgInput.bytes.byteLength;
    }
    if (validatedOpts.crop) ticketBody.crop = true;
    if (validatedOpts.cropMargin) ticketBody.crop_margin = validatedOpts.cropMargin;
    if (validatedOpts.shadow) ticketBody.add_shadow = true;
    if (validatedOpts.shadowType) ticketBody.shadow_type = validatedOpts.shadowType;
    if (validatedOpts.shadowOpacity !== "") ticketBody.shadow_opacity = validatedOpts.shadowOpacity;

    let ticketRes;
    try {
      ticketRes = await safeFetch(`${baseUrl}/v1.0/removebg/ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": validatedOpts.apiKey,
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
    const tData = ticketJson?.data;
    const ticket = tData?.ticket;
    const directEndpoint = tData?.directEndpoint;
    const rawHoldId = tData?.holdId ?? tData?.hold_id ?? tData?.lock_id;
    const rawReleaseToken = tData?.releaseToken ?? tData?.release_token;
    const holdId = typeof rawHoldId === "string" ? rawHoldId.trim() : "";
    const releaseToken = typeof rawReleaseToken === "string" ? rawReleaseToken.trim() : "";

    if (
      typeof ticket !== "string" ||
      !ticket.trim() ||
      typeof directEndpoint !== "string" ||
      !directEndpoint.trim()
    ) {
      await releaseTicketHold(holdId, releaseToken);
      return { ok: false, status: 502, errorText: "Missing ticket or directEndpoint in response" };
    }
    const epErr = await validateDirectEndpointUrl(directEndpoint, {
      baseUrl,
      lookupFn,
      label: "directEndpoint",
    });
    if (epErr) {
      await releaseTicketHold(holdId, releaseToken);
      return { ok: false, status: 502, errorText: epErr };
    }

    const directForm = new FormData();
    directForm.set("image_file", new Blob([bytes], { type: mimeType }), fileName);
    if (effectiveBgInput?.kind === "file") {
      directForm.set(
        "bg_image_file",
        new Blob([effectiveBgInput.bytes], { type: effectiveBgInput.mime }),
        path.basename(effectiveBgInput.path),
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
      await releaseTicketHold(holdId, releaseToken);
      if (err && typeof err.statusCode === "number") {
        return { ok: false, status: err.statusCode, errorText: err.message };
      }
      throw err;
    }
    if (!directRes.ok) {
      const errText = await directRes.text();
      await releaseTicketHold(holdId, releaseToken);
      return { ok: false, status: directRes.status, errorText: errText };
    }
    return {
      ok: true,
      buffer: Buffer.from(await directRes.arrayBuffer()),
      contentType: directRes.headers.get("content-type") || "",
      charged:
        directRes.headers.get("x-credits-charged") ??
        String(tData?.creditsHeld ?? ticketJson?.creditsHeld ?? "?"),
      via: "direct-stream",
    };
  };

  const needsDirect =
    validatedOpts.direct ||
    bytes.byteLength > DIRECT_STREAM_THRESHOLD_BYTES ||
    (effectiveBgInput?.kind === "file" &&
      (effectiveBgInput.bytes.byteLength > DIRECT_STREAM_THRESHOLD_BYTES ||
        bytes.byteLength + effectiveBgInput.bytes.byteLength > DIRECT_STREAM_THRESHOLD_BYTES)) ||
    shouldPreFlightViaTicket(
      bytes,
      validatedOpts.size,
      validatedOpts.format,
      validatedOpts.channels,
      Boolean(validatedOpts.crop),
    );

  if (needsDirect) {
    return runViaTicket("direct");
  }

  const buildFormData = () => {
    const form = new FormData();
    form.set("image_file", new Blob([bytes], { type: mimeType }), fileName);
    form.set("size", validatedOpts.size);
    form.set("format", validatedOpts.format);
    form.set("channels", validatedOpts.channels);
    if (validatedOpts.type && validatedOpts.type !== "auto") form.set("type", validatedOpts.type);
    if (validatedOpts.typeLevel) form.set("type_level", validatedOpts.typeLevel);
    if (validatedOpts.roi) form.set("roi", validatedOpts.roi);
    if (validatedOpts.scale) form.set("scale", validatedOpts.scale);
    if (validatedOpts.position) form.set("position", validatedOpts.position);
    if (validatedOpts.bgColor) form.set("bg_color", validatedOpts.bgColor);
    if (effectiveBgInput?.kind === "url") form.set("bg_image_url", effectiveBgInput.url);
    if (effectiveBgInput?.kind === "file") {
      form.set(
        "bg_image_file",
        new Blob([effectiveBgInput.bytes], { type: effectiveBgInput.mime }),
        path.basename(effectiveBgInput.path),
      );
    }
    if (validatedOpts.crop) form.set("crop", "true");
    if (validatedOpts.cropMargin) form.set("crop_margin", validatedOpts.cropMargin);
    if (validatedOpts.shadow) form.set("add_shadow", "true");
    if (validatedOpts.shadowType) form.set("shadow_type", validatedOpts.shadowType);
    if (validatedOpts.shadowOpacity !== "") form.set("shadow_opacity", String(validatedOpts.shadowOpacity));
    if (!validatedOpts.semitransparency) form.set("semitransparency", "false");
    return form;
  };

  let res;
  try {
    res = await safeFetch(`${baseUrl}/v1.0/removebg`, {
      method: "POST",
      headers: {
        "X-Api-Key": validatedOpts.apiKey,
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

  if (res.status === 409 && !validatedOpts.idempotencyKey) {
    const errText = await res.text();
    if (errText.includes("idempotency_replay_unavailable")) {
      try {
        res = await safeFetch(`${baseUrl}/v1.0/removebg`, {
          method: "POST",
          headers: {
            "X-Api-Key": validatedOpts.apiKey,
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
    contentType: res.headers.get("content-type") || "",
    charged: res.headers.get("x-credits-charged") ?? "?",
    via: "gateway",
  };
}

export function extensionFromContentType(contentType) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  return "png";
}

export function resolveDestPath(filePath, opts, contentType = "") {
  const outExt =
    opts.format === "auto"
      ? extensionFromContentType(contentType)
      : opts.format === "jpeg"
        ? "jpg"
        : opts.format;
  const stem = path.basename(filePath, path.extname(filePath));
  return opts.output
    ? path.resolve(opts.output)
    : path.join(opts.outputDir ? path.resolve(opts.outputDir) : path.dirname(filePath), `${stem}-nobg.${outExt}`);
}

export function assertSafeCliWriteTarget(destPath) {
  const resolved = path.resolve(destPath);
  let st = null;
  try {
    st = fs.lstatSync(resolved);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link destination: ${resolved}`);
    }
    if (st.isDirectory()) {
      throw new Error(`Destination path is a directory: ${resolved}`);
    }
  }
  return resolved;
}

export function writeFileAtomicallyNoSymlink(destPath, buffer) {
  const resolved = assertSafeCliWriteTarget(destPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(resolved)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tmpPath, buffer, { flag: "wx", mode: 0o644 });
    assertSafeCliWriteTarget(resolved);
    fs.renameSync(tmpPath, resolved);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

function isSameRealBgFile(destPath, bgInput) {
  if (bgInput?.kind !== "file") return false;
  try {
    if (!fs.existsSync(destPath)) return false;
    return fs.realpathSync(destPath) === fs.realpathSync(bgInput.path);
  } catch {
    return false;
  }
}

export async function processSingleFile(filePath, opts, baseUrl, bgInput, runtimeDeps = {}) {
  if (opts.output || opts.format !== "auto") {
    const prelimDest = resolveDestPath(filePath, opts);
    if (isSameRealBgFile(prelimDest, bgInput)) {
      console.error(`[FAIL] ${path.basename(filePath)} -> Refusing to overwrite --bg-image file: ${prelimDest}`);
      return false;
    }
    try {
      assertSafeCliWriteTarget(prelimDest);
    } catch (err) {
      console.error(`[FAIL] ${path.basename(filePath)} -> ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  const st = fs.statSync(filePath);
  if (st.size <= 0) {
    console.error(`[FAIL] ${path.basename(filePath)} -> Foreground image must not be empty.`);
    return false;
  }
  if (st.size > MAX_UPLOAD_BYTES) {
    console.error(`[FAIL] ${path.basename(filePath)} -> Foreground image exceeds 25 MB maximum upload size.`);
    return false;
  }
  if (bgInput?.kind === "file" && st.size + bgInput.bytes.byteLength > MAX_COMBINED_UPLOAD_BYTES) {
    console.error(
      `[FAIL] ${path.basename(filePath)} -> Combined foreground and --bg-image size exceeds 29.5 MB limit (30 MB multipart envelope).`,
    );
    return false;
  }
  const bytes = fs.readFileSync(filePath);
  let outcome;
  try {
    outcome = await processImageBuffer({
      bytes,
      fileName: path.basename(filePath),
      mimeType: detectSupportedImageMime(bytes) || mimeForPath(filePath),
      opts,
      baseUrl,
      bgInput,
      ...(runtimeDeps.fetchImpl ? { fetchImpl: runtimeDeps.fetchImpl } : {}),
      ...(runtimeDeps.lookupFn ? { lookupFn: runtimeDeps.lookupFn } : {}),
    });
  } catch (err) {
    console.error(`[FAIL] ${path.basename(filePath)} -> ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!outcome.ok) {
    console.error(`[FAIL] ${path.basename(filePath)} -> HTTP ${outcome.status}: ${outcome.errorText}`);
    return false;
  }
  const destPath = resolveDestPath(filePath, opts, outcome.contentType);
  if (isSameRealBgFile(destPath, bgInput)) {
    console.error(`[FAIL] ${path.basename(filePath)} -> Refusing to overwrite --bg-image file: ${destPath}`);
    return false;
  }
  try {
    writeFileAtomicallyNoSymlink(destPath, outcome.buffer);
  } catch (err) {
    console.error(`[FAIL] ${path.basename(filePath)} -> ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  console.log(`[OK] ${path.basename(filePath)} -> ${destPath} (${outcome.charged} credits, ${outcome.via})`);
  return true;
}

export async function runBatchPool(items, concurrency, workerFn) {
  const limit = Math.max(1, Math.min(MAX_CONCURRENCY, Math.trunc(concurrency || 1)));
  let cursor = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      const ok = await workerFn(items[idx], idx);
      if (!ok) failed += 1;
    }
  });
  await Promise.all(workers);
  return failed;
}

export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.version) {
    console.log(CLI_VERSION);
    return;
  }
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
      headers: mergeWithUserAgent({ "X-Api-Key": opts.apiKey }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${text}`);
      process.exit(1);
    }
    console.log(text);
    return;
  }

  const bgInput = await resolveBgInput(opts.bgImage);
  const excludeCanonicalPath =
    bgInput?.kind === "file" ? fs.realpathSync(bgInput.path) : "";

  let precollectedFiles = null;
  if (!opts.watch) {
    precollectedFiles = collectFiles(opts.inputs, { excludeCanonicalPath });
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
      const candidates = collectFiles(opts.inputs, { excludeCanonicalPath });
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

  const failed = await runBatchPool(files, opts.concurrency, (filePath) =>
    processSingleFile(filePath, opts, baseUrl, bgInput),
  );

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
