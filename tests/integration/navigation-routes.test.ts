import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { stopWebServer, webRequest } from "./web-request-fixture";

const schema = `navigation_${process.pid}_${Date.now()}`;
let prisma: PrismaClient;

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/nsn_library_machine_test");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" });
  prisma = (await import("../../src/lib/db/prisma")).getPrismaClient();
  await prisma.connectedLibrary.create({ data: { id: "route-root", displayName: "Synthetic route folder", localPath: "bridge://route-root", readPermission: true } });
  await prisma.scanSession.create({ data: { id: "route-scan", connectedFolderId: "route-root", status: "COMPLETED", completedAt: new Date(), filesScanned: 1 } });
  await prisma.scannedFile.create({ data: { id: "route-file", sessionId: "route-scan", localPath: "bridge://route-root/notes.txt", relativePath: "notes.txt", fileType: "TEXT" } });
  await prisma.organizationSuggestion.create({ data: { id: "route-suggestion", scanSessionId: "route-scan", scannedFileId: "route-file", suggestionType: "KEEP_UNCHANGED", currentRelativePath: "notes.txt", title: "Keep synthetic notes", explanation: "Synthetic route check", whySuggested: [], supportingInformation: [], suggestionKey: "route-suggestion" } });
  await prisma.notebookEntry.create({ data: { id: "route-note", entryType: "REFLECTION", title: "Synthetic reflection", summary: "Route check", body: "Synthetic route check", sourceType: "MANUAL", sourceId: "route-note", sourceKey: "route-note", provenanceSummary: "Synthetic test", history: [], relatedEntryKeys: [] } });
  await prisma.knowledgeObject.create({ data: { id: "route-topic", objectType: "TOPIC", name: "Cobalt orchard", normalizedName: "cobalt orchard", description: "Synthetic topic", provenanceSummary: "Synthetic test", evidence: [], sourceKeys: [] } });
  await prisma.libraryBatch.create({ data: { id: "route-batch", name: "Synthetic route batch" } });
  await prisma.libraryDocument.create({ data: { id: "route-document", batchId: "route-batch", originalFileName: "notes.txt", normalizedFileName: "notes.txt" } });
  await prisma.observationSession.create({ data: { id: "route-observation", libraryDocumentId: "route-document", observerType: "BASIC", observations: {}, interpretations: {}, explanation: {}, planSuggestions: [], warnings: [] } });
});

after(async () => {
  await stopWebServer();
  if (prisma) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  }
});

async function pages(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const descendants = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => pages(path.join(directory, entry.name))));
  return [...(entries.some((entry) => entry.name === "page.tsx") ? [directory] : []), ...descendants.flat()];
}

test("every page route finishes rendering, including compatibility redirects and detail pages", { timeout: 180_000 }, async (t) => {
  const routes = (await pages("src/app")).map((file) => file.slice("src/app".length) || "/");
  assert.equal(routes.length, 33, "Update route coverage deliberately when adding a page");
  for (const pattern of routes) await t.test(pattern, async () => {
    let route = pattern.replace("[sessionId]", pattern.includes("/review/") ? "route-observation" : "route-scan")
      .replace("[fileId]", "route-file").replace("[suggestionId]", "route-suggestion")
      .replace("[entryId]", "route-note").replace("[topicId]", "route-topic");
    const started = Date.now();
    for (let redirects = 0; ; redirects++) {
      assert.ok(redirects < 5, `Redirect loop: ${pattern}`);
      const response = await webRequest(route);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get("location")!, "http://127.0.0.1");
        route = next.pathname + next.search;
        continue;
      }
      assert.equal(response.status, 200, `${pattern}: HTTP ${response.status}`);
      const html = await response.text();
      assert.doesNotMatch(html, /data-dgst="(?!NEXT_REDIRECT)[^"]+"|\d+:E\{/, `${pattern}: server rendering failed after streaming headers`);
      assert.match(html, /<main|<body/);
      break;
    }
    assert.ok(Date.now() - started < 15_000, `${pattern} exceeded the 15-second complete-response budget`);
  });
});

test("new refresh and indicator endpoints retain human authentication and same-origin checks", async () => {
  const { startWebServer } = await import("./web-request-fixture");
  const origin = await startWebServer();
  assert.equal((await webRequest("/api/bridge/status?view=indicator", false)).status, 401);
  const denied = await fetch(`${origin}/api/library/knowledge/refresh`, { method: "POST", headers: { origin } });
  assert.equal(denied.status, 401);
  const indicator = await webRequest("/api/bridge/status?view=indicator");
  assert.equal(indicator.status, 200);
  assert.deepEqual(await indicator.json(), { ok: true, label: "Bridge not paired", tone: "pending" });
  const { createHumanSessionToken, HUMAN_SESSION_COOKIE } = await import("../../src/lib/auth/token");
  const user = { email: "ci@example.com", googleSubject: "ci-google-subject", name: "CI User", role: "OWNER" as const };
  const cookie = `${HUMAN_SESSION_COOKIE}=${createHumanSessionToken(user, { ...user, picture: null })}`;
  const crossSite = await fetch(`${origin}/api/library/knowledge/refresh`, {
    method: "POST", headers: { cookie, origin: "https://untrusted.example" },
  });
  assert.equal(crossSite.status, 403);
  const refresh = await fetch(`${origin}/api/library/knowledge/refresh`, {
    method: "POST", headers: { cookie, origin },
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(await refresh.json(), { ok: true });
});
