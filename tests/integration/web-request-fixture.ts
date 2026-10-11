import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createHumanSessionToken, HUMAN_SESSION_COOKIE } from "../../src/lib/auth/token";

let server: ChildProcess | undefined, baseUrl = "", output = "";
export async function startWebServer() {
  if (server) return baseUrl;
  const address = await new Promise<number>((resolve, reject) => {
    const socket = createServer(); socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => { const port = (socket.address() as { port: number }).port; socket.close(() => resolve(port)); });
  });
  baseUrl = `http://127.0.0.1:${address}`; output = "";
  const application = process.env.NSN_TEST_WEB_APPLICATION_DIR ?? process.cwd();
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", process.env.NSN_TEST_WEB_MODE === "production" ? "start" : "dev", "--hostname", "127.0.0.1", "--port", String(address)], {
    cwd: application,
    env: { ...process.env, NEXT_PUBLIC_APP_URL: baseUrl, NSN_LIBRARIAN_APP_URL: baseUrl, NEXT_TELEMETRY_DISABLED: "1" }, windowsHide: true, detached: process.platform !== "win32",
  });
  server.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (output.includes("Ready in")) return baseUrl;
    if (server.exitCode !== null) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Local Next server failed to start: ${output}`);
}
export async function stopWebServer() {
  if (!server?.pid) return;
  if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "pipe", windowsHide: true });
  else process.kill(-server.pid, "SIGKILL");
  server = undefined;
}
export async function webRequest(pathname: string, authenticated = true, question?: string) {
  await startWebServer();
  const user = { email: "ci@example.com", googleSubject: "ci-google-subject", name: "CI User", role: "OWNER" as const };
  const token = createHumanSessionToken(user, { ...user, picture: null });
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: question ? "POST" : "GET", redirect: "manual",
    headers: { ...(authenticated ? { cookie: `${HUMAN_SESSION_COOKIE}=${token}` } : {}), origin: baseUrl, "Content-Type": "application/json" },
    ...(question ? { body: JSON.stringify({ question }) } : {}),
  });
  assert.notEqual(response.status, 500, `Local web request failed: ${output}`);
  return response;
}
export const accessMemory = (authenticated = true) => webRequest("/admin/library/memory", authenticated);
export const accessSearch = (query = "cobalt", authenticated = true) => webRequest(`/api/library/search?q=${encodeURIComponent(query)}`, authenticated);
export const accessAsk = () => webRequest("/api/library/ask", true, "What does Memory say about cobalt?");
