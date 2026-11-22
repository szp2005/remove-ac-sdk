import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveSubIdempotencyKey,
  parseImageDimensions,
  RemoveAcClient,
  RemoveAcError,
  removeBackgroundFromImageUrl,
  SDK_VERSION,
  USER_AGENT,
  VALID_SIZES,
} from "../node/index.mjs";
import {
  fetchPinnedResponseBytes,
  validateDirectEndpointUrl,
  validateRemoteImageUrl,
} from "../node/net-safety.mjs";
import {
  CLI_VERSION,
  deriveSubIdempotencyKey as deriveCliSubKey,
  extensionFromContentType,
  parseArgs as parseCliArgs,
  processImageBuffer,
  processSingleFile,
  resolveDestPath,
  runBatchPool,
  USER_AGENT as CLI_USER_AGENT,
  VALID_SIZES as CLI_VALID_SIZES,
  writeFileAtomicallyNoSymlink,
} from "../bin/remove-ac-cli.mjs";

const cliBinPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/remove-ac-cli.mjs");

test("RemoveAcClient calls /v1.0/removebg for standard inputs", async () => {
  const calls = [];
  const client = new RemoveAcClient({
    apiKey: "rac_live_test_example",
    baseUrl: "https://remove.ac",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Width": "1024",
          "X-Height": "768",
          "X-Credits-Charged": "1",
        },
      });
    },
  });

  const res = await client.removeBackground(new Uint8Array([1, 2, 3]), {
    size: "full",
    shadowType: "contact",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://remove.ac/v1.0/removebg");
  assert.equal(calls[0].init.headers["X-Api-Key"], "rac_live_test_example");
  assert.equal(res.width, 1024);
  assert.equal(res.height, 768);
  assert.equal(res.creditsCharged, 1);
  assert.equal(res.buffer[0], 0x89);
});

