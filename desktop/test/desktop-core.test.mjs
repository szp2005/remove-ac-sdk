import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CredentialManager,
  DesktopApiClient,
  collectInputItems,
  isPlausibleApiKey,
  maskApiKey,
  parseImageDimensions,
  resolveOutputTarget,
  runBatchQueue,
  sanitizeSettings,
  validateServiceEndpointUrl,
  writeFileAtomically,
} = require("../src/core.cjs");

function makeTinyPng(width = 4, height = 3) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, 0);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeFakeLargeHeaderPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    len,
    Buffer.from("IHDR", "ascii"),
    ihdr,
    Buffer.alloc(12),
  ]);
}

test("parseImageDimensions parses PNG headers accurately", () => {
  const png = makeTinyPng(19, 11);
  assert.deepEqual(parseImageDimensions(png), { width: 19, height: 11 });
  assert.equal(parseImageDimensions(Buffer.from("not-an-image")), null);
});

test("validateServiceEndpointUrl enforces strict HTTPS and first-party/GPU host allowlist", () => {
  assert.equal(
    validateServiceEndpointUrl("https://remove.ac/anything", { kind: "base" }),
    "https://remove.ac"
  );
  assert.equal(
    validateServiceEndpointUrl("https://worker.modal.run/cutout", { kind: "direct" }),
    "https://worker.modal.run/cutout"
  );

  // Reject Modal host as base API URL (prevent sending X-Api-Key to non-remove.ac hosts)
  assert.throws(
    () => validateServiceEndpointUrl("https://worker.modal.run", { kind: "base" }),
    /Refused untrusted base host/
  );
  // Reject arbitrary HTTPS host on directEndpoint
  assert.throws(
    () => validateServiceEndpointUrl("https://evil.example.com/upload", { kind: "direct" }),
    /Refused untrusted direct host/
  );
  // Reject plain HTTP unless loopback test flag is explicitly enabled
  assert.throws(
    () => validateServiceEndpointUrl("http://127.0.0.1:8787", { kind: "base", allowLoopback: false }),
    /must use HTTPS/
  );
  assert.equal(
    validateServiceEndpointUrl("http://127.0.0.1:8787/", { kind: "base", allowLoopback: true }),
    "http://127.0.0.1:8787"
  );
  // Reject embedded credentials and non-443 ports
  assert.throws(
    () => validateServiceEndpointUrl("https://user:pass@remove.ac", { kind: "base" }),
    /Credentials are not allowed/
  );
  assert.throws(
    () => validateServiceEndpointUrl("https://remove.ac:8443", { kind: "base" }),
    /Non-standard port/
  );
});

