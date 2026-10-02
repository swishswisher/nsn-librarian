# Phase 3 intelligence handover (pre-deployment)

This describes the current worktree, not a production approval. The machine suggests; Deanne decides; nothing moves without approval. All Phase 1-3 changes remain uncommitted. No production data or private Mac files were used for this review.

## System flow and trust

1. The authenticated Bridge scans an explicitly connected root. File bytes stay on the Mac. Signed, temporary read results supply bounded extracted text and metadata to the web processor. Unsupported or metadata-only media does not become a transcript.
2. The observer proposes observations with source ranges; evidence verification rejects quotations that cannot be located in the extracted source. An observation remains provisional until a human accepts or modifies it. Rejection cannot create trusted Memory.
3. Scan working knowledge may combine verified content, provisional observation, and approved Memory, but keeps their evidence kinds separate. The persistent layer records source/checksum identity, relationship state, document signals, entities, and version families. Inferred relationships stay provisional; human corrections/reviews are explicit revisions, not implicit promotion.
4. Only approved or modified observation decisions build trusted Memory. Memory used in permission-sensitive search, QA, or recommendation context needs complete contributing-observation and connected-root provenance. Approved Memory is human-reviewed context, not a direct quotation from a file.
5. Organization preferences have separate human decisions and revisions. Current, destination-specific evidence is required before an organization suggestion becomes a candidate. Search relevance and QA output never become destination evidence or approval.
6. The versioned search index stores only bounded verified excerpts and metadata. Search/QA select readable, connected roots before retrieval, distinguish current from historical sources, and label Memory separately. Ask the Librarian returns cited, validated claims or a conservative incomplete/ambiguous/error state; it does not save a conversation or update knowledge.
7. Organization recommendations require their own human decision. An Organization Plan includes only eligible current decisions; final authorization, Bridge preview, permission checks, typed execution confirmation, execution history, and Undo remain separate. Search, QA, preparation, and recommendation generation do not mutate Mac files.

The canonical physical-file identity is connected-library identity plus normalized relative path; checksum distinguishes content versions and exact copies at different paths. A move/rename is a different path until explicitly linked by reviewed identity/version evidence. A checksum match at the same root/path across scans is not a duplicate. The observation-reuse fingerprint additionally includes Bridge device/root/version, file type, model/prompt/processing version, path, and verified checksum. The search entry is derived from root/path/checksum/index version. QA cites selected search source IDs and rechecks its entire authorized context after the model returns. Plan operations use root-relative paths and revalidate source state before execution.

## State changes and recovery

| Change | Current behavior / required follow-up |
| --- | --- |
| Changed checksum, disappeared file, move or rename | New scan snapshot determines current files. Prior search entries become historical/superseded, not deleted. Observation reuse requires unchanged fingerprint. Review identity/version links rather than assuming filename or checksum proves lineage. Regenerate recommendations for changed content. |
| Root disconnected, hidden, merged, or read revoked | Search, QA, and scan working knowledge exclude that root and Memory with incomplete or unavailable provenance. Historical database rows remain retained; this is access filtering, not erasure. Reconnection requires current permissions and a new/reconciled scan. |
| Observation corrected or rejected | Human decision updates trusted Memory and affected index context through the existing review/reindex path. QA checks the selected context again at response time. Old decision history remains. Existing scan-wide recommendations must be regenerated if their evidence changed. |
| Memory archived or provenance incomplete | Permission-sensitive search/QA/recommendation context excludes it. Notebook/history may still retain earlier narrative. No destructive purge occurs. |
| Relationship disputed, corrected, or superseded | Search/QA use only active, unsuperseded, generation-compatible relationships with matching current endpoint checksums. A correction creates a reviewed revision; old relationship records remain historical. Reindex/revisit recommendations if relationship evidence was material. |
| Preference edited or revoked | Revision/status is persisted. Only current approved preferences are eligible corroboration; previously generated recommendations and plans still require independent current validation. |
| Recommendation regenerated | Prior generations remain historical/inactive. Only current active generation can be decided or planned. Approval/execution are never automatic. |
| Interrupted scan/read/observation | Scan sessions, file stages, commands, and observation claims persist. Pending/failed work can be retried; completed work is reused only with a compatible fingerprint. Provider timeouts and failed files are isolated. Browser closure does not guarantee any unpersisted request will finish. |
| Interrupted search backfill | Per-file `PROCESSING` claims use a stale lease; completed entries remain, failed entries retry, and concurrent preparations do not both claim a live file. Browser must continue issuing bounded requests; this is not a background worker. |
| QA failure or changing authorization/source during generation | Search remains usable. Usage metadata records the attempted request. Claims are withheld if the retrieved context changed; Deanne may ask again. A browser/network timeout may not cancel a provider request already started. |

## Processing compatibility

| Identifier | Current value | Incompatible change action |
| --- | --- | --- |
| Observation/evidence | `phase1-grounded-observer-v2` plus model, prompt, Bridge and source fingerprint | Re-observe changed/incompatible files; never reuse a corrected provisional result over human review. |
| Document signals | `document-signals-v1` | Rebuild signal/identity context; old signals are not current search or QA evidence. |
| Relationships / correction | `scan-relationships-v1` / `human-identity-correction-v1` | Reconcile derived relationships; preserve human correction history. |
| Search index | `library-search-v1` | Reindex from retained verified evidence; an incomplete index leaves filename/path fallback. |
| QA | `library-answer-v1` | New answers use the current logic; no old answers are retained to migrate. |
| Recommendations | `organization-recommendations-v11` | Explicit regeneration for existing scan snapshots; keep prior decisions as history and do not silently replace reviewed decisions. |
| Organization preferences | Per-record revision number | Revalidate dependent proposals; no global generation version exists. |

