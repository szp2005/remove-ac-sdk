import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTION_VERSION,
  resolveSafeActionPath,
  runGithubAction,
  validateActionBaseUrl,
  writeGithubOutputs,
} from "../bin/remove-ac-action.mjs";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const TEMP_ROOT = fs.existsSync("/Volumes/Expansion/dev-tools/build-temp")
  ? "/Volumes/Expansion/dev-tools/build-temp"
  : os.tmpdir();

function createTempWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, "remove-ac-gha-test-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fs.realpathSync(dir);
}

test("GitHub Action processes single local file, masks secret, and writes safe GITHUB_OUTPUT", async (t) => {
  const ws = createTempWorkspace(t);
  const inputFile = path.join(ws, "shoe.png");
  const ghOutput = path.join(ws, "_runner_output.txt");
  fs.writeFileSync(inputFile, TINY_PNG);
  fs.writeFileSync(ghOutput, "", "utf8");

  let logs = "";
  const stdout = {
    write(chunk) {
      logs += String(chunk);
    },
  };

  const summary = await runGithubAction({
    env: {
      GITHUB_WORKSPACE: ws,
      GITHUB_OUTPUT: ghOutput,
      INPUT_API_KEY: "rac_live_secret_test_key",
      INPUT_INPUT_PATH: "shoe.png",
      INPUT_BASE_URL: "http://127.0.0.1:8787",
      INPUT_FORMAT: "png",
      INPUT_SIZE: "full",
    },
    cwd: ws,
    stdout,
    allowLoopbackBaseUrlForTest: true,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:8787/v1.0/removebg");
      assert.equal(init.headers["X-Api-Key"], "rac_live_secret_test_key");
      return new Response(TINY_PNG, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Credits-Charged": "1",
          "X-Width": "1",
          "X-Height": "1",
        },
      });
    },
  });

  assert.equal(summary.processed_count, "1");
  assert.equal(summary.credits_charged, "1");
  assert.equal(summary.output_path, path.join(ws, "shoe-nobg.png"));
  assert.equal(fs.existsSync(path.join(ws, "shoe-nobg.png")), true);
  assert.match(logs, /::add-mask::rac_live_secret_test_key/);

  const rawOutputFile = fs.readFileSync(ghOutput, "utf8");
  assert.match(rawOutputFile, /output_path<<ghadelim_[0-9a-f]{32}\n/);
  assert.match(rawOutputFile, /processed_count<<ghadelim_[0-9a-f]{32}\n1\n/);
});