test("RemoveAcClient automatically upgrades >4 MB payloads to zero-disk direct cutout tickets", async () => {
  const calls = [];
  const largeBuffer = Buffer.alloc(4 * 1024 * 1024 + 64, 0x42);
  const client = new RemoveAcClient({
    apiKey: "rac_live_test_example",
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/v1.0/removebg/ticket")) {
        return Response.json({
          data: {
            ticket: "signed_ticket_token",
            directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
          },
        });
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });

  const res = await client.removeBackground(largeBuffer, { size: "full" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://remove.ac/v1.0/removebg/ticket");
  assert.equal(calls[1].url, "https://api.remove.ac/v1.0/direct-cutout");
  assert.equal(calls[1].init.headers.Authorization, "Bearer signed_ticket_token");
  assert.equal(res.creditsCharged, 1);
});

test("RemoveAcClient rejects missing API keys and removeBackgroundFromImageUrl returns base64", async () => {
  const noKey = new RemoveAcClient({ apiKey: "" });
  await assert.rejects(() => noKey.removeBackground(new Uint8Array([1])), RemoveAcError);

  const out = await removeBackgroundFromImageUrl({
    apiKey: "rac_live_test_example",
    url: "https://example.com/item.jpg",
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () =>
      new Response(Buffer.from("PNGDATA"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
  });
  assert.equal(out.base64img, Buffer.from("PNGDATA").toString("base64"));
});

test("A1: High-MP (<4 MB) PNG/JPEG pre-flights directly to /v1.0/removebg/ticket without hitting proxy", async () => {
  // Minimal 24-byte PNG header declaring 6000x4000 (24 MP)
  const png24Mp = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(png24Mp, 0);
  png24Mp.write("IHDR", 12, "ascii");
  png24Mp.writeUInt32BE(6000, 16);
  png24Mp.writeUInt32BE(4000, 20);
  assert.deepEqual(parseImageDimensions(png24Mp), { width: 6000, height: 4000 });

  const calls = [];
  const client = new RemoveAcClient({
    apiKey: "rac_live_test_example",
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/v1.0/removebg/ticket")) {
        return Response.json({
          data: {
            ticket: "tkt_24mp",
            directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
          },
        });
      }
      return new Response(Buffer.from("DIRECT_PNG"), {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });
  const res = await client.removeBackground(png24Mp, { size: "auto", format: "png" });
  assert.equal(res.buffer.toString("utf8"), "DIRECT_PNG");
  assert.deepEqual(calls, [
    "https://remove.ac/v1.0/removebg/ticket",
    "https://api.remove.ac/v1.0/direct-cutout",
  ]);
});

test("A2: CLI generates fresh Idempotency-Key per invocation unless --idempotency-key is supplied", async () => {
  const seenIdem = [];
  const mockFetch = async (_url, init) => {
    seenIdem.push(init.headers["Idempotency-Key"]);
    return new Response(Buffer.from("OK"), {
      status: 200,
      headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
    });
  };
  const opts = parseCliArgs(["sample.png", "--api-key", "rac_live_mock"]);
  await processImageBuffer({
    bytes: Buffer.from("same-bytes"),
    fileName: "sample.png",
    mimeType: "image/png",
    opts,
    baseUrl: "https://remove.ac",
    fetchImpl: mockFetch,
  });
  await processImageBuffer({
    bytes: Buffer.from("same-bytes"),
    fileName: "sample.png",
    mimeType: "image/png",
    opts,
    baseUrl: "https://remove.ac",
    fetchImpl: mockFetch,
  });
  assert.equal(seenIdem.length, 2);
  assert.notEqual(seenIdem[0], seenIdem[1]);
});

test("A1-1 & A2-1 R2: parseImageDimensions(ArrayBuffer), <=255-char sub-idempotency keys, and CLI --watch/batch rejection", async () => {
  const pngBuf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(pngBuf, 0);
  pngBuf.write("IHDR", 12, "ascii");
  pngBuf.writeUInt32BE(2500, 16);
  pngBuf.writeUInt32BE(3000, 20);
  const rawArrayBuffer = pngBuf.buffer.slice(pngBuf.byteOffset, pngBuf.byteOffset + pngBuf.byteLength);
  assert.deepEqual(parseImageDimensions(rawArrayBuffer), { width: 2500, height: 3000 });

  const long250 = "k".repeat(250);
  const derivedSdk = deriveSubIdempotencyKey(long250, "fallback413");
  const derivedCli = deriveCliSubKey(long250, "fallback413");
  assert.ok(derivedSdk.length <= 255, `Expected <=255, got ${derivedSdk.length}`);
  assert.equal(derivedSdk, derivedCli);
  assert.throws(() => deriveSubIdempotencyKey("k".repeat(256), "direct"), RemoveAcError);
  assert.throws(() => parseCliArgs(["a.png", "--idempotency-key", "--direct"]), /requires a non-empty/);
  assert.throws(() => parseCliArgs(["a.png", "--idempotency-key", "x".repeat(256)]), /255 characters/);

  const tempBase = fs.existsSync("/Volumes/Expansion/dev-tools/build-temp")
    ? "/Volumes/Expansion/dev-tools/build-temp"
    : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tempBase, "rac-cli-r2-"));
  try {
    const f1 = path.join(tmpDir, "one.png");
    const f2 = path.join(tmpDir, "two.png");
    fs.writeFileSync(f1, pngBuf);
    fs.writeFileSync(f2, pngBuf);

    const watchRun = spawnSync(
      process.execPath,
      [cliBinPath, tmpDir, "--output-dir", tmpDir, "--watch", "--api-key", "rac_live_x", "--idempotency-key", "fixed-1"],
      { encoding: "utf8" },
    );
    assert.equal(watchRun.status, 2);
    assert.match(watchRun.stderr, /--idempotency-key cannot be used with --watch/);

    const batchRun = spawnSync(
      process.execPath,
      [cliBinPath, f1, f2, "--output-dir", tmpDir, "--api-key", "rac_live_x", "--idempotency-key", "fixed-2"],
      { encoding: "utf8" },
    );
    assert.equal(batchRun.status, 2);
    assert.match(batchRun.stderr, /--idempotency-key can only be used with a single input file/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MF-1 & MF-2: Node SDK and CLI block 3xx redirects without leaking X-Api-Key and reject unsafe directEndpoint URLs", async () => {
  const http = await import("node:http");
  let leakHits = 0;
  const leakServer = http.createServer((_req, res) => {
    leakHits += 1;
    res.writeHead(200);
    res.end("LEAKED");
  });
  await new Promise((r) => leakServer.listen(0, "127.0.0.1", r));
  const leakPort = leakServer.address().port;

  const redirServer = http.createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${leakPort}/steal` });
    res.end();
  });
  await new Promise((r) => redirServer.listen(0, "127.0.0.1", r));
  const redirPort = redirServer.address().port;

  try {
    const client = new RemoveAcClient({
      apiKey: "rac_live_secret_do_not_leak",
      baseUrl: `http://127.0.0.1:${redirPort}`,
    });
    await assert.rejects(() => client.getAccount(), (err) => {
      assert.ok(err instanceof RemoveAcError);
      assert.equal(err.statusCode, 302);
      return true;
    });
    await assert.rejects(() => client.removeBackground(Buffer.from([1, 2, 3])), RemoveAcError);
    assert.equal(leakHits, 0, "Redirect target must receive 0 requests");

    const cliOpts = parseCliArgs(["sample.png", "--api-key", "rac_live_secret_do_not_leak"]);
    const cliRedir = await processImageBuffer({
      bytes: Buffer.from("abc"),
      fileName: "sample.png",
      mimeType: "image/png",
      opts: cliOpts,
      baseUrl: `http://127.0.0.1:${redirPort}`,
    });
    assert.equal(cliRedir.ok, false);
    assert.equal(leakHits, 0, "CLI must not follow 307 redirect");
  } finally {
    redirServer.close();
    leakServer.close();
  }

  // MF-2: Unsafe or missing directEndpoint in /v1.0/removebg/ticket must fail closed with 0 upload calls
  const badDirectEndpoints = [
    null,
    "http://gpu.remove.ac/v1.0/direct-cutout",
    "https://127.0.0.1/v1.0/direct-cutout",
    "https://[::ffff:169.254.169.254]/latest/meta-data",
    "https://rebind.example.com/v1.0/direct-cutout",
    "https://api.remove.ac/v1.0/direct-cutout",
  ];

  for (const badEp of badDirectEndpoints) {
    const seenUrls = [];
    const sdkClient = new RemoveAcClient({
      apiKey: "rac_live_test",
      baseUrl: "https://remove.ac",
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
      fetch: async (url, init) => {
        seenUrls.push(String(url));
        assert.equal(init.redirect, "error");
        return Response.json({
          data: {
            ticket: "tok_test",
            ...(badEp ? { directEndpoint: badEp } : {}),
          },
        });
      },
    });
    await assert.rejects(
      () => sdkClient.removeBackground(Buffer.from("small"), { direct: true }),
      (err) => err instanceof RemoveAcError && err.statusCode === 502,
    );
    assert.equal(seenUrls.length, 1, `Expected 0 upload requests for bad directEndpoint=${badEp}`);

    const cliCalls = [];
    const cliRes = await processImageBuffer({
      bytes: Buffer.from("small"),
      fileName: "a.png",
      mimeType: "image/png",
      opts: parseCliArgs(["a.png", "--api-key", "rac_live_test", "--direct"]),
      baseUrl: "https://remove.ac",
      lookupFn: async () => [{ address: "10.0.0.5", family: 4 }],
      fetchImpl: async (url, init) => {
        cliCalls.push(String(url));
        assert.equal(init.redirect, "error");
        return Response.json({
          data: {
            ticket: "tok_cli",
            ...(badEp ? { directEndpoint: badEp } : {}),
          },
        });
      },
    });
    assert.equal(cliRes.ok, false);
    assert.equal(cliRes.status, 502);
    assert.equal(cliCalls.length, 1);
  }
});

test("v1.3.0 MF-01, MF-05 & MF-06: User-Agent, enum guards, 25mp/50mp preflight, CLI --flag=value/--concurrency/--version, and ticket hold release", async () => {
  assert.equal(SDK_VERSION, "1.3.1");
  assert.equal(USER_AGENT, "remove-ac-node-sdk/1.3.1");
  assert.equal(CLI_VERSION, "1.3.1");
  assert.equal(CLI_USER_AGENT, "remove-ac-cli/1.3.1");
  assert.ok(VALID_SIZES.includes("25mp") && VALID_SIZES.includes("50mp"));
  assert.deepEqual(VALID_SIZES, CLI_VALID_SIZES);

  // CLI --version / -v
  const verRun = spawnSync(process.execPath, [cliBinPath, "--version"], { encoding: "utf8" });
  assert.equal(verRun.status, 0);
  assert.equal(verRun.stdout.trim(), "1.3.1");

  // Exact README Section 3 invocations parse cleanly
  const readmeBatch = parseCliArgs([
    "./input-photos",
    "--output-dir",
    "./output-pngs",
    "--concurrency=4",
    "--size=50mp",
  ]);
  assert.deepEqual(readmeBatch.inputs, ["./input-photos"]);
  assert.equal(readmeBatch.outputDir, "./output-pngs");
  assert.equal(readmeBatch.concurrency, 4);
  assert.equal(readmeBatch.size, "50mp");

  const readmeWatch = parseCliArgs([
    "./incoming",
    "--output-dir",
    "./cutouts",
    "--watch",
    "--format=webp",
    "--crop",
  ]);
  assert.deepEqual(readmeWatch.inputs, ["./incoming"]);
  assert.equal(readmeWatch.outputDir, "./cutouts");
  assert.equal(readmeWatch.watch, true);
  assert.equal(readmeWatch.format, "webp");
  assert.equal(readmeWatch.crop, true);

  // Upfront enum validation in CLI and Node SDK (0 HTTP calls)
  assert.throws(() => parseCliArgs(["a.png", "--size=999mp"]), /Unsupported --size/);
  assert.throws(() => parseCliArgs(["a.png", "--format=../bad"]), /Unsupported --format/);
  assert.throws(() => parseCliArgs(["a.png", "--concurrency=0"]), /--concurrency must be an integer/);
  assert.throws(() => parseCliArgs(["a.png", "--concurrency=99"]), /--concurrency must be an integer/);

  let invalidHits = 0;
  const guardClient = new RemoveAcClient({
    apiKey: "rac_live_test",
    fetch: async () => {
      invalidHits += 1;
      return new Response("unexpected");
    },
  });
  for (const badOpts of [
    { size: "999mp" },
    { format: "bmp" },
    { channels: "cmyk" },
    { type: "spaceship" },
    { shadowType: "neon" },
  ]) {
    await assert.rejects(
      () => guardClient.removeBackground(Buffer.from([1, 2, 3]), badOpts),
      (err) => err instanceof RemoveAcError && err.statusCode === 400,
    );
  }
  assert.equal(invalidHits, 0);

  // 20 MP PNG (5000x4000) with crop: true -> stays direct on 4k (<= 10 MP), upgrades to ticket on 25mp & 50mp
  const png20Mp = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(png20Mp, 0);
  png20Mp.write("IHDR", 12, "ascii");
  png20Mp.writeUInt32BE(5000, 16);
  png20Mp.writeUInt32BE(4000, 20);

  const traceTier = async (sizeTier) => {
    const sdkTrace = [];
    const cliTrace = [];
    const mockHandler = (bucket) => async (url, init) => {
      bucket.push({ url: String(url), ua: init.headers["User-Agent"] });
      if (String(url).endsWith("/v1.0/removebg/ticket")) {
        return Response.json({
          data: {
            ticket: `tkt_${sizeTier}`,
            directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
          },
        });
      }
      return new Response(Buffer.from("PNG_OK"), {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    };

    const c = new RemoveAcClient({
      apiKey: "rac_live_test",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: mockHandler(sdkTrace),
    });
    await c.removeBackground(png20Mp, { size: sizeTier, crop: true });

    await processImageBuffer({
      bytes: png20Mp,
      fileName: "item.png",
      mimeType: "image/png",
      opts: parseCliArgs(["item.png", `--size=${sizeTier}`, "--crop", "--api-key=rac_live_test"]),
      baseUrl: "https://remove.ac",
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: mockHandler(cliTrace),
    });

    for (const item of sdkTrace) assert.equal(item.ua, "remove-ac-node-sdk/1.3.1");
    for (const item of cliTrace) assert.equal(item.ua, "remove-ac-cli/1.3.1");
    return { sdkUrls: sdkTrace.map((x) => x.url), cliUrls: cliTrace.map((x) => x.url) };
  };

  const t4k = await traceTier("4k");
  assert.deepEqual(t4k.sdkUrls, ["https://remove.ac/v1.0/removebg"]);
  assert.deepEqual(t4k.cliUrls, ["https://remove.ac/v1.0/removebg"]);

  for (const hiTier of ["25mp", "50mp"]) {
    const tHi = await traceTier(hiTier);
    assert.deepEqual(tHi.sdkUrls, [
      "https://remove.ac/v1.0/removebg/ticket",
      "https://api.remove.ac/v1.0/direct-cutout",
    ]);
    assert.deepEqual(tHi.cliUrls, [
      "https://remove.ac/v1.0/removebg/ticket",
      "https://api.remove.ac/v1.0/direct-cutout",
    ]);
  }

  // Bounded worker pool concurrency check
  let active = 0;
  let maxObserved = 0;
  const poolFailed = await runBatchPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    active += 1;
    if (active > maxObserved) maxObserved = active;
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    return item !== 5;
  });
  assert.equal(poolFailed, 1);
  assert.ok(maxObserved <= 3 && maxObserved >= 2, `Expected concurrency 2..3, got ${maxObserved}`);

  // MF-06: Best-effort POST /v1.0/removebg/ticket/release on directEndpoint validation or upload failure
  const releasePayloads = [];
  const failClient = new RemoveAcClient({
    apiKey: "rac_live_hold_test",
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v1.0/removebg/ticket")) {
        return Response.json({
          data: {
            ticket: "tkt_hold_1",
            directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
            holdId: "hold_node_1",
            releaseToken: "rel_node_secret_1",
          },
        });
      }
      if (u.endsWith("/v1.0/removebg/ticket/release")) {
        releasePayloads.push(JSON.parse(init.body));
        return Response.json({ ok: true });
      }
      throw new Error("simulated network reset during 25MB upload");
    },
  });
  await assert.rejects(
    () => failClient.removeBackground(Buffer.from("bytes"), { direct: true }),
    /simulated network reset/,
  );
  assert.deepEqual(releasePayloads, [{ holdId: "hold_node_1", releaseToken: "rel_node_secret_1" }]);

  const cliReleasePayloads = [];
  const cliFailOut = await processImageBuffer({
    bytes: Buffer.from("bytes"),
    fileName: "x.png",
    mimeType: "image/png",
    opts: parseCliArgs(["x.png", "--direct", "--api-key=rac_live_hold_test"]),
    baseUrl: "https://remove.ac",
    lookupFn: async () => [{ address: "10.0.0.9", family: 4 }],
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v1.0/removebg/ticket")) {
        return Response.json({
          data: {
            ticket: "tkt_cli_hold",
            directEndpoint: "https://rebind.example.com/v1.0/direct-cutout",
            holdId: "hold_cli_1",
            releaseToken: "rel_cli_secret_1",
          },
        });
      }
      if (u.endsWith("/v1.0/removebg/ticket/release")) {
        cliReleasePayloads.push(JSON.parse(init.body));
        return Response.json({ ok: true });
      }
      return new Response("unexpected", { status: 500 });
    },
  });
  assert.equal(cliFailOut.ok, false);
  assert.equal(cliFailOut.status, 502);
  assert.deepEqual(cliReleasePayloads, [{ holdId: "hold_cli_1", releaseToken: "rel_cli_secret_1" }]);
});

