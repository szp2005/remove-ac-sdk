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
} from "../node/index.mjs";
import {
  deriveSubIdempotencyKey as deriveCliSubKey,
  parseArgs as parseCliArgs,
  processImageBuffer,
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
