/* eslint-disable no-console */
"use strict";

const path = require("path");
const { execFileSync } = require("child_process");

function readElectronVersion(projectDir) {
  try {
    // Prefer installed electron package version.
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const pkg = require(path.join(projectDir, "node_modules", "electron", "package.json"));
    return String(pkg.version || "").trim();
  } catch (_) {
    return "";
  }
}

module.exports = async function beforePack(context) {
  const projectDir = context && context.appDir ? context.appDir : process.cwd();
  const electronVersion = (context && context.electronVersion) || readElectronVersion(projectDir);
  const archRaw = context && context.arch != null ? context.arch : "x64";
  const archMap = {
    0: "ia32",
    1: "x64",
    2: "armv7l",
    3: "arm64",
    x64: "x64",
    ia32: "ia32",
    arm64: "arm64",
  };
  const arch = archMap[archRaw] || "x64";
  const platform = (context && context.electronPlatformName) || "win32";

  if (!electronVersion) {
    throw new Error("electron version not found (needed for better-sqlite3 prebuild)");
  }

  const betterSqliteDir = path.join(projectDir, "node_modules", "better-sqlite3");
  const prebuildBin = path.join(projectDir, "node_modules", "prebuild-install", "bin.js");

  console.log("• beforePack: installing better-sqlite3 prebuild", {
    electronVersion,
    arch,
    platform,
  });

  execFileSync(
    process.execPath,
    [
      prebuildBin,
      "--runtime=electron",
      `--target=${electronVersion}`,
      `--arch=${arch}`,
      `--platform=${platform}`,
      "--verbose",
    ],
    { cwd: betterSqliteDir, stdio: "inherit" }
  );
};
