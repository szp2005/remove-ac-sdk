"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function stripNestedCodeSignatures(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_CodeSignature") {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        stripNestedCodeSignatures(fullPath);
      }
    }
  }
}

/**
 * Ad-hoc signs the final universal Remove.ac.app on macOS when no paid Apple Developer ID
 * certificate is configured.
 *
 * For electron-builder universal builds, afterPack is invoked three times:
 *   1. dist/mac-universal-x64-temp
 *   2. dist/mac-universal-arm64-temp
 *   3. dist/mac-universal (after @electron/universal merges both slices via lipo)
 *
 * Intermediate *-temp bundles MUST NOT be signed (and must have any pre-existing per-arch
 * _CodeSignature directories stripped) so @electron/universal sees identical SHAs for all
 * non-Mach-O files across x64 and arm64 before merging.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const outDirBase = path.basename(context.appOutDir);

  if (outDirBase.endsWith("-temp")) {
    stripNestedCodeSignatures(appPath);
    return;
  }

  if (process.env.CSC_LINK) {
    return;
  }

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
};
