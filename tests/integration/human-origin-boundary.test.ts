import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createHumanSessionToken, HUMAN_SESSION_COOKIE } from "../../src/lib/auth/token";
import { requestIsSameOrigin } from "../../src/lib/auth/http";
import { createBridgeDeviceRequestHeaders, createBridgeKeyPair } from "../../packages/bridge-protocol/src";
import { startWebServer, stopWebServer } from "./web-request-fixture";

const original = { ...process.env };
const preview = "https://authorized-preview.example";
const production = "https://nsn-librarian.example";
const schema = `human_origin_${process.pid}_${Date.now()}`;
let prisma: PrismaClient, base: string, token: string;
const key = createBridgeKeyPair();

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/nsn_library_machine_test");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" });
  process.env.NSN_AUTH_TRUSTED_ORIGINS = `${production},${preview}`;
  process.env.AUTH_SECRET = "ci-auth-secret-with-at-least-thirty-two-characters";
  process.env.AUTH_GOOGLE_ID = "ci-google-client-id.apps.googleusercontent.com";
  process.env.AUTH_GOOGLE_SECRET = "synthetic-google-client-secret";
  const user = { email: "ci@example.com", googleSubject: "ci-google-subject", name: "CI User", role: "OWNER" as const };
  process.env.NSN_AUTH_ALLOWED_USERS_JSON = JSON.stringify([user]);
  process.env.CRON_SECRET = "synthetic-origin-scheduler-secret-at-least-32-characters";
  token = createHumanSessionToken(user, { ...user, picture: null });
  prisma = new PrismaClient(); base = await startWebServer();
});
after(async () => {
  await stopWebServer();
  if (prisma) { await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await prisma.$disconnect(); }
  for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k];
  Object.assign(process.env, original);
});
async function device() {
  const id = `human-origin-${randomUUID()}`;
  await prisma.bridgeDevice.create({ data: { bridgeDeviceId: id, publicKey: key.publicKey, deviceDisplayName: "Synthetic origin control", platform: "WINDOWS", architecture: "x64", appVersion: "test", status: "PAIRED" } });
  return id;
}
async function raw(pathname: string, headers: string[], method = "POST") {
  if (!headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === "host"))
    headers = ["Host", new URL(base).host, ...headers];
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpRequest(new URL(pathname, base), { method, headers, agent: false }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }); req.on("error", reject); req.end();
  });
}
const cookie = () => ["Cookie", `${HUMAN_SESSION_COOKIE}=${token}`];

test("PRIVACY-2 actual proxy rejects original forged origin and conflicting/duplicate authority headers without revoking a device", async () => {
  const id = await device(), pathname = `/api/bridge/cloud/devices/${id}/revoke`;
  for (const headers of [
    ["Origin", "https://evil.invalid", "X-Forwarded-Host", "evil.invalid", "X-Forwarded-Proto", "https"],
    ["Origin", "https://evil.invalid", "Host", "evil.invalid", "X-Forwarded-Host", "evil.invalid", "X-Forwarded-Proto", "https"],
    ["Origin", "https://evil.invalid", "X-Forwarded-Host", "evil.invalid", "X-Forwarded-Host", new URL(base).host, "X-Forwarded-Proto", "https", "X-Forwarded-Proto", "http", "Forwarded", "host=evil.invalid;proto=https"],
    ["Origin", "https://evil.invalid", "X-Forwarded-Host", new URL(base).host, "X-Forwarded-Proto", "http", "Sec-Fetch-Site", "same-origin"],
    ["Origin", base, "Origin", "https://evil.invalid"],
    ["Origin", base, "Origin", base],
    ["Origin", "null"], ["Origin", `${base}/`], ["Origin", `${base}/path`],
    ["Origin", `${base}#fragment`], ["Origin", "https://user:secret@authorized-preview.example"],
    ["Origin", "https://authorized-preview.example.evil.invalid"], [],
  ]) {
    const result = await raw(pathname, [...cookie(), ...headers]);
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal((await prisma.bridgeDevice.findUniqueOrThrow({ where: { bridgeDeviceId: id } })).status, "PAIRED");
  }
});

