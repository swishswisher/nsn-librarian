import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/nsn_library_machine_test"); assert.equal(process.env.OPENAI_API_KEY, undefined);
async function main() {
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  await (await import("../../src/lib/bridge/remote-execution")).applyRemoteExecutionReport(input);
  process.send?.("COMMITTED");
  await new Promise(() => { setInterval(() => undefined, 1000); });
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
