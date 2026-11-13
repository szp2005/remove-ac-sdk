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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://remove.ac";
const SUPPORTED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DIRECT_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;

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
    else if (arg === "--api-key") opts.apiKey = argv[++i] || "";
    else if (arg === "--output" || arg === "-o") opts.output = argv[++i] || null;
    else if (arg === "--output-dir") opts.outputDir = argv[++i] || null;
    else if (arg === "--size") opts.size = argv[++i] || "auto";
    else if (arg === "--format") opts.format = argv[++i] || "png";
    else if (arg === "--channels") opts.channels = argv[++i] || "rgba";
    else if (arg === "--type") opts.type = argv[++i] || "auto";
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
}) {
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
      }),
    ),
  ).slice(0, 32);
  const idemKey = `cli:${paramFingerprint}`;

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

    const ticketRes = await fetchImpl(`${baseUrl}/v1.0/removebg/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": opts.apiKey,
        "Idempotency-Key": `${idemKey}:${idemSuffix}`,
      },
      body: JSON.stringify(ticketBody),
    });
    if (!ticketRes.ok) {
      return { ok: false, status: ticketRes.status, errorText: await ticketRes.text() };
    }
    const ticketJson = await ticketRes.json();
    const ticket = ticketJson?.data?.ticket;
    const directEndpoint = ticketJson?.data?.directEndpoint;
    if (!ticket || !directEndpoint) {
      return { ok: false, status: 502, errorText: "Missing ticket or directEndpoint in response" };
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
    const directRes = await fetchImpl(directEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ticket}`,
      },
      body: directForm,
    });
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
    (bgInput?.kind === "file" && bgInput.bytes.byteLength > DIRECT_STREAM_THRESHOLD_BYTES);

  if (needsDirect) {
    return runViaTicket("direct");
  }

  const form = new FormData();
  form.set("image_file", new Blob([bytes], { type: mimeType }), fileName);
  form.set("size", opts.size);
  form.set("format", opts.format);
  form.set("channels", opts.channels);
  if (opts.type && opts.type !== "auto") form.set("type", opts.type);
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

  const res = await fetchImpl(`${baseUrl}/v1.0/removebg`, {
    method: "POST",
    headers: {
      "X-Api-Key": opts.apiKey,
      "Idempotency-Key": idemKey,
    },
    body: form,
  });

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
  const baseUrl = opts.endpoint.replace(/\/+$/, "");

  if (opts.account) {
    const res = await fetch(`${baseUrl}/v1.0/account`, {
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
    if (opts.output) {
      console.error("Error: --watch requires --output-dir instead of --output.");
      process.exit(2);
    }
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

  const files = collectFiles(opts.inputs);
  if (files.length === 0) {
    console.error("No supported image files (.jpg, .jpeg, .png, .webp) found.");
    process.exit(1);
  }
  if (opts.output && files.length > 1) {
    console.error("Error: --output can only be used with a single input file. Use --output-dir for batches.");
    process.exit(2);
  }
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
