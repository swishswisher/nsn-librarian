# PR #3 structural derived-state audit

Reviewed base: `c897939e9a253b4bbaa2f228dfc1524a59b66d1d`.
Review: `5439696761`; findings `4204761518`, `4204761535`, `4204761544`, `4204761567`, `4204761583`.

This audit covers the four requested patterns in production current-data and human-review paths. It preserves historical records and physical execution/Undo policies where those contexts differ. Validation counts and the resulting commit identity are recorded in the external validation report, after the tree is frozen.

## A. Stale checks followed by writes

| Inspected paths | Boundary and result |
| --- | --- |
| Search backfill and file indexing | Preparation, individual indexing, and final retirement acquire the PostgreSQL transaction advisory lock for `scan-publication:<rootId>`. Each mutation checks the latest completed snapshot and canonical root inside that Serializable transaction. Final retirement cannot use an earlier invocation's latest check. Stale or busy workers return incomplete without retiring another session. |
| Full Knowledge publication, relationship supersession, typed identity projection, version indexing, full Search publication | These production writes share the same root lock, acquired before loading working Knowledge. Each publication stage commits its derived writes together with completion. The nontransactional persistence helper remains available for explicit legacy/test callers; production publication passes the locked transaction. |
| Observation and identity Search refresh | Fresh working Knowledge, correction graph traversal, indexed endpoint selection, and checksum-bound hash updates now run inside the same root transaction. The identity refresh retains indexed O(V+E) traversal and 500-row SQL update chunks. |
| Recommendation generation/replacement | Asynchronous preparation captures file/document/checksum/media/observation/human-review/current-suggestion authority and used preference versions. Persistence rechecks that authority in a Serializable transaction and uses a durable per-file no-op UPDATE shared with checksum bootstrap. A stale generation cannot replace newer recommendations or human decisions. |
| Checksum duplicate bootstrap | Derivation and persistence now share one Serializable transaction. Bootstrap preserves a current full generation or human-reviewed suggestion and cannot reactivate historical bootstrap keys. Media updates, suggestion creation and stale-support invalidation commit together. Retired pending bootstrap diagnostics retain the existing KEEP_UNCHANGED recheck presentation; reviewed rows retain their original type/status/evidence. |
| Organization plan generation/review | Generation reloads source suggestions and the previous plan in its transaction. Replacement, selection, clear, approval and cancellation compare the exact parent status/revision and reject plans owned by execution. Source action checks run in the write transaction. |
| Local and remote execution admission | Claim of the exact READY_FOR_EXECUTION plan revision and creation of its execution run/actions are atomic. Queued/running/completed/partially completed runs own immutable snapshots; competing planning writes cannot replace them. Existing filesystem permissions, checksum checks, no-overwrite rules and Undo remain in force. |
| Observation reuse and recovery | Existing per-file lease/CAS and latest-observation ordering remain authoritative. Recovery applies canonical root eligibility before its 50-file work cap. Rejected latest observations are not reused. |

The root advisory lock is transaction scoped. Commit, rollback, connection loss and backend death release ownership. It is not process local and introduces no globally shared root bottleneck. A contention miss returns incomplete for the existing bounded recovery path. Lock order is root publication lock, root authorization share lock, then derived writes. Human observation review locks observations before Memory; Memory follows the same order and locks all required observations before modifying parents. Transaction aborts fail closed rather than applying a stale write.

Existing per-session scan recommendation completion writes remain scoped to that scan, use unique pending publication generations, and do not directly retire current Search/Knowledge. Historical scans are rejected at the root publication boundary. Primary processing error flags are diagnostics; they do not override human review or create trusted application evidence. Notebook reflections are optional historical notes and cannot publish current Search/Knowledge.

## B. Partial parent/children/completion creation

| Inspected paths | Retry behavior |
| --- | --- |
| Memory parent, source rows and completion | Builder operations now share one Serializable transaction. Durable `MEMORY_PROVENANCE_REQUIRED` evidence records the required observation IDs. Attachment reconciles missing sources even when the parent already existed. Completion depends on the verified durable state, never the creator boolean. |
| Historical Memory source reconstruction | Existing bounded 20-entry checked-marker recovery uses the same attachment/completion rule. It keeps strict unique approved-item reconstruction and does not guess filenames or manufacture provenance. |
| Knowledge relationships, identities, version lineage | Production stage writes and completion are atomic under the root lock. Stable keys/upserts, human-confirmed authority and complete-family checks remain unchanged. An interrupted stage rolls back or remains durably pending. |
| Search entries and backfill progress | Entry creation is atomic; per-file leases/CAS remain restart recoverable. Same-session retries keep stable keys and do not churn completed publication. Final retirement is guarded independently of earlier progress. |
| Organization preferences and revisions | Proposal parent/revision writes share one transaction. Reviews use version/status CAS and append-only revisions. |
| Recommendations and execution snapshots | Per-file recommendation replacement and children commit together. Execution parent and nested actions commit together with the plan claim. Historical review rows are retained. |

Memory completes only when the required manifest is nonempty, every required observation is represented by durable sources, every stored source is currently valid, and the actual source count covers the previously required count. Source validity requires the latest approved/modified human observation, a current readable canonical root, the latest completed snapshot, exact document binding, available physical file and matching nonnull checksum. Legacy documents with a null document checksum keep exact document/file binding; a known document checksum must equal the current file checksum. Modified observations require the latest nonempty MODIFY authority.

Missing/revoked/unavailable/rejected/historical sources keep completion false. Latest approval/correction authority excludes append-only NOTE events, matching the production decision path; a later note retains the human edit, while rejection still removes authority. Active updates merge required IDs; correction reconciliation replaces the manifest explicitly. Historical correction archives retain the complete prior provenance manifest. Repeated recovery adds only missing unique source rows and settles a stable completion/count without duplicate parents or children.

## C. Authority committed before derived invalidation

| Inspected paths | Boundary and result |
| --- | --- |
| Regeneration, single reset, bulk reset | Source suggestion mutations, review/history events, plan cancellation and preference disputes now commit in the same transaction. Retry sees either the unchanged source or the completed invalidation. |
| Automatic replacement and checksum stale-support retirement | Both call preference invalidation inside their source mutation transaction. Existing human statuses, reasons and append-only history are retained. |
| Preference applicability | Live support is also checked during retrieval. A legacy interrupted approved preference cannot remain applicable when a listed support is missing, invalidated, from another root/generation, or no longer APPROVED/MODIFIED. Empty legacy/manual manifests retain the existing human-approved semantics. |
| Observation human review to Memory/Knowledge/Search | Existing atomic Memory invalidation and document publication pending markers remain in the authority transaction. Memory reconstruction is transactional; current retrieval independently checks live source authority. |
| Identity correction and relationship review to Search | These paths now write a unique durable Search pending generation in their authority transaction. Eager hash refresh is an optimization; ordinary Bridge polling recovers the full projection after request/process failure. SEPARATE and human supersession remain authoritative. |
| Version correction and projection | Live effective typed/version evidence is read at publication/retrieval. The durable pending generation repairs indexed projections; complete-family fail-closed checks remain in place. |

Preference dispute semantics remain **any changed supporting decision disputes the preference**, matching the prior implementation. An unrelated changed decision does not dispute it. Each dispute increments the version once and appends one DISPUTE revision without erasing approval/history. Repeated calls are idempotent. Direct atomic invalidation is used; no new best-effort work queue is introduced. SQL trigger fault tests prove that failure of derived invalidation rolls back source mutations and history in all four source-change paths.

Correction projection work is durably recoverable because its existing production coordinator selects only authorized latest snapshots and processes at most two pending scans per poll. Failure markers use generation CAS and cannot overwrite a later success. Both ORM serialization failures and PostgreSQL raw-SQL serialization/deadlock failures are translated to the existing 409 review conflict response. No partial eager refresh is falsely declared a completed full Search publication.

## D. Eligibility before semantic limits

