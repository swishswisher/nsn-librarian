import assert from "node:assert/strict";
import { test } from "node:test";

import { compareDocumentVersions, extractDocumentSignals } from "../../src/lib/bridge/document-signals";

function verified(text: string, start = 0) {
  return `Source characters ${start}-${start + text.length}: "${text}"`;
}

test("client identifiers resolve repeated mentions without merging same-name clients", () => {
  const a = extractDocumentSignals(verified("Client: Alex Lee; Client ID: C-101; Project: Intake; Project ID: P-1"), "root-a");
  const again = extractDocumentSignals(verified("Client: Alex Lee; Client ID: C-101; Project: Followup; Project ID: P-2"), "root-a");
  const different = extractDocumentSignals(verified("Client: Alex Lee; Client ID: C-202; Project: Intake; Project ID: P-1"), "root-a");
  assert.equal(a.find((item) => item.kind === "CLIENT")?.identityHash, again.find((item) => item.kind === "CLIENT")?.identityHash);
  assert.notEqual(a.find((item) => item.kind === "CLIENT")?.identityHash, different.find((item) => item.kind === "CLIENT")?.identityHash);
  assert.notEqual(a.find((item) => item.kind === "PROJECT")?.identityHash, again.find((item) => item.kind === "PROJECT")?.identityHash);
  assert.notEqual(a.find((item) => item.kind === "PROJECT")?.identityHash, different.find((item) => item.kind === "PROJECT")?.identityHash);
  assert.notEqual(a.find((item) => item.kind === "CLIENT")?.identityHash, extractDocumentSignals(verified("Client: Alex Lee; Client ID: C-101"), "root-b").find((item) => item.kind === "CLIENT")?.identityHash);
});

test("name-only and generic terminology stay unresolved", () => {
  const source = extractDocumentSignals(verified("Client: Alex Lee; Project: General; workshop materials and payment notes"), "root-a");
  assert.ok(source.some((item) => item.kind === "UNRESOLVED_CLIENT"));
  assert.ok(source.some((item) => item.kind === "UNRESOLVED_PROJECT"));
  assert.ok(!source.some((item) => item.kind === "CLIENT" || item.kind === "PROJECT"));
  assert.deepEqual(extractDocumentSignals("The client and workshop share generic words.", "root-a"), []);
  assert.ok(!extractDocumentSignals(verified("Person: Alex Lee; Email: info@example.org"), "root-a").some((item) => item.kind === "PERSON"));
});

test("conflicting explicit identifiers do not resolve to the first value", () => {
  const signals = extractDocumentSignals(verified("Client: Alex Lee; Client ID: C-1; Client ID: C-2; Project: Outreach; Project ID: P-1; Project ID: P-2"), "root-a");
  assert.ok(signals.some((item) => item.kind === "UNRESOLVED_CLIENT"));
  assert.ok(signals.some((item) => item.kind === "UNRESOLVED_PROJECT"));
  assert.ok(!signals.some((item) => item.kind === "CLIENT" || item.kind === "PROJECT"));
  const revision = extractDocumentSignals(verified("Client ID: C-1; Document ID: D-1; Document ID: D-2; Document Title: Annual Plan; Version: v2"), "root-a");
  assert.ok(!revision.some((item) => item.kind === "DOCUMENT_FAMILY"));
});

test("a project title reused in another year remains separate", () => {
  const first = extractDocumentSignals(verified("Client: Acme; Client ID: C-1; Project: Outreach; Year: 2025"), "root-a");
  const second = extractDocumentSignals(verified("Client: Acme; Client ID: C-1; Project: Outreach; Year: 2026"), "root-a");
  assert.notEqual(first.find((item) => item.kind === "PROJECT")?.identityHash, second.find((item) => item.kind === "PROJECT")?.identityHash);
});

