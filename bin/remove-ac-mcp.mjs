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
export const SERVER_VERSION = "1.1.2";
export const MAX_MCP_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_MCP_HEADER_BYTES = 16 * 1024;
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
    enum: ["auto", "car", "drop", "soft", "contact", "reflection", "none"],
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
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};

    try {
      const client = effectiveClientFactory();

      if (toolName === "get_account_balance") {
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
        const urlErr = await validateRemoteImageUrl(args.imageUrl, options.lookup);
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