| Inspected paths | Eligibility and budget |
| --- | --- |
| Preference human page | Independent SQL-filtered budgets of 80 reviewable PROPOSED/DEFERRED, 80 active APPROVED and 80 historical rows. Disputed/superseded rows belong to history. Canonical root eligibility precedes every cap. Combined output uses updatedAt descending/id descending; each preference retains at most 12 revisions. |
| Approved preference application | Eligible current approval/support pages of 200 are traversed before matching/conflict selection. Scope conflict detection sees all eligible scopes; final matching output remains capped at 40. |
| Preference proposals | Pages of 200 reviewed current decisions are traversed until 200 distinct physical paths with usable final destinations are collected. Invalid/malformed rows do not consume that semantic budget. Existing four-proposal bound remains. |
| Preference source context | DISTINCT ON suggestion selects its latest nonnull context independently. One source's repeated events cannot crowd another source out of a global event cap. |
| Knowledge relationship review and correction candidates | Existing eligible SQL plus cursor traversal remains: 30 review relationships and independent CLIENT/PROJECT/anchor candidate budgets. Final exact executed-move/fileKey checks continue traversal when a row is ineligible. |
| Search indexed and metadata files | Canonical roots/latest snapshots/checksum/currentness and file type are applied before file result windows. Trusted identity-name anchors are discovered across formats so human-confirmed cross-format identity joins remain valid; type eligibility precedes the final candidate cap. Explicit typed entity queries retain checksum-bound effective evidence and never use misleading path-only metadata. Typed identities and full version families retain exhaustive eligible traversal; ordinary ranking/source bounds remain deterministic. |
| Search/working-Knowledge Memory | Every durable source, expected count, current human observation/root/file/checksum is checked before the 60 Search or 80 working-Knowledge Memory cap. Invalid entries cannot crowd out valid Memory. |
| Memory curation | Eligibility and type precede independent 12-row category budgets and the 8-row recent budget. Standalone upload notes are intentionally visible to human curation, but never used as application evidence. Modern source manifests prevent a revoked physical source from masquerading as a standalone upload. |
| Memory aggregation and human preferences | Current authorized observation eligibility precedes the 100-observation aggregate. Standalone uploads keep human curation semantics. Current MODIFY authority is paged in groups of 150 until 150 usable terminology edits; malformed or superseded decisions cannot consume that budget. Required existing contribution sources are loaded separately for correction reconciliation rather than silently forgotten at a recent-page boundary. |
| Recommendation Memory/context | Eligible 200-row Memory pages are traversed for independent eight-Memory/eight-preferred-term matching slots, with an explicit UTC timestamp cursor independent of the database timezone. Memory relationship pages continue until five useful approved relationships; earlier relationship context continues past malformed historical evidence until three usable contexts. |
| Ask relationships | Both observation IDs and their current selected checksums are filtered before the 24-relationship cap. Old checksum rows cannot crowd out current support. Context stays bounded at eight sources and claims at three. |
| Current recommendation listing | Current generation, active state and canonical root eligibility precede the existing 160-row list cap. Plan source selection keeps current reviewed generation eligibility. |

Text/excerpt/term truncation, displayed append-only history tails, SQL batch chunk sizes, observation latest-row selection, retry work windows and post-ranking final source caps are deliberately retained. They bound already selected evidence, history or resumable work rather than hiding otherwise eligible user actions. Exact typed/version paths still validate complete families before selecting bounded sources. Existing 20,000/50,000 fixtures and correction graph endpoint chunking are unchanged.

## Canonical root rule and deliberately different contexts

`current-readable-root.ts` defines one semantic rule, with Prisma, in-memory and SQL forms derived from the same fields:

```
isEnabled = true
readPermission = true
status = CONNECTED
disconnectedAt = null
hiddenFromActiveListAt = null
mergedAt = null
canonicalConnectedLibraryId = null
```

Current Search, Ask, Knowledge SQL/current signals/review/candidates, version publication, Memory, preferences, observation recovery, recommendation generation/listing, checksum bootstrap and plan writes reuse this rule. No weaker status-only definition is introduced. This installation's existing authorization model is the authenticated single-human library model; roots have no per-user ownership column. Optional permitted root IDs remain enforced in Search/Ask.

Connection management/reconnection deliberately includes disabled, paused, needs-attention and historical roots so the human can repair or restore them. Explorer and plan navigation retain last-scan/history diagnostics and labels for disconnected/paused roots; current evidence and mutation paths apply the canonical rule independently. Human notebook/append-only review history may retain earlier authority. Physical execution/Undo and file resolution retain their separate explicit permissions, device/root/path/checksum/no-overwrite rules and can act on historical execution snapshots; imposing latest-scan eligibility there would make legitimate recovery impossible. Historical plan cancellation may decrease future activity even when a root is unavailable, but still checks the exact plan revision and execution ownership.

Restoring a root's existing permission/current/canonical fields makes an otherwise valid approved preference applicable again. Restoration does not approve proposals, resurrect disputed/superseded preferences, change human review or rewrite historical support.

## Regression method

The new production suite uses deterministic barriers for stale Search orderings and database row locks for plan races. Root independence and backend death are exercised against PostgreSQL. Memory tests seed recovered parents with zero/partial sources, use the real builder, retry twice and verify Search/Ask eligibility plus invalid-authority controls. SQL trigger faults inject failure at preference and Memory child boundaries. Authorization tests cover each canonical field and restoration. Cap tests include history/actionable ties, unusable evidence, old checksums and revoked observations. Native Bridge tests cover cancellation before execution admission and competing plan writes after admission.

Counterfactual regressions are run in a detached worktree of the exact reviewed base with only the test file copied in. All application validation uses disposable `127.0.0.1:5432/nsn_library_machine_test`, isolated schemas, mocked AI and no OPENAI_API_KEY. The original cloud environment and untracked Bridge distribution are isolated during validation and restored byte-for-byte afterward. No production database, paid application AI, push, release, promotion or master operation is part of this task.

## Whole-project audit of 6a1a4f0

Baseline: `6a1a4f074668038f5b556413769dd6178ca752eb`, `release-candidate/phase-1-3`, fetched origin at the same head, tracked index/worktree clean, ahead/behind 0/0. Native dist was untracked and unstaged. Master/origin master were `99bfcfdbef6b8e63f0a845d6e9dd359aff5b717a`. Inspection covered the production source/configuration inventory, API/page/UI boundaries, protocol/native storage and operations, all 34 migration definitions and 33 subsystems in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md). Read/write/lock/cap/dependency maps guided targeted line inspection; this is not a claim that every line received an independent review. The normalized inspection ledger records 421 paths: 357 production, 35 migrations, 14 test paths and 15 configuration/documentation paths, including all 343 tracked baseline production paths. Validation evidence belongs in external artifacts.

This register was established **before any production remediation**. Initial confirmed counts: P0 **0**, P1 **13**, P2 **12**, P3 **0** (25 confirmed findings). All 25 confirmed findings are REMEDIATED following production-path controls and the complete final validation gate. No confirmed P0/P1/P2 remains open. Recommendations/false positives are separate below. Earlier sections record the preceding narrow audit; the newly discovered sibling defects supersede any broader interpretation of its assurances, particularly about physical recovery, root admission and per-session completion.

### Confirmed finding register

Each line reference below points to the unchanged reviewed baseline. Architectural class numbers correspond to the task's 17 adversarial classes. Each design is a safety requirement; implementation must preserve stronger existing behavior and be verified across its named siblings.

#### AUD-001 — P1 — Conflicting observation authority (REMEDIATED)

* Path: human decision API → `src/lib/library/observation-sessions.ts:636–738`, `saveHumanDecision` (known inline 4208026599).
* Violates AUTH-2 / TX-1; classes 1, 2, 3. Concurrent ACCEPT and REJECT/MODIFY can read the same prior state and independently append history/update status. Transaction-start timestamps and missing id tie-break can order events differently from committed materialized status, exposing rejected material to downstream consumers.
* Cause: no database owner lock/version before authority read; event order is not assigned after serialization.
* Siblings inspected: Memory builder/live provenance, reuse/latest authority, persistent relationship/correction reviews, preference version-CAS, recommendation review, plan CAS, graph and Notebook revisions.
* Gap/design: deterministic real-PG conflicting review barriers (A/R, A/M, R/M), same-action retry, event/status/Memory agreement. Serialize the observation row before reads; assign strictly increasing per-owner authority time, stable id tie-break; commit status/event/invalidation/pending work together.

#### AUD-002 — P2 — Approval can strand missing Memory (REMEDIATED)

* Path: `observation-sessions.ts:718–738` → `src/app/api/library/observation-sessions/[sessionId]/decision/route.ts:55`, post-commit Memory builder.
* Violates DERIVED-2 / RECOVER-1; classes 3, 4, 14. Death after successful ACCEPT/MODIFY commit but before route-level Memory build leaves no Memory creation and no ordinary recovery admission. Existing atomic invalidation and live retrieval fail closed, but cannot create the missing new derived object.
* Siblings: Memory manifest/source builder and recovery, observation reuse, scan publication pending markers, ordinary Bridge polling.
* Gap/design: fail after review commit then use normal recovery twice. Admit generation-bound pending Memory work in the authority transaction and recover it in bounded coordinator work; avoid holding one observation write lock while acquiring many other observation locks for an expensive global builder.