test("v1.3.0 bgImageFile, bgImageFileB64, combined >4 MB ticket routing, mutual exclusion, and submitImprove", async () => {
  const crypto = await import("node:crypto");
  const tempBase = fs.existsSync("/Volumes/Expansion/dev-tools/build-temp")
    ? "/Volumes/Expansion/dev-tools/build-temp"
    : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tempBase, "rac-sdk-v130-"));

  try {
    const bgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const bgPath = path.join(tmpDir, "backdrop.png");
    fs.writeFileSync(bgPath, bgBytes);

    // 1. Mutual exclusion & invalid bgImageFile checks with 0 HTTP calls
    let blockedCalls = 0;
    const guardClient = new RemoveAcClient({
      apiKey: "rac_live_guard",
      fetch: async () => {
        blockedCalls += 1;
        return new Response("unexpected");
      },
    });
    for (const badOpts of [
      { bgColor: "FFFFFF", bgImageFile: bgBytes },
      { bgImageUrl: "https://example.com/bg.jpg", bgImageFile: bgPath },
      { bgColor: "000000", bgImageFileB64: bgBytes.toString("base64") },
      { bgImageFile: bgBytes, bgImageFileB64: bgBytes.toString("base64") },
      { bgImageFile: Buffer.alloc(0) },
      { bgImageFile: "" },
      { bgImageFile: "https://example.com/not-local.png" },
      { bgImageFileB64: "   " },
      { bgImageFileB64: "!!!not-base64!!!" },
    ]) {
      await assert.rejects(
        () => guardClient.removeBackground(Buffer.from([1, 2, 3]), badOpts),
        (err) => err instanceof RemoveAcError && err.statusCode === 400,
      );
    }
    await assert.rejects(
      () =>
        guardClient.removeBackground(Buffer.from([1, 2, 3]), {
          bgImageFile: Buffer.alloc(25 * 1024 * 1024 + 1, 0x11),
        }),
      (err) => err instanceof RemoveAcError && err.statusCode === 413,
    );
    assert.equal(blockedCalls, 0);

    // 2. Sync /v1.0/removebg multipart with bgImageFile (path, Uint8Array subarray, ArrayBuffer) and bgImageFileB64
    const seenSyncForms = [];
    const syncClient = new RemoveAcClient({
      apiKey: "rac_live_sync",
      fetch: async (url, init) => {
        assert.equal(String(url), "https://remove.ac/v1.0/removebg");
        seenSyncForms.push(init.body);
        return new Response(Buffer.from("CUTOUT_OK"), {
          status: 200,
          headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
        });
      },
    });

    await syncClient.removeBackground(Buffer.from("fg1"), { bgImageFile: bgPath });
    const paddedU8 = new Uint8Array([99, ...bgBytes, 88]);
    await syncClient.removeBackground(Buffer.from("fg2"), {
      bgImageFile: paddedU8.subarray(1, 1 + bgBytes.length),
    });
    const ab = bgBytes.buffer.slice(bgBytes.byteOffset, bgBytes.byteOffset + bgBytes.byteLength);
    await syncClient.removeBackground(Buffer.from("fg3"), { bgImageFile: ab });
    await syncClient.removeBackground(Buffer.from("fg4"), {
      bgImageFileB64: bgBytes.toString("base64"),
    });

    assert.equal(seenSyncForms.length, 4);
    for (let i = 0; i < 3; i++) {
      const bgBlob = seenSyncForms[i].get("bg_image_file");
      assert.ok(bgBlob instanceof Blob);
      assert.deepEqual(Buffer.from(await bgBlob.arrayBuffer()), bgBytes);
    }
    assert.equal(seenSyncForms[0].get("bg_image_file").name, "backdrop.png");
    assert.equal(seenSyncForms[3].get("bg_image_file_b64"), bgBytes.toString("base64"));

    // 3. Combined foreground (2.5 MB) + bgImageFile (2.5 MB) > 4 MB routes automatically via /v1.0/removebg/ticket
    const fg25 = Buffer.alloc(Math.floor(2.5 * 1024 * 1024), 0xaa);
    const bg25 = Buffer.alloc(Math.floor(2.5 * 1024 * 1024), 0xbb);
    const expectedFgSha = crypto.createHash("sha256").update(fg25).digest("hex");
    const expectedBgSha = crypto.createHash("sha256").update(bg25).digest("hex");

    let capturedTicketBody = null;
    let capturedDirectForm = null;
    const ticketClient = new RemoveAcClient({
      apiKey: "rac_live_ticket_bg",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url, init) => {
        if (String(url).endsWith("/v1.0/removebg/ticket")) {
          capturedTicketBody = JSON.parse(init.body);
          return Response.json({
            data: {
              ticket: "tkt_combined_bg",
              directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
            },
          });
        }
        assert.equal(String(url), "https://api.remove.ac/v1.0/direct-cutout");
        assert.equal(init.headers.Authorization, "Bearer tkt_combined_bg");
        capturedDirectForm = init.body;
        return new Response(Buffer.from("DIRECT_BG_OK"), {
          status: 200,
          headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
        });
      },
    });

    const tOut = await ticketClient.removeBackground(fg25, { bgImageFile: bg25, size: "50mp" });
    assert.equal(tOut.buffer.toString("utf8"), "DIRECT_BG_OK");
    assert.equal(capturedTicketBody.foregroundSha256, expectedFgSha);
    assert.equal(capturedTicketBody.foregroundByteLength, fg25.byteLength);
    assert.equal(capturedTicketBody.bgImageSha256, expectedBgSha);
    assert.equal(capturedTicketBody.bgImageByteLength, bg25.byteLength);
    assert.equal((await capturedDirectForm.get("image_file").arrayBuffer()).byteLength, fg25.byteLength);
    assert.equal((await capturedDirectForm.get("bg_image_file").arrayBuffer()).byteLength, bg25.byteLength);

    // 4. submitImprove supports local file path, bytes, and image_url with tag & description
    const improveCalls = [];
    const improveClient = new RemoveAcClient({
      apiKey: "rac_live_improve",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url, init) => {
        improveCalls.push({ url: String(url), headers: init.headers, body: init.body });
        return Response.json({ data: { id: `imp_${improveCalls.length}`, status: "received" } });
      },
    });

    const imp1 = await improveClient.submitImprove(bgPath, {
      tag: "hair-edge",
      description: "Fine flyaway strands against studio backdrop",
    });
    assert.equal(imp1.id, "imp_1");
    assert.equal(imp1.status, "received");
    assert.equal(improveCalls[0].url, "https://remove.ac/v1.0/improve");
    assert.equal(improveCalls[0].headers["X-Api-Key"], "rac_live_improve");
    assert.equal(improveCalls[0].headers["User-Agent"], "remove-ac-node-sdk/1.3.1");
    assert.equal(improveCalls[0].body.get("tag"), "hair-edge");
    assert.equal(improveCalls[0].body.get("description"), "Fine flyaway strands against studio backdrop");
    assert.equal(improveCalls[0].body.get("image_file").name, "backdrop.png");

    const imp2 = await improveClient.submitImprove("https://example.com/hard-case.jpg", {
      tag: "glass",
    });
    assert.equal(imp2.id, "imp_2");
    assert.equal(improveCalls[1].body.get("image_url"), "https://example.com/hard-case.jpg");
    assert.equal(improveCalls[1].body.get("tag"), "glass");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R2 MF-01, MF-02 & MF-03: SSRF URL guards, submitImprove bounds, all-non-2xx hold release, <=30 MB combined envelope, and CLI --bg-image hardening", async () => {
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const png54Mp = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(png54Mp, 0);
  png54Mp.write("IHDR", 12, "ascii");
  png54Mp.writeUInt32BE(9000, 16);
  png54Mp.writeUInt32BE(6000, 20);

  // 1. MF-01: Upfront SSRF validation on submitImprove, removeBackground (image_url & bgImageUrl), and removeBackgroundFromImageUrl (0 HTTP calls)
  let ssrfHttpHits = 0;
  const ssrfClient = new RemoveAcClient({
    apiKey: "rac_live_ssrf_guard",
    lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    fetch: async () => {
      ssrfHttpHits += 1;
      return Response.json({ data: { id: "leaked", status: "accepted" } });
    },
  });

  const disallowedUrls = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/internal.png",
    "http://[::ffff:127.0.0.1]/secret.png",
    "http://[64:ff9b::169.254.169.254]/secret.png",
    "http://100.64.0.1/cgnat.png",
    "http://localhost/admin.png",
    "http://service.internal/img.png",
    "http://2130706433/decimal.png",
    "http://0x7f000001/hex.png",
    "http://user:pass@example.com/private.png",
    "ftp://example.com/file.png",
    "file:///etc/passwd",
    "https://rebind.attacker.example/img.png",
  ];

  for (const badUrl of disallowedUrls) {
    await assert.rejects(
      () => ssrfClient.submitImprove(badUrl, { tag: "probe" }),
      (err) => err instanceof RemoveAcError && err.statusCode === 400,
    );
    await assert.rejects(
      () => ssrfClient.removeBackground(badUrl),
      (err) => err instanceof RemoveAcError && err.statusCode === 400,
    );
    await assert.rejects(
      () => ssrfClient.removeBackground(TINY_PNG, { bgImageUrl: badUrl }),
      (err) => err instanceof RemoveAcError && err.statusCode === 400,
    );
  }
  await assert.rejects(
    () =>
      removeBackgroundFromImageUrl({
        apiKey: "rac_live_ssrf_guard",
        url: "/etc/passwd",
        fetch: async () => {
          ssrfHttpHits += 1;
          return new Response(TINY_PNG);
        },
      }),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );

  // submitImprove tag (<=64), description (<=500), 0-byte, >25MB, and >50MP checks
  await assert.rejects(
    () => ssrfClient.submitImprove(TINY_PNG, { tag: "t".repeat(65) }),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  await assert.rejects(
    () => ssrfClient.submitImprove(TINY_PNG, { description: "d".repeat(501) }),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  await assert.rejects(
    () => ssrfClient.submitImprove(Buffer.alloc(0)),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  await assert.rejects(
    () => ssrfClient.submitImprove(Buffer.alloc(25 * 1024 * 1024 + 1, 0x22)),
    (err) => err instanceof RemoveAcError && err.statusCode === 413,
  );
  await assert.rejects(
    () => ssrfClient.submitImprove(png54Mp),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  assert.equal(ssrfHttpHits, 0, "All invalid URLs and bounds must fail before any HTTP call");

  // 2. MF-02: Combined >30 MB envelope rejected upfront (0 HTTP calls) + hold released on ALL non-2xx directEndpoint statuses
  let envelopeHits = 0;
  const envClient = new RemoveAcClient({
    apiKey: "rac_live_env",
    fetch: async () => {
      envelopeHits += 1;
      return new Response(TINY_PNG);
    },
  });
  await assert.rejects(
    () => envClient.removeBackground(Buffer.alloc(0)),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  await assert.rejects(
    () => envClient.removeBackground(Buffer.alloc(25 * 1024 * 1024 + 1, 0x11)),
    (err) => err instanceof RemoveAcError && err.statusCode === 413,
  );
  await assert.rejects(
    () => envClient.removeBackground(png54Mp),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  await assert.rejects(
    () => envClient.removeBackground(TINY_PNG, { bgImageFile: png54Mp }),
    (err) => err instanceof RemoveAcError && err.statusCode === 400,
  );
  await assert.rejects(
    () =>
      envClient.removeBackground(Buffer.alloc(18 * 1024 * 1024, 0xaa), {
        bgImageFile: Buffer.alloc(16 * 1024 * 1024, 0xbb),
      }),
    (err) => err instanceof RemoveAcError && err.statusCode === 413,
  );
  assert.equal(envelopeHits, 0);

  for (const status of [400, 401, 403, 413, 415, 422, 429, 500, 502, 503, 504]) {
    let sdkReleases = 0;
    const c = new RemoveAcClient({
      apiKey: "rac_live_hold_matrix",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url) => {
        const u = String(url);
        if (u.endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: `t_${status}`,
              directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
              holdId: `h_${status}`,
              releaseToken: `r_${status}`,
            },
          });
        }
        if (u.endsWith("/v1.0/removebg/ticket/release")) {
          sdkReleases += 1;
          return Response.json({ ok: true });
        }
        return new Response(`err_${status}`, { status });
      },
    });
    await assert.rejects(
      () => c.removeBackground(TINY_PNG, { direct: true }),
      (err) => err instanceof RemoveAcError && err.statusCode === status,
    );
    assert.equal(sdkReleases, 1, `Node SDK must release ticket hold on directEndpoint HTTP ${status}`);

    let cliReleases = 0;
    const cliOut = await processImageBuffer({
      bytes: TINY_PNG,
      fileName: "fg.png",
      mimeType: "image/png",
      opts: parseCliArgs(["fg.png", "--direct", "--api-key=rac_live_hold_matrix"]),
      baseUrl: "https://remove.ac",
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: `tc_${status}`,
              directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
              holdId: `hc_${status}`,
              releaseToken: `rc_${status}`,
            },
          });
        }
        if (u.endsWith("/v1.0/removebg/ticket/release")) {
          cliReleases += 1;
          return Response.json({ ok: true });
        }
        return new Response(`err_${status}`, { status });
      },
    });
    assert.equal(cliOut.ok, false);
    assert.equal(cliOut.status, status);
    assert.equal(cliReleases, 1, `CLI must release ticket hold on directEndpoint HTTP ${status}`);
  }

  // 3. MF-03: CLI --bg-color + --bg-image conflict, 0-byte/fake-magic/oversize/SSRF --bg-image, and processImageBuffer auto-resolving opts.bgImage
  assert.throws(
    () => parseCliArgs(["fg.png", "--bg-color", "ffffff", "--bg-image", "bg.png"]),
    /Cannot combine --bg-color and --bg-image/,
  );

  const tempBase = fs.existsSync("/Volumes/Expansion/dev-tools/build-temp")
    ? "/Volumes/Expansion/dev-tools/build-temp"
    : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tempBase, "rac-cli-mf03-"));
  try {
    const fgPath = path.join(tmpDir, "fg.png");
    const bgPath = path.join(tmpDir, "bg.png");
    const emptyBgPath = path.join(tmpDir, "empty.png");
    const fakePngPath = path.join(tmpDir, "disguised.png");
    const dotEnvPath = path.join(tmpDir, "secret.env");
    fs.writeFileSync(fgPath, TINY_PNG);
    fs.writeFileSync(bgPath, TINY_PNG);
    fs.writeFileSync(emptyBgPath, Buffer.alloc(0));
    fs.writeFileSync(fakePngPath, "SUPER_SECRET_TOKEN=12345\n");
    fs.writeFileSync(dotEnvPath, "SUPER_SECRET_TOKEN=12345\n");

    let cliNetHits = 0;
    const neverFetch = async () => {
      cliNetHits += 1;
      return new Response(TINY_PNG);
    };

    for (const badBg of [
      emptyBgPath,
      fakePngPath,
      dotEnvPath,
      "http://169.254.169.254/latest/meta-data",
      "https://rebind.attacker.example/bg.png",
    ]) {
      await assert.rejects(() =>
        processImageBuffer({
          bytes: TINY_PNG,
          fileName: "fg.png",
          mimeType: "image/png",
          opts: parseCliArgs(["fg.png", `--bg-image=${badBg}`, "--api-key=rac_live_cli"]),
          baseUrl: "https://remove.ac",
          lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
          fetchImpl: neverFetch,
        }),
      );
    }

    // Combined >30 MB via processImageBuffer
    const bigValidBgPath = path.join(tmpDir, "big-bg.png");
    fs.writeFileSync(bigValidBgPath, Buffer.concat([TINY_PNG, Buffer.alloc(16 * 1024 * 1024, 0)]));
    await assert.rejects(
      () =>
        processImageBuffer({
          bytes: Buffer.concat([TINY_PNG, Buffer.alloc(15 * 1024 * 1024, 0)]),
          fileName: "fg.png",
          mimeType: "image/png",
          opts: parseCliArgs(["fg.png", `--bg-image=${bigValidBgPath}`, "--api-key=rac_live_cli"]),
          baseUrl: "https://remove.ac",
          fetchImpl: neverFetch,
        }),
      /exceeds 30 MB/,
    );
    assert.equal(cliNetHits, 0);

    // Exported processImageBuffer resolves opts.bgImage automatically when bgInput is omitted
    let sawBgFilePart = false;
    const okOut = await processImageBuffer({
      bytes: TINY_PNG,
      fileName: "fg.png",
      mimeType: "image/png",
      opts: parseCliArgs(["fg.png", `--bg-image=${bgPath}`, "--api-key=rac_live_cli"]),
      baseUrl: "https://remove.ac",
      fetchImpl: async (_url, init) => {
        const bgPart = init.body.get("bg_image_file");
        sawBgFilePart = bgPart instanceof Blob && bgPart.type === "image/png";
        return new Response(TINY_PNG, {
          status: 200,
          headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
        });
      },
    });
    assert.equal(okOut.ok, true);
    assert.equal(sawBgFilePart, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("M-P1-07: allowTunFakeIp rejects 198.18.0.0/15 on arbitrary & HTTP domains with default lookup and allows only https://remove.ac / *.remove.ac", async () => {
  const origLookup = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: "198.18.0.42", family: 4 }];
  try {
    // Arbitrary external HTTPS & HTTP domains resolving to 198.18.x.x MUST be rejected with default lookup
    const evilHttpsErr = await validateRemoteImageUrl("https://evil.example.com/photo.png");
    assert.match(evilHttpsErr, /private, loopback, or reserved/i);

    const evilHttpErr = await validateRemoteImageUrl("http://internal-mesh.attacker.example/secret.png");
    assert.match(evilHttpErr, /private, loopback, or reserved/i);

    // Plain http://remove.ac MUST be rejected even with default lookup
    const httpRemoveAcErr = await validateRemoteImageUrl("http://remove.ac/photo.png");
    assert.match(httpRemoveAcErr, /private, loopback, or reserved/i);

    // Suffix-spoofed host MUST be rejected
    const spoofErr = await validateRemoteImageUrl("https://evil-remove.ac/photo.png");
    assert.match(spoofErr, /private, loopback, or reserved/i);

    // Literal 198.18.x.x MUST be rejected
    const literalErr = await validateRemoteImageUrl("https://198.18.0.42/photo.png");
    assert.match(literalErr, /private, loopback, or reserved/i);

    // First-party HTTPS remove.ac & *.remove.ac ARE allowed under default lookup (TUN Fake-IP compatibility)
    assert.equal(await validateRemoteImageUrl("https://remove.ac/v1.0/removebg"), null);
    assert.equal(await validateRemoteImageUrl("https://api.remove.ac/v1.0/direct-cutout"), null);

    // Explicit custom lookup returning 198.18.x.x MUST still be rejected even on https://remove.ac
    const customLookupErr = await validateRemoteImageUrl(
      "https://remove.ac/v1.0/removebg",
      async () => [{ address: "198.18.0.42", family: 4 }],
    );
    assert.match(customLookupErr, /private, loopback, or reserved/i);
  } finally {
    dns.promises.lookup = origLookup;
  }
});

