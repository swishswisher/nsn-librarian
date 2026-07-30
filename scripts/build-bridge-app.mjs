import { build } from "esbuild";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeDir = path.join(root, "apps", "bridge");
const distDir = path.join(bridgeDir, "dist");
const bridgePackage = JSON.parse(
  await readFile(path.join(bridgeDir, "package.json"), "utf8"),
);
const librarianAppUrl =
  process.env.NSN_LIBRARIAN_APP_URL?.trim() ||
  "https://nsn-librarian.vercel.app";
const bridgeVersion = bridgePackage.version || "0.1.0";

await mkdir(distDir, { recursive: true });

await build({
  bundle: true,
  define: {
    "process.env.NSN_BRIDGE_APP_VERSION": JSON.stringify(bridgeVersion),
    "process.env.NSN_LIBRARIAN_APP_URL": JSON.stringify(librarianAppUrl),
  },
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

process.stdout.write(
  `NSN Bridge desktop sources built for ${librarianAppUrl}.\n`,
);