#### AUD-003 — P2 — Current-root read/watch predicate drift (REMEDIATED)

* Path: `remote-scan-queue.ts:528–557` (known inline 4208026617), `queueRemoteReads:514`, manual `remote-read-commands.ts:904`, `connected-libraries.ts:1275`, `remote-monitoring.ts:22`, `monitor.ts:1286`, command target/delivery in `cloud-coordinator.ts:453,697` and `recoverable-commands.ts:90`.
* Violates ROOT-1/3 / PRIVACY-2; classes 2, 9, 16. Hidden/merged/noncanonical/disconnected-at roots can still queue reads; queued work may dispatch after revocation; manual/local siblings and late watch events use smaller predicates.
* Cause: local status/permission copies and admission outside fresh shared authorization.
* Siblings: canonical helper, scan/read/media resolver, observation recovery, Search/Ask/Memory/Knowledge/preferences/plan current guards, native grants, cessation/management exceptions.
* Gap/design: every canonical field individually, valid/device mismatch, admission and dispatch, retained evidence control. Use canonical predicate plus exact device/root at current read/watch boundaries; fresh root share lock in command admission; preserve stronger operation grants and explicitly documented stop/repair/physical-history exceptions.

#### AUD-004 — P1 — Native/root reports overwrite later human state or another device (REMEDIATED)

* Path: `device-root-sync.ts:258–392`, `cloud-command-results.ts:932–1045`, `scan-sessions.ts:789`, remote scan result root update, native `filesystem/scanner.ts:312`.
* Violates ROOT-2 / CURRENT-2; classes 1, 2, 9, 13, 16. Cloud disconnect/hide can be undone by the next native sync; stale watch/permission/scan results can restore old root status/grants. Root sync finds global root identity then unconditionally writes a different device binding.
* Cause: report freshness/authority does not protect all root fields; update payload clears human lifecycle fields; global deterministic native root IDs are not permission to rebind devices.
* Siblings: fingerprint reconciliation/reconnect, confirmed permission anti-stale logic, disconnect/hide endpoints, native root registration, revocation, monitoring generations.
* Gap/design: delayed sync/scan/watch/permission report after disconnect/revoke; cross-device same root ID; explicit reconnect control. Serialize root state, preserve human lifecycle and device binding, persist/report native generation freshness, permit reactivation only on an explicit newer authorized connection action. Background scan success only updates scan diagnostics.

#### AUD-005 — P1 — Device revocation endpoint is publicly reachable (REMEDIATED)

* Path: `src/lib/auth/route-policy.ts:isSignedBridgeDevicePath` → `src/proxy.ts` → `src/app/api/bridge/cloud/devices/[deviceId]/revoke/route.ts`.
* Violates PRIVACY-2 / ROOT-2; class 16. An unauthenticated request to the revocation endpoint passes the broad public device-prefix exemption; the route has no signed-device or human guard and revokes the named device.
* Cause: public route classification is broader than signed-machine implementations.
* Siblings: every API route, Google auth/CSRF, signed device command/heartbeat/root/watch routes, pairing redemption, release manifest, legacy command APIs.
* Gap/design: proxy production-path unauthenticated and authenticated cross-origin revocation controls; exact signed-path allowlist, protected human revocation. Unknown descendants fail closed.

#### AUD-006 — P1 — Concurrent pairing code reuse (REMEDIATED)

* Path: public pairing redemption → `cloud-coordinator.ts:238–330`.
* Violates ROOT-2 / TX-1; classes 1, 2, 16. Two devices can validate the same ACTIVE code before either transaction consumes it; both upserts succeed and the code records only the last device. Same code can also replace a device key twice concurrently.
* Cause: one-use validation outside consumption transaction without lock/CAS.
* Siblings: device registration validation, pairing expiry/rate limit/audit, native identity/keychain, signed request nonce.
* Gap/design: real concurrent redemption with deterministic DB barrier and distinct keys; exactly one device/audit winner. Lock/revalidate code inside the transaction before device mutation and consumption; keep unique registration/key constraints.

#### AUD-007 — P1 — Revocation can be lost or partially applied (REMEDIATED)

* Path: `cloud-coordinator.ts:345–450`, heartbeat and revoke; signed request eligibility is read earlier in `device-request-auth.ts:155`.
* Violates ROOT-2 / TX-1 / CURRENT-2; classes 1–3, 16. Heartbeat reads PAIRED, waits, then sets ONLINE after revoke. Revocation writes device, command cancellation and root denial separately; death can leave a revoked device with current readable roots.
* Cause: stale unconditional heartbeat update and multi-commit authority propagation.
* Siblings: device sync/admission/delivery, root current evidence consumers, command expiry/results and pending execution/scan state.
* Gap/design: heartbeat/revoke barrier and child-write rollback fault. Atomic device/root/command/audit revocation, locked fresh device eligibility or update CAS that cannot clear revoked state, safe dependent-work reconciliation.

#### AUD-008 — P2 — Partial remote scan import and lifecycle replay (REMEDIATED)

* Path: `remote-scan-queue.ts:671–788`, `importRemoteBridgeScanReport`; local `scan-sessions.ts:648–746` has the same parent/child gap.
* Violates CURRENT-1 / TX-1 / RECOVER-1/2; classes 2–4, 14, 17. Death after first 500-file chunk leaves a partial session; retry sees nonzero child count and skips the remainder but reports full counts/complete work. Repeated terminal report can rewind an already complete scan to READING. A scan parent can also be left SCANNING before command admission/import finishes.
* Siblings: scan report parser, media metadata children, checksum bootstrap, observation reuse/read queue, command complete route, publication/current snapshot selection.
* Gap/design: trigger failure after first chunk/media row, retry twice, report replay after completion. Atomic bounded import or complete stable-key per-file reconciliation with owner lock and verified coverage; import completion cannot reset later lifecycle; session + scan command admission atomic.

#### AUD-009 — P2 — Recommendation batch ownership has no recovery/fresh completion (REMEDIATED)

* Path: `scan-recommendation-batch.ts:108–205`, `completeSession:71`, timeout failure:51.
* Violates CURRENT-2 / RECOVER-1/2; classes 2, 4, 14, 17. Death after status claim strands GENERATING_SUGGESTIONS forever. A timed-out promise continues writing, while unconditional failure/completion can overwrite newer file/session retry authority. An old batch can complete a session whose newly retried reads are unfinished.
* Siblings: local processing, manual read retry/reset/regeneration, recommendation per-file authority fences, publication epochs, coordinator/progress UI.
* Gap/design: expired ownership takeover, old worker after retry, active understanding at completion, process-death normal recovery. Durable batch generation/lease, owned heartbeat/CAS, fresh child coverage and completion transaction; abort/stale work cannot settle a newer generation.

#### AUD-010 — P2 — Library batch and cluster work is quadratic (REMEDIATED)

* Path: `processing-pipeline.ts:227,418` repeatedly loads all files; `scan-recommendation-batch.ts:140` finds in all files; `organization-suggestions.ts:2338–2690` expands all sibling files per target and scans relationships/clusters; `scan-working-knowledge.ts:970–1028` shifts BFS queue and filters all edges per component.
* Violates SCALE-3; classes 7, 8. 20,000 targets can fetch/process ~400 million sibling rows and repeatedly scan component edges. Existing typed/correction scale fixes do not cover this production batch.
* Siblings: checksum duplicate/media match helpers, suggestion pure algorithms, current authority/preference/Memory checks, local/cloud batch callers, result action lookup loops.
* Additional confirmed sibling before its remediation: `checksum-duplicates.ts:196–214` scans accumulated physical candidates for every row; `:95–109,721–722` filters/sorts the full same-checksum family for each file; `comparableSessionIdsFor:170–189` scans prior root aliases repeatedly. A 20,000-file duplicate family produces quadratic work even before recommendations. Preserve conservative physical alias/presentation exclusions while indexing identity and choosing deterministic distinct targets; chunk checksum/session IDs rather than unbounded IN lists.
* Gap/design: realistic synthetic 20,000-file and disjoint-component operation/query counters. Share immutable batch indexes for file IDs, folders, checksums/media, semantic postings, per-file adjacency/clusters; retain fresh per-target authority and eligibility. Cursor queue and edge adjacency for O(V+E); bounded local candidate selection, no loop × full library DB load.

#### AUD-011 — P1 — Machine graph refresh overwrites human curation (REMEDIATED)