test("CredentialManager encrypts API keys via safeStorage and never writes plaintext keys", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rac-desk-cred-"));
  try {
    let keychainCalls = 0;
    const fakeSafeStorage = {
      isAsyncEncryptionAvailable: async () => {
        keychainCalls += 1;
        return true;
      },
      encryptString: (plain) => Buffer.from(`ENC:${plain}`, "utf8"),
      decryptString: (buf) => {
        const s = buf.toString("utf8");
        assert.ok(s.startsWith("ENC:"));
        return s.slice(4);
      },
    };
    const mgr = new CredentialManager({ storageDir: tmpDir, safeStorage: fakeSafeStorage });
    // Cold boot before credentials.json exists must NOT touch OS Keychain
    const coldStatus = await mgr.getKeyStatus();
    assert.equal(coldStatus.hasApiKey, false);
    assert.equal(keychainCalls, 0);

    assert.equal(isPlausibleApiKey("rac_live_AbCdEf123456"), true);
    assert.equal(isPlausibleApiKey("sk_invalid"), false);

    await assert.rejects(() => mgr.setApiKey("bad_key"), /must start with 'rac_live_'/);

    const saved = await mgr.setApiKey("rac_live_SecretToken9876");
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.persisted, true);
    assert.equal(saved.maskedKey, maskApiKey("rac_live_SecretToken9876"));
    assert.ok(!saved.maskedKey.includes("SecretToken"));

    const rawOnDisk = fs.readFileSync(path.join(tmpDir, "credentials.json"), "utf8");
    assert.ok(!rawOnDisk.includes("rac_live_SecretToken9876"));

    // Reload from fresh instance
    const mgr2 = new CredentialManager({ storageDir: tmpDir, safeStorage: fakeSafeStorage });
    assert.equal(await mgr2.getApiKey(), "rac_live_SecretToken9876");

    // When OS keyring is unavailable, keep key in session memory only (no disk write)
    const tmpNoKeyring = fs.mkdtempSync(path.join(os.tmpdir(), "rac-desk-nokeyring-"));
    const mgrNoEnc = new CredentialManager({
      storageDir: tmpNoKeyring,
      safeStorage: { isAsyncEncryptionAvailable: async () => false },
    });
    const sessionStatus = await mgrNoEnc.setApiKey("rac_live_SessionOnlyKey1234");
    assert.equal(sessionStatus.persisted, false);
    assert.equal(fs.existsSync(path.join(tmpNoKeyring, "credentials.json")), false);
    assert.equal(await mgrNoEnc.getApiKey(), "rac_live_SessionOnlyKey1234");
    fs.rmSync(tmpNoKeyring, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectInputItems & resolveOutputTarget preserve subfolders, skip output folders & avoid collisions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rac-desk-scan-"));
  try {
    const png = makeTinyPng(4, 4);
    fs.mkdirSync(path.join(tmpDir, "shoes", "sneakers"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "remove-ac-output"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "hero.png"), png);
    fs.writeFileSync(path.join(tmpDir, "hero.webp"), png);
    fs.writeFileSync(path.join(tmpDir, "shoes", "sneakers", "runner.jpg"), png);
    fs.writeFileSync(path.join(tmpDir, "remove-ac-output", "already-cut.png"), png);
    fs.writeFileSync(path.join(tmpDir, ".hidden.png"), png);
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "ignore me");

    const scanned = collectInputItems([tmpDir], { recursive: true });
    assert.equal(scanned.skippedUnsupported, 1);
    assert.equal(scanned.items.length, 3);

    const rels = scanned.items.map((i) => (i.relSubdir ? `${i.relSubdir}/${i.fileName}` : i.fileName));
    assert.deepEqual(rels, [
      "hero.png",
      "hero.webp",
      `${path.join("shoes", "sneakers")}/runner.jpg`,
    ]);

    // Collision resolution within the same batch (hero.png + hero.webp -> hero-nobg.png & hero-nobg-1.png)
    const outDir = path.join(tmpDir, "custom-out");
    const reserved = new Set();
    const t1 = resolveOutputTarget({
      item: scanned.items[0],
      outputDir: outDir,
      format: "png",
      reservedPaths: reserved,
    });
    const t2 = resolveOutputTarget({
      item: scanned.items[1],
      outputDir: outDir,
      format: "png",
      reservedPaths: reserved,
    });
    const t3 = resolveOutputTarget({
      item: scanned.items[2],
      outputDir: outDir,
      format: "webp",
      reservedPaths: reserved,
    });

    assert.equal(t1.outputPath, path.join(outDir, "hero-nobg.png"));
    assert.equal(t2.outputPath, path.join(outDir, "hero-nobg-1.png"));
    assert.equal(
      t3.outputPath,
      path.join(outDir, "shoes", "sneakers", "runner-nobg.webp")
    );

    // Skip existing check
    writeFileAtomically(t1.outputPath, png);
    const skippedCheck = resolveOutputTarget({
      item: scanned.items[0],
      outputDir: outDir,
      format: "png",
      skipExisting: true,
      reservedPaths: new Set(),
    });
    assert.equal(skippedCheck.skip, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DesktopApiClient handles /v1.0/account, /v1.0/remove, 503 retries, 413 ticket fallback & SSRF guard", async () => {
  const pngOut = makeTinyPng(8, 6);
  let removeCalls = 0;
  let ticketCalls = 0;
  let directCalls = 0;
  let seenIdemKeys = [];
  let force413 = false;
  let forceTransient503Once = false;
  let maliciousDirectUrl = false;

  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    if (req.method === "GET" && req.url === "/v1.0/account") {
      assert.equal(req.headers["x-api-key"], "rac_live_TestKey12345");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            attributes: {
              credits: { total: 42.5, subscription: 40, payg: 2.5, enterprise: 0 },
              api: { rate_limit_per_minute: 60 },
            },
          },
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1.0/remove") {
      removeCalls += 1;
      seenIdemKeys.push(req.headers["idempotency-key"]);
      req.resume();
      req.on("end", () => {
        if (forceTransient503Once) {
          forceTransient503Once = false;
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errors: [{ title: "GPU warming up", code: "upstream_busy" }] }));
          return;
        }
        if (force413) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errors: [{ title: "Payload too large", code: "payload_too_large" }] }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "X-Width": "8",
          "X-Height": "6",
          "X-Credits-Charged": "1",
        });
        res.end(pngOut);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1.0/remove/ticket") {
      ticketCalls += 1;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        assert.equal(typeof parsed.foregroundSha256, "string");
        assert.equal(parsed.foregroundSha256.length, 64);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              ticket: "tok_live_ticket_xyz",
              directEndpoint: maliciousDirectUrl
                ? "https://evil.attacker.invalid/steal"
                : `http://${host}/gpu-direct`,
            },
          })
        );
      });
      return;
    }

    if (req.method === "POST" && req.url === "/gpu-direct") {
      directCalls += 1;
      // Ensure X-Api-Key is NEVER leaked to direct GPU endpoint
      assert.equal(req.headers["x-api-key"], undefined);
      assert.equal(req.headers.authorization, "Bearer tok_live_ticket_xyz");
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "X-Width": "8",
          "X-Height": "6",
          "X-Credits-Charged": "1",
        });
        res.end(pngOut);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const client = new DesktopApiClient({
      baseUrl,
      apiKey: "rac_live_TestKey12345",
      allowLoopback: true,
      retryBaseDelayMs: 20,
    });

    const account = await client.getAccount();
    assert.equal(account.totalCredits, 42.5);

    // 1. Transient 503 retry preserves exact Idempotency-Key
    forceTransient503Once = true;
    const inputPng = makeTinyPng(10, 10);
    const r1 = await client.removeBackgroundBuffer(
      inputPng,
      "sample.png",
      sanitizeSettings({ size: "full", format: "png", bgMode: "white" }),
      { idempotencyKey: "idem-fixed-1" }
    );
    assert.equal(r1.width, 8);
    assert.equal(r1.creditsCharged, 1);
    assert.equal(removeCalls, 2);
    assert.deepEqual(seenIdemKeys, ["idem-fixed-1", "idem-fixed-1"]);

    // 2. 413 fallback to /v1.0/remove/ticket -> directEndpoint
    force413 = true;
    const r2 = await client.removeBackgroundBuffer(inputPng, "big.png", {});
    assert.equal(r2.buffer.length, pngOut.length);
    assert.equal(ticketCalls, 1);
    assert.equal(directCalls, 1);

    // 3. Rejects untrusted directEndpoint host (SSRF protection)
    maliciousDirectUrl = true;
    await assert.rejects(
      () => client.removeBackgroundBuffer(inputPng, "big2.png", {}),
      /Refused untrusted direct host/
    );

    // 4. Rejects >40 MP image locally before touching network
    const prevRemoveCalls = removeCalls;
    const prevTicketCalls = ticketCalls;
    const hugePng = makeFakeLargeHeaderPng(8000, 6000); // 48 MP
    await assert.rejects(
      () => client.removeBackgroundBuffer(hugePng, "48mp.png", {}),
      /exceeds 40 MP maximum/
    );
    assert.equal(removeCalls, prevRemoveCalls);
    assert.equal(ticketCalls, prevTicketCalls);
  } finally {
    server.close();
  }
});

test("runBatchQueue supports parallel workers and clean mid-flight AbortController cancellation", async () => {
  const controller = new AbortController();
  const items = Array.from({ length: 8 }, (_, idx) => ({ id: `i_${idx}` }));
  const statuses = new Map();

  const summary = await runBatchQueue(
    items,
    async (item) => {
      await new Promise((r) => setTimeout(r, 25));
      if (item.id === "i_2") {
        controller.abort();
      }
      return {
        skipped: false,
        outputPath: `/tmp/${item.id}.png`,
        creditsCharged: 0.25,
      };
    },
    {
      concurrency: 2,
      signal: controller.signal,
      onItemUpdate: (ev) => statuses.set(ev.id, ev.status),
    }
  );

  assert.equal(summary.total, 8);
  assert.ok(summary.completed >= 2);
  assert.ok(summary.cancelled >= 1);
  assert.equal(summary.completed + summary.cancelled + summary.failed + summary.skipped, 8);
});
