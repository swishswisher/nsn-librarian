import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeDir = path.join(root, "apps", "bridge");
const distDir = path.join(bridgeDir, "dist");

await mkdir(distDir, { recursive: true });

await build({
  bundle: true,
  entryPoints: [path.join(bridgeDir, "src", "main", "main.ts")],
  external: ["electron"],
  format: "cjs",
  outfile: path.join(distDir, "main.cjs"),
  platform: "node",
  sourcemap: false,
  target: "node20",
});

await build({
  bundle: true,
  entryPoints: [path.join(bridgeDir, "src", "main", "preload.ts")],
  external: ["electron"],
  format: "cjs",
  outfile: path.join(distDir, "preload.cjs"),
  platform: "node",
  sourcemap: false,
  target: "node20",
});

await copyFile(
  path.join(bridgeDir, "package.json"),
  path.join(distDir, "package.json"),
);

process.stdout.write("NSN Bridge desktop sources built.\n");