* Path: `knowledge/graph.ts:367–512` upserts and `cleanupWorkflowKnowledgeNoise:1373–1478`, human reviews:1845–2055.
* Violates AUTH-1/3 / CURRENT-2; classes 1, 2, 11. Memory backfill can promote a REJECTED/ARCHIVED/KEEP_PROVISIONAL object or relation back to approved, replace human revised meaning with longer machine text, or cleanup a newly approved object after an earlier read. Concurrent read/modify/write loses evidence/source contributions.
* Cause: machine upsert/cleanup treats materialized status as inference authority without human-revision fence.
* Siblings: Memory/Notebook/observation/media/history graph producers, human review endpoints, merge and trustedReasoningFilter, recommendation context.
* Confirmed recommendation sibling: `organization-suggestions.ts:persistDrafts` protected only all-PENDING generations and otherwise invalidated APPROVED/MODIFIED/REJECTED recommendations during ordinary batch replay. The older regeneration regression intentionally exercised that unsafe default. Automatic generation now preserves reviewed active recommendations; `prepareOrganizationRecommendationRegeneration(..., { confirmedReviewedDecisions: true })` remains the explicit human transition that archives their approval and prepares fresh pending proposals. Update that regression to use the real confirmation path and add unconfirmed preservation assertions without removing its stale-approval/history checks.
* Gap/design: real backfill after reject/revise/keep, cleanup barrier after human review, contribution retry. Serialized owner mutation and explicit human-revision preservation; machine may refresh provenance but cannot overwrite saved human status/text/canonical choice. Human events/materialized state ordered atomically.

#### AUD-012 — P2 — Curated Knowledge merges can form canonical cycles (REMEDIATED)

* Path: `knowledge/graph.ts:2057–2205`, merge API.
* Violates AUTH-3 / FILE-1 / RECOVER-1; classes 1, 2, 4. A→B then B→A is accepted even when target is an archived redirect; concurrent opposite merges can do the same, leaving neither live canonical item and broken relation navigation.
* Cause: no canonical-target validation/lock order; relationship duplicate reconciliation may discard stronger human state.
* Siblings: object/relationship upsert, human object review, trusted graph queries, duplicate relationship merge history.
* Gap/design: sequential/opposite concurrent merges plus duplicate human relation. Lock graph mutation owners in stable order; reject noncanonical/archived targets or resolve a verified acyclic live canonical owner; preserve stronger relation authority and audit originals.

#### AUD-013 — P2 — Graph derives approved current trust from invalid Memory (REMEDIATED)

* Path: `knowledge/graph.ts:982–1031`, Memory backfill; observation backfill:1129–1193.
* Violates DERIVED-1 / PROOF-2 / SCALE-1; classes 5, 6, 10, 16. ACTIVE Memory with a modern incomplete/revoked/rejected provenance manifest is copied into HUMAN_APPROVED graph without live source validation. Raw non-REJECT decision budget can be consumed by repeated or no-longer-usable owners; MODIFY proposal text still mixes replaced machine meaning.
* Siblings: strict Memory retrieval/build SQL, explicit standalone human curation exception, graph historical Notebook/recommendation sources, recommendations' graph context and current QA exclusion.
* Additional confirmed sibling, recorded before its remediation: `memory-provenance.ts:89` admits a modern standalone-upload Memory statement after MODIFY changes the same observation's authority, because the manifest binds only the observation id. Rootless modern derivation must bind the exact latest non-NOTE decision too; the legacy standalone-note history exception does not authorize stale modern statements.
* Its recovery sibling is `memory.ts:855`: correction reconciliation selects only root-bound `MemorySearchSource` rows and misses a standalone manifest. Select either indexed retained manifest support or physical support and reconcile the complete family on the explicit human correction; never rebind stale wording to a fresh decision.
* Gap/design: modern invalid Memory ahead of valid sources, deep review history, human MODIFY replacement. Live Memory provenance before approved graph admission; keep explicit standalone human curation distinct; latest usable non-NOTE observation per owner before cap and use only authoritative edited meaning. Graph history remains history, not new QA authority.

#### AUD-014 — P2 — Notebook ignores/overwrites human meaning and approval (REMEDIATED)

* Path: `library/notebook.ts:338–417`, `saveNotebookEntryResponse:1456–1505`, display:274–301.
* Violates AUTH-3 / TX-1; classes 1–3, 11, 17. Revised text is written only into revision history while displayed/backfilled text stays machine-generated. APPROVE then REJECT/KEEP_ONLY leaves approvedForMemory=true. Machine backfill resets human approval/attention and can replace text after later source changes.
* Siblings: archive/restore, Notebook detail/timeline, graph Notebook source priority, optional historical reflections, explicit exclusion from Ask.
* Gap/design: revise/approve/reject/keep/archive then real backfill, concurrent updates. Serialize entry authority, materialize saved human text/flags with event; protect revised meaning/status from machine updates while refreshing source/history metadata.

#### AUD-015 — P2 — Notebook raw cap hides actionable categories (REMEDIATED)

* Path: `library/notebook.ts:1266–1297`, Notebook landing UI.
* Violates SCALE-1 / CURRENT-3; classes 5, 17. 250 archived attention rows or one high-volume category consume the raw window before filtering; valid current attention/questions/learning disappear from their advertised panels.
* Siblings: homepage eligible queries, archive retention, digest and category filters, graph backfill/source budgets.
* Gap/design: >250 ineligible/deep-owner rows and same-time controls. Independent SQL-filtered budgets by semantic category with deterministic ordering; retain accessible archive/history, no deletion to meet a cap.

#### AUD-016 — P1 — Remote execution claim and command admission are not atomic (REMEDIATED)

* Path: `remote-execution.ts:637–753`.
* Violates AUTH-4 / TX-1 / RECOVER-1; classes 2–4, 14, 15. Death after exact plan/run claim but before command creation leaves immutable PENDING execution with no recoverable job. If post-queue page refresh fails, the catch marks admitted run BLOCKED while the command can still execute, allowing another admission.
* Siblings: command creation/audit optional Tx API, plan exact revision CAS, native execution, remote Undo, pending expiry, plan UI refresh.
* Gap/design: command child fault rolls back claim, death after queue, post-queue presentation failure, competing plan/root changes. Claim/run/actions/command/audit in one fresh authority transaction; presentation errors cannot change queued authority; retain exact source snapshot checks and current operation grants.

#### AUD-017 — P1 — Remote result replay and unverified summaries corrupt execution truth (REMEDIATED)

* Path: signed complete route → `remote-execution.ts:764–921`, `remote-undo.ts:447–595` before `completeBridgeCloudCommand` terminal check.
* Violates RECOVER-2 / TX-1 / FILE-2; classes 2, 3, 13–15, 17. Retried old report can rewrite results/paths after later Undo; per-action/plan/run writes commit separately; report COMPLETED is trusted even if actions fail/missing, yielding falsely executed/undone UI. Undo path-only metadata update can bind a different replacement file.
* Siblings: scan/read report application, native action report shape, command terminal CAS, execution/Undo snapshots, scanned source binding, Notebook/history.
* Gap/design: report replay after terminal/Undo, invalid coverage/duplicate IDs/checksum/path, fault between action and run. Check terminal owner before effects; validate exact action IDs/paths/checksum/coverage; derive status/counts from verified outcomes; atomically apply DB report effects and terminal authority. Index results once, not find per action.

#### AUD-018 — P1 — Concurrent and partial remote Undo admission (REMEDIATED)

* Path: `remote-undo.ts:73–261,325–445`.
* Violates AUTH-4 / TX-1 / RECOVER-1 / FILE-2; classes 1–4, 13, 15. Concurrent previews both find no pending Undo and create two runs/commands; queue gap and page-refresh catch mirror execution. Partial retry includes already restored actions and can block safe completion. Current path row checksum can supersede immutable executed-file checksum.
* Siblings: local Undo owner transaction/completed-action filtering, execution history, native folder ownership/checksum validation, command expiry/report replay.
* Gap/design: deterministic concurrent UNDO, queue rollback, partial retry and external replacement. Lock execution owner; atomically admit run/actions/command; exclude completed reversals; immutable execution result checksum is restoration authority, with fresh native verification.

#### AUD-019 — P2 — Command acknowledgement/expiry strands dependent work (REMEDIATED)

