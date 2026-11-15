"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Ad-hoc signs Remove.ac.app on macOS when no paid Apple Developer ID certificate
 * is configured so Apple Silicon (arm64 / universal) builds pass kernel Mach-O
 * signature checks cleanly after mounting the .dmg.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  if (process.env.CSC_LINK) {
    return;
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
