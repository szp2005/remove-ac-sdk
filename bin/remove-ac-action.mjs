#!/usr/bin/env node
/**
 * Zero-dependency GitHub Action entrypoint v1.3.2 (node20) for remove.ac (/v1.0/removebg).
 * Supports single local image files, batch folders, and SSRF-validated public image URLs.
 */

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoveAcClient } from "../node/index.mjs";
import { validateRemoteImageUrl } from "../node/net-safety.mjs";

export const ACTION_VERSION = "1.3.2";
const MAX_ACTION_FG_BYTES = 25 * 1024 * 1024;
const MAX_ACTION_BG_BYTES = 25 * 1024 * 1024;
export const MAX_ACTION_COMBINED_BYTES = 30 * 1024 * 1024 - 512 * 1024; // 29.5 MB (30,932,992 bytes)
const SUPPORTED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ALLOWED_SIZES = new Set(["auto", "preview", "small", "regular", "medium", "hd", "4k", "25mp", "50mp", "full", "maximum"]);
const ALLOWED_FORMATS = new Set(["auto", "png", "jpg", "jpeg", "webp", "zip"]);
const ALLOWED_TYPES = new Set(["auto", "person", "product", "car", "animal", "graphic", "transportation"]);
const ALLOWED_SHADOW_TYPES = new Set(["auto", "car", "drop", "soft", "contact", "reflection", "none"]);

function readInput(env, name, fallback = "") {
  const upper = name.toUpperCase();
  const hyphenUpper = upper.replace(/_/g, "-");
  const hasUpper = env[`INPUT_${upper}`] !== undefined && env[`INPUT_${upper}`] !== null;
  const hasHyphen =
    hyphenUpper !== upper &&
    env[`INPUT_${hyphenUpper}`] !== undefined &&
    env[`INPUT_${hyphenUpper}`] !== null;
  const vUpper = hasUpper ? String(env[`INPUT_${upper}`]).trim() : "";
  const vHyphen = hasHyphen ? String(env[`INPUT_${hyphenUpper}`]).trim() : "";
  if (vUpper && vHyphen && vUpper !== vHyphen) {
    throw new Error(`Conflicting inputs provided for '${name}' and '${name.replace(/_/g, "-")}'.`);
  }
  if (vUpper) return vUpper;
  if (vHyphen) return vHyphen;
  return String(fallback ?? "").trim();
}

function parseBool(val, defaultVal = false) {
  if (val === "" || val === undefined || val === null) return defaultVal;
  const norm = String(val).trim().toLowerCase();
  if (norm === "true" || norm === "1" || norm === "yes") return true;
  if (norm === "false" || norm === "0" || norm === "no") return false;
  throw new Error(`Invalid boolean value: '${val}' (expected 'true' or 'false')`);
}