* Path: `cloud-coordinator.ts:159,719–771`, `recoverable-commands.ts:80–100`.
* Violates CURRENT-2 / RECOVER-1/2; classes 2, 3, 14, 17. ACK read then unconditional update can downgrade a concurrently completed command. Expiring PENDING/ACK/RUN commands does not reconcile their execution/Undo/scan dependents; pending work can remain blocking forever, while executed-but-unreported work becomes unqueryable.
* Siblings: native replay/outbox, command report/terminal rules, scan/read recovery, plan ownership, execution/Undo UI.
* Gap/design: ACK/complete barrier, pending expiry and known/unknown physical outcomes. CAS monotonic status transitions; atomic safe unexecuted dependent failure/recovery; acknowledged uncertain physical work retains reconciliation/journal recovery, never assumed safely unexecuted.

#### AUD-020 — P1 — Replay marker cannot recover mid-execution physical outcomes (REMEDIATED)

* Path: `apps/bridge/src/main/command-runner.ts:421–510`, native `filesystem/operations.ts`, local compatibility executor/Undo.
* Violates TX-3 / RECOVER-1/2; classes 3, 4, 14, 15. Replay key is persisted before filesystem work, while complete result outbox is written only after operation returns. Death after one move yields recovery rejection with no completed action details; server can mark moved files failed and Undo cannot restore them. Local compatibility response loss has the same outcome gap.
* Siblings: native report outbox/keychain/replay, server result application, local API/executor/Undo, physical source identity and created-folder ownership.
* Gap/design: injected death after first physical move and before final report; normal restart/retry recovers exactly once and enables partial Undo. Durable per-command/action intent/outcome journal before each effect; reconstruct only verified outcomes using recorded source physical identity, fail closed for uncertainty; replay never blindly moves again.

#### AUD-021 — P1 — Destination check then rename can overwrite user files (REMEDIATED)

* Path: native `filesystem/operations.ts:290–510,614`, application `executor.ts` and `undo.ts:1112–1125` developer physical fallbacks.
* Violates TX-3 / FILE-2; classes 2, 15. Another process creates a destination after lstat/check and before POSIX rename; rename overwrites the unrelated file despite the advertised no-overwrite policy, during execution or Undo.
* Siblings: source checksum/stat check, safe-path/symlink resolution, journal crash ownership, CREATE/REMOVE_FOLDER behavior.
* Final self-review sibling: unlinking the public source pathname after an identity check can delete an editor's atomic replacement. Source removal now captures the pathname into a unique private same-volume directory, journals its directory identity before capture, verifies the captured inode/checksum, and removes only that owned internal name. A raced unrelated replacement is preserved/restored exclusively; recovery never unlinks the public source name. Real command-process death during capture and a later public replacement are permanent controls.
* Gap/design: deterministic destination insertion at operation boundary in native and fallback paths, content preservation, external source mutation. Shared exclusive destination primitive (no-overwrite claim), source identity verification and safe completion/journal integration; unsupported filesystem must fail closed without deleting user data.

#### AUD-022 — P1 — Local extraction binds changed bytes to old scanned identity (REMEDIATED)

* Path: `reader.ts:158–224,379–419`, local audio/video/image readers, unclaimed local `scanned-file-observations.ts:301–363`.
* Violates FILE-1/2 / PROOF-1 / CURRENT-2; classes 2, 9, 13, 16. Native read returns sourceChecksum but web path does not compare it to scan checksum; developer extraction has no before/after hash. Changed bytes can create observation/typed/provenance evidence under the old checksum. Unconditional stage writes can settle newer work.
* Siblings: strong remote completed-read checksum/lease path, native read verification, resolver/root permissions, observation commit and Search/QA metadata fallback.
* Gap/design: mutate source after scan/during extraction across local text/media, stale read vs newer generation. Shared expected-source verification at extraction and mutation, claim/CAS ownership, exact bound checksum carried into observation publication; failure cannot mutate a newer successful generation.

#### AUD-023 — P2 — Monitoring treats partial changes as full snapshot and applies stale events (REMEDIATED)

* Path: `monitor.ts:2244–2340,2503–2596,2634–2787`.
* Violates CURRENT-1/2/3 / FILE-2 / RECOVER-1; classes 2, 4, 8–10, 13, 14, 17. A one-file change creates a new completed scan containing only changed files, so current publication can retire unchanged library evidence. Delayed delete/path events mutate all snapshots by path (checksum optional), including newer replacements/history. Process-local batch admission can duplicate work; global active scan blocks unrelated root progression.
* Siblings: native/cloud watchers, full reconcile scan, baseline loading, completed-snapshot selection, publication/Search/Knowledge, monitoring restart lease, UI completion/reconcile claims.
* Gap/design: unchanged current file survives single change, delayed delete after replacement, retained path history, root independence and batch retry. Watch events trigger verified full-root reconciliation; events are hints, not source truth. Serialize root/batch ownership, use generation/identity for settlement and avoid rewriting retained historical provenance.

#### AUD-024 — P1 — Native registry/outbox read-modify-write loses grants/history (REMEDIATED)

* Path: `bridge-app/src/main/registry.ts:40–65,128–278,312–388`, command/event outbox persistence.
* Violates ROOT-3 / RECOVER-3 / CURRENT-2; classes 1, 2, 4, 15, 16. Concurrent watcher/status/permission/root mutations load the same JSON and overwrite one another; one can restore revoked permissions. Shared temporary filenames race. Corrupt existing storage is interpreted as empty and overwritten, erasing roots/pending outcomes rather than preserving diagnostic evidence.
* Siblings: single Electron instance/poll guard (does not serialize IPC/watcher mutations), keychain, native root sync, watcher event acknowledgement, command journal/report delivery.
* Gap/design: concurrent different/same root patch with deterministic storage barrier, corrupt-state preservation. Serialize local authoritative mutations, unique atomic replacement with durable flush; only ENOENT means initial empty state; malformed/unreadable existing state fails closed. Keep replay/outbox retention auditable.

#### AUD-025 — P2 — Local observation processing bypasses shared ownership (REMEDIATED)

* Path: `processing-pipeline.ts:143–175,319–360,380–434`, `scanned-file-observations.ts:301–363`, direct observe/read API.
* Violates CURRENT-2 / TX-1 / RECOVER-1; classes 1–4, 14. Two local processors can select the same file without a durable claim, make duplicate provider/observation work and overwrite stages/status after timeout or primary completion. Observation creation and file completion split when claimedAt is absent.
* Siblings: strong remote per-file observation lease, observation recovery/reuse, direct local/media reads, recommendation batch readiness, manual retry, exact provider source identity.
* Gap/design: deterministic competing local processing, death after observation parent and expired worker after success. All production generation uses the shared owned lease and atomic observation/file completion; guard local primary/failure writes by source/owner generation. No optional unowned production publication path.

### Recommendations and intentional non-findings

* **REC-001 (P3 recommendation):** Paginate the complete Notebook archive and large curated graph historical exports with a user-visible continuation if these surfaces grow. The audit will not silently truncate/delete historical evidence; actionable category starvation is separately AUD-015. Bounded display tails of already selected append-only history are not authority caps.
* **REC-002 (P3 recommendation):** Release updater manifest trust relies on HTTPS plus verified asset checksum and explicit open/install. Strong signed manifest distribution would be separate product work; no confirmed arbitrary-library operation or authorization bypass was established in the updater. The audit does not publish a release.
* **REC-003 (P3 recommendation):** Path containment checks cannot fully defend against a malicious local privileged process swapping directory components concurrently without OS descriptor-relative operations. Native symlink exclusion/containment remain; confirmed destination overwrite and ordinary source mutation are addressed, not hidden behind this limitation.
* Existing canonical current consumers, typed/version complete-family checks, correction O(V+E) traversal, human-confirmed relationships outside candidate bounds, source manifests, Search pending publication epochs, version/copy retention and context8/claim3 are controls, not defects to reimplement.
* `queueExecutionCommandForApprovedPlan` is exported legacy code with no production caller in the repository. It is not counted as a production-reachable defect. Production execution admission is audited through `queueRemoteOrganizationPlanExecution`.
* Installation-wide authenticated human access, management/history visibility, physical Undo of a historical approved snapshot, optional historical Notebook reflection and bounded model/excerpt/history tails are intentional contexts documented in the invariants. They cannot weaken current Search/Ask/root/read semantics.
* Serializable/CAS relationship, correction, preference and plan reviews can safely reject a conflicting writer instead of appending contradictory status history. Their existing tests remain controls. Do not add global locking or replace strict endpoint semantics merely for uniformity.

### Adversarial coverage and remediation evidence