test("PRIVACY-2 actual routes preserve configured local/production/preview mutations, sessions and logout", async () => {
  for (const origin of [base, production, preview]) {
    const id = await device();
    const result = await raw(`/api/bridge/cloud/devices/${id}/revoke`, [...cookie(), "Origin", origin, "X-Forwarded-Host", "conflicting.invalid", "X-Forwarded-Host", "another.invalid", "X-Forwarded-Proto", "https", "X-Forwarded-Proto", "http"]);
    assert.equal(result.status, 200);
    assert.equal((await prisma.bridgeDevice.findUniqueOrThrow({ where: { bridgeDeviceId: id } })).status, "REVOKED");
  }
  const id = await device();
  assert.equal((await raw(`/api/bridge/cloud/devices/${id}/revoke`, ["Origin", base])).status, 401);
  assert.equal((await raw(`/api/bridge/cloud/devices/${id}/revoke`, ["Cookie", `${HUMAN_SESSION_COOKIE}=${token}tampered`, "Origin", base])).status, 401);
  assert.equal((await raw("/api/auth/logout", [...cookie(), "Origin", "https://evil.invalid", "X-Forwarded-Host", "evil.invalid", "X-Forwarded-Proto", "https"])).status, 403);
  const logout = await raw("/api/auth/logout", [...cookie(), "Origin", base]);
  assert.equal(logout.status, 303); assert.match(String(logout.headers["set-cookie"]), /nsn_session=;/);
});

test("PRIVACY-2 trusted origin configuration fails closed without request-derived or wildcard fallbacks", () => {
  const saved = { primary: process.env.NSN_LIBRARIAN_APP_URL, public: process.env.NEXT_PUBLIC_APP_URL, additional: process.env.NSN_AUTH_TRUSTED_ORIGINS, mode: process.env.NODE_ENV };
  try {
    process.env.NODE_ENV = "production"; delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NSN_LIBRARIAN_APP_URL = production; process.env.NSN_AUTH_TRUSTED_ORIGINS = preview;
    const check = (origin: string) => requestIsSameOrigin(new Request(`${production}/api/library/review`, { method: "POST", headers: { origin, host: "evil.invalid", "x-forwarded-host": "evil.invalid", "x-forwarded-proto": "https" } }));
    assert.equal(check(production), true); assert.equal(check(preview), true); assert.equal(check("https://evil.invalid"), false);
    for (const invalid of ["https://*.example", `${preview}/path`, `${preview},`, "http://untrusted.example", "https://user:password@authorized-preview.example", ","]) {
      process.env.NSN_AUTH_TRUSTED_ORIGINS = invalid; assert.equal(check(production), false, invalid);
    }
    delete process.env.NSN_LIBRARIAN_APP_URL; delete process.env.NSN_AUTH_TRUSTED_ORIGINS;
    assert.equal(check(production), false); assert.equal(check("http://localhost:3000"), false);
    process.env.NODE_ENV = "development"; assert.equal(check("http://localhost:3000"), true); assert.equal(check("http://localhost:3999"), false);
  } finally {
    for (const [name, value] of Object.entries({ NSN_LIBRARIAN_APP_URL: saved.primary, NEXT_PUBLIC_APP_URL: saved.public, NSN_AUTH_TRUSTED_ORIGINS: saved.additional, NODE_ENV: saved.mode })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("PRIVACY-4 actual scheduler, signed Bridge traffic and OAuth entry/callback retain their separate authentication", async () => {
  const id = await device(), pathname = `/api/bridge/cloud/devices/${id}/commands`;
  const headers = createBridgeDeviceRequestHeaders({ bridgeDeviceId: id, privateKey: key.privateKey, method: "GET", pathname, bodyText: "" });
  assert.equal((await fetch(base + pathname, { headers })).status, 200);
  assert.equal((await fetch(base + pathname, { headers })).status, 409);
  assert.equal((await raw("/api/cron/memory-recovery", cookie(), "GET")).status, 401);
  assert.equal((await raw("/api/cron/memory-recovery", ["Authorization", `Bearer ${process.env.CRON_SECRET}`], "GET")).status, 200);
  const oauth = await raw("/api/auth/google/start?next=/admin/library", [], "GET");
  assert.equal(oauth.status, 302);
  const url = new URL(String(oauth.headers.location)); assert.equal(url.origin, "https://accounts.google.com");
  // NextURL normalizes its loopback request URL to localhost; retain the exact
  // existing callback URI and port, rather than requiring a raw Host spelling.
  assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${new URL(base).port}/api/auth/google/callback`);
  assert.equal((await raw("/api/auth/google/callback?error=access_denied", [], "GET")).status, 303);
});