test("M-P1-08: Strict directEndpoint hostname allowlist (rejects *.modal.run & arbitrary hosts; accepts remove.ac & configured baseUrl) + pinned remote fetch hardening", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  // 1. Direct validator matrix
  assert.equal(
    await validateDirectEndpointUrl("https://remove.ac/v1.0/direct-cutout", {
      baseUrl: "https://remove.ac",
      lookupFn: publicLookup,
    }),
    null,
  );
  assert.equal(
    await validateDirectEndpointUrl("https://edge.remove.ac/v1.0/direct-cutout", {
      baseUrl: "https://remove.ac",
      lookupFn: publicLookup,
    }),
    null,
  );
  assert.equal(
    await validateDirectEndpointUrl("https://gateway.corp.example/v1.0/direct-cutout", {
      baseUrl: "https://gateway.corp.example",
      lookupFn: publicLookup,
    }),
    null,
  );
  for (const rejectedEp of [
    "https://evil.modal.run/v1.0/direct-cutout",
    "https://tenant--gpu-app.modal.run/v1.0/direct-cutout",
    "https://gpu.example.invalid/v1.0/direct-cutout",
    "https://attacker.example.com/v1.0/direct-cutout",
    "https://evil-remove.ac/v1.0/direct-cutout",
    "https://remove.ac:8443/v1.0/direct-cutout",
  ]) {
    const err = await validateDirectEndpointUrl(rejectedEp, {
      baseUrl: "https://remove.ac",
      lookupFn: publicLookup,
    });
    assert.ok(err, `Expected directEndpoint rejection for ${rejectedEp}`);
  }
  const crossHostErr = await validateDirectEndpointUrl("https://other.corp.example/v1.0/direct-cutout", {
    baseUrl: "https://gateway.corp.example",
    lookupFn: publicLookup,
  });
  assert.match(crossHostErr, /untrusted host/i);

  // 2. SDK & CLI reject evil.modal.run and arbitrary hosts even on public IP and release ticket hold with 0 direct uploads
  for (const badHostEp of [
    "https://evil.modal.run/v1.0/direct-cutout",
    "https://gpu.example.invalid/v1.0/direct-cutout",
  ]) {
    let sdkDirectUploads = 0;
    let sdkReleases = 0;
    const client = new RemoveAcClient({
      apiKey: "rac_live_allowlist",
      lookup: publicLookup,
      fetch: async (url) => {
        const u = String(url);
        if (u.endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: "tkt_bad_host",
              directEndpoint: badHostEp,
              holdId: "hold_bad_host",
              releaseToken: "rel_bad_host",
            },
          });
        }
        if (u.endsWith("/v1.0/removebg/ticket/release")) {
          sdkReleases += 1;
          return Response.json({ ok: true });
        }
        sdkDirectUploads += 1;
        return new Response("SHOULD_NOT_UPLOAD", { status: 200 });
      },
    });
    await assert.rejects(
      () => client.removeBackground(TINY_PNG, { direct: true }),
      (err) => err instanceof RemoveAcError && err.statusCode === 502 && /untrusted host/i.test(err.message),
    );
    assert.equal(sdkDirectUploads, 0);
    assert.equal(sdkReleases, 1);

    let cliDirectUploads = 0;
    let cliReleases = 0;
    const cliRes = await processImageBuffer({
      bytes: TINY_PNG,
      fileName: "fg.png",
      mimeType: "image/png",
      opts: parseCliArgs(["fg.png", "--direct", "--api-key=rac_live_allowlist"]),
      baseUrl: "https://remove.ac",
      lookupFn: publicLookup,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: "tkt_cli_bad_host",
              directEndpoint: badHostEp,
              holdId: "hold_cli_bad_host",
              releaseToken: "rel_cli_bad_host",
            },
          });
        }
        if (u.endsWith("/v1.0/removebg/ticket/release")) {
          cliReleases += 1;
          return Response.json({ ok: true });
        }
        cliDirectUploads += 1;
        return new Response("SHOULD_NOT_UPLOAD", { status: 200 });
      },
    });
    assert.equal(cliRes.ok, false);
    assert.equal(cliRes.status, 502);
    assert.equal(cliDirectUploads, 0);
    assert.equal(cliReleases, 1);
  }

  // 3. Pinned Node HTTP transport enforces pinned IP, no redirects, maxBytes cap, and zero third-party error body leakage
  const http = await import("node:http");
  let seenHostHeader = "";
  const srv = http.createServer((req, res) => {
    seenHostHeader = req.headers.host || "";
    if (req.url === "/ok.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(TINY_PNG);
      return;
    }
    if (req.url === "/redir") {
      res.writeHead(302, { Location: "/ok.png" });
      res.end();
      return;
    }
    if (req.url === "/secret-error") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("AWS_SECRET_ACCESS_KEY=super_sensitive_leak");
      return;
    }
    if (req.url === "/oversize") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.alloc(2048, 0x41));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const pinnedOk = await fetchPinnedResponseBytes(
      new URL(`http://pinned-host.example:${port}/ok.png`),
      [{ address: "127.0.0.1", family: 4 }],
      { maxBytes: 1024, userAgent: USER_AGENT },
    );
    assert.deepEqual(pinnedOk, TINY_PNG);
    assert.equal(seenHostHeader, `pinned-host.example:${port}`);

    await assert.rejects(
      () =>
        fetchPinnedResponseBytes(
          new URL(`http://pinned-host.example:${port}/redir`),
          [{ address: "127.0.0.1", family: 4 }],
          { maxBytes: 1024 },
        ),
      (err) => err.statusCode === 302 && /redirects are disallowed/i.test(err.message),
    );

    await assert.rejects(
      () =>
        fetchPinnedResponseBytes(
          new URL(`http://pinned-host.example:${port}/secret-error`),
          [{ address: "127.0.0.1", family: 4 }],
          { maxBytes: 1024 },
        ),
      (err) =>
        err.statusCode === 502 &&
        !err.message.includes("AWS_SECRET_ACCESS_KEY") &&
        /HTTP 500/.test(err.message),
    );

    await assert.rejects(
      () =>
        fetchPinnedResponseBytes(
          new URL(`http://pinned-host.example:${port}/oversize`),
          [{ address: "127.0.0.1", family: 4 }],
          { maxBytes: 512 },
        ),
      (err) => err.statusCode === 413,
    );
  } finally {
    srv.close();
  }
});