All 17 classes map to register entries: concurrent authority 001/006/007/011/012/014/018/024/025; stale writers 001/003/004/007–009/011/016–025; source/derived gaps 002/007/008/016/017/019/020/025; partial retry 002/008/009/020/024/025; eligibility caps 013/015; per-owner latest 010/013 and existing typed/Search/QA controls; complexity/fanout 010/017/023; root drift 003/004; current/history 004/008/013/017/023; human candidate dominance 011/014 and existing confirmed correction controls; physical/semantic copies existing typed/version controls plus 017/018/022; strong identity 004/017/018/021–023; premature terminal 008/009/017/019/020/023/025; physical consistency 016–025; privacy/auth 003–007/013/022/024; UI truth 008/009/014/015/017/019/023.

The following production changes and their permanent production-path controls passed the complete final release gate. All register entries are REMEDIATED. Test names below refer to permanent production-path suites, not separate model implementations.

| Finding | Remediation and permanent proof |
| --- | --- |
| 001 | Observation owner UPDATE lock before authority read, strict next timestamp and id tie-break; latest non-NOTE retry authority; atomic event/status/invalidation/work marker. `system-invariants` runs both deterministic lock orders of ACCEPT/REJECT, ACCEPT/MODIFY and REJECT/MODIFY plus same-action/NOTE/Memory retry. |
| 002 | Review commits `PENDING@decisionId`; eager builder plus bounded fair ordinary poll recovery with exact generation CAS. Real Memory-child fault followed by two ordinary device polls; complete source-family structural controls. |
| 003 | Shared canonical seven-field read/watch predicate at admission, dispatch and local read boundary; fresh Device → Root authorization. Individual root fields, valid root/device mismatch, retained history, signed watch and rotated-key controls. |
| 004 | Exact native/device identity, monotonically explicit connection revision and native timestamp; sorted fingerprint reconciliation, preserve human denial and canonical duplicate ownership. Reconnect suite and late sync/revision/key/result invariant tests. |
| 005 | Public machine route classification is an exact signed implementation allowlist. Human revoke remains session/same-origin protected; auth/proxy tests exercise anonymous revocation, unknown descendants and cross-origin mutation. |
| 006 | Pair-code row lock/revalidation plus identity advisory lock, device write and consumption/audit in one transaction. Deterministic simultaneous different-key redemption has one winner. |
| 007 | Device/root denial, command cancellation and safe dependent-owner settlement atomic; fresh locked heartbeat/key authority. Barrier heartbeat/revoke, injected root-write rollback, key replacement and physical-history result controls. |
| 008 | Stable session/path identities, immutable inventory hash, 500-file imports and exact fresh key/revision/inventory owner; local complete import atomic. 601-file second-page fault, repeated retry and completed replay prove full coverage without lifecycle rewind. |
| 009 | UUID ten-minute recommendation owner, renewal, aborted 25-second model deadline, fenced result/failure/completion; physical generation/unresolved operation fences at claim and persistence. Abandoned ordinary poll, superseded worker, aborted late result, incomplete understanding, explicit regeneration and current-inventory controls. |
| 010 | Stable 500-file keyset pages, shared file/semantic/physical indexes and O(V+E) graph adjacency; 100-source independently durable duplicate-persistence pages with fresh tuple locks. Real 20,000-owner DB fault/retry and query/operation counters, existing 20,000/50,000 typed/correction fixtures. Progress uses DB aggregates, not a claim of constant DB work. |
| 011 | Curated graph machine updates share owner authority and preserve human revisions; cleanup rechecks human incidents. Automatic suggestion replacement preserves reviewed decisions; only explicit confirmed regeneration disputes/reset them atomically. Actual backfill/cleanup/approval/preference structural controls. |
| 012 | Shared/exclusive graph coordination, stable owner locks, live canonical merge validation and stronger human duplicate-relation preservation. Cycle/idempotent canonical/human relationship/history controls; opposite merge requests serialize on graph coordination before owner resolution. |
| 013 | Graph sources use live Memory provenance and latest usable non-NOTE authority before per-owner caps; MODIFY uses edited meaning. Modern standalone Memory binds exact decision and correction reconciles indexed complete manifests. Invalid-before-valid, deep history, changed human meaning and repeated source-family recovery controls. |
| 014 | Notebook owner serialization and monotonic revision order; materialized human text/approval/status; machine refresh preserves it. Conflicting review, revise/backfill, approve→keep/reject/archive and both archival entry points. |
| 015 | Independent SQL-filtered attention/question/learning budgets with deterministic ordering. One thousand archived attention entries cannot hide actionable categories; history retained. |
| 016 | Exact approved plan claim/run/actions/signed command/audit in one fresh Serializable authority transaction; post-admission presentation failure cannot change queued ownership. Child-command rollback, deterministic competing execution, cancelled plan and immutable action-source controls. |
| 017 | Exact indexed result sets/paths/checksums; complete child coverage determines parent truth; DB projection/result/command terminal state atomic; terminal replay has no effects. Invalid/duplicate/missing results, signed-completion rollback, replay after Undo and reconciliation/current Search controls. |
| 018 | Execution owner serializes Undo claim, actions and command; immutable executed checksums; exclude already completed original reversals across attempts. Concurrent Undo, partial retry, late first report, external mutation and real local database-gap controls. |
| 019 | Monotonic command CAS; expire only safely unstarted physical work, settle dependents atomically; acknowledged physical uncertainty stays recoverable. Pending expiry/ACK history, revocation/key settlement and real native replay controls. |
| 020 | Command journal before ACK; immutable per-action intent/link/source-capture/completion proof, restart recovery even after revoked polling. Local bounded action transaction plus journal-backed ordinary history recovery. Actual child-process death at ACK, after effect and during source capture; DB-gap/partial Undo controls. Legacy local owners lacking both captured authority revision and journal proof remain visibly unresolved on repeated ordinary recovery; missing proof cannot authorize a repeated effect or invented terminal failure. |
| 021 | Exclusive hard-link destination, verified inode/checksum and private source capture; same-volume requirement fails closed. Destination insertion, editor source replacement, captured crash, no repeated effects and created-folder ownership native controls. |
| 022 | Native expected checksum plus local before/after SHA/inode/size/time validation, shared lease and scoped write guard through all four readers. Real document/audio/video/image changed-source entry points and late local writer controls. |
| 023 | Watch events are hints for a full inventory; renewable root/batch generation, revision and watch state fence; exact latest-scan baseline and indexed events. Unchanged current/history survives delayed delete; concurrent claims produce one command; signed hint denial/key fences. |
| 024 | Serialized local read/modify/write, exclusive UUID temporary file, flush/atomic rename; only ENOENT initializes empty state. Real concurrent registry/outbox writes and byte-preserving corruption; existing connection fault/retry controls. |
| 025 | Every local producer uses the shared owned observation lease, fresh root/key/revision/physical generation and atomic document/observation/file/counters; only exact owner may fail/release. Abandoned file ordinary recovery, competing/expired writer, downstream completion and existing media simultaneous-report controls. |

Permanent gate: `npm run test:invariants` includes `system-invariants.test.ts`, `structural-derived-state.test.ts`, `scan-publication-recovery.test.ts` and `knowledge-eligibility-caps.test.ts` with concurrency one. The existing release quality job runs it after Memory, before the unchanged full Phase1–3 workflow. `test:bridge` includes the three new native invariant files and real process fixture. No redundant CI pipeline was created.

Final self-review checked cross-subsystem authority, eligibility, deadlock order, scope, replay/history, physical inventory, privacy and scale. New sibling corrections were included in their original finding classes: physical outcome epochs fence reads/recommendations/current publication; stale connection revisions cannot regain grants with a newer clock; key replacement settles unstarted owners; Notebook archive clears approval; NOTE cannot create duplicate authority; native source capture closes the public-name unlink race. Root UPDATE precedes physical run ownership, and Device → Root → command → scan ordering protects signed import/admission; publication and source builders retain independent per-root/owner locks. Provider/extraction/full scan I/O stays outside authority transactions; one local physical action is the documented bounded 120-second exception with a durable journal. Duplicate persistence commits independent 100-source pages rather than holding a whole-library write transaction.

Existing regression expectations changed only where the audited contract proved the old expectation incorrect: reconnect fixtures now provide explicit connection revision 2; native atomic-writer faults target actual UUID rename rather than an obsolete fixed temp name; physical completion initially admits REQUIRED reconciliation and ordinary full-scan publication proves completion; automatic machine regeneration preserves APPROVED support/preference history rather than disputing it. Existing explicit human reset/regeneration rollback, checksum, root, complete-family, context8/claim3 and 20,000/50,000 fixtures remain intact. Restored permission error categories and JSON semantic equality were production fixes. New pairing-key assertions compare the boundary's canonical trimmed public key.

