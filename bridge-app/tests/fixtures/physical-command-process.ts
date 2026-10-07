import { readFile, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { processPendingBridgeCommands } from "../../../apps/bridge/src/main/command-runner";
import { setBridgeCloudFetchForTests, setBridgeCloudDiagnosticSinkForTests } from "../../../apps/bridge/src/main/cloud-client";
import type { BridgeCommandEnvelope } from "../../../packages/bridge-protocol/src";

async function main() {
const [fixturePath, mode, outputPath] = process.argv.slice(2);
if (mode === "capture-death") {
  const originalRename = fsPromises.rename;
  fsPromises.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (path.basename(path.dirname(String(destination))).startsWith(".nsn-move-") && path.basename(String(destination)) === "source") process.exit(76);
  };
  syncBuiltinESMExports();
}
const command = JSON.parse(await readFile(fixturePath, "utf8")) as BridgeCommandEnvelope;
const reports: unknown[] = [];
setBridgeCloudDiagnosticSinkForTests(null);
setBridgeCloudFetchForTests(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/complete")) {
    if (mode === "effect-death") process.exit(74);
    reports.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }
  if (url.pathname.endsWith("/acknowledge")) {
    if (mode === "admission-death") process.exit(75);
    return mode === "recover" ? Response.json({ ok: false, code: "DEVICE_REVOKED" }, { status: 401 }) : Response.json({ ok: true });
  }
  if (url.pathname.endsWith("/commands")) return mode === "recover"
    ? Response.json({ ok: false, code: "DEVICE_REVOKED" }, { status: 401 }) : Response.json({ ok: true, commands: [command] });
  throw new Error(`Unexpected synthetic cloud path ${url.pathname}`);
});
// Real production polling with durable files, synthetic signed transport only.
await processPendingBridgeCommands().catch((error: unknown) => {
  if (mode !== "recover" || (error as { code?: string }).code !== "DEVICE_REVOKED") throw error;
});
await processPendingBridgeCommands().catch(() => undefined);
await writeFile(outputPath, JSON.stringify(reports));

}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