function nearestExistingRealpath(targetPath) {
  let cur = path.resolve(targetPath);
  while (true) {
    if (fs.existsSync(cur)) {
      return fs.realpathSync(cur);
    }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

function canonicalizePathWithRealAncestor(targetPath) {
  const abs = path.resolve(targetPath);
  const tail = [];
  let cur = abs;
  while (true) {
    if (fs.existsSync(cur)) {
      const realCur = fs.realpathSync(cur);
      return tail.length === 0 ? realCur : path.join(realCur, ...tail.reverse());
    }
    tail.push(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) {
      return tail.length === 0 ? cur : path.join(cur, ...tail.reverse());
    }
    cur = parent;
  }
}

function assertNoSymlinkComponentsFromRoot(rootDir, targetPath, rawLabel) {
  const rel = path.relative(rootDir, targetPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  let probe = rootDir;
  for (const seg of rel.split(path.sep)) {
    if (!seg || seg === ".") continue;
    probe = path.join(probe, seg);
    let st = null;
    try {
      st = fs.lstatSync(probe);
    } catch (err) {
      if (err && err.code === "ENOENT") break;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to operate on symbolic link path: ${rawLabel}`);
    }
  }
}

function assertNoDanglingSymlinkInChain(targetPath, rawLabel) {
  let cur = path.resolve(targetPath);
  while (true) {
    let st = null;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    if (st && st.isSymbolicLink()) {
      throw new Error(`Refusing to operate on symbolic link path: ${rawLabel}`);
    }
    if (st && fs.existsSync(cur)) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

function isSubpathOrEqual(parentReal, candidateReal) {
  const rel = path.relative(parentReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveSafeActionPath(rawPath, { env = process.env, cwd = process.cwd(), allowOutsideWorkspace = false, forWrite = false } = {}) {
  if (!rawPath || typeof rawPath !== "string" || rawPath.includes("\0")) {
    throw new Error("Invalid file path");
  }
  const baseDir = env.GITHUB_WORKSPACE ? path.resolve(env.GITHUB_WORKSPACE) : path.resolve(cwd);
  const resolved = path.resolve(baseDir, rawPath);

  assertNoDanglingSymlinkInChain(resolved, rawPath);
  assertNoSymlinkComponentsFromRoot(baseDir, resolved, rawPath);
  if (fs.existsSync(baseDir)) {
    assertNoSymlinkComponentsFromRoot(fs.realpathSync(baseDir), resolved, rawPath);
  }

  const resolvedCanonical = canonicalizePathWithRealAncestor(resolved);

  if (forWrite) {
    const protectedEnvFiles = [
      env.GITHUB_OUTPUT,
      env.GITHUB_ENV,
      env.GITHUB_PATH,
      env.GITHUB_STEP_SUMMARY,
      env.GITHUB_STATE,
    ]
      .filter(Boolean)
      .map((p) => ({
        abs: path.resolve(p),
        canonical: canonicalizePathWithRealAncestor(p),
      }));

    for (const prot of protectedEnvFiles) {
      if (resolved === prot.abs || resolvedCanonical === prot.canonical) {
        throw new Error("Refusing to write output to a protected GitHub Actions runner control file");
      }
    }
  }

  if (env.GITHUB_WORKSPACE && !allowOutsideWorkspace) {
    const workspaceReal = fs.realpathSync(path.resolve(env.GITHUB_WORKSPACE));
    const ancestorReal = nearestExistingRealpath(resolved);
    if (!isSubpathOrEqual(workspaceReal, ancestorReal) || !isSubpathOrEqual(workspaceReal, resolvedCanonical)) {
      throw new Error(
        `Path '${rawPath}' resolves outside GITHUB_WORKSPACE. Set allow_outside_workspace: 'true' if intentional.`
      );
    }
  }

  return resolved;
}

export async function validateActionBaseUrl(rawBaseUrl, { lookupFn = dns.promises.lookup, allowLoopbackForTest = false } = {}) {
  const target = String(rawBaseUrl || "https://remove.ac").trim();
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`Invalid base_url: '${target}'`);
  }

  if (allowLoopbackForTest) {
    return parsed.origin;
  }

  if (parsed.protocol !== "https:") {
    throw new Error("base_url must use https:// to protect your API key in transit");
  }
  if (parsed.username || parsed.password) {
    throw new Error("base_url must not contain embedded credentials");
  }
  const ssrfErr = await validateRemoteImageUrl(parsed.origin, lookupFn);
  if (ssrfErr) {
    throw new Error(`Disallowed base_url (${ssrfErr})`);
  }
  return parsed.origin;
}

export function writeGithubOutputs(outputFilePath, entries) {
  if (!outputFilePath) return;
  const chunks = [];
  for (const [key, rawVal] of Object.entries(entries)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) {
      throw new Error(`Invalid GitHub output key: ${key}`);
    }
    const val = String(rawVal ?? "");
    let delim = `ghadelim_${crypto.randomBytes(16).toString("hex")}`;
    while (val.includes(delim)) {
      delim = `ghadelim_${crypto.randomBytes(16).toString("hex")}`;
    }
    chunks.push(`${key}<<${delim}\n${val}\n${delim}\n`);
  }
  fs.appendFileSync(outputFilePath, chunks.join(""), "utf8");
}

function writeBufferAtomically(destPath, buffer, overwrite) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (!overwrite && fs.existsSync(destPath)) {
    throw new Error(`Output file already exists (set overwrite: 'true' to replace): ${destPath}`);
  }
  if (fs.existsSync(destPath) && fs.lstatSync(destPath).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link: ${destPath}`);
  }
  const tmpPath = `${destPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const writeFlag = overwrite ? "w" : "wx";
  try {
    fs.writeFileSync(tmpPath, buffer, { flag: "wx", mode: 0o644 });
    if (!overwrite && fs.existsSync(destPath)) {
      throw new Error(`Output file already exists: ${destPath}`);
    }
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
  void writeFlag;
}

function outExtForActionFormat(format, mediaType = "") {
  if (format === "auto") {
    const mime = String(mediaType || "").split(";")[0].trim().toLowerCase();
    if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
    if (mime === "image/webp") return ".webp";
    if (mime === "application/zip" || mime === "application/x-zip-compressed") return ".zip";
    return ".png";
  }
  if (format === "jpg" || format === "jpeg") return ".jpg";
  if (format === "webp") return ".webp";
  if (format === "zip") return ".zip";
  return ".png";
}

function defaultCutoutPath(inputPath, format, mediaType = "") {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const stem = path.basename(inputPath, ext);
  const outExt = outExtForActionFormat(format, mediaType);
  return path.join(dir, `${stem}-nobg${outExt}`);
}

export async function runGithubAction({
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  fetchImpl = globalThis.fetch,
  lookupFn = dns.promises.lookup,
  allowLoopbackBaseUrlForTest = false,
} = {}) {
  const apiKey =
    readInput(env, "api_key") ||
    String(env.REMOVE_AC_API_KEY || env.REMOVE_BG_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error("Missing API key: provide inputs.api_key or set REMOVE_AC_API_KEY secret.");
  }

  for (const line of apiKey.split(/[\r\n]+/)) {
    if (line.trim()) {
      stdout.write(`::add-mask::${line.trim()}\n`);
    }
  }

  const allowOutsideWorkspace = parseBool(readInput(env, "allow_outside_workspace", "false"), false);
  const overwrite = parseBool(readInput(env, "overwrite", "false"), false);
  const size = readInput(env, "size", "full").toLowerCase();
  const format = readInput(env, "format", "png").toLowerCase();
  const bgColor = readInput(env, "bg_color", "");
  const rawBgImageFile = readInput(env, "bg_image_file", "");
  const rawBgImageUrl = readInput(env, "bg_image_url", "");
  const crop = parseBool(readInput(env, "crop", "false"), false);
  const fgType = readInput(env, "type", "auto").toLowerCase();
  const addShadow = parseBool(readInput(env, "add_shadow", "false"), false);
  const shadowType = readInput(env, "shadow_type", "").toLowerCase();
  const rawBaseUrl = readInput(env, "base_url", env.REMOVE_AC_BASE_URL || "https://remove.ac");

  if (!ALLOWED_SIZES.has(size)) throw new Error(`Unsupported size '${size}'`);
  if (!ALLOWED_FORMATS.has(format)) throw new Error(`Unsupported format '${format}'`);
  if (!ALLOWED_TYPES.has(fgType)) throw new Error(`Unsupported type '${fgType}'`);
  if (shadowType && !ALLOWED_SHADOW_TYPES.has(shadowType)) {
    throw new Error(`Unsupported shadow_type '${shadowType}'`);
  }

  const bgOptionCount =
    (bgColor ? 1 : 0) + (rawBgImageFile ? 1 : 0) + (rawBgImageUrl ? 1 : 0);
  if (bgOptionCount > 1) {
    throw new Error("Provide at most one of 'bg_color', 'bg-image-file', or 'bg-image-url'.");
  }

  const baseUrl = await validateActionBaseUrl(rawBaseUrl, {
    lookupFn,
    allowLoopbackForTest: allowLoopbackBaseUrlForTest,
  });

  const rawInputPath = readInput(env, "input_path");
  const rawImageUrl = readInput(env, "image_url");
  const rawOutputPath = readInput(env, "output_path");
  const rawOutputDir = readInput(env, "output_dir");

  if ((rawInputPath && rawImageUrl) || (!rawInputPath && !rawImageUrl)) {
    throw new Error("Provide exactly one of 'input_path' or 'image_url'.");
  }

  let resolvedBgImageFile = "";
  let canonicalBgImageFile = "";
  let bgFileByteLength = 0;
  if (rawBgImageFile) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(rawBgImageFile) || /^(data|javascript|file):/i.test(rawBgImageFile)) {
      throw new Error("'bg-image-file' must be a local file path; use 'bg-image-url' for remote URLs.");
    }
    resolvedBgImageFile = resolveSafeActionPath(rawBgImageFile, {
      env,
      cwd,
      allowOutsideWorkspace,
      forWrite: false,
    });
    if (!fs.existsSync(resolvedBgImageFile)) {
      throw new Error(`bg-image-file does not exist: ${resolvedBgImageFile}`);
    }
    const bgStat = fs.statSync(resolvedBgImageFile);
    if (!bgStat.isFile()) {
      throw new Error(`bg-image-file must be a regular file: ${resolvedBgImageFile}`);
    }
    const bgExt = path.extname(resolvedBgImageFile).toLowerCase();
    if (!SUPPORTED_EXTS.has(bgExt)) {
      throw new Error(
        `Unsupported bg-image-file extension '${bgExt}' (expected .png, .jpg, .jpeg, or .webp)`
      );
    }
    if (bgStat.size <= 0) {
      throw new Error(`bg-image-file must not be empty: ${resolvedBgImageFile}`);
    }
    if (bgStat.size > MAX_ACTION_BG_BYTES) {
      throw new Error(`bg-image-file exceeds 25 MB limit: ${resolvedBgImageFile}`);
    }
    canonicalBgImageFile = fs.realpathSync(resolvedBgImageFile);
    bgFileByteLength = bgStat.size;
  } else if (rawBgImageUrl) {
    const bgSsrfErr = await validateRemoteImageUrl(rawBgImageUrl, lookupFn);
    if (bgSsrfErr) {
      throw new Error(`Disallowed bg-image-url (${bgSsrfErr})`);
    }
  }

  const client = new RemoveAcClient({
    apiKey,
    baseUrl,
    fetch: fetchImpl,
    lookup: lookupFn,
  });

  const cutoutOpts = {
    size,
    format,
    crop,
    type: fgType,
    addShadow,
  };
  if (bgColor) cutoutOpts.bgColor = bgColor;
  if (resolvedBgImageFile) cutoutOpts.bgImageFile = resolvedBgImageFile;
  if (rawBgImageUrl) cutoutOpts.bgImageUrl = rawBgImageUrl;
  if (shadowType) cutoutOpts.shadowType = shadowType;

  const generatedFiles = [];
  let totalCredits = 0;
  let lastWidth = "";
  let lastHeight = "";
  let primaryOutputPath = "";

  if (rawImageUrl) {
    const ssrfErr = await validateRemoteImageUrl(rawImageUrl, lookupFn);
    if (ssrfErr) {
      throw new Error(`Disallowed image_url (${ssrfErr})`);
    }
    if (!rawOutputPath) {
      throw new Error("'output_path' is required when using 'image_url'.");
    }
    const destPath = resolveSafeActionPath(rawOutputPath, {
      env,
      cwd,
      allowOutsideWorkspace,
      forWrite: true,
    });
    if (canonicalBgImageFile && canonicalizePathWithRealAncestor(destPath) === canonicalBgImageFile) {
      throw new Error(
        `Refusing to overwrite bg-image-file with output_path: ${destPath}`
      );
    }
    if (!overwrite && fs.existsSync(destPath)) {
      throw new Error(`Output file already exists: ${destPath}`);
    }

    const res = await client.removeBackground(rawImageUrl, cutoutOpts);
    writeBufferAtomically(destPath, res.buffer, overwrite);
    generatedFiles.push(destPath);
    totalCredits += Number(res.creditsCharged ?? 0);
    lastWidth = res.width ? String(res.width) : "";
    lastHeight = res.height ? String(res.height) : "";
    primaryOutputPath = destPath;
  } else {
    const srcPath = resolveSafeActionPath(rawInputPath, {
      env,
      cwd,
      allowOutsideWorkspace,
      forWrite: false,
    });
    if (!fs.existsSync(srcPath)) {
      throw new Error(`input_path does not exist: ${srcPath}`);
    }
    const st = fs.statSync(srcPath);

    if (st.isFile()) {
      const ext = path.extname(srcPath).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) {
        throw new Error(`Unsupported input image extension '${ext}' (expected .png, .jpg, .jpeg, or .webp)`);
      }
      if (st.size <= 0) {
        throw new Error(`input_path must not be empty: ${srcPath}`);
      }
      if (st.size > MAX_ACTION_FG_BYTES) {
        throw new Error(`input_path exceeds 25 MB limit: ${srcPath}`);
      }
      if (bgFileByteLength > 0 && st.size + bgFileByteLength > MAX_ACTION_COMBINED_BYTES) {
        throw new Error(
          `Combined input_path and bg-image-file size exceeds 29.5 MB limit (${st.size + bgFileByteLength} > ${MAX_ACTION_COMBINED_BYTES} bytes; 30 MB multipart envelope)`
        );
      }
      const hasExplicitDest = Boolean(rawOutputPath);
      let destPath = "";
      if (hasExplicitDest || format !== "auto") {
        destPath = hasExplicitDest
          ? resolveSafeActionPath(rawOutputPath, { env, cwd, allowOutsideWorkspace, forWrite: true })
          : resolveSafeActionPath(defaultCutoutPath(srcPath, format), {
              env,
              cwd,
              allowOutsideWorkspace,
              forWrite: true,
            });
        if (canonicalBgImageFile && canonicalizePathWithRealAncestor(destPath) === canonicalBgImageFile) {
          throw new Error(
            `Refusing to overwrite bg-image-file with output_path: ${destPath}`
          );
        }
        if (!overwrite && fs.existsSync(destPath)) {
          throw new Error(`Output file already exists: ${destPath}`);
        }
      } else {
        resolveSafeActionPath(defaultCutoutPath(srcPath, "png"), {
          env,
          cwd,
          allowOutsideWorkspace,
          forWrite: true,
        });
      }
      const res = await client.removeBackground(srcPath, cutoutOpts);
      if (!destPath) {
        destPath = resolveSafeActionPath(defaultCutoutPath(srcPath, format, res.mediaType), {
          env,
          cwd,
          allowOutsideWorkspace,
          forWrite: true,
        });
        if (canonicalBgImageFile && canonicalizePathWithRealAncestor(destPath) === canonicalBgImageFile) {
          throw new Error(
            `Refusing to overwrite bg-image-file with output_path: ${destPath}`
          );
        }
        if (!overwrite && fs.existsSync(destPath)) {
          throw new Error(`Output file already exists: ${destPath}`);
        }
      }
      writeBufferAtomically(destPath, res.buffer, overwrite);
      generatedFiles.push(destPath);
      totalCredits += Number(res.creditsCharged ?? 0);
      lastWidth = res.width ? String(res.width) : "";
      lastHeight = res.height ? String(res.height) : "";
      primaryOutputPath = destPath;
    } else if (st.isDirectory()) {
      const outDir = rawOutputDir
        ? resolveSafeActionPath(rawOutputDir, { env, cwd, allowOutsideWorkspace, forWrite: true })
        : resolveSafeActionPath(path.join(srcPath, "cutouts"), {
            env,
            cwd,
            allowOutsideWorkspace,
            forWrite: true,
          });
      if (canonicalBgImageFile && canonicalizePathWithRealAncestor(outDir) === canonicalBgImageFile) {
        throw new Error(
          `Refusing to use bg-image-file path as output_dir: ${outDir}`
        );
      }
      fs.mkdirSync(outDir, { recursive: true });
      const sameDir = fs.realpathSync(srcPath) === fs.realpathSync(outDir);

      const entries = fs
        .readdirSync(srcPath, { withFileTypes: true })
        .filter((d) => {
          if (!d.isFile() || d.isSymbolicLink()) return false;
          const ext = path.extname(d.name).toLowerCase();
          if (!SUPPORTED_EXTS.has(ext)) return false;
          if (sameDir && path.basename(d.name, ext).endsWith("-nobg")) return false;
          if (canonicalBgImageFile) {
            const candidateReal = fs.realpathSync(path.join(srcPath, d.name));
            if (candidateReal === canonicalBgImageFile) return false;
          }
          return true;
        })
        .map((d) => d.name)
        .sort();

      if (entries.length === 0) {
        throw new Error(`No supported images (.png, .jpg, .jpeg, .webp) found in directory: ${srcPath}`);
      }

      const outExt = outExtForActionFormat(format);
      const batchPlan = entries.map((fileName) => {
        const itemSrc = path.join(srcPath, fileName);
        const itemStat = fs.statSync(itemSrc);
        if (itemStat.size <= 0) {
          throw new Error(`Batch input image must not be empty: ${itemSrc}`);
        }
        if (itemStat.size > MAX_ACTION_FG_BYTES) {
          throw new Error(`Batch input image exceeds 25 MB limit: ${itemSrc}`);
        }
        if (bgFileByteLength > 0 && itemStat.size + bgFileByteLength > MAX_ACTION_COMBINED_BYTES) {
          throw new Error(
            `Combined batch image '${fileName}' and bg-image-file size exceeds 29.5 MB limit (${itemStat.size + bgFileByteLength} > ${MAX_ACTION_COMBINED_BYTES} bytes; 30 MB multipart envelope)`
          );
        }
        const stem = path.basename(fileName, path.extname(fileName));
        const outName = sameDir ? `${stem}-nobg${outExt}` : `${stem}${outExt}`;
        const itemDest = resolveSafeActionPath(path.join(outDir, outName), {
          env,
          cwd,
          allowOutsideWorkspace,
          forWrite: true,
        });
        if (format !== "auto") {
          if (canonicalBgImageFile && canonicalizePathWithRealAncestor(itemDest) === canonicalBgImageFile) {
            throw new Error(
              `Refusing to overwrite bg-image-file with batch output: ${itemDest}`
            );
          }
          if (!overwrite && fs.existsSync(itemDest)) {
            throw new Error(`Output file already exists: ${itemDest}`);
          }
        }
        return { itemSrc, itemDest, stem };
      });

      for (const { itemSrc, itemDest, stem } of batchPlan) {
        const res = await client.removeBackground(itemSrc, cutoutOpts);
        let finalDest = itemDest;
        if (format === "auto") {
          const actualExt = outExtForActionFormat("auto", res.mediaType);
          const actualName = sameDir ? `${stem}-nobg${actualExt}` : `${stem}${actualExt}`;
          finalDest = resolveSafeActionPath(path.join(outDir, actualName), {
            env,
            cwd,
            allowOutsideWorkspace,
            forWrite: true,
          });
          if (canonicalBgImageFile && canonicalizePathWithRealAncestor(finalDest) === canonicalBgImageFile) {
            throw new Error(
              `Refusing to overwrite bg-image-file with batch output: ${finalDest}`
            );
          }
          if (!overwrite && fs.existsSync(finalDest)) {
            throw new Error(`Output file already exists: ${finalDest}`);
          }
        }
        writeBufferAtomically(finalDest, res.buffer, overwrite);
        generatedFiles.push(finalDest);
        totalCredits += Number(res.creditsCharged ?? 0);
        lastWidth = res.width ? String(res.width) : lastWidth;
        lastHeight = res.height ? String(res.height) : lastHeight;
      }
      primaryOutputPath = outDir;
    } else {
      throw new Error(`input_path must be a regular file or directory: ${srcPath}`);
    }
  }

  const resultSummary = {
    output_path: primaryOutputPath,
    output_files_json: JSON.stringify(generatedFiles),
    processed_count: String(generatedFiles.length),
    credits_charged: String(totalCredits),
    width: lastWidth,
    height: lastHeight,
  };

  if (env.GITHUB_OUTPUT) {
    writeGithubOutputs(env.GITHUB_OUTPUT, resultSummary);
  }

  stdout.write(
    `remove.ac processed ${generatedFiles.length} image(s) -> ${primaryOutputPath} (${totalCredits} credit(s) charged)\n`
  );
  return resultSummary;
}

const isMain =
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${ACTION_VERSION}\n`);
    process.exit(0);
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      `remove.ac GitHub Action runner v${ACTION_VERSION} (node20)\nUsage: set INPUT_API_KEY and INPUT_INPUT_PATH or INPUT_IMAGE_URL.\n`
    );
    process.exit(0);
  }
  runGithubAction().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const escaped = msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    process.stdout.write(`::error::${escaped}\n`);
    process.exitCode = 1;
  });
}
