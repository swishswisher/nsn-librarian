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
