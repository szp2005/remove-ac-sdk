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
const serverJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../server.json",
);
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const tempRoot = fs.existsSync("/Volumes/Expansion/dev-tools/build-temp")
  ? "/Volumes/Expansion/dev-tools/build-temp"
  : os.tmpdir();

test("MCP initialize, ping, and tools/list follow JSON-RPC 2.0 contract at v1.3.0", async () => {
  assert.equal(SERVER_VERSION, "1.3.1");
  const initRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.protocolVersion, "2024-11-05");
  assert.equal(initRes.result.serverInfo.name, SERVER_NAME);
  assert.equal(initRes.result.serverInfo.version, "1.3.1");

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
  assert.deepEqual(
    MCP_TOOLS[0].inputSchema.properties.shadowType.enum,
    ["auto", "car", "drop", "soft", "contact", "reflection", "none"],
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
  const tmpDir = fs.mkdtempSync(path.join(tempRoot, "remove-ac-mcp-test-"));
  const inputPath = path.join(tmpDir, "large-input.png");
  fs.writeFileSync(inputPath, Buffer.concat([TINY_PNG, Buffer.alloc(4 * 1024 * 1024 + 128, 0x2a)]));

  const calls = [];
  const fakeClient = () =>
    new RemoveAcClient({
      apiKey: "rac_live_mcp_test",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url) => {
        calls.push(url);
        if (url.endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: "mcp_signed_ticket",
              directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
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
  assert.equal(lines[0].result.serverInfo.version, "1.3.1");
  assert.equal(lines[1].id, 11);
  assert.equal(lines[1].result.tools.length, 3);
  const fileTool = lines[1].result.tools.find((t) => t.name === "remove_background_file");
  assert.ok(fileTool.inputSchema.properties.size.enum.includes("25mp"));
  assert.ok(fileTool.inputSchema.properties.size.enum.includes("50mp"));
});

test("MF-02 & MF-03: server.json satisfies Official MCP Registry <=100-char limit and MCP runtime blocks format traversal, invalid enums, unknown args, and symlinks with 0 HTTP calls", async () => {
  const srv = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
  assert.equal(srv.version, SERVER_VERSION);
  assert.equal(srv.packages[0].version, SERVER_VERSION);
  assert.ok(
    typeof srv.description === "string" && srv.description.length > 0 && srv.description.length <= 100,
    `Expected server.json description <= 100 chars, got ${srv.description?.length}`,
  );

  const sandbox = fs.mkdtempSync(path.join(tempRoot, "remove-ac-mcp-sec-"));
  try {
    const workDir = path.join(sandbox, "nested", "workspace");
    fs.mkdirSync(workDir, { recursive: true });
    const inputPath = path.join(workDir, "photo.png");
    fs.writeFileSync(inputPath, TINY_PNG);

    const outsideSecret = path.join(sandbox, "victim.txt");
    fs.writeFileSync(outsideSecret, "DO_NOT_OVERWRITE");
    const liveSymlinkOut = path.join(workDir, "symlink-out.png");
    fs.symlinkSync(outsideSecret, liveSymlinkOut);
    const danglingSymlinkOut = path.join(workDir, "dangling-out.png");
    fs.symlinkSync(path.join(sandbox, "nonexistent-target.png"), danglingSymlinkOut);
    const symlinkDir = path.join(workDir, "symdir");
    fs.symlinkSync(sandbox, symlinkDir);

    let httpHits = 0;
    const neverCalledClient = () => ({
      removeBackground: async () => {
        httpHits += 1;
        return { buffer: Buffer.from("PWNED"), width: 10, height: 10, creditsCharged: 1, mediaType: "image/png" };
      },
      getAccount: async () => {
        httpHits += 1;
        return {};
      },
    });

    const badCalls = [
      { inputPath, format: "/../../../escaped_via_format.bin" },
      { inputPath, size: "999mp_invalid_tier" },
      { inputPath, type: "alien_entity" },
      { inputPath, shadowType: "laser_beam" },
      { inputPath, unknownExtraKey: "blocked" },
      { inputPath, outputPath: liveSymlinkOut, overwrite: true },
      { inputPath, outputPath: danglingSymlinkOut, overwrite: true },
      { inputPath, outputPath: path.join(symlinkDir, "escaped.png"), overwrite: true },
    ];

    for (const badArgs of badCalls) {
      const res = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "remove_background_file", arguments: badArgs },
        },
        neverCalledClient,
      );
      assert.equal(res.result.isError, true, `Expected error for args=${JSON.stringify(badArgs)}`);
    }

    assert.equal(httpHits, 0, "Invalid arguments or symlink targets must make 0 HTTP calls");
    assert.equal(fs.existsSync(path.join(sandbox, "escaped_via_format.bin")), false);
    assert.equal(fs.readFileSync(outsideSecret, "utf8"), "DO_NOT_OVERWRITE");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("v1.3.0 MCP bg_image_path and bg_image_url support with symlink and SSRF protection", async () => {
  const sandbox = fs.mkdtempSync(path.join(tempRoot, "remove-ac-mcp-bg-"));
  try {
    const fgPath = path.join(sandbox, "fg.png");
    const bgPath = path.join(sandbox, "bg.png");
    const symlinkBg = path.join(sandbox, "symlink-bg.png");
    fs.writeFileSync(fgPath, TINY_PNG);
    fs.writeFileSync(bgPath, TINY_PNG);
    fs.symlinkSync(bgPath, symlinkBg);

    const capturedOpts = [];
    const mockClient = () => ({
      removeBackground: async (_input, opts) => {
        capturedOpts.push(opts);
        return {
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          width: 100,
          height: 100,
          creditsCharged: 1,
          mediaType: "image/png",
        };
      },
    });

    // 1. Valid bg_image_path and bg_image_url
    const r1 = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 201,
        method: "tools/call",
        params: {
          name: "remove_background_file",
          arguments: { inputPath: fgPath, bg_image_path: bgPath, outputPath: path.join(sandbox, "out1.png") },
        },
      },
      mockClient,
    );
    assert.equal(r1.result.isError, undefined);
    assert.equal(capturedOpts[0].bgImageFile, bgPath);

    const r2 = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 202,
        method: "tools/call",
        params: {
          name: "remove_background_file",
          arguments: {
            inputPath: fgPath,
            bg_image_url: "https://cdn.example.com/studio-bg.jpg",
            outputPath: path.join(sandbox, "out2.png"),
          },
        },
      },
      mockClient,
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
    );
    assert.equal(r2.result.isError, undefined);
    assert.equal(capturedOpts[1].bgImageUrl, "https://cdn.example.com/studio-bg.jpg");

    // 2. Reject symlink bg_image_path, SSRF bg_image_url, and conflicting background options with 0 HTTP calls
    const beforeCount = capturedOpts.length;
    for (const badArgs of [
      { inputPath: fgPath, bg_image_path: symlinkBg },
      { inputPath: fgPath, bg_image_url: "http://169.254.169.254/latest/meta-data" },
      { inputPath: fgPath, bgColor: "FFFFFF", bg_image_path: bgPath },
      { inputPath: fgPath, bg_image_path: bgPath, bg_image_url: "https://cdn.example.com/bg.jpg" },
    ]) {
      const badRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 203,
          method: "tools/call",
          params: { name: "remove_background_file", arguments: badArgs },
        },
        mockClient,
        { lookup: async () => [{ address: "169.254.169.254", family: 4 }] },
      );
      assert.equal(badRes.result.isError, true);
    }
    assert.equal(capturedOpts.length, beforeCount);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("R2 MF-05 & MF-02: MCP blocks non-image file exfiltration (.env, SSH keys, disguised text) and >30 MB combined uploads with 0 HTTP calls", async () => {
  const sandbox = fs.mkdtempSync(path.join(tempRoot, "remove-ac-mcp-mf05-"));
  try {
    const validFg = path.join(sandbox, "fg.png");
    const dotEnv = path.join(sandbox, ".env.production");
    const sshKey = path.join(sandbox, "id_rsa");
    const disguisedPng = path.join(sandbox, "disguised-secret.png");
    const bigFg = path.join(sandbox, "fg18.png");
    const bigBg = path.join(sandbox, "bg16.png");

    fs.writeFileSync(validFg, TINY_PNG);
    fs.writeFileSync(dotEnv, "SUPER_SECRET_DB_URL=postgres://admin:pw@db/prod\n");
    fs.writeFileSync(sshKey, "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n");
    fs.writeFileSync(disguisedPng, "SUPER_SECRET_API_TOKEN=secret\n");
    fs.writeFileSync(bigFg, Buffer.concat([TINY_PNG, Buffer.alloc(18 * 1024 * 1024, 0)]));
    fs.writeFileSync(bigBg, Buffer.concat([TINY_PNG, Buffer.alloc(16 * 1024 * 1024, 0)]));

    let networkCalls = 0;
    const guardClient = () =>
      new RemoveAcClient({
        apiKey: "rac_live_mcp_guard",
        fetch: async () => {
          networkCalls += 1;
          return new Response(TINY_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
        },
      });

    for (const [toolName, badArgs] of [
      ["remove_background_file", { inputPath: dotEnv, outputPath: path.join(sandbox, "o1.png") }],
      ["remove_background_file", { inputPath: sshKey, outputPath: path.join(sandbox, "o2.png") }],
      ["remove_background_file", { inputPath: disguisedPng, outputPath: path.join(sandbox, "o3.png") }],
      ["remove_background_file", { inputPath: validFg, bg_image_path: dotEnv, outputPath: path.join(sandbox, "o4.png") }],
      ["remove_background_file", { inputPath: validFg, bg_image_path: sshKey, outputPath: path.join(sandbox, "o5.png") }],
      ["remove_background_file", { inputPath: validFg, bg_image_path: disguisedPng, outputPath: path.join(sandbox, "o6.png") }],
      [
        "remove_background_url",
        {
          imageUrl: "https://cdn.example.com/photo.jpg",
          bg_image_path: dotEnv,
          outputPath: path.join(sandbox, "o7.png"),
        },
      ],
      ["remove_background_file", { inputPath: bigFg, bg_image_path: bigBg, outputPath: path.join(sandbox, "o8.png") }],
      [
        "remove_background_file",
        { inputPath: validFg, bg_image_path: bigBg, outputPath: bigBg, overwrite: true },
      ],
    ]) {
      const res = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 505,
          method: "tools/call",
          params: { name: toolName, arguments: badArgs },
        },
        guardClient,
        { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      );
      assert.equal(res.result.isError, true, `Expected MCP rejection for ${JSON.stringify(badArgs)}`);
    }

    assert.equal(networkCalls, 0, "MCP must make 0 HTTP calls on non-image or >30 MB inputs");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("M-P0-04 & M-P1-08: MCP remove_background_url recovers from HTTP 413 via ticket fallback and rejects untrusted directEndpoint (*.modal.run)", async () => {
  const sandbox = fs.mkdtempSync(path.join(tempRoot, "remove-ac-mcp-413-"));
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  try {
    const outOk = path.join(sandbox, "url-413-cutout.png");
    const calls = [];
    const fallbackClientFactory = () =>
      new RemoveAcClient({
        apiKey: "rac_live_mcp_413",
        lookup: publicLookup,
        fetch: async (url, init = {}) => {
          const u = String(url);
          calls.push(u);
          if (u === "https://remove.ac/v1.0/removebg") {
            return new Response(JSON.stringify({ errors: [{ code: "result_too_large" }] }), {
              status: 413,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (u === "https://cdn.example.com/big-photo.png") {
            assert.equal(init.redirect, "error");
            return new Response(TINY_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
          }
          if (u === "https://remove.ac/v1.0/removebg/ticket") {
            return Response.json({
              data: {
                ticket: "mcp_413_ticket",
                directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
              },
            });
          }
          if (u === "https://api.remove.ac/v1.0/direct-cutout") {
            return new Response(Buffer.from("MCP_413_OK"), {
              status: 200,
              headers: { "Content-Type": "image/png", "X-Width": "4000", "X-Height": "3000", "X-Credits-Charged": "1" },
            });
          }
          return new Response("unexpected", { status: 500 });
        },
      });

    const okRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 601,
        method: "tools/call",
        params: {
          name: "remove_background_url",
          arguments: {
            imageUrl: "https://cdn.example.com/big-photo.png",
            outputPath: outOk,
          },
        },
      },
      fallbackClientFactory,
      { lookup: publicLookup },
    );
    assert.equal(okRes.result.isError, undefined);
    const body = JSON.parse(okRes.result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.width, 4000);
    assert.equal(fs.readFileSync(outOk, "utf8"), "MCP_413_OK");
    assert.deepEqual(calls, [
      "https://remove.ac/v1.0/removebg",
      "https://cdn.example.com/big-photo.png",
      "https://remove.ac/v1.0/removebg/ticket",
      "https://api.remove.ac/v1.0/direct-cutout",
    ]);

    // Untrusted *.modal.run directEndpoint must be rejected with 0 direct uploads
    let evilUploads = 0;
    const evilClientFactory = () =>
      new RemoveAcClient({
        apiKey: "rac_live_mcp_413",
        lookup: publicLookup,
        fetch: async (url) => {
          const u = String(url);
          if (u === "https://remove.ac/v1.0/removebg") return new Response("too large", { status: 413 });
          if (u === "https://cdn.example.com/big-photo.png") {
            return new Response(TINY_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
          }
          if (u === "https://remove.ac/v1.0/removebg/ticket") {
            return Response.json({
              data: {
                ticket: "tkt_evil",
                directEndpoint: "https://evil.modal.run/v1.0/direct-cutout",
              },
            });
          }
          evilUploads += 1;
          return new Response("SHOULD_NOT_HIT", { status: 200 });
        },
      });

    const badRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 602,
        method: "tools/call",
        params: {
          name: "remove_background_url",
          arguments: {
            imageUrl: "https://cdn.example.com/big-photo.png",
            outputPath: path.join(sandbox, "should-not-exist.png"),
          },
        },
      },
      evilClientFactory,
      { lookup: publicLookup },
    );
    assert.equal(badRes.result.isError, true);
    assert.match(badRes.result.content[0].text, /untrusted host/i);
    assert.equal(evilUploads, 0);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
