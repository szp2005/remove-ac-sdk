import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RemoveAcClient } from "../node/index.mjs";
import {
  handleMcpRequest,
  isDisallowedRemoteUrl,
  MCP_TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
} from "../bin/remove-ac-mcp.mjs";

const mcpBinPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/remove-ac-mcp.mjs",
);

test("MCP initialize, ping, and tools/list follow JSON-RPC 2.0 contract", async () => {
  const initRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.protocolVersion, "2024-11-05");
  assert.equal(initRes.result.serverInfo.name, SERVER_NAME);
  assert.equal(initRes.result.serverInfo.version, SERVER_VERSION);

  const notifRes = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(notifRes, null);

  const listRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.equal(listRes.result.tools.length, 3);
  assert.deepEqual(
    MCP_TOOLS.map((t) => t.name),
    ["remove_background_file", "remove_background_url", "get_account_balance"],
  );
});

test("MCP remove_background_file writes cutout output and upgrades >4 MB files via ticket", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remove-ac-mcp-test-"));
  const inputPath = path.join(tmpDir, "large-input.png");
  fs.writeFileSync(inputPath, Buffer.alloc(4 * 1024 * 1024 + 128, 0x2a));

  const calls = [];
  const fakeClient = () =>
    new RemoveAcClient({
      apiKey: "rac_live_mcp_test",
      fetch: async (url) => {
        calls.push(url);
        if (url.endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: "mcp_signed_ticket",
              directEndpoint: "https://gpu.example.invalid/v1.0/direct-cutout",
            },
          });
        }
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "X-Width": "2000",
            "X-Height": "1500",
            "X-Credits-Charged": "1",
          },
        });
      },
    });

  const callRes = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "remove_background_file",
        arguments: { inputPath },
      },
    },
    fakeClient,
  );

  assert.equal(callRes.result.isError, undefined);
  const parsed = JSON.parse(callRes.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outputPath, path.join(tmpDir, "large-input-nobg.png"));
  assert.equal(parsed.width, 2000);
  assert.equal(parsed.creditsCharged, 1);
  assert.equal(fs.existsSync(parsed.outputPath), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], "https://remove.ac/v1.0/removebg/ticket");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("MCP remove_background_url blocks loopback/private SSRF targets", async () => {
  assert.ok(isDisallowedRemoteUrl("http://127.0.0.1:8080/secret.png"));
  assert.ok(isDisallowedRemoteUrl("http://169.254.169.254/latest/meta-data"));
  assert.ok(isDisallowedRemoteUrl("file:///etc/passwd"));
  assert.equal(isDisallowedRemoteUrl("https://images.unsplash.com/photo-1.jpg"), null);

  const res = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "remove_background_url",
      arguments: {
        imageUrl: "http://127.0.0.1/test.png",
        outputPath: "/tmp/should-not-write.png",
      },
    },
  });
  assert.equal(res.result.isError, true);
});

test("MCP stdio child process handles newline-delimited JSON-RPC end-to-end", async () => {
  const child = spawn(process.execPath, [mcpBinPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  let stdoutBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });

  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" })}\n`,
  );
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 10);
  assert.equal(lines[0].result.serverInfo.name, "remove-ac-mcp");
  assert.equal(lines[1].id, 11);
  assert.equal(lines[1].result.tools.length, 3);
});