test("GitHub Action processes directory batch and skips -nobg artifacts on same-folder output", async (t) => {
  const ws = createTempWorkspace(t);
  const imgDir = path.join(ws, "catalog");
  fs.mkdirSync(imgDir);
  fs.writeFileSync(path.join(imgDir, "a.png"), TINY_PNG);
  fs.writeFileSync(path.join(imgDir, "b.jpg"), TINY_PNG);
  fs.writeFileSync(path.join(imgDir, "a-nobg.png"), TINY_PNG);

  let callCount = 0;
  const summary = await runGithubAction({
    env: {
      GITHUB_WORKSPACE: ws,
      INPUT_API_KEY: "rac_live_batch",
      INPUT_INPUT_PATH: "catalog",
      INPUT_OUTPUT_DIR: "catalog",
      INPUT_OVERWRITE: "true",
      INPUT_BASE_URL: "http://127.0.0.1:8787",
    },
    cwd: ws,
    stdout: { write() {} },
    allowLoopbackBaseUrlForTest: true,
    fetchImpl: async () => {
      callCount += 1;
      return new Response(TINY_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });

  assert.equal(callCount, 2);
  assert.equal(summary.processed_count, "2");
  assert.equal(summary.credits_charged, "2");
  assert.equal(fs.existsSync(path.join(imgDir, "a-nobg.png")), true);
  assert.equal(fs.existsSync(path.join(imgDir, "b-nobg.png")), true);
});

test("GitHub Action blocks SSRF on image_url and non-HTTPS or private base_url", async (t) => {
  const ws = createTempWorkspace(t);

  await assert.rejects(
    () =>
      validateActionBaseUrl("http://remove.ac", {
        lookupFn: async () => [{ address: "104.21.1.1", family: 4 }],
      }),
    /base_url must use https:\/\//
  );

  await assert.rejects(
    () =>
      validateActionBaseUrl("https://evil.example.com", {
        lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    /Disallowed base_url/
  );

  await assert.rejects(
    () =>
      runGithubAction({
        env: {
          GITHUB_WORKSPACE: ws,
          INPUT_API_KEY: "rac_live_test",
          INPUT_IMAGE_URL: "http://[::ffff:127.0.0.1]/secret.png",
          INPUT_OUTPUT_PATH: "out.png",
          INPUT_BASE_URL: "http://127.0.0.1:8787",
        },
        cwd: ws,
        stdout: { write() {} },
        allowLoopbackBaseUrlForTest: true,
      }),
    /Disallowed image_url/
  );

  const okSummary = await runGithubAction({
    env: {
      GITHUB_WORKSPACE: ws,
      INPUT_API_KEY: "rac_live_test",
      INPUT_IMAGE_URL: "https://cdn.example.com/product.jpg",
      INPUT_OUTPUT_PATH: "remote-cutout.png",
      INPUT_BASE_URL: "http://127.0.0.1:8787",
    },
    cwd: ws,
    stdout: { write() {} },
    allowLoopbackBaseUrlForTest: true,
    lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:8787/v1.0/removebg");
      assert.equal(init.body.get("image_url"), "https://cdn.example.com/product.jpg");
      return new Response(TINY_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1", "X-Width": "1", "X-Height": "1" },
      });
    },
  });
  assert.equal(okSummary.output_path, path.join(ws, "remote-cutout.png"));
  assert.equal(fs.existsSync(path.join(ws, "remote-cutout.png")), true);
});

test("GitHub Action blocks workspace traversal, symlinks, and runner control file overwrites", (t) => {
  const ws = createTempWorkspace(t);
  const outside = fs.mkdtempSync(path.join(TEMP_ROOT, "remove-ac-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const envFile = path.join(ws, "_github_env");
  fs.writeFileSync(envFile, "", "utf8");

  const env = {
    GITHUB_WORKSPACE: ws,
    GITHUB_ENV: envFile,
  };

  assert.throws(
    () => resolveSafeActionPath("../escape.png", { env, cwd: ws, forWrite: true }),
    /outside GITHUB_WORKSPACE/
  );

  assert.throws(
    () => resolveSafeActionPath("_github_env", { env, cwd: ws, forWrite: true }),
    /protected GitHub Actions runner control file/
  );

  const symPath = path.join(ws, "link.png");
  fs.symlinkSync(path.join(outside, "secret.txt"), symPath);
  assert.throws(
    () => resolveSafeActionPath("link.png", { env, cwd: ws, forWrite: true }),
    /symbolic link/
  );
});

test("writeGithubOutputs safely wraps multiline values without delimiter injection", (t) => {
  const ws = createTempWorkspace(t);
  const outFile = path.join(ws, "gh_out.txt");
  fs.writeFileSync(outFile, "", "utf8");

  writeGithubOutputs(outFile, {
    output_path: "/workspace/line1\nINJECTED=evil\nEOF",
  });

  const text = fs.readFileSync(outFile, "utf8");
  assert.match(text, /^output_path<<ghadelim_[0-9a-f]{32}\n\/workspace\/line1\nINJECTED=evil\nEOF\nghadelim_[0-9a-f]{32}\n$/);
});

test("MF-3 & MF-4: GitHub Action protects GITHUB_STATE, uncreated runner files under symlinked dirs, dangling symlink ancestors (0 API calls), and exact shadow_type allowlist", async (t) => {
  const ws = createTempWorkspace(t);
  const outside = fs.mkdtempSync(path.join(TEMP_ROOT, "remove-ac-outside-mf3-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  // 1) GITHUB_STATE must be protected even if not yet created on disk
  const uncreatedState = path.join(ws, "_runner_state_uncreated");
  assert.throws(
    () =>
      resolveSafeActionPath("_runner_state_uncreated", {
        env: { GITHUB_WORKSPACE: ws, GITHUB_STATE: uncreatedState },
        cwd: ws,
        forWrite: true,
      }),
    /protected GitHub Actions runner control file/
  );

  // 2) Uncreated GITHUB_OUTPUT referenced through a symlinked runner directory alias must still match canonical path
  const realRunnerDir = path.join(outside, "real-runner");
  fs.mkdirSync(realRunnerDir);
  const aliasRunnerDir = path.join(outside, "alias-runner");
  fs.symlinkSync(realRunnerDir, aliasRunnerDir);
  const uncreatedOutputViaAlias = path.join(aliasRunnerDir, "uncreated_output.txt");
  const uncreatedOutputViaReal = path.join(realRunnerDir, "uncreated_output.txt");
  assert.throws(
    () =>
      resolveSafeActionPath(uncreatedOutputViaReal, {
        env: {
          GITHUB_WORKSPACE: ws,
          GITHUB_OUTPUT: uncreatedOutputViaAlias,
        },
        cwd: ws,
        allowOutsideWorkspace: true,
        forWrite: true,
      }),
    /protected GitHub Actions runner control file/
  );

  // 3) Dangling symlink ancestor directory inside GITHUB_WORKSPACE must fail BEFORE calling remove.ac API (0 HTTP calls)
  const inputFile = path.join(ws, "item.png");
  fs.writeFileSync(inputFile, TINY_PNG);
  const danglingDir = path.join(ws, "escape_dir");
  fs.symlinkSync(path.join(outside, "nonexistent_target_dir"), danglingDir);

  let apiCalls = 0;
  await assert.rejects(
    () =>
      runGithubAction({
        env: {
          GITHUB_WORKSPACE: ws,
          INPUT_API_KEY: "rac_live_no_burn",
          INPUT_INPUT_PATH: "item.png",
          INPUT_OUTPUT_PATH: "escape_dir/cutout.png",
          INPUT_BASE_URL: "http://127.0.0.1:8787",
        },
        cwd: ws,
        stdout: { write() {} },
        allowLoopbackBaseUrlForTest: true,
        fetchImpl: async () => {
          apiCalls += 1;
          return new Response(TINY_PNG, { status: 200 });
        },
      }),
    /symbolic link/
  );
  assert.equal(apiCalls, 0, "Must make 0 HTTP calls when output traverses a dangling symlink");

  // 4) MF-4: shadow_type rejects '3d' and accepts 'soft' / 'reflection' / 'none'
  await assert.rejects(
    () =>
      runGithubAction({
        env: {
          GITHUB_WORKSPACE: ws,
          INPUT_API_KEY: "rac_live_test",
          INPUT_INPUT_PATH: "item.png",
          INPUT_SHADOW_TYPE: "3d",
          INPUT_BASE_URL: "http://127.0.0.1:8787",
        },
        cwd: ws,
        stdout: { write() {} },
        allowLoopbackBaseUrlForTest: true,
      }),
    /Unsupported shadow_type '3d'/
  );

  for (const validShadow of ["soft", "reflection", "none"]) {
    const res = await runGithubAction({
      env: {
        GITHUB_WORKSPACE: ws,
        INPUT_API_KEY: "rac_live_test",
        INPUT_INPUT_PATH: "item.png",
        INPUT_OUTPUT_PATH: `item-${validShadow}.png`,
        INPUT_ADD_SHADOW: "true",
        INPUT_SHADOW_TYPE: validShadow,
        INPUT_BASE_URL: "http://127.0.0.1:8787",
      },
      cwd: ws,
      stdout: { write() {} },
      allowLoopbackBaseUrlForTest: true,
      fetchImpl: async (_url, init) => {
        assert.equal(init.body.get("shadow_type"), validShadow);
        return new Response(TINY_PNG, {
          status: 200,
          headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
        });
      },
    });
    assert.equal(res.processed_count, "1");
  }

  for (const validSize of ["25mp", "50mp", "full"]) {
    const res = await runGithubAction({
      env: {
        GITHUB_WORKSPACE: ws,
        INPUT_API_KEY: "rac_live_test",
        INPUT_INPUT_PATH: "item.png",
        INPUT_OUTPUT_PATH: `item-size-${validSize}.png`,
        INPUT_SIZE: validSize,
        INPUT_BASE_URL: "http://127.0.0.1:8787",
      },
      cwd: ws,
      stdout: { write() {} },
      allowLoopbackBaseUrlForTest: true,
      fetchImpl: async (_url, init) => {
        assert.equal(init.body.get("size"), validSize);
        return new Response(TINY_PNG, {
          status: 200,
          headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
        });
      },
    });
    assert.equal(res.processed_count, "1");
  }
});

test("v1.3.0 GitHub Action supports bg-image-file and bg-image-url and blocks traversal/SSRF/conflicts", async (t) => {
  assert.equal(ACTION_VERSION, "1.3.0");
  const ws = createTempWorkspace(t);
  const fgFile = path.join(ws, "subject.png");
  const bgFile = path.join(ws, "backdrop.png");
  fs.writeFileSync(fgFile, TINY_PNG);
  fs.writeFileSync(bgFile, TINY_PNG);

  // 1. Hyphenated INPUT_BG-IMAGE-FILE works even when INPUT_BG_IMAGE_FILE="" default is set by runner
  let seenBgBlob = null;
  const rFile = await runGithubAction({
    env: {
      GITHUB_WORKSPACE: ws,
      INPUT_API_KEY: "rac_live_test",
      INPUT_INPUT_PATH: "subject.png",
      INPUT_OUTPUT_PATH: "subject-bg-file.png",
      INPUT_BG_IMAGE_FILE: "",
      "INPUT_BG-IMAGE-FILE": "backdrop.png",
      INPUT_BASE_URL: "http://127.0.0.1:8787",
    },
    cwd: ws,
    stdout: { write() {} },
    allowLoopbackBaseUrlForTest: true,
    fetchImpl: async (_url, init) => {
      seenBgBlob = init.body.get("bg_image_file");
      return new Response(TINY_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });
  assert.equal(rFile.processed_count, "1");
  assert.ok(seenBgBlob instanceof Blob);
  assert.equal(seenBgBlob.name, "backdrop.png");

  // 2. bg-image-url passes SSRF check for public host and sends bg_image_url
  let seenBgUrl = null;
  const rUrl = await runGithubAction({
    env: {
      GITHUB_WORKSPACE: ws,
      INPUT_API_KEY: "rac_live_test",
      INPUT_INPUT_PATH: "subject.png",
      INPUT_OUTPUT_PATH: "subject-bg-url.png",
      "INPUT_BG-IMAGE-URL": "https://cdn.example.com/bg.jpg",
      INPUT_BASE_URL: "http://127.0.0.1:8787",
    },
    cwd: ws,
    stdout: { write() {} },
    allowLoopbackBaseUrlForTest: true,
    lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (_url, init) => {
      seenBgUrl = init.body.get("bg_image_url");
      return new Response(TINY_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });
  assert.equal(rUrl.processed_count, "1");
  assert.equal(seenBgUrl, "https://cdn.example.com/bg.jpg");

  // 3. Rejects outside-workspace bg-image-file, private bg-image-url, and mutual exclusion with 0 HTTP calls
  let blockedHits = 0;
  for (const badEnv of [
    { "INPUT_BG-IMAGE-FILE": "../outside.png" },
    { "INPUT_BG-IMAGE-URL": "http://127.0.0.1:8080/internal-bg.png" },
    { INPUT_BG_COLOR: "FFFFFF", "INPUT_BG-IMAGE-FILE": "backdrop.png" },
  ]) {
    await assert.rejects(() =>
      runGithubAction({
        env: {
          GITHUB_WORKSPACE: ws,
          INPUT_API_KEY: "rac_live_test",
          INPUT_INPUT_PATH: "subject.png",
          INPUT_OUTPUT_PATH: "unused.png",
          INPUT_BASE_URL: "http://127.0.0.1:8787",
          ...badEnv,
        },
        cwd: ws,
        stdout: { write() {} },
        allowLoopbackBaseUrlForTest: true,
        fetchImpl: async () => {
          blockedHits += 1;
          return new Response(TINY_PNG, { status: 200 });
        },
      })
    );
  }
  assert.equal(blockedHits, 0);
});

test("R2 MF-04 & MF-02: GitHub Action excludes bg-image-file from directory batches, forbids overwriting bg-image-file, and enforces <=30 MB combined envelope", async (t) => {
  const ws = createTempWorkspace(t);
  const catalogDir = path.join(ws, "catalog");
  fs.mkdirSync(catalogDir);
  const backdropPayload = Buffer.concat([TINY_PNG, Buffer.from("ORIGINAL_BG_MARKER")]);
  fs.writeFileSync(path.join(catalogDir, "item1.png"), TINY_PNG);
  fs.writeFileSync(path.join(catalogDir, "backdrop.png"), backdropPayload);

  // 1. Directory batch excludes bg-image-file itself from foreground items
  const processedNames = [];
  const batchSummary = await runGithubAction({
    env: {
      GITHUB_WORKSPACE: ws,
      INPUT_API_KEY: "rac_live_mf04",
      INPUT_INPUT_PATH: "catalog",
      "INPUT_BG-IMAGE-FILE": "catalog/backdrop.png",
      INPUT_BASE_URL: "http://127.0.0.1:8787",
    },
    cwd: ws,
    stdout: { write() {} },
    allowLoopbackBaseUrlForTest: true,
    fetchImpl: async (_url, init) => {
      processedNames.push(init.body.get("image_file").name);
      return new Response(TINY_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "X-Credits-Charged": "1" },
      });
    },
  });
  assert.deepEqual(processedNames, ["item1.png"]);
  assert.equal(batchSummary.processed_count, "1");
  assert.deepEqual(fs.readFileSync(path.join(catalogDir, "backdrop.png")), backdropPayload);

  // 2. Forbids overwriting bg-image-file in single-file, URL, and batch modes even when overwrite: true (0 HTTP calls)
  let overwriteApiCalls = 0;
  for (const badEnv of [
    {
      INPUT_INPUT_PATH: "catalog/item1.png",
      INPUT_OUTPUT_PATH: "catalog/backdrop.png",
      "INPUT_BG-IMAGE-FILE": "catalog/backdrop.png",
      INPUT_OVERWRITE: "true",
    },
    {
      INPUT_IMAGE_URL: "https://cdn.example.com/subject.png",
      INPUT_OUTPUT_PATH: "catalog/backdrop.png",
      "INPUT_BG-IMAGE-FILE": "catalog/backdrop.png",
      INPUT_OVERWRITE: "true",
    },
    {
      INPUT_INPUT_PATH: "catalog",
      INPUT_OUTPUT_DIR: "out-collide",
      "INPUT_BG-IMAGE-FILE": "out-collide/item1.png",
      INPUT_OVERWRITE: "true",
    },
  ]) {
    if (badEnv.INPUT_OUTPUT_DIR === "out-collide") {
      fs.mkdirSync(path.join(ws, "out-collide"), { recursive: true });
      fs.writeFileSync(path.join(ws, "out-collide", "item1.png"), backdropPayload);
    }
    await assert.rejects(
      () =>
        runGithubAction({
          env: {
            GITHUB_WORKSPACE: ws,
            INPUT_API_KEY: "rac_live_mf04",
            INPUT_BASE_URL: "http://127.0.0.1:8787",
            ...badEnv,
          },
          cwd: ws,
          stdout: { write() {} },
          allowLoopbackBaseUrlForTest: true,
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchImpl: async () => {
            overwriteApiCalls += 1;
            return new Response(Buffer.from("CLOBBERED"), { status: 200 });
          },
        }),
      /overwrite bg-image-file/,
    );
  }
  assert.equal(overwriteApiCalls, 0);
  assert.deepEqual(fs.readFileSync(path.join(catalogDir, "backdrop.png")), backdropPayload);

  // 3. Combined >30 MB rejected upfront with 0 HTTP calls
  fs.writeFileSync(path.join(ws, "fg18.png"), Buffer.concat([TINY_PNG, Buffer.alloc(18 * 1024 * 1024, 0)]));
  fs.writeFileSync(path.join(ws, "bg16.png"), Buffer.concat([TINY_PNG, Buffer.alloc(16 * 1024 * 1024, 0)]));
  await assert.rejects(
    () =>
      runGithubAction({
        env: {
          GITHUB_WORKSPACE: ws,
          INPUT_API_KEY: "rac_live_mf04",
          INPUT_INPUT_PATH: "fg18.png",
          "INPUT_BG-IMAGE-FILE": "bg16.png",
          INPUT_BASE_URL: "http://127.0.0.1:8787",
        },
        cwd: ws,
        stdout: { write() {} },
        allowLoopbackBaseUrlForTest: true,
        fetchImpl: async () => {
          overwriteApiCalls += 1;
          return new Response(TINY_PNG, { status: 200 });
        },
      }),
    /exceeds 30 MB limit/,
  );
  assert.equal(overwriteApiCalls, 0);
});