Final validation passed on the frozen production/configuration/test source, using only disposable localhost PostgreSQL, synthetic files, mocked AI and unset OPENAI_API_KEY. The final remaining database gates ran sequentially after parallel large Serializable fixtures exceeded PostgreSQL predicate-lock shared memory; no scale fixtures or safety assertions were reduced. The two Bridge skips are existing Windows symlink controls requiring privileges unavailable to this account. Full native macOS packaging/publication was not invoked. Legacy physical owners without journal proof remain visibly unresolved for human inspection, without repeated moves or invented outcomes. No confirmed P0/P1/P2 remains unresolved. Ephemeral logs and the full local commit report stay outside the repository.

| Final gate | Result |
| --- | --- |
| `test-invariants` | 141 passed / 141 tests |
| `workflow` | 367 passed / 367 tests |
| `qa-suite` | 132 passed / 132 tests |
| `convergence` | 63 passed / 63 tests |
| `provenance` | 36 passed / 36 tests |
| `claims` | 21 passed / 21 tests |
| `lifecycle` | 36 passed / 36 tests |
| `publication` | 12 passed / 12 tests |
| `eligible-caps` | 18 passed / 18 tests |
| `refresh` | 3 passed / 3 tests |
| `copies` | 8 passed / 8 tests |
| `observations` | 7 passed / 7 tests |
| `test-bridge` | 344 passed / 346 tests; 2 existing platform skips |
| `native-command` | 15 passed / 15 tests |
| `legacy-controls` | 4 passed / 4 tests |
| `test-memory` | 9 passed / 9 tests |
| `test-auth` | 9 passed / 9 tests |
| `test-protocol` | 49 passed / 49 tests |
| `migrations` | PASS; schema valid, 35 migrations deployed/up to date |
| `db-generate` | PASS |
| `lint` | PASS |
| `build` | PASS |
| `build-bridge` | PASS |
| `source-typecheck` | PASS |
| `diffcheck` | PASS |

## Final architecture audit closure of eab21e3

Exact baseline: `eab21e320840f6ca9e2ca4f85d41f4637a7f2e7b`, release branch and fetched origin identical, tracked worktree/index clean. Review `5449751760` confirmed three residuals. This section supersedes the preceding audit's broader assurances at these boundaries. All 35 migrations and the Prisma schema remain unchanged. Raw logs, validation counts, commit identity and hash evidence are recorded externally after validation.

* **4213170295 / P1:** Execution and Undo requested reconciliation unconditionally. Generation now advances only for newly verified changed actions. Explicit bound no-effect failure, an existing folder and replay preserve it. Missing/unverified results retain pending command/human-inspection authority. Action projection, generation, old-scan retirement and durable reconciliation admission share one transaction. Ordinary reconciliation includes FAILED parents, with fresh terminal owner/child and generation/revision checks. The baseline regression observed epoch 1 instead of 0 and current evidence invalidation.
* **4213170299 / P1:** Abandoned recovery wrote scan state using a stale lease selection. It now locks Device → Root → read commands → Scan → File and rechecks lifecycle, physical generation, canonical root, key/revision, exact lease and extraction before mutation. Terminal/retired/new-owner work is unchanged. Eligibility precedes the 50-file window. The baseline deterministic race revived FAILED as READING; new controls reject that worker and allow reconciliation.
* **4213170306 / P2:** Migration 35 invalidated old sourced Memory, but recovery required Bridge polling. Authenticated Memory/Search/Ask now admit one eligible durable owner per request with a nonblocking advisory lock, five-second transaction deadline and bounded failure rotation. Failed interactive work can schedule the same generation in a bounded 120-second Next post-response attempt. Both use the existing transactional complete-provenance builder; cancellation leaves pending work durable. Actual populated 34→35 HTTP tests have no Bridge device or poll and never manually invoke recovery. Baseline Memory and Search left valid sourced Memory untrusted.

Sibling verification exposed a local compatibility regression after missing action journals became explicitly unknown: a revoked modern local run could not prove that later actions were untouched. Local execution/Undo now admit durable PREPARED proof, then separately commit an exact STARTED owner before filesystem work. Only that owner can start an operation under fresh locked grants. Recovery settles denied PREPARED work as no-effect, recovers bound journals, or preserves STARTED/legacy uncertainty. The original revoked-local regression remains and is strengthened with durable phase, byte preservation, generation and replay assertions. Native commands retain analogous PREPARED/STARTED proof bound to the signed command; legacy replay markers cannot manufacture preparation evidence.

Native sibling inspection also confirmed that successful ACK/current grants could re-enter execution for a STARTED or legacy historical command. Both production polling counterfactuals failed before correction. Such commands now use journal-only recovery even while authorized, preserving unknown outcomes and source/destination bytes instead of admitting another filesystem effect. Exact PREPARED proof still allows a genuinely unstarted authorized command to begin.

Final outcome inspection reproduced another native proof gap in both execution and Undo: an interrupted captured source plus an externally removed destination left a durable action journal without a verifiable outcome, but live failure settlement classified it as no-effect. Existing unresolved journals now remain PENDING/UNKNOWN. Both actual native operation counterfactuals failed before correction (19/21 passed) and pass afterward (21/21), preserving captured bytes and never claiming an absent effect from absent public names.

The existing stale-read restart fixtures previously wrote only a lease timestamp. They now acquire a real production observation lease before simulating expiry, retaining all original restart/completion/idempotency assertions while supplying captured root/key authority. Explicit missing-authority controls remain fail closed. Unknown physical children also carry the recovery category, so the execution panel describes uncertainty instead of implying no filesystem effect occurred.

Production regressions use PostgreSQL barriers, actual process termination before/after outcome commit, competing observation workers, concurrent HTTP requests, a killed/restarted web process and a source family exceeding the interactive deadline. Cross-system inspection retains atomic command outcome/terminality, immutable action identity/checksum, partial Undo, current publication fences, latest human authority, complete source families, append-only history, canonical grants and context8/claim3. Notebook/curated graph continue using their existing live-provenance rules.

### AUD-001 through AUD-025 closure verification matrix

Paths below are relative to `src/lib/` unless prefixed otherwise. Integration suite names refer to `tests/integration/*.test.ts`; native suites live under `bridge-app/tests/`. Each row combines current code inspection, the documented invariant and actual production-path regressions. Results are updated after the complete validation gate.

