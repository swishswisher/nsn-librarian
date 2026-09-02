import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const electronBuilderBin = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);

if (process.platform !== "darwin") {
  process.stdout.write(
    "macOS Bridge packaging is configured for macOS runners. Skipping DMG packaging on this platform.\n",
  );
  process.exit(0);
}

if (!existsSync(electronBuilderBin)) {
  process.stderr.write(
    "electron-builder is required to package macOS DMGs. Install release tooling before running package:bridge:mac.\n",
  );
  process.exit(1);
}

const unsignedBuild = process.env.NSN_UNSIGNED_BUILD === "true";
const bridgeArch = process.env.NSN_BRIDGE_ARCH?.trim();
const bridgeArchFlag =
  bridgeArch === "arm64" ? "--arm64" : bridgeArch === "x64" ? "--x64" : null;
const bridgePackagePath = path.join(
  process.cwd(),
  "apps",
  "bridge",
  "package.json",
);
const releaseVersion = process.env.NSN_BRIDGE_RELEASE_VERSION?.trim();
let originalBridgePackageText = null;

if (!bridgeArchFlag) {
  process.stderr.write(
    "NSN_BRIDGE_ARCH must be set to arm64 or x64 when packaging the macOS Bridge.\n",
  );
  process.exit(1);
}

if (releaseVersion && !/^\d+\.\d+\.\d+$/u.test(releaseVersion)) {
  process.stderr.write(
    "NSN_BRIDGE_RELEASE_VERSION must be a valid x.y.z semver version.\n",
  );
  process.exit(1);
}

if (releaseVersion) {
  originalBridgePackageText = readFileSync(bridgePackagePath, "utf8");
  const bridgePackage = JSON.parse(originalBridgePackageText);

  bridgePackage.version = releaseVersion;
  writeFileSync(
    bridgePackagePath,
    `${JSON.stringify(bridgePackage, null, 2)}\n`,
    "utf8",
  );
  process.on("exit", () => {
    if (originalBridgePackageText !== null) {
      writeFileSync(bridgePackagePath, originalBridgePackageText, "utf8");
    }
  });
}

const buildResult = spawnSync("node", ["scripts/build-bridge-app.mjs"], {
  stdio: "inherit",
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const packageResult = spawnSync(
  electronBuilderBin,
  [
    "--config",
    "apps/bridge/electron-builder.yml",
    "--mac",
    "dmg",
    bridgeArchFlag,
    "--publish",
    "never",
  ],
  {
    env: {
      ...process.env,
      CSC_HARDENED_RUNTIME: unsignedBuild ? "false" : "true",
      CSC_IDENTITY_AUTO_DISCOVERY: unsignedBuild ? "false" : process.env.CSC_IDENTITY_AUTO_DISCOVERY,
    },
    stdio: "inherit",
  },
);

if (packageResult.status !== 0) {
  process.exit(packageResult.status ?? 1);
}

const releaseDir = path.join(process.cwd(), "apps", "bridge", "dist", "release");

if (unsignedBuild && existsSync(releaseDir)) {
  for (const fileName of readdirSync(releaseDir)) {
    if (!fileName.endsWith(".dmg") || fileName.includes("-unsigned")) {
      continue;
    }

    const unsignedName = fileName.replace(/\.dmg$/u, "-unsigned.dmg");
    renameSync(path.join(releaseDir, fileName), path.join(releaseDir, unsignedName));
  }
}

const dmgFiles = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((fileName) => fileName.endsWith(".dmg"))
  : [];
const expectedArchDmgs = dmgFiles.filter((fileName) =>
  fileName.includes(`mac-${bridgeArch}`),
);
const wrongArchDmgs = dmgFiles.filter(
  (fileName) => !fileName.includes(`mac-${bridgeArch}`),
);

if (expectedArchDmgs.length !== 1 || wrongArchDmgs.length > 0) {
  process.stderr.write(
    `Expected exactly one macOS ${bridgeArch} DMG, found ${expectedArchDmgs.length}. Unexpected DMGs: ${wrongArchDmgs.join(", ") || "none"}.\n`,
  );
  process.exit(1);
}

writeFileSync(
  path.join(releaseDir, "latest-mac.json"),
  `${JSON.stringify(
      {
        channel: unsignedBuild ? "development" : "production",
        files: dmgFiles,
        generatedAt: new Date().toISOString(),
        signed: !unsignedBuild,
        version: releaseVersion ?? JSON.parse(readFileSync(bridgePackagePath, "utf8")).version,
      },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  unsignedBuild
    ? `Created unsigned NSN Bridge development DMG for ${bridgeArch}. macOS will require manual approval on first launch.\n`
    : `Created signed NSN Bridge production DMG for ${bridgeArch}.\n`,
);