test("a person across projects and similar company names do not collapse project or organization identities", () => {
  const first = extractDocumentSignals(verified("Person: Alex Lee; Email: alex@example.org; Client ID: C-1; Project ID: P-1; Organization: Acme Studio; Domain: acme-studio.example"), "root-a");
  const second = extractDocumentSignals(verified("Person: Alex Lee; Email: alex@example.org; Client ID: C-1; Project ID: P-2; Organization: Acme Studios; Domain: acme-studios.example"), "root-a");
  assert.equal(first.find((item) => item.kind === "PERSON")?.identityHash, second.find((item) => item.kind === "PERSON")?.identityHash);
  assert.notEqual(first.find((item) => item.kind === "PROJECT")?.identityHash, second.find((item) => item.kind === "PROJECT")?.identityHash);
  assert.notEqual(first.find((item) => item.kind === "ORGANIZATION")?.identityHash, second.find((item) => item.kind === "ORGANIZATION")?.identityHash);
});

test("workshop title needs date and scoped client or project evidence", () => {
  const first = extractDocumentSignals(verified("Client: Acme; Client ID: C-1; Workshop: Boundaries; Date: 2026-08-03"), "root-a");
  const other = extractDocumentSignals(verified("Client: Acme; Client ID: C-1; Workshop: Boundaries; Date: 2026-09-01"), "root-a");
  assert.ok(first.some((item) => item.kind === "WORKSHOP"));
  assert.notEqual(first.find((item) => item.kind === "WORKSHOP")?.identityHash, other.find((item) => item.kind === "WORKSHOP")?.identityHash);
  assert.ok(!extractDocumentSignals(verified("Workshop: Boundaries"), "root-a").some((item) => item.kind === "WORKSHOP"));
  assert.ok(!extractDocumentSignals(verified("Client ID: C-1; Workshop: Boundaries; Date: 2026-02-30"), "root-a").some((item) => item.kind === "WORKSHOP"));
  const otherClient = extractDocumentSignals(verified("Client ID: C-2; Workshop: Boundaries; Date: 2026-08-03"), "root-a");
  assert.notEqual(first.find((item) => item.kind === "WORKSHOP")?.identityHash, otherClient.find((item) => item.kind === "WORKSHOP")?.identityHash);
});

test("document family requires explicit identity and title, not a filename", () => {
  const one = extractDocumentSignals(verified("Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v1"), "root-a");
  const two = extractDocumentSignals(verified("Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v2"), "root-a");
  assert.equal(one.find((item) => item.kind === "DOCUMENT_FAMILY")?.identityHash, two.find((item) => item.kind === "DOCUMENT_FAMILY")?.identityHash);
  assert.equal(compareDocumentVersions(one.find((item) => item.kind === "DOCUMENT_FAMILY")!, two.find((item) => item.kind === "DOCUMENT_FAMILY")!), -1);
  assert.ok(!extractDocumentSignals("final2.docx shares a template", "root-a").some((item) => item.kind === "DOCUMENT_FAMILY"));
  assert.ok(!extractDocumentSignals(verified("Document ID: TEMPLATE-1; Document Title: Workshop Form; Version: v2"), "root-a").some((item) => item.kind === "DOCUMENT_FAMILY"));
});

test("conflicting revision dates leave ordering ambiguous", () => {
  const one = extractDocumentSignals(verified("Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v1; Date: 2026-10-01"), "root-a");
  const two = extractDocumentSignals(verified("Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v2; Date: 2026-09-01"), "root-a");
  assert.equal(compareDocumentVersions(one.find((item) => item.kind === "DOCUMENT_FAMILY")!, two.find((item) => item.kind === "DOCUMENT_FAMILY")!), null);
});

test("source markers retain only hashes and source ranges", () => {
  const text = "Client: Alex Lee; Client ID: C-101";
  const signals = extractDocumentSignals(verified(text, 250), "root-a");
  const serialized = JSON.stringify(signals);
  assert.ok(!serialized.includes("Alex Lee") && !serialized.includes("C-101"));
  assert.deepEqual(signals.find((item) => item.kind === "CLIENT")?.sourceRanges, [{ start: 250, end: 250 + text.length }]);
});
