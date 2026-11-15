import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  CLI_VERSION,
  deriveSubIdempotencyKey as deriveCliSubKey,
  parseArgs as parseCliArgs,
  processImageBuffer,
  runBatchPool,
  USER_AGENT as CLI_USER_AGENT,
  VALID_SIZES as CLI_VALID_SIZES,
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
            directEndpoint: "https://gpu.example.invalid/v1.0/direct-cutout",
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
  assert.equal(calls[1].url, "https://gpu.example.invalid/v1.0/direct-cutout");
  assert.equal(calls[1].init.headers.Authorization, "Bearer signed_ticket_token");
  assert.equal(res.creditsCharged, 1);
});

test("RemoveAcClient rejects missing API keys and removeBackgroundFromImageUrl returns base64", async () => {
  const noKey = new RemoveAcClient({ apiKey: "" });
  await assert.rejects(() => noKey.removeBackground(new Uint8Array([1])), RemoveAcError);

  const out = await removeBackgroundFromImageUrl({
    apiKey: "rac_live_test_example",
    url: "https://example.com/item.jpg",
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
            directEndpoint: "https://gpu.example.invalid/v1.0/direct-cutout",
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
    "https://gpu.example.invalid/v1.0/direct-cutout",
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

test("v1.2.0 MF-01, MF-05 & MF-06: User-Agent, enum guards, 25mp/50mp preflight, CLI --flag=value/--concurrency/--version, and ticket hold release", async () => {
  assert.equal(SDK_VERSION, "1.2.0");
  assert.equal(USER_AGENT, "remove-ac-node-sdk/1.2.0");
  assert.equal(CLI_VERSION, "1.2.0");
  assert.equal(CLI_USER_AGENT, "remove-ac-cli/1.2.0");
  assert.ok(VALID_SIZES.includes("25mp") && VALID_SIZES.includes("50mp"));
  assert.deepEqual(VALID_SIZES, CLI_VALID_SIZES);

  // CLI --version / -v
  const verRun = spawnSync(process.execPath, [cliBinPath, "--version"], { encoding: "utf8" });
  assert.equal(verRun.status, 0);
  assert.equal(verRun.stdout.trim(), "1.2.0");

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
            directEndpoint: "https://gpu.example.invalid/v1.0/direct-cutout",
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

    for (const item of sdkTrace) assert.equal(item.ua, "remove-ac-node-sdk/1.2.0");
    for (const item of cliTrace) assert.equal(item.ua, "remove-ac-cli/1.2.0");
    return { sdkUrls: sdkTrace.map((x) => x.url), cliUrls: cliTrace.map((x) => x.url) };
  };

  const t4k = await traceTier("4k");
  assert.deepEqual(t4k.sdkUrls, ["https://remove.ac/v1.0/removebg"]);
  assert.deepEqual(t4k.cliUrls, ["https://remove.ac/v1.0/removebg"]);

  for (const hiTier of ["25mp", "50mp"]) {
    const tHi = await traceTier(hiTier);
    assert.deepEqual(tHi.sdkUrls, [
      "https://remove.ac/v1.0/removebg/ticket",
      "https://gpu.example.invalid/v1.0/direct-cutout",
    ]);
    assert.deepEqual(tHi.cliUrls, [
      "https://remove.ac/v1.0/removebg/ticket",
      "https://gpu.example.invalid/v1.0/direct-cutout",
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
            directEndpoint: "https://gpu.example.invalid/v1.0/direct-cutout",
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