| ID | Protected invariant | Production files | Production-path regression | Result | New issue / disposition |
| --- | --- | --- | --- | --- | --- |
| AUD-001 | AUTH-2/TX-1 serialized human authority/events | `library/observation-sessions.ts`, `db/authority.ts`, `library/memory.ts` | system-invariants conflicting ACCEPT/REJECT/MODIFY and same-action/NOTE retry | PASS | Fresh builder authority retained |
| AUD-002 | DERIVED-2/RECOVER-1 durable review-to-Memory work | `library/observation-sessions.ts`, `library/memory.ts`, `library/memory-recovery.ts`, protected scheduler endpoint and optional web accelerators | system-invariants committed review fault/poll; audit-closure-upgrade HTTP recovery; scheduler-only 120-owner actual-upgrade, overlap, fairness, death/restart and authority races | Local worker proof; production activation separately required | Request reachability alone did not establish autonomous recovery; independent scheduled consumer closes the code defect |
| AUD-003 | ROOT-1/3 canonical grants before read/watch | `bridge/current-readable-root.ts`, `bridge/remote-scan-queue.ts`, `bridge/remote-read-commands.ts`, `bridge/cloud-coordinator.ts`, `bridge/monitor.ts` | system-invariants each canonical field, valid/device mismatch and signed watch/key | PASS | Fresh observation recovery now shares authority |
| AUD-004 | ROOT-2/CURRENT-2 reports preserve newer human/device state | `bridge/device-root-sync.ts`, `bridge/cloud-command-results.ts`, `bridge/scan-sessions.ts` | connected-libraries-reconnect; system-invariants late sync/revision/key/import | PASS | Recovery checks exact key/revision |
| AUD-005 | PRIVACY-2 authenticated same-origin human revoke | `auth/route-policy.ts`, `src/proxy.ts`, human revoke API | human-auth anonymous revoke, unknown descendants, cross-origin mutation | PASS | Web recovery follows human guard |
| AUD-006 | ROOT-2/TX-1 pairing code consumed once | `bridge/cloud-coordinator.ts` | system-invariants simultaneous distinct-key redemption | PASS | Admission unchanged |
| AUD-007 | ROOT-2/TX-1 atomic revoke/fresh heartbeat | `bridge/cloud-coordinator.ts`, `bridge/device-request-auth.ts` | system-invariants heartbeat/revoke barrier, root-write fault, rotated keys | PASS | Physical-history permission remains distinct |
| AUD-008 | CURRENT-1/TX-1 complete import/no lifecycle rewind | `bridge/remote-scan-queue.ts`, `bridge/scan-sessions.ts` | system-invariants 601-file fault/replay and atomic command admission; scan-publication-recovery | PASS | Late recovery cannot revive retired scans |
| AUD-009 | RECOVER-1/2 generation-owned recommendation lifecycle | `bridge/scan-recommendation-batch.ts`, `bridge/recommendation-batch-authority.ts` | system-invariants abandoned poll, superseded/aborted worker, inventory controls | PASS | Recovery rejects newer lifecycle |
| AUD-010 | SCALE-3 bounded pages and indexed O(V+E) work | `bridge/processing-pipeline.ts`, `bridge/organization-suggestions.ts`, `bridge/scan-working-knowledge.ts`, `bridge/checksum-duplicates.ts` | system-invariants real 20,000-owner paging/fault/retry/counters; workflow/convergence 20,000/50,000 | PASS | No pairwise scan or reduced assertion |
| AUD-011 | AUTH-1/3 machine refresh preserves curation | `knowledge/graph.ts`, `bridge/organization-suggestions.ts` | system-invariants graph backfill/review; structural-derived-state reviewed suggestions/preferences | PASS | Memory rebuild retains human decisions |
| AUD-012 | AUTH-3/FILE-1 acyclic canonical graph merge | `knowledge/graph.ts` | system-invariants cycle/stronger human relationship/history; graph workflow controls | PASS | Graph coordination unchanged |
| AUD-013 | DERIVED-1/PROOF-2 live complete Memory before graph trust | `knowledge/graph.ts`, `library/memory-provenance.ts`, `library/memory.ts` | system-invariants invalid-before-valid/deep history/exact standalone decision; structural family controls; upgrade invalid-source controls | PASS | No rebinding of stale/rejected/denied wording |
| AUD-014 | AUTH-1/2 Notebook human text/status outranks refresh | `library/notebook.ts`, `db/authority.ts` | system-invariants revise/backfill/conflicting review/archive/keep | PASS | Notebook trust/history unchanged |
| AUD-015 | SCALE-1 independent eligible Notebook budgets | `library/notebook.ts` | system-invariants 1,000 archived attention rows/category visibility | PASS | Eligibility caps unchanged |
| AUD-016 | AUTH-4/TX-1 exact execution claim/run/command atomic | `bridge/remote-execution.ts`, `bridge/plan-execution-authority.ts`, `bridge/cloud-coordinator.ts` | system-invariants child fault/simultaneous execution; connected-library-execution admission | PASS | Approval/admission unchanged |
| AUD-017 | RECOVER-2/TX-1/FILE-2 proof-bound atomic reports/replay | `bridge/remote-execution.ts`, `bridge/remote-undo.ts`, `bridge/physical-result-authority.ts`, signed complete API | system-invariants coverage/identity/atomic completion; CLOSURE-1 no-effect/unknown/partial/replay/process-death | PASS | Unconditional reconciliation fixed by 4213170295 |
| AUD-018 | AUTH-4/FILE-2 one Undo owner/immutable restoration checksum | `bridge/remote-undo.ts`, `bridge/undo.ts`, `bridge/physical-result-authority.ts` | system-invariants simultaneous/partial Undo/replay/real local Undo; connected-library-execution | PASS | Only verified reversals advance inventory |
| AUD-019 | CURRENT-2/RECOVER-1 monotonic commands/explicit uncertainty | `bridge/cloud-coordinator.ts`, `bridge/recoverable-commands.ts`, signed complete API | system-invariants expiry/unstarted/acknowledged controls; protocol; signed empty-result recovery | PASS | Unknown retains recoverable RUNNING command |
| AUD-020 | TX-3/RECOVER-1 durable journals/no blind retry | `apps/bridge/src/main/command-runner.ts`, `apps/bridge/src/main/command-journal.ts`, `bridge-app/src/filesystem/operations.ts`, `bridge/local-physical-recovery.ts` | native command death at ACK/effect/capture, authorized legacy/STARTED retry and execution/Undo unresolved-journal settlement; system-invariants local move/Undo gaps, revoked remaining actions, legacy uncertainty | PASS | Local phase proof, native journal-only retry and uncertain live outcomes fixed |
| AUD-021 | TX-3/FILE-2 exclusive destination/owned source removal | `bridge-app/src/filesystem/safe-move.ts`, `bridge-app/src/filesystem/physical-journal.ts`, native operations/local recovery | physical-recovery-invariants destination/source races/capture death/folder Undo; execution controls | PASS | Safe primitives/journal identity retained |
| AUD-022 | FILE-1/2/PROOF-1 extraction binds bytes and owner | `bridge/reader.ts`, local media readers, `library/scanned-file-observations.ts` | system-invariants document/audio/video/image changed bytes/expired-reader guard; Bridge media lease/reuse | PASS | Abandoned completion also checks extraction/checksum |
| AUD-023 | CURRENT-1/2/FILE-2 watch hints produce full owned snapshots | `bridge/monitor.ts`, `bridge/remote-scan-queue.ts`, publication helpers | system-invariants full snapshot/history/concurrent batch; scan-availability/publication recovery | PASS | Failed-parent reconciliation recoverable |
| AUD-024 | ROOT-3/RECOVER-3 durable serialized registry/outbox | `bridge-app/src/main/registry.ts`, local JSON and command/report/event persistence | local-state-invariants concurrent writers/corruption; native durable replay | PASS | Phase proof keeps legacy/corrupt fail-closed behavior |
| AUD-025 | CURRENT-2/TX-1 shared observation lease/atomic completion | `bridge/processing-pipeline.ts`, `bridge/observation-authority.ts`, `library/scanned-file-observations.ts`, `bridge/observation-recovery.ts` | system-invariants local reclaim/old reader; CLOSURE-2 physical/lease/lifecycle races/idempotency | PASS | Stale recovery fixed by 4213170299 |

Final closure validation: 26/26 application closure regressions, 167/167 permanent invariant tests, 367/367 exact full workflow tests, 132/132 Ask tests, 350 passed of 352 Bridge tests (two existing Windows symlink skips), and 21/21 native recovery tests. Convergence/provenance/claims/lifecycle/publication/eligibility/refresh/version/observation/Memory/auth/protocol gates, all 35 migrations, schema validation, Prisma generation, lint, production build and source/Bridge typechecks pass. Complete raw counts, baseline RED counterfactuals and Git/diff/hash evidence are retained in the external final closure report.

Limits: privileged Windows symlink controls, macOS-specific packaging, serverless termination before post-response completion and malicious privileged directory swaps remain outside complete automated proof. Durable pending generations survive web cancellation for ordinary retries. Legacy physical owners without proof remain unresolved for inspection. Provider behavior is tested with mocks; upgrade HTTP Ask has no provider key and proves recovery/retrieval rather than a live model answer. No publication, promotion, push or additional Codex review is part of closure.

### Independent Memory scheduling correction

The subsequent 120-owner verification at `e9eed266` reproduced an architectural liveness gap: one Memory visit restored one owner, then 119 remained pending after 180 seconds and a restart plus 60 seconds without requests. The previous HTTP regressions proved request-driven reachability, not independent scheduling. That observation supersedes the earlier autonomous-recovery interpretation of AUD-002.

The protected cron consumer now reuses exact pending generations and the canonical builder with independent owner transactions, bounded work, overlap safety, durable UTC retry fairness and safe aggregate health/UI. The permanent regression uses actual migrations 34, 35 and additive 36, one Memory visit and only configured scheduler HTTP thereafter. Baseline RED is retained externally. All earlier migrations are unchanged. Read-only Vercel inspection identified the project and SSO protection, but not its billing/runtime/cron activation metadata; the checked-in daily expression is compatible with documented plan tiers. Production activation, protection reachability and acceptable cadence remain operational gates, not claims established by local green tests. See [MEMORY_RECOVERY_OPERATIONS.md](MEMORY_RECOVERY_OPERATIONS.md).

Revalidation limitation: the unchanged native folder-Undo ownership assertion failed once on Windows, while the full Bridge run, subsequent complete native runs and 100 direct journal reproductions passed. Separate probes observed numeric file-ID precision loss but did not reproduce an identity collision or incorrect removal. The cause of that single failure remains unconfirmed; its log and probe evidence are retained externally. This focused change makes no native/filesystem modification and does not claim that intermittent platform-control failure is resolved.
