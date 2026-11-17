#!/usr/bin/env node
/**
 * Zero-dependency Model Context Protocol (MCP) stdio server for remove.ac.
 *
 * Exposes 3 tools over JSON-RPC 2.0 stdio (both newline-delimited MCP 2024-11-05+
 * and Content-Length / multi-header framed JSON-RPC):
 *   - remove_background_file
 *   - remove_background_url
 *   - get_account_balance
 *
 * Environment variables:
 *   REMOVE_AC_API_KEY (or REMOVE_BG_API_KEY) — required at tool execution time
 *   REMOVE_AC_BASE_URL — optional override (defaults to https://remove.ac)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoveAcClient } from "../node/index.mjs";
import {
  isDisallowedIpAddress,
  isDisallowedRemoteUrl,
  isPrivateIpv4,
  isPrivateIpv6,
  parseIpv6Words,
  validateRemoteImageUrl,
} from "../node/net-safety.mjs";

export {
  isDisallowedIpAddress,
  isDisallowedRemoteUrl,
  isPrivateIpv4,
  isPrivateIpv6,
  parseIpv6Words,
  validateRemoteImageUrl,
};

export const SERVER_NAME = "remove-ac-mcp";
export const SERVER_VERSION = "1.3.0";
export const MAX_MCP_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_BG_IMAGE_BYTES = MAX_IMAGE_BYTES;
const MAX_COMBINED_UPLOAD_BYTES = 30 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_MCP_HEADER_BYTES = 16 * 1024;
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

const MCP_SIZE_ENUM = [
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
];
const MCP_FORMAT_ENUM = ["png", "jpg", "webp", "zip"];
const MCP_TYPE_ENUM = [
  "auto",
  "person",
  "product",
  "car",
  "animal",
  "graphic",
  "transportation",
];
const MCP_SHADOW_ENUM = [
  "auto",
  "car",
  "drop",
  "soft",
  "contact",
  "reflection",
  "none",
];

const ALLOWED_MCP_SIZES = new Set(MCP_SIZE_ENUM);
const ALLOWED_MCP_FORMATS = new Set(MCP_FORMAT_ENUM);
const ALLOWED_MCP_TYPES = new Set(MCP_TYPE_ENUM);
const ALLOWED_MCP_SHADOWS = new Set(MCP_SHADOW_ENUM);

const SHARED_CUTOUT_PROPERTIES = {
  size: {
    type: "string",
    enum: MCP_SIZE_ENUM,
    description: "Output resolution tier. Defaults to 'full'.",
  },
  format: {
    type: "string",
    enum: MCP_FORMAT_ENUM,
    description: "Output file format. Defaults to 'png'.",
  },
  bgColor: {
    type: "string",
    description: "Optional solid background hex color (e.g. 'FFFFFF') instead of transparency.",
  },
  bgImagePath: {
    type: "string",
    description:
      "Optional local background image file path (.png, .jpg, .jpeg, .webp, up to 25 MB / 50 MP) to composite behind the cutout.",
  },
  bgImageUrl: {
    type: "string",
    description:
      "Optional public http(s) background image URL to composite behind the cutout.",
  },
  bg_image_path: {
    type: "string",
    description:
      "Alias for bgImagePath: local background image file path (.png, .jpg, .jpeg, .webp, up to 25 MB / 50 MP).",
  },
  bg_image_url: {
    type: "string",
    description:
      "Alias for bgImageUrl: public http(s) background image URL.",
  },
  crop: {
    type: "boolean",
    description: "Trim empty transparent padding around the foreground subject.",
  },
  type: {
    type: "string",
    enum: MCP_TYPE_ENUM,
    description: "Optional foreground category hint.",
  },
  addShadow: {
    type: "boolean",
    description: "Render a realistic drop or contact shadow under the cutout.",
  },
  shadowType: {
    type: "string",
    enum: MCP_SHADOW_ENUM,
    description: "Shadow preset when addShadow is enabled.",
  },
};

export const MCP_TOOLS = [
  {
    name: "remove_background_file",
    description:
      "Remove the background from a local image file (.png, .jpg, .jpeg, .webp) via the stateless remove.ac Cloud GPU API (/v1.0/removebg). Files above 4 MB (up to 25 MB / 50 MP) automatically stream via zero-disk /v1.0/removebg/ticket.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["inputPath"],
      properties: {
        inputPath: {
          type: "string",
          description: "Path to the local source image file.",
        },
        outputPath: {
          type: "string",
          description:
            "Destination path for the cutout image. Defaults to '<stem>-nobg.<ext>' alongside inputPath.",
        },
        overwrite: {
          type: "boolean",
          description: "Allow overwriting an existing outputPath. Defaults to false.",
        },
        ...SHARED_CUTOUT_PROPERTIES,
      },
    },
  },
  {
    name: "remove_background_url",
    description:
      "Remove the background from a public HTTPS/HTTP image URL via remove.ac (/v1.0/removebg) and save the cutout locally.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["imageUrl", "outputPath"],
      properties: {
        imageUrl: {
          type: "string",
          description: "Publicly reachable http(s) URL of the source image.",
        },
        outputPath: {
          type: "string",
          description: "Local file path where the cutout output will be written.",
        },
        overwrite: {
          type: "boolean",
          description: "Allow overwriting an existing outputPath. Defaults to false.",
        },
        ...SHARED_CUTOUT_PROPERTIES,
      },
    },
  },
  {
    name: "get_account_balance",
    description:
      "Inspect the current remove.ac API credit balance via GET /v1.0/account.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

const TOOL_SCHEMA_MAP = new Map(MCP_TOOLS.map((t) => [t.name, t.inputSchema]));

function validateNoSymlinkPathChain(resolvedPath, label) {
  const root = path.parse(resolvedPath).root;
  // Always check the leaf path itself with lstatSync (catches both live and dangling symlinks).
  try {
    const leafStat = fs.lstatSync(resolvedPath);
    if (leafStat.isSymbolicLink()) {
      throw new Error(`Refusing to operate on symbolic link ${label}: ${resolvedPath}`);
    }
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }

  // Walk ancestor directories up to (but excluding) OS root-level FHS links like macOS /var or /tmp.
  let cur = path.dirname(resolvedPath);
  while (cur && cur !== root && path.dirname(cur) !== root) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symbolic link ancestor in ${label}: ${cur}`);
      }
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

function resolveDefaultOutputPath(inputPath, format = "png") {
  if (!ALLOWED_MCP_FORMATS.has(format)) {
    throw new Error(`Unsupported format '${format}'. Expected one of: ${MCP_FORMAT_ENUM.join(", ")}`);
  }
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}-nobg.${format}`);
}

export function ensureSafeWriteTarget(targetPath, overwrite = false, sourcePath = null) {
  if (!targetPath || typeof targetPath !== "string" || targetPath.includes("\0")) {
    throw new Error("Invalid outputPath");
  }
  const resolvedTarget = path.resolve(targetPath);
  validateNoSymlinkPathChain(resolvedTarget, "outputPath");

  if (sourcePath && path.resolve(sourcePath) === resolvedTarget && !overwrite) {
    throw new Error(
      "outputPath resolves to inputPath; specify a separate outputPath or set overwrite: true",
    );
  }

  let existingStat = null;
  try {
    existingStat = fs.lstatSync(resolvedTarget);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }

  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link outputPath: ${resolvedTarget}`);
    }
    if (existingStat.isDirectory()) {
      throw new Error(`outputPath points to an existing directory: ${resolvedTarget}`);
    }
    if (!overwrite) {
      throw new Error(
        `Destination file already exists: ${resolvedTarget} (pass overwrite: true to replace)`,
      );
    }
  }

  return resolvedTarget;
}

function writeBufferAtomically(resolvedTarget, buffer, overwrite = false, sourcePath = null) {
  ensureSafeWriteTarget(resolvedTarget, overwrite, sourcePath);
  const parentDir = path.dirname(resolvedTarget);
  fs.mkdirSync(parentDir, { recursive: true });
  validateNoSymlinkPathChain(resolvedTarget, "outputPath");

  const tmpPath = path.join(
    parentDir,
    `.remove-ac-mcp-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, buffer, { flag: "wx", mode: 0o644 });
    if (!overwrite) {
      try {
        fs.linkSync(tmpPath, resolvedTarget);
        fs.unlinkSync(tmpPath);
        return;
      } catch (linkErr) {
        if (linkErr && linkErr.code === "EEXIST") {
          throw new Error(
            `Destination file already exists: ${resolvedTarget} (pass overwrite: true to replace)`,
          );
        }
        // Fallback when filesystem does not support hardlinks
        let raceStat = null;
        try {
          raceStat = fs.lstatSync(resolvedTarget);
        } catch (stErr) {
          if (!stErr || stErr.code !== "ENOENT") throw stErr;
        }
        if (raceStat) {
          throw new Error(
            `Destination file already exists: ${resolvedTarget} (pass overwrite: true to replace)`,
          );
        }
      }
    } else {
      let existingStat = null;
      try {
        existingStat = fs.lstatSync(resolvedTarget);
      } catch (stErr) {
        if (!stErr || stErr.code !== "ENOENT") throw stErr;
      }
      if (existingStat && (existingStat.isSymbolicLink() || existingStat.isDirectory())) {
        throw new Error(`Refusing to overwrite non-regular file: ${resolvedTarget}`);
      }
    }
    fs.renameSync(tmpPath, resolvedTarget);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

function validateAllowedArguments(toolName, args) {
  const schema = TOOL_SCHEMA_MAP.get(toolName);
  if (!schema) return;
  const allowedKeys = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown argument '${key}' for tool '${toolName}'`);
    }
  }
  if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
    throw new Error("Invalid 'overwrite': expected boolean");
  }
  if (args.outputPath !== undefined && typeof args.outputPath !== "string") {
    throw new Error("Invalid 'outputPath': expected string");
  }
}

export function mapToolCutoutOptions(args = {}) {
  let size = "full";
  if (args.size !== undefined) {
    if (typeof args.size !== "string") {
      throw new Error("Invalid 'size': expected string");
    }
    size = args.size.trim().toLowerCase();
    if (!ALLOWED_MCP_SIZES.has(size)) {
      throw new Error(`Unsupported size '${args.size}'. Expected one of: ${MCP_SIZE_ENUM.join(", ")}`);
    }
  }

  let format = "png";
  if (args.format !== undefined) {
    if (typeof args.format !== "string") {
      throw new Error("Invalid 'format': expected string");
    }
    format = args.format.trim().toLowerCase();
    if (!ALLOWED_MCP_FORMATS.has(format)) {
      throw new Error(
        `Unsupported format '${args.format}'. Expected one of: ${MCP_FORMAT_ENUM.join(", ")}`,
      );
    }
  }

  let fgType = "";
  if (args.type !== undefined) {
    if (typeof args.type !== "string") {
      throw new Error("Invalid 'type': expected string");
    }
    fgType = args.type.trim().toLowerCase();
    if (!ALLOWED_MCP_TYPES.has(fgType)) {
      throw new Error(`Unsupported type '${args.type}'. Expected one of: ${MCP_TYPE_ENUM.join(", ")}`);
    }
  }

  let shadowType = "";
  if (args.shadowType !== undefined) {
    if (typeof args.shadowType !== "string") {
      throw new Error("Invalid 'shadowType': expected string");
    }
    shadowType = args.shadowType.trim().toLowerCase();
    if (!ALLOWED_MCP_SHADOWS.has(shadowType)) {
      throw new Error(
        `Unsupported shadowType '${args.shadowType}'. Expected one of: ${MCP_SHADOW_ENUM.join(", ")}`,
      );
    }
  }

  if (args.crop !== undefined && typeof args.crop !== "boolean") {
    throw new Error("Invalid 'crop': expected boolean");
  }
  if (args.addShadow !== undefined && typeof args.addShadow !== "boolean") {
    throw new Error("Invalid 'addShadow': expected boolean");
  }

  let bgColor = "";
  if (args.bgColor !== undefined) {
    if (typeof args.bgColor !== "string") {
      throw new Error("Invalid 'bgColor': expected string");
    }
    bgColor = args.bgColor.trim();
    if (bgColor.length > 32 || /[\r\n\0]/.test(bgColor)) {
      throw new Error("Invalid 'bgColor' value");
    }
  }

  if (args.bgImagePath !== undefined && typeof args.bgImagePath !== "string") {
    throw new Error("Invalid 'bgImagePath': expected string");
  }
  if (args.bg_image_path !== undefined && typeof args.bg_image_path !== "string") {
    throw new Error("Invalid 'bg_image_path': expected string");
  }
  const camelBgPath = typeof args.bgImagePath === "string" ? args.bgImagePath.trim() : "";
  const snakeBgPath = typeof args.bg_image_path === "string" ? args.bg_image_path.trim() : "";
  if ((args.bgImagePath !== undefined && !camelBgPath) || (args.bg_image_path !== undefined && !snakeBgPath)) {
    throw new Error("Invalid 'bg_image_path': expected non-empty file path string");
  }
  if (camelBgPath && snakeBgPath && camelBgPath !== snakeBgPath) {
    throw new Error("Conflicting 'bgImagePath' and 'bg_image_path' arguments");
  }
  const bgImageFile = camelBgPath || snakeBgPath;
  if (bgImageFile.includes("\0")) {
    throw new Error("Invalid 'bg_image_path' value");
  }
  if (bgImageFile && /^https?:\/\//i.test(bgImageFile)) {
    throw new Error("'bg_image_path' must be a local file path; use 'bg_image_url' for remote URLs");
  }

  if (args.bgImageUrl !== undefined && typeof args.bgImageUrl !== "string") {
    throw new Error("Invalid 'bgImageUrl': expected string");
  }
  if (args.bg_image_url !== undefined && typeof args.bg_image_url !== "string") {
    throw new Error("Invalid 'bg_image_url': expected string");
  }
  const camelBgUrl = typeof args.bgImageUrl === "string" ? args.bgImageUrl.trim() : "";
  const snakeBgUrl = typeof args.bg_image_url === "string" ? args.bg_image_url.trim() : "";
  if ((args.bgImageUrl !== undefined && !camelBgUrl) || (args.bg_image_url !== undefined && !snakeBgUrl)) {
    throw new Error("Invalid 'bg_image_url': expected non-empty URL string");
  }
  if (camelBgUrl && snakeBgUrl && camelBgUrl !== snakeBgUrl) {
    throw new Error("Conflicting 'bgImageUrl' and 'bg_image_url' arguments");
  }
  const bgImageUrl = camelBgUrl || snakeBgUrl;
  if (bgImageUrl.includes("\0")) {
    throw new Error("Invalid 'bg_image_url' value");
  }

  const bgCount = (bgColor ? 1 : 0) + (bgImageFile ? 1 : 0) + (bgImageUrl ? 1 : 0);
  if (bgCount > 1) {
    throw new Error(
      "Specify at most one background option among 'bgColor', 'bg_image_path'/'bgImagePath', or 'bg_image_url'/'bgImageUrl'",
    );
  }

  return {
    size,
    format,
    ...(bgColor ? { bgColor } : {}),
    ...(bgImageFile ? { bgImageFile } : {}),
    ...(bgImageUrl ? { bgImageUrl } : {}),
    ...(typeof args.crop === "boolean" ? { crop: args.crop } : {}),
    ...(fgType ? { type: fgType } : {}),
    ...(typeof args.addShadow === "boolean" ? { addShadow: args.addShadow } : {}),
    ...(shadowType ? { shadowType } : {}),
  };
}

function assertSupportedMcpImageExtension(filePath, label) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
    throw new Error(
      `Unsupported ${label} extension '${ext || "(none)"}'. Expected one of: .png, .jpg, .jpeg, .webp`,
    );
  }
}

function hasSupportedImageMagicBytes(bytes) {
  if (!bytes || bytes.byteLength < 3) return false;
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
    return true;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
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
    return true;
  }
  return false;
}

function assertSupportedMcpImageMagicHeader(filePath, label) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (!hasSupportedImageMagicBytes(header.subarray(0, bytesRead))) {
      throw new Error(
        `Invalid ${label}: file header is not a valid PNG, JPEG, or WebP image`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function prepareValidatedCutoutOptions(cutoutOpts, lookupFn) {
  const prepared = { ...cutoutOpts };
  let bgByteLength = 0;
  if (prepared.bgImageFile) {
    const resolvedBg = path.resolve(prepared.bgImageFile);
    validateNoSymlinkPathChain(resolvedBg, "bg_image_path");
    assertSupportedMcpImageExtension(resolvedBg, "bg_image_path");
    let bgStat = null;
    try {
      bgStat = fs.lstatSync(resolvedBg);
    } catch (stErr) {
      if (!stErr || stErr.code !== "ENOENT") throw stErr;
    }
    if (!bgStat || !bgStat.isFile()) {
      throw new Error(`Background image file not found: ${resolvedBg}`);
    }
    if (bgStat.size <= 0) {
      throw new Error(`Background image file is empty: ${resolvedBg}`);
    }
    if (bgStat.size > MAX_BG_IMAGE_BYTES) {
      throw new Error(`Background image file exceeds 25 MB limit: ${resolvedBg}`);
    }
    assertSupportedMcpImageMagicHeader(resolvedBg, "bg_image_path");
    prepared.bgImageFile = resolvedBg;
    bgByteLength = bgStat.size;
  }
  if (prepared.bgImageUrl) {
    const bgUrlErr = await validateRemoteImageUrl(prepared.bgImageUrl, lookupFn);
    if (bgUrlErr) {
      throw new Error(bgUrlErr);
    }
  }
  return { cutoutOpts: prepared, bgByteLength };
}

function toolSuccess(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function toolFailure(message) {
  return {
    content: [{ type: "text", text: String(message) }],
    isError: true,
  };
}

export async function handleMcpRequest(
  msg,
  clientFactory = null,
  options = {},
) {
  const effectiveClientFactory =
    clientFactory || (() => new RemoveAcClient({ lookup: options.lookup }));
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
    };
  }

  // Notifications carry no `id` and must not emit a response.
  if (msg.id === undefined) {
    return null;
  }

  const { id, method, params } = msg;

  if (method === "initialize") {
    const requestedVersion =
      typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requestedVersion)
      ? requestedVersion
      : DEFAULT_PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const rawArgs = params?.arguments;
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      return {
        jsonrpc: "2.0",
        id,
        result: toolFailure("Invalid tool arguments: expected JSON object"),
      };
    }
    const args = rawArgs || {};

    try {
      if (toolName === "get_account_balance") {
        validateAllowedArguments(toolName, args);
        const client = effectiveClientFactory();
        const account = await client.getAccount();
        const creditsObj = account?.data?.attributes?.credits ?? account?.credits ?? null;
        return {
          jsonrpc: "2.0",
          id,
          result: toolSuccess({
            ok: true,
            totalCredits:
              typeof creditsObj?.total === "number"
                ? creditsObj.total
                : typeof account?.totalCredits === "number"
                  ? account.totalCredits
                  : null,
            account,
          }),
        };
      }

      if (toolName === "remove_background_file") {
        validateAllowedArguments(toolName, args);
        const rawCutoutOpts = mapToolCutoutOptions(args);
        if (!args.inputPath || typeof args.inputPath !== "string" || args.inputPath.includes("\0")) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure("Missing required string argument: inputPath"),
          };
        }
        const resolvedInput = path.resolve(args.inputPath);
        validateNoSymlinkPathChain(resolvedInput, "inputPath");
        assertSupportedMcpImageExtension(resolvedInput, "inputPath");
        let inputStat = null;
        try {
          inputStat = fs.lstatSync(resolvedInput);
        } catch (stErr) {
          if (!stErr || stErr.code !== "ENOENT") throw stErr;
        }
        if (!inputStat || !inputStat.isFile()) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure(`Input image file not found: ${resolvedInput}`),
          };
        }
        if (inputStat.size <= 0) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure(`Input image file is empty: ${resolvedInput}`),
          };
        }
        if (inputStat.size > MAX_IMAGE_BYTES) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure(`Input image file exceeds 25 MB limit: ${resolvedInput}`),
          };
        }
        assertSupportedMcpImageMagicHeader(resolvedInput, "inputPath");

        const { cutoutOpts, bgByteLength } = await prepareValidatedCutoutOptions(
          rawCutoutOpts,
          options.lookup,
        );
        if (bgByteLength > 0 && inputStat.size + bgByteLength > MAX_COMBINED_UPLOAD_BYTES) {
          throw new Error(
            `Combined inputPath and bg_image_path size exceeds 30 MB limit (${inputStat.size + bgByteLength} bytes)`,
          );
        }

        const rawOut =
          typeof args.outputPath === "string" && args.outputPath.trim()
            ? args.outputPath
            : resolveDefaultOutputPath(resolvedInput, cutoutOpts.format);
        const overwrite = Boolean(args.overwrite);
        const resolvedOutput = ensureSafeWriteTarget(rawOut, overwrite, resolvedInput);
        if (cutoutOpts.bgImageFile && resolvedOutput === cutoutOpts.bgImageFile) {
          throw new Error(
            "outputPath resolves to bg_image_path; specify a separate outputPath",
          );
        }

        const client = effectiveClientFactory();
        const res = await client.removeBackground(resolvedInput, cutoutOpts);
        writeBufferAtomically(resolvedOutput, res.buffer, overwrite, resolvedInput);
        return {
          jsonrpc: "2.0",
          id,
          result: toolSuccess({
            ok: true,
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            bytes: res.buffer.byteLength,
            width: res.width,
            height: res.height,
            mediaType: res.mediaType,
            creditsCharged: res.creditsCharged,
          }),
        };
      }

      if (toolName === "remove_background_url") {
        validateAllowedArguments(toolName, args);
        const rawCutoutOpts = mapToolCutoutOptions(args);
        if (!args.imageUrl || typeof args.imageUrl !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure("Missing required string argument: imageUrl"),
          };
        }
        if (!args.outputPath || typeof args.outputPath !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure("Missing required string argument: outputPath"),
          };
        }
        const urlErr = await validateRemoteImageUrl(args.imageUrl, options.lookup);
        if (urlErr) {
          return { jsonrpc: "2.0", id, result: toolFailure(urlErr) };
        }
        const { cutoutOpts } = await prepareValidatedCutoutOptions(rawCutoutOpts, options.lookup);
        const overwrite = Boolean(args.overwrite);
        const resolvedOutput = ensureSafeWriteTarget(args.outputPath, overwrite);
        if (cutoutOpts.bgImageFile && resolvedOutput === cutoutOpts.bgImageFile) {
          throw new Error(
            "outputPath resolves to bg_image_path; specify a separate outputPath",
          );
        }

        const client = effectiveClientFactory();
        const res = await client.removeBackground(args.imageUrl, cutoutOpts);
        writeBufferAtomically(resolvedOutput, res.buffer, overwrite);
        return {
          jsonrpc: "2.0",
          id,
          result: toolSuccess({
            ok: true,
            imageUrl: args.imageUrl,
            outputPath: resolvedOutput,
            bytes: res.buffer.byteLength,
            width: res.width,
            height: res.height,
            mediaType: res.mediaType,
            creditsCharged: res.creditsCharged,
          }),
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(toolName)}` },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: toolFailure(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${String(method)}` },
  };
}

function printHelp() {
  process.stdout.write(
    [
      `${SERVER_NAME} v${SERVER_VERSION} — Official MCP stdio server for remove.ac`,
      "",
      "Usage:",
      "  REMOVE_AC_API_KEY=rac_live_... remove-ac-mcp",
      "  npx -y -p remove-ac remove-ac-mcp",
      "",
      "Options:",
      "  -h, --help      Show this help message and exit",
      "  -v, --version   Print server version and exit",
      "",
      "Docs & API keys: https://remove.ac/api-info",
      "",
    ].join("\n"),
  );
}

function isAsciiWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

export function startStdioServer(
  clientFactory = () => new RemoveAcClient(),
  io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  options = {},
) {
  let buffer = Buffer.alloc(0);
  let framingMode = null; // "line" | "content-length"
  let processing = Promise.resolve();

  const sendResponse = (payload, mode) => {
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (mode === "content-length") {
      const byteLen = Buffer.byteLength(json, "utf8");
      io.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      io.stdout.write(`${json}\n`);
    }
  };

  const enqueueResponse = (payload, mode) => {
    processing = processing.then(() => {
      sendResponse(payload, mode);
    });
  };

  const dispatchJson = (rawText, mode) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    processing = processing
      .then(async () => {
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          sendResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            },
            mode,
          );
          return;
        }
        if (Array.isArray(parsed)) {
          const responses = [];
          for (const item of parsed) {
            const out = await handleMcpRequest(item, clientFactory, options);
            if (out) responses.push(out);
          }
          if (responses.length > 0) sendResponse(responses, mode);
          return;
        }
        const out = await handleMcpRequest(parsed, clientFactory, options);
        if (out) sendResponse(out, mode);
      })
      .catch((err) => {
        io.stderr.write(
          `[remove-ac-mcp] internal dispatch error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      if (!framingMode) {
        let firstNonWs = 0;
        while (firstNonWs < buffer.length && isAsciiWhitespace(buffer[firstNonWs])) {
          firstNonWs++;
        }
        if (firstNonWs > 0) {
          buffer = buffer.subarray(firstNonWs);
        }
        if (buffer.length === 0) return;

        const firstByte = buffer[0];
        if (firstByte === 0x7b /* '{' */ || firstByte === 0x5b /* '[' */) {
          framingMode = "line";
        } else {
          // Wait for a complete first header line before locking framingMode so split chunks
          // like "Content-" + "Length: 85\r\n\r\n" or multi-header LSP frames work reliably.
          const firstNl = buffer.indexOf(0x0a);
          if (firstNl === -1) {
            if (buffer.length > MAX_MCP_HEADER_BYTES) {
              buffer = Buffer.alloc(0);
              enqueueResponse(
                {
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: "Malformed header exceeds maximum size" },
                },
                "line",
              );
            }
            return;
          }
          const firstLine = buffer.subarray(0, firstNl).toString("utf8").trim();
          framingMode = /^[A-Za-z][A-Za-z0-9-]*\s*:/.test(firstLine) ? "content-length" : "line";
        }
      }

      if (framingMode === "content-length") {
        let firstNonWs = 0;
        while (firstNonWs < buffer.length && isAsciiWhitespace(buffer[firstNonWs])) {
          firstNonWs++;
        }
        if (firstNonWs > 0) {
          buffer = buffer.subarray(firstNonWs);
        }
        if (buffer.length === 0) return;

        let sepIdx = buffer.indexOf("\r\n\r\n");
        let sepLen = 4;
        const lfSepIdx = buffer.indexOf("\n\n");
        if (sepIdx === -1 || (lfSepIdx !== -1 && lfSepIdx < sepIdx)) {
          sepIdx = lfSepIdx;
          sepLen = 2;
        }
        if (sepIdx === -1) {
          if (buffer.length > MAX_MCP_HEADER_BYTES) {
            buffer = Buffer.alloc(0);
            enqueueResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Header block exceeds 16 KB limit" },
              },
              "content-length",
            );
          }
          return;
        }

        const headerText = buffer.subarray(0, sepIdx).toString("utf8");
        const match = headerText.match(/(?:^|\r?\n)content-length:\s*(\d+)\s*(?:\r?\n|$)/i);
        if (!match) {
          buffer = buffer.subarray(sepIdx + sepLen);
          enqueueResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Missing Content-Length header" },
            },
            "content-length",
          );
          continue;
        }

        const bodyLen = Number.parseInt(match[1], 10);
        if (!Number.isSafeInteger(bodyLen) || bodyLen < 0 || bodyLen > MAX_MCP_MESSAGE_BYTES) {
          buffer = Buffer.alloc(0);
          enqueueResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32600,
                message: `Content-Length exceeds maximum allowed size (${MAX_MCP_MESSAGE_BYTES} bytes)`,
              },
            },
            "content-length",
          );
          return;
        }

        const bodyStart = sepIdx + sepLen;
        if (buffer.length < bodyStart + bodyLen) return;
        const bodyText = buffer.subarray(bodyStart, bodyStart + bodyLen).toString("utf8");
        buffer = buffer.subarray(bodyStart + bodyLen);
        dispatchJson(bodyText, "content-length");
      } else {
        const nlIdx = buffer.indexOf(0x0a);
        if (nlIdx === -1) {
          if (buffer.length > MAX_MCP_MESSAGE_BYTES) {
            buffer = Buffer.alloc(0);
            enqueueResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32600,
                  message: `Line exceeds maximum allowed size (${MAX_MCP_MESSAGE_BYTES} bytes)`,
                },
              },
              "line",
            );
          }
          return;
        }
        const lineText = buffer.subarray(0, nlIdx).toString("utf8");
        buffer = buffer.subarray(nlIdx + 1);
        dispatchJson(lineText, "line");
      }
    }
  };

  io.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    drainBuffer();
  });

  io.stdin.on("end", () => {
    if (framingMode !== "content-length" && buffer.length > 0) {
      const rest = buffer.toString("utf8");
      buffer = Buffer.alloc(0);
      dispatchJson(rest, "line");
    }
  });

  return {
    waitForIdle: () => processing,
  };
}

const isDirectEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    process.exit(0);
  }
  startStdioServer();
}
