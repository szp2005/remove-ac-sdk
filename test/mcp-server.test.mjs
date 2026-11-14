import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RemoveAcClient } from "../node/index.mjs";
import {
  handleMcpRequest,
  isDisallowedRemoteUrl,
  MAX_MCP_MESSAGE_BYTES,
  MCP_TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
  startStdioServer,
  validateRemoteImageUrl,
} from "../bin/remove-ac-mcp.mjs";

const mcpBinPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/remove-ac-mcp.mjs",
);

test("MCP initialize, ping, and tools/list follow JSON-RPC 2.0 contract at v1.1.1", async () => {
  assert.equal(SERVER_VERSION, "1.1.1");
  const initRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.protocolVersion, "2024-11-05");
  assert.equal(initRes.result.serverInfo.name, SERVER_NAME);
  assert.equal(initRes.result.serverInfo.version, "1.1.1");

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

test("MCP get_account_balance surfaces totalCredits cleanly for positive and zero balances", async () => {
  for (const total of [41, 0]) {
    const fakeClient = () => ({
      getAccount: async () => ({
        data: {
          attributes: {
            credits: {
              total,
              subscription: total > 0 ? 40 : 0,
              payg: total > 0 ? 1 : 0,
              enterprise: 0,
            },
            api: { free_calls: 0, sizes: "all" },
          },
        },
      }),
    });
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 20 + total,
        method: "tools/call",
        params: { name: "get_account_balance", arguments: {} },
      },
      fakeClient,
    );
    assert.equal(res.result.isError, undefined);
    const body = JSON.parse(res.result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.totalCredits, total);
    assert.equal(body.account.data.attributes.credits.total, total);
  }
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

test("MCP remove_background_url blocks IPv4, IPv4-mapped/compatible IPv6, fe80::/10, NAT64, and DNS-rebound private targets", async () => {
  const blockedUrls = [
    "http://127.0.0.1:8080/secret.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/secret.png",
    "http://[::]/secret.png",
    "http://[::ffff:127.0.0.1]/secret.png",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::127.0.0.1]/secret.png",
    "http://[fe80::1]/secret.png",
    "http://[febf::1]/secret.png",
    "http://[fc00::1]/secret.png",
    "http://[fd12:3456::1]/secret.png",
    "http://[64:ff9b::10.0.0.1]/secret.png",
    "http://[64:ff9b::169.254.169.254]/secret.png",
    "http://[100::1]/secret.png",
    "http://2130706433/secret.png",
    "http://user:pass@images.unsplash.com/photo.jpg",
    "file:///etc/passwd",
  ];
  for (const bad of blockedUrls) {
    assert.ok(isDisallowedRemoteUrl(bad), `Expected URL to be blocked: ${bad}`);
  }

  assert.equal(isDisallowedRemoteUrl("https://images.unsplash.com/photo-1.jpg"), null);
  assert.equal(isDisallowedRemoteUrl("https://[2606:4700:4700::1111]/photo.png"), null);

  // DNS resolution guard blocks domains resolving to private/loopback IPv4 or IPv4-mapped IPv6
  const dnsRebindErr = await validateRemoteImageUrl(
    "http://127.0.0.1.nip.io/secret.png",
    async () => [{ address: "127.0.0.1", family: 4 }],
  );
  assert.match(dnsRebindErr, /private, loopback, or reserved/i);

  const dnsMappedV6Err = await validateRemoteImageUrl(
    "http://rebind.example.com/secret.png",
    async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:169.254.169.254", family: 6 },
    ],
  );
  assert.match(dnsMappedV6Err, /private, loopback, or reserved/i);

  const dnsPublicOk = await validateRemoteImageUrl(
    "https://cdn.example.com/public.png",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  assert.equal(dnsPublicOk, null);

  const res = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "remove_background_url",
        arguments: {
          imageUrl: "http://127.0.0.1.nip.io/test.png",
          outputPath: "/tmp/should-not-write.png",
        },
      },
    },
    () => new RemoveAcClient({ apiKey: "rac_live_unused" }),
    { lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
  );
  assert.equal(res.result.isError, true);
});

test("MCP framing decoder handles split Content-Length headers, multi-headers, and byte caps", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let outRaw = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (c) => {
    outRaw += c;
  });

  const srv = startStdioServer(() => new RemoveAcClient(), { stdin, stdout, stderr });

  const msg1 = JSON.stringify({ jsonrpc: "2.0", id: 101, method: "ping" });
  const msg2 = JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/list" });

  // 1) Split header across tiny chunks ("Content-" then "Length: ...")
  stdin.write("Content-");
  stdin.write(`Length: ${Buffer.byteLength(msg1)}\r\n\r\n`);
  stdin.write(msg1.slice(0, 10));
  stdin.write(msg1.slice(10));

  // 2) Standard LSP multi-header frame with Content-Type preceding Content-Length
  stdin.write(
    `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(msg2)}\r\n\r\n${msg2}`,
  );

  // 3) Oversized Content-Length frame must be rejected cleanly without hanging
  stdin.write(`Content-Length: ${MAX_MCP_MESSAGE_BYTES + 1024}\r\n\r\n{}`);
  stdin.end();

  await srv.waitForIdle();
  await new Promise((r) => setTimeout(r, 20));

  const decoded = [];
  let cursor = outRaw;
  while (cursor.includes("\r\n\r\n")) {
    const idx = cursor.indexOf("\r\n\r\n");
    const hdr = cursor.slice(0, idx);
    const len = Number.parseInt(hdr.match(/Content-Length:\s*(\d+)/i)[1], 10);
    const body = cursor.slice(idx + 4, idx + 4 + len);
    decoded.push(JSON.parse(body));
    cursor = cursor.slice(idx + 4 + len);
  }

  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].id, 101);
  assert.deepEqual(decoded[0].result, {});
  assert.equal(decoded[1].id, 102);
  assert.equal(decoded[1].result.tools.length, 3);
  assert.equal(decoded[2].error.code, -32600);
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
  assert.equal(lines[0].result.serverInfo.version, "1.1.1");
  assert.equal(lines[1].id, 11);
  assert.equal(lines[1].result.tools.length, 3);
});
