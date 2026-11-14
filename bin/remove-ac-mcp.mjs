#!/usr/bin/env node
/**
 * Zero-dependency Model Context Protocol (MCP) stdio server for remove.ac.
 *
 * Exposes 3 tools over JSON-RPC 2.0 stdio (both newline-delimited MCP 2024-11-05+
 * and Content-Length framed JSON-RPC):
 *   - remove_background_file
 *   - remove_background_url
 *   - get_account_balance
 *
 * Environment variables:
 *   REMOVE_AC_API_KEY (or REMOVE_BG_API_KEY) — required at tool execution time
 *   REMOVE_AC_BASE_URL — optional override (defaults to https://remove.ac)
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoveAcClient } from "../node/index.mjs";

export const SERVER_NAME = "remove-ac-mcp";
export const SERVER_VERSION = "1.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

const SHARED_CUTOUT_PROPERTIES = {
  size: {
    type: "string",
    enum: ["auto", "preview", "small", "regular", "medium", "hd", "4k", "full"],
    description: "Output resolution tier. Defaults to 'full'.",
  },
  format: {
    type: "string",
    enum: ["png", "jpg", "webp", "zip"],
    description: "Output file format. Defaults to 'png'.",
  },
  bgColor: {
    type: "string",
    description: "Optional solid background hex color (e.g. 'FFFFFF') instead of transparency.",
  },
  crop: {
    type: "boolean",
    description: "Trim empty transparent padding around the foreground subject.",
  },
  type: {
    type: "string",
    enum: ["auto", "person", "product", "car", "animal", "graphic", "transportation"],
    description: "Optional foreground category hint.",
  },
  addShadow: {
    type: "boolean",
    description: "Render a realistic drop or contact shadow under the cutout.",
  },
  shadowType: {
    type: "string",
    enum: ["auto", "car", "3d", "drop", "contact"],
    description: "Shadow preset when addShadow is enabled.",
  },
};

export const MCP_TOOLS = [
  {
    name: "remove_background_file",
    description:
      "Remove the background from a local image file (.png, .jpg, .jpeg, .webp) via the stateless remove.ac Cloud GPU API (/v1.0/removebg). Files above 4 MB (up to 25 MB / 40 MP) automatically stream via zero-disk /v1.0/removebg/ticket.",
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

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) return isPrivateIpv4(v4);
  }
  return false;
}

export function isDisallowedRemoteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return "Invalid URL syntax";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Only http:// and https:// image URLs are allowed";
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return "Local or internal hostnames are not permitted";
  }
  if (net.isIPv4(host) && isPrivateIpv4(host)) {
    return "Private or loopback IPv4 addresses are not permitted";
  }
  if (net.isIPv6(host) && isPrivateIpv6(host)) {
    return "Private or loopback IPv6 addresses are not permitted";
  }
  return null;
}

function resolveDefaultOutputPath(inputPath, format = "png") {
  const parsed = path.parse(inputPath);
  const ext = format === "auto" ? ".png" : `.${format}`;
  return path.join(parsed.dir, `${parsed.name}-nobg${ext}`);
}

function ensureSafeWriteTarget(targetPath, overwrite = false, sourcePath = null) {
  const resolvedTarget = path.resolve(targetPath);
  if (sourcePath && path.resolve(sourcePath) === resolvedTarget && !overwrite) {
    throw new Error(
      "outputPath resolves to inputPath; specify a separate outputPath or set overwrite: true",
    );
  }
  if (!overwrite && fs.existsSync(resolvedTarget)) {
    throw new Error(
      `Destination file already exists: ${resolvedTarget} (pass overwrite: true to replace)`,
    );
  }
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  return resolvedTarget;
}

function mapToolCutoutOptions(args = {}) {
  return {
    size: args.size || "full",
    format: args.format || "png",
    ...(args.bgColor ? { bgColor: String(args.bgColor) } : {}),
    ...(typeof args.crop === "boolean" ? { crop: args.crop } : {}),
    ...(args.type ? { type: String(args.type) } : {}),
    ...(typeof args.addShadow === "boolean" ? { addShadow: args.addShadow } : {}),
    ...(args.shadowType ? { shadowType: String(args.shadowType) } : {}),
  };
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

export async function handleMcpRequest(msg, clientFactory = () => new RemoveAcClient()) {
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
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};

    try {
      const client = clientFactory();

      if (toolName === "get_account_balance") {
        const account = await client.getAccount();
        return {
          jsonrpc: "2.0",
          id,
          result: toolSuccess({ ok: true, account }),
        };
      }

      if (toolName === "remove_background_file") {
        if (!args.inputPath || typeof args.inputPath !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure("Missing required string argument: inputPath"),
          };
        }
        const resolvedInput = path.resolve(args.inputPath);
        if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isFile()) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolFailure(`Input image file not found: ${resolvedInput}`),
          };
        }
        const cutoutOpts = mapToolCutoutOptions(args);
        const rawOut =
          typeof args.outputPath === "string" && args.outputPath.trim()
            ? args.outputPath
            : resolveDefaultOutputPath(resolvedInput, cutoutOpts.format);
        const resolvedOutput = ensureSafeWriteTarget(
          rawOut,
          Boolean(args.overwrite),
          resolvedInput,
        );
        const res = await client.removeBackground(resolvedInput, cutoutOpts);
        fs.writeFileSync(resolvedOutput, res.buffer);
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
        const urlErr = isDisallowedRemoteUrl(args.imageUrl);
        if (urlErr) {
          return { jsonrpc: "2.0", id, result: toolFailure(urlErr) };
        }
        const resolvedOutput = ensureSafeWriteTarget(
          args.outputPath,
          Boolean(args.overwrite),
        );
        const cutoutOpts = mapToolCutoutOptions(args);
        const res = await client.removeBackground(args.imageUrl, cutoutOpts);
        fs.writeFileSync(resolvedOutput, res.buffer);
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

export function startStdioServer(clientFactory = () => new RemoveAcClient()) {
  let buffer = Buffer.alloc(0);
  let framingMode = null; // "line" | "content-length"
  let processing = Promise.resolve();

  const sendResponse = (payload, mode) => {
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (mode === "content-length") {
      const byteLen = Buffer.byteLength(json, "utf8");
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
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
            const out = await handleMcpRequest(item, clientFactory);
            if (out) responses.push(out);
          }
          if (responses.length > 0) sendResponse(responses, mode);
          return;
        }
        const out = await handleMcpRequest(parsed, clientFactory);
        if (out) sendResponse(out, mode);
      })
      .catch((err) => {
        process.stderr.write(
          `[remove-ac-mcp] internal dispatch error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      if (!framingMode) {
        const preview = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8").trimStart();
        if (!preview) return;
        framingMode = /^content-length:/i.test(preview) ? "content-length" : "line";
      }

      if (framingMode === "content-length") {
        let sepIdx = buffer.indexOf("\r\n\r\n");
        let sepLen = 4;
        if (sepIdx === -1) {
          sepIdx = buffer.indexOf("\n\n");
          sepLen = 2;
        }
        if (sepIdx === -1) return;
        const headerText = buffer.subarray(0, sepIdx).toString("utf8");
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(sepIdx + sepLen);
          continue;
        }
        const bodyLen = Number.parseInt(match[1], 10);
        const bodyStart = sepIdx + sepLen;
        if (buffer.length < bodyStart + bodyLen) return;
        const bodyText = buffer.subarray(bodyStart, bodyStart + bodyLen).toString("utf8");
        buffer = buffer.subarray(bodyStart + bodyLen);
        dispatchJson(bodyText, "content-length");
      } else {
        const nlIdx = buffer.indexOf(0x0a);
        if (nlIdx === -1) return;
        const lineText = buffer.subarray(0, nlIdx).toString("utf8");
        buffer = buffer.subarray(nlIdx + 1);
        dispatchJson(lineText, "line");
      }
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    drainBuffer();
  });

  process.stdin.on("end", () => {
    if (framingMode !== "content-length" && buffer.length > 0) {
      const rest = buffer.toString("utf8");
      buffer = Buffer.alloc(0);
      dispatchJson(rest, "line");
    }
  });
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