There is no embedding index. Search uses deterministic lexical, source-supported subject, identity, and version information. A search match, broad semantic relationship, provisional claim, or historical record is not authorization for a destination or an executable action.

## Data flow and privacy

| Boundary | Current data and limit |
| --- | --- |
| Mac only | Original connected-root files and raw media. Bridge reads are temporary and read-only for intelligence workflows. Organization execution and Undo are separate, explicitly authorized capabilities. |
| Mac to web service | Signed command results can carry up to 2,000,000 extracted text characters temporarily for a document read, plus path-relative metadata, checksum, size, timestamps, and bounded media summaries. The cloud path persists a `ScannedFile.previewText` of at most 2,000 characters and read/observation metadata, not the entire extracted document. This is **not end-to-end Mac-only content processing**. |
| Web to OpenAI: observation | A selected document sample up to 120,000 characters, title/metadata and grounding instructions; configured `OPENAI_MODEL` (default `gpt-4o-mini`). Responses request uses `store: false`, a 90-second timeout, and at most two SDK retries (up to three HTTP attempts per application request). This is an application setting, not a guarantee about all provider retention. |
| Web to OpenAI: QA | One question of at most 500 characters; at most eight authorized sources, each with one verified excerpt up to 240 characters or an approved Memory description up to 400 characters, bounded relationship text/version facts, and title/root display name/relative path. Configured `OPENAI_QA_MODEL` or fallback OpenAI model; `store: false`; max 700 output tokens; up to three HTTP attempts. No absolute Mac paths, full text, media, or database physical-file ID is intentionally sent in QA context. |
| PostgreSQL | Root/scan metadata (including backend absolute local paths), checksums, relative paths, bounded previews, up to eight 240-character verified search excerpts per file with ranges, observation/evidence/decision history, approved Memory and provenance, relationships, identity/version signals, Notebook, suggestions/preferences/plans, execution/Undo audit, and QA usage metadata. `LibraryAnswerUsage` does not store question, context, or answer text. Phase 1 evidence and historical index excerpts may remain indefinitely. |
| Legacy upload path | `/api/library/upload` and `storage/library-uploads` still exist; legacy uploaded `LibraryDocument` rows may store original copies and full `rawText`. This is outside the newer Bridge-only data boundary and requires an explicit product/security decision before describing the whole application as never storing full files. |

Audio/video transcription has separate paths and may send temporary media to OpenAI when enabled. Its exact provider retention and cost are not established by the document-observation/QA `store: false` settings. Cloud/native metadata-only audio/video must not be presented as transcript knowledge. Review media behavior separately before enabling real-world scans.

Disconnecting a root, archiving Memory, invalidating a recommendation, or superseding a source filters active use; it does **not** erase retained excerpts, approved narrative, audit rows, or historical index entries. There is no complete per-document/per-root derived-knowledge purge workflow. Decide whether to (a) retain bounded excerpts/audit indefinitely, (b) define a time-limited archival window, or (c) implement a human-authorized purge with legal/audit exceptions. Also decide whether legacy upload remains available and explicitly approve bounded QA transmission to OpenAI. Do not deploy on an assumption that disconnect means deletion.

## Usage, authorization, and injection

Observation telemetry distinguishes application-level requests, measured SDK HTTP attempts, provider-reported input/output tokens, reuse, and model failures. QA reports per-answer requests/attempts/tokens and stores non-content usage. There are no embeddings. Monetary cost is unavailable without a maintained pricing table; counters do not imply a bill. Transcription and any provider-side unreported retries are not covered by the document/QA token totals. A large scan has no global paid-request cap; compatible observation reuse and per-file processing bounds reduce repeat work, not first-scan total spend. No paid requests were made during this verification.

Human API routes are behind the session proxy; search, index preparation, and QA also check the session in-route. Public signed Bridge device endpoints authenticate each request independently. Root eligibility is selected server-side before source retrieval. The deployment is a single-human design; it does not implement per-tenant authorization. Do not trust a client-supplied root ID, source ID, plan action, or `X-NSN-Bridge-Client` as authorization. Prompt templates place document excerpts in source/data sections and explicitly prohibit treating embedded commands as instructions. Server-side claim validation, root filtering, recommendation decisions, plan validation, and Bridge authorization remain the enforcement boundaries; a prompt alone is not one.

## Coverage and real-world handover

| Area | Automated coverage | Remaining real-world check |
| --- | --- | --- |
| Scan, extraction, Bridge connectivity, auth/protocol | Strong synthetic/integration coverage | Physical Mac permissions, offline/reconnect, malformed media, slow provider/network. |
| Evidence, observation reuse, scan working knowledge | Strong focused coverage | Representative long documents and provider output quality. |
| Memory, persistent relationships, identity/version, preferences | Behavioral integration coverage | Human review of ambiguous identities, changed/revoked knowledge. |
| Search, backfill, QA | Strong synthetic coverage including permissions, stale context, concurrency and injection | Real corpus retrieval relevance, citation correctness, browser accessibility, timeout behavior. |
| Recommendations, plans, execution, Undo | Existing integration coverage for selections and safeguards | Preview and tiny authorized file move/Undo on a disposable Mac test root, never private files first. |
| Retention/purge and monetary cost | Audit only; no complete deletion UI or pricing system | Product/privacy approval and operational cost monitoring. |

Deployment needs the existing Phase 1-3 migration chain applied through the direct Prisma URL, compatible generated Prisma client, configured environment, a production backup/rollback plan, and explicit privacy approval. Existing connected scans need explicit search preparation or a new scan; existing recommendations need version-aware regeneration, not a physical rescan solely for logic changes. The current Phase 3C changes are web/server-only; they do not require a new Bridge DMG or protocol version. Do not infer production readiness from synthetic tests alone.