test("M-P0-04: Node SDK URL mode automatically recovers from HTTP 413 via safe remote fetch + direct ticket fallback", async () => {
  const crypto = await import("node:crypto");
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const remoteJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
  const expectedSha = crypto.createHash("sha256").update(remoteJpeg).digest("hex");

  const calls = [];
  let ticketPayload = null;
  let ticketIdemHeader = "";
  let remoteReqHeaders = null;
  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ method: init.method || "GET", url: u });
    if (u === "https://remove.ac/v1.0/removebg") {
      return new Response(JSON.stringify({ errors: [{ code: "result_too_large" }] }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u === "https://cdn.example.com/12mp-product.jpg") {
      assert.equal(init.redirect, "error");
      remoteReqHeaders = init.headers;
      return new Response(remoteJpeg, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    if (u === "https://remove.ac/v1.0/removebg/ticket") {
      ticketPayload = JSON.parse(init.body);
      ticketIdemHeader = init.headers["Idempotency-Key"];
      return Response.json({
        data: {
          ticket: "tkt_url_413",
          directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
        },
      });
    }
    if (u === "https://api.remove.ac/v1.0/direct-cutout") {
      assert.equal(init.headers.Authorization, "Bearer tkt_url_413");
      const uploaded = Buffer.from(await init.body.get("image_file").arrayBuffer());
      assert.deepEqual(uploaded, remoteJpeg);
      return new Response(Buffer.from("CUTOUT_413_OK"), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Width": "4032",
          "X-Height": "3024",
          "X-Credits-Charged": "1",
        },
      });
    }
    return new Response("unexpected", { status: 500 });
  };

  const client = new RemoveAcClient({
    apiKey: "rac_live_url413",
    fetch: mockFetch,
    lookup: publicLookup,
  });
  const res = await client.removeBackground("https://cdn.example.com/12mp-product.jpg", {
    size: "full",
    idempotencyKey: "url-idem-1",
  });
  assert.equal(res.buffer.toString("utf8"), "CUTOUT_413_OK");
  assert.equal(res.width, 4032);
  assert.equal(res.height, 3024);
  assert.equal(res.creditsCharged, 1);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "POST https://remove.ac/v1.0/removebg",
      "GET https://cdn.example.com/12mp-product.jpg",
      "POST https://remove.ac/v1.0/removebg/ticket",
      "POST https://api.remove.ac/v1.0/direct-cutout",
    ],
  );
  assert.equal(ticketPayload.foregroundSha256, expectedSha);
  assert.equal(ticketPayload.foregroundByteLength, remoteJpeg.byteLength);
  assert.equal(ticketIdemHeader, "url-idem-1:fallback413");
  assert.equal(remoteReqHeaders["X-Api-Key"], undefined, "Never leak API key to third-party image host");
  assert.equal(remoteReqHeaders.Authorization, undefined);

  // removeBackgroundFromImageUrl helper also recovers cleanly from 413
  const helperOut = await removeBackgroundFromImageUrl({
    apiKey: "rac_live_url413",
    url: "https://cdn.example.com/12mp-product.jpg",
    fetch: mockFetch,
    lookup: publicLookup,
  });
  assert.equal(helperOut.base64img, Buffer.from("CUTOUT_413_OK").toString("base64"));

  // Negative cases on 413 remote fetch: redirect, error body leak, non-image magic bytes, >25 MB cap
  let ticketHits = 0;
  const makeNegClient = (remoteResponder) =>
    new RemoveAcClient({
      apiKey: "rac_live_neg",
      lookup: publicLookup,
      fetch: async (url) => {
        const u = String(url);
        if (u.endsWith("/v1.0/removebg")) return new Response("too large", { status: 413 });
        if (u.endsWith("/v1.0/removebg/ticket")) {
          ticketHits += 1;
          return Response.json({ data: { ticket: "bad", directEndpoint: "https://api.remove.ac/v1.0/direct-cutout" } });
        }
        return remoteResponder();
      },
    });

  await assert.rejects(
    () =>
      makeNegClient(() => new Response("", { status: 302, headers: { Location: "http://127.0.0.1/secret" } })).removeBackground(
        "https://cdn.example.com/redir.jpg",
      ),
    (err) => err instanceof RemoveAcError && err.statusCode === 302,
  );
  await assert.rejects(
    () =>
      makeNegClient(() => new Response("INTERNAL_DB_PASSWORD=topsecret", { status: 403 })).removeBackground(
        "https://cdn.example.com/forbidden.jpg",
      ),
    (err) =>
      err instanceof RemoveAcError &&
      err.statusCode === 502 &&
      !err.message.includes("INTERNAL_DB_PASSWORD"),
  );
  await assert.rejects(
    () =>
      makeNegClient(() => new Response("<html>not an image</html>", { status: 200 })).removeBackground(
        "https://cdn.example.com/fake.jpg",
      ),
    (err) => err instanceof RemoveAcError && err.statusCode === 400 && /valid PNG, JPEG, WebP, or GIF/i.test(err.message),
  );
  await assert.rejects(
    () =>
      makeNegClient(
        () => new Response(Buffer.alloc(16), { status: 200, headers: { "Content-Length": String(26 * 1024 * 1024) } }),
      ).removeBackground("https://cdn.example.com/huge.jpg"),
    (err) => err instanceof RemoveAcError && err.statusCode === 413,
  );
  // Also cap streaming responses with NO Content-Length header
  await assert.rejects(
    () =>
      makeNegClient(() => {
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent >= 26 * 1024 * 1024) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(1024 * 1024);
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, { status: 200 });
      }).removeBackground("https://cdn.example.com/huge-stream.jpg"),
    (err) => err instanceof RemoveAcError && err.statusCode === 413,
  );
  assert.equal(ticketHits, 0, "Invalid remote fetches must never mint a ticket");
});

