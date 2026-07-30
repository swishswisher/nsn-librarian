import { existsSync } from "node:fs";
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
    "electron-builder is required to package signed macOS DMGs. Install release tooling before running package:bridge:mac.\n",
  );
  process.exit(1);
}

const buildResult = spawnSync("node", ["scripts/build-bridge-app.mjs"], {
  stdio: "inherit",
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const packageResult = spawnSync(
  electronBuilderBin,
  ["--config", "apps/bridge/electron-builder.yml", "--mac", "dmg"],
  {
    env: {
      ...process.env,
      CSC_HARDENED_RUNTIME: "true",
    },
    stdio: "inherit",
  },
);

process.exit(packageResult.status ?? 1);