test("M-P2-17: CLI --format=auto derives output extension from Content-Type, rejects symlinks via lstatSync, and writes atomically", async () => {
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

  assert.equal(extensionFromContentType("image/jpeg"), "jpg");
  assert.equal(extensionFromContentType("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionFromContentType("image/webp"), "webp");
  assert.equal(extensionFromContentType("application/zip"), "zip");
  assert.equal(extensionFromContentType("image/png"), "png");
  assert.equal(extensionFromContentType(""), "png");
  assert.equal(
    path.basename(resolveDestPath("/tmp/photo.png", { format: "auto", output: null, outputDir: null }, "image/jpeg")),
    "photo-nobg.jpg",
  );

  const tempBase = fs.existsSync("/Volumes/Expansion/dev-tools/build-temp")
    ? "/Volumes/Expansion/dev-tools/build-temp"
    : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tempBase, "rac-cli-p207-"));
  try {
    const inputPath = path.join(tmpDir, "product.png");
    fs.writeFileSync(inputPath, TINY_PNG);

    // 1. --format=auto + --bg-color ffffff returning image/jpeg writes product-nobg.jpg (NOT .png) with zero .tmp leftovers
    const outDir1 = path.join(tmpDir, "out-jpeg");
    const optsAuto = parseCliArgs([
      inputPath,
      "--format=auto",
      "--bg-color",
      "ffffff",
      "--output-dir",
      outDir1,
      "--api-key=rac_live_cli_auto",
    ]);
    const okJpg = await processSingleFile(inputPath, optsAuto, "https://remove.ac", null, {
      fetchImpl: async () =>
        new Response(FAKE_JPG, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "X-Credits-Charged": "1" },
        }),
    });
    assert.equal(okJpg, true);
    const jpgDest = path.join(outDir1, "product-nobg.jpg");
    assert.equal(fs.existsSync(jpgDest), true);
    assert.equal(fs.existsSync(path.join(outDir1, "product-nobg.png")), false);
    assert.deepEqual(fs.readFileSync(jpgDest), FAKE_JPG);
    assert.deepEqual(fs.readdirSync(outDir1), ["product-nobg.jpg"], "Atomic write must leave no temp files");

    // 2. --format=auto returning image/webp and application/zip
    for (const [ct, ext] of [
      ["image/webp; charset=binary", "webp"],
      ["application/zip", "zip"],
    ]) {
      const subDir = path.join(tmpDir, `out-${ext}`);
      const subOpts = parseCliArgs([
        inputPath,
        "--format=auto",
        "--output-dir",
        subDir,
        "--api-key=rac_live_cli_auto",
      ]);
      const ok = await processSingleFile(inputPath, subOpts, "https://remove.ac", null, {
        fetchImpl: async () =>
          new Response(Buffer.from(`PAYLOAD_${ext}`), {
            status: 200,
            headers: { "Content-Type": ct, "X-Credits-Charged": "1" },
          }),
      });
      assert.equal(ok, true);
      assert.equal(fs.readFileSync(path.join(subDir, `product-nobg.${ext}`), "utf8"), `PAYLOAD_${ext}`);
    }

    // 3. processImageBuffer returns contentType on both gateway and direct-ticket paths
    const directRes = await processImageBuffer({
      bytes: TINY_PNG,
      fileName: "product.png",
      mimeType: "image/png",
      opts: parseCliArgs(["product.png", "--direct", "--format=auto", "--api-key=rac_live_cli_auto"]),
      baseUrl: "https://remove.ac",
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        if (String(url).endsWith("/v1.0/removebg/ticket")) {
          return Response.json({
            data: {
              ticket: "tkt_cli_ct",
              directEndpoint: "https://api.remove.ac/v1.0/direct-cutout",
            },
          });
        }
        return new Response(FAKE_JPG, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "X-Credits-Charged": "1" },
        });
      },
    });
    assert.equal(directRes.ok, true);
    assert.equal(directRes.contentType, "image/jpeg");

    // 4. Rejects live & dangling symlinks via lstatSync (0 API calls for explicit/non-auto, and post-fetch block for --format=auto)
    const victimFile = path.join(tmpDir, "victim.txt");
    fs.writeFileSync(victimFile, "PROTECTED_CONTENT");

    const liveSymDir = path.join(tmpDir, "sym-live");
    fs.mkdirSync(liveSymDir);
    const liveSymDest = path.join(liveSymDir, "product-nobg.png");
    fs.symlinkSync(victimFile, liveSymDest);

    let symApiHits = 0;
    const okLiveSym = await processSingleFile(
      inputPath,
      parseCliArgs([inputPath, "--format=png", "--output-dir", liveSymDir, "--api-key=rac_live_sym"]),
      "https://remove.ac",
      null,
      {
        fetchImpl: async () => {
          symApiHits += 1;
          return new Response(TINY_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
        },
      },
    );
    assert.equal(okLiveSym, false);
    assert.equal(symApiHits, 0, "Pre-planted symlink destination must be rejected before API call");
    assert.equal(fs.readFileSync(victimFile, "utf8"), "PROTECTED_CONTENT");

    // Dangling symlink must also be rejected
    const danglingSym = path.join(tmpDir, "dangling-out.png");
    fs.symlinkSync(path.join(tmpDir, "does-not-exist.txt"), danglingSym);
    assert.throws(() => writeFileAtomicallyNoSymlink(danglingSym, TINY_PNG), /symbolic link/i);

    // Pre-planted .jpg symlink under --format=auto when server returns image/jpeg must be rejected without touching victim
    const autoSymDir = path.join(tmpDir, "sym-auto");
    fs.mkdirSync(autoSymDir);
    fs.symlinkSync(victimFile, path.join(autoSymDir, "product-nobg.jpg"));
    const okAutoSym = await processSingleFile(
      inputPath,
      parseCliArgs([inputPath, "--format=auto", "--output-dir", autoSymDir, "--api-key=rac_live_sym"]),
      "https://remove.ac",
      null,
      {
        fetchImpl: async () =>
          new Response(FAKE_JPG, { status: 200, headers: { "Content-Type": "image/jpeg" } }),
      },
    );
    assert.equal(okAutoSym, false);
    assert.equal(fs.readFileSync(victimFile, "utf8"), "PROTECTED_CONTENT");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
