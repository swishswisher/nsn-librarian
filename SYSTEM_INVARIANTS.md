# System invariants and engineering gate

The machine suggests. Deanne decides. Nothing moves without approval. These requirements implement [PRODUCT_CONSTITUTION.md](PRODUCT_CONSTITUTION.md). Use the [architecture map](SYSTEM_ARCHITECTURE.md), [change-impact map](CHANGE_IMPACT.md) and [finding register](STRUCTURAL_DERIVED_STATE_AUDIT.md) together. The baseline audit discovered violations; the register records them until production-path regressions and final validation prove remediation.

## A. Human authority

**AUTH-1.** Machine proposals never become human approval merely through persistence, candidate selection, confidence or backfill. ACCEPT/APPROVE authorizes only the reviewed meaning and scope. MODIFY replaces the relevant machine meaning with the saved human text/destination. REJECT excludes it. NOTE is append-only context and does not replace non-NOTE authority. SEPARATE blocks a machine join. Confirmed correction/relationship authority survives bounded recomputation.

**AUTH-2.** Latest non-NOTE observation authority is ordered by createdAt descending then id descending. Authority writes lock before reading previous state and assign a strictly increasing timestamp for that owner after lock acquisition; database transaction-start defaults are insufficient after lock waits. Status, event and meaning must agree after every successful conflicting request. Same action + same text/note + matching current state is idempotent. A stale version-CAS review may return 409 instead of winning; it must not partially append an event or overwrite status.

**AUTH-3.** Graph and Notebook human revisions protect status, approval, edited meaning and merge choice from machine backfill. Machine evidence can be refreshed without erasing human truth. Merges resolve only to a live canonical object and cannot form a cycle. Rejection/keep-only/archive revoke Notebook's current approval flag. Saved human text is the text shown and used by later derivation.

**AUTH-4.** Suggestion approval, plan approval, execution and Undo are distinct intents. Plan approval performs no filesystem operation. Explicit EXECUTE claims the exact approved plan snapshot; explicit UNDO admits restoration of verified completed actions only. Permissions alone are never operation approval.

## B. Authority and derived state

**DERIVED-1.** Review events → materialized review status. Complete physical scan/read identities + effective human evidence → Knowledge/signals/version projections. Current Knowledge/document state → Search. Approved current observation sources → Memory. Reviewed organization decisions → preferences. Exact approved plan → execution. Verified physical outcomes → execution/Undo history. Cache/index/status/completeness is not independently authoritative.

**DERIVED-2.** Every correctness-significant derivation commits with its source transition or has durable pending work admitted in that source transaction. Best-effort UI/Notebook reflection is allowed only when it cannot publish current evidence or falsely assert completion. Memory creation after approval must recover after process death; atomic invalidation alone does not create missing new Memory.

## C. Currentness and snapshot ordering

**CURRENT-1.** Select the latest complete usable scan per root by startedAt descending/id descending. Pending, failed, partial watcher imports and incomplete discovery are not complete snapshots. A complete snapshot's file set is exhaustive for its declared root; a changed-files batch cannot retire unchanged files.

**CURRENT-2.** Older work cannot retire/overwrite newer current state. Fresh currentness/root/source authority must be checked inside the actual mutation transaction, under the shared root protocol or exact generation CAS. Earlier checks, process-local flags and captured arrays do not authorize later writes. A stale lease owner cannot settle success/failure or primary completion for a newer generation.

**CURRENT-3.** Retain historical scans, decisions, signals, corrections, plans, outcomes and provenance. History intent must not silently use current-only fallback. Current Search/Ask/Memory cannot use superseded/rejected history as current grounding. UI status must distinguish primary progress, pending derived publication and historical outcome from present filesystem state.

**CURRENT-4.** Physical inventory uses a database generation, not wall-clock comparison. Discovery captures `ConnectedLibrary.physicalInventoryGeneration` before I/O; `ScanSession.inventoryGeneration` must still match at import/publication. A verified execution/Undo outcome increments the root generation in the outcome transaction and retires old active scan/read work without changing completed history. Pending/running physical work blocks inventory publication and current grounding; recovery of its journal/outcome precedes a new complete inventory. Execution reconciliation is complete only after that inventory's Knowledge and Search stages both commit.

## D. Root/library authorization

**ROOT-1.** Current readable canonical connected root uses all seven fields in `current-readable-root.ts`: enabled=true, readPermission=true, status=CONNECTED, disconnectedAt=null, hiddenFromActiveListAt=null, mergedAt=null, canonicalConnectedLibraryId=null. Use its ORM, SQL or in-memory form; do not invent weaker copies. Optional permitted-root IDs and required device/native-root bindings are additional restrictions.

**ROOT-2.** Device signed identity must remain eligible at mutation/delivery, not just at an earlier authentication read. Revocation, native sync, heartbeat and result replay cannot revive a later human revocation/hide/disconnect/merge. Device/root binding is exact; null or conflicting binding cannot authorize a command. Reconnect requires an explicit new human/native connection action. A pairing code admits at most one device/key, atomically with consumption and audit.

**ROOT-3.** New discovery/read/watch/recommendation/plan authority requires current Root and additional operation grants. Recheck at command admission and dispatch. Local native grants are independently checked immediately before physical actions. Permission changes cannot be lost through concurrent local registry writes.

**ROOT-4.** Reconnect is a strictly newer native connection revision; ordinary sync cannot clear denial. Stale native update times cannot replace current state. Device key replacement fences captured read/report/delivery authority. Fingerprint reconciliation locks all candidate roots in stable order, preserves the record owning the native identity, merges duplicates and relinks retained history atomically. An apparently active duplicate cannot replace that record's denied authority.

Intentional exceptions:

* Authenticated root management/reconnect/history navigation can include disabled/hidden/paused/merged roots for repair/audit. Merely viewing them grants no read or derivation.
* STOP/PAUSE/revocation decreases activity and can target an otherwise unreadable root, with exact device/root binding. Permission updates may repair an unreadable root only through explicit human authorization.
* Execution/Undo uses historical immutable approved actions rather than requiring the latest scan to be the original execution scan. It still requires live physical root availability, action permissions, expected identity and explicit intent. Restoring history does not revive current knowledge or silently grant arbitrary temporary reads.
* Human upload/standalone Memory curation and Notebook/curated graph history can retain human material outside a current scanned root. Application grounding requires complete current provenance; Notebook narrative is excluded from Ask.
* Signed completion may retain a verified historical physical result after access cessation so audit/Undo is not lost. It cannot admit another read, restore permission, execute new work or override later terminal authority.

## E. File identity

**FILE-1.** Current evidence binds connected root + normalized physical fileKey/path + nonnull checksum + owning document/session/current snapshot, as required by the consuming contract. The canonical physical identity helpers account for platform case rules and root aliases. A known document checksum must match; legacy null document checksum still requires exact document/file binding.

**FILE-2.** Path-only joins cannot attach new content/corrections to an old typed identity, mark a newly replaced file deleted, redirect historical provenance or restore a different file during Undo. Temporary reads verify the scanned expected checksum plus before/after physical identity. Commit uses the same source generation. Strong identity checks also apply to metadata/AI/media fallbacks and replay.

**FILE-3.** Keep physical copies available for root authorization/discovery. Collapse byte-identical semantic copies only after complete effective typed/version metadata agrees. Copies are not independent corroboration or contradictory revisions. Complete-family ambiguity fails closed before bounded source selection.

## F. Transactions and physical atomicity

**TX-1.** Human event ↔ materialized state ↔ source invalidation ↔ durable reconciliation admission is atomic. Recommendation replacement ↔ history ↔ preference disputes is atomic. Plan claim ↔ run/actions ↔ signed queued command/audit is atomic. Imported file children ↔ scan import completion is atomic or fully idempotent on every retry. Derived stage writes ↔ stage completion/retirement is atomic under current root authority.

**TX-2.** Provider calls, extraction and full inventory I/O run outside database authority transactions. Local physical execution is a deliberate exception: one immutable action's filesystem call and outcome publication share a root/run authority transaction bounded at 120 seconds, backed by the durable native action journal. It contains no AI work or whole-library scan. Use stable lock order; database deadlock/serialization failure returns a safe retry/conflict. Long full-library publication already has its scoped bounded stage transaction; never add a global owner bottleneck. Different roots must progress independently.

**TX-3.** PostgreSQL cannot atomically commit a filesystem move. Admit a durable local operation journal before work, record/recover each physical outcome, and apply reports idempotently. Exclusively create destinations; a check followed by POSIX rename can overwrite another file and is forbidden. Never delete/overwrite an unrelated destination. Capture source removal into a unique private same-volume directory, journal its ownership before rename, verify the captured inode/checksum and remove only its internal name; never unlink the public source pathname after a check. Raced editor replacement bytes remain intact. Unknown crash outcomes preserve evidence and require reconciliation, never blind retry or invented failure/success.

## G. Retry, recovery and idempotency

**RECOVER-1.** Every owned long operation has a durable claim/generation, expiry/recovery path and mutation fence. Replay converges to uninterrupted semantics. Stable parent existence does not prove child/provenance completion. A nonterminal claim cannot remain unrecoverable solely because its process died.

**RECOVER-2.** Primary terminal status requires complete validated child coverage and already durable/recoverable downstream work. Report summary status cannot override missing/failed actions. Expiry/cancellation/acknowledgement cannot race completed authority backward or strand a dependent run/scan. Report replay must check terminal state before any side effect and preserve the first committed terminal outcome and subsequent Undo.

**RECOVER-3.** Persistent local registry/journal/outbox corruption fails closed and preserves the original bytes for diagnosis; it must not masquerade as empty state and erase grants, pending results or history. Serialize read/modify/write and atomically replace the file. Local polling serialization is not a substitute for per-action crash records.

**RECOVER-4.** Ordinary Bridge polling/history navigation discovers durable work without a second human authorization to repeat the physical effect. Memory recovery owns the exact non-NOTE review generation; recommendation recovery owns a renewable ten-minute generation; watch discovery renews its ten-minute owner during I/O. Physical recovery reads the journal bound to the exact action/path/checksum/original Undo owner. Reconciliation owns its execution generation, connection revision and scan ID. Partial Undo retries exclude already completed original actions across all prior attempts. Delivered native reports leave the hot pending directory while retained journals continue to prove history.

## H. Bounds and scale

**SCALE-1.** Semantic eligibility (authorization/currentness/type/checksum/actionability/owner) precedes its result cap. Raw-row caps followed by eligibility filtering are forbidden on correctness-significant paths. Latest per owner is independently selected; one owner's deep history cannot starve another. Stable pagination uses timestamp + unique id where ordered by time; no timestamp-only cursor gaps.

**SCALE-2.** Work windows can cap resumable claims after eligibility; excerpt/term/model/output/history-display tails can cap already selected evidence. Preserve complete typed/family validation and human authority outside machine candidate bounds. No shortcut may lower existing 20,000/50,000 test fixtures.

**SCALE-3.** Library graph work is O(V+E) with indexes/adjacency/cursor queues. Batch processing cannot load/filter the entire library separately per file, rescan all edges for every component or linearly find each result inside an action loop. Use shared indexes, chunked safe SQL parameter lists and bounded query fanout. Prove scale with operation/query counters where practical, not wall time alone.

## I. Provenance

**PROOF-1.** Source excerpts/ranges are verified against authorized bound content. Typed relationship/version proof uses effective human-reviewed typed evidence and exact endpoints. Human MODIFY does not retain the replaced machine meaning as approved evidence. Source completeness must be established for every required source, not guessed from filenames or one available contribution.

**PROOF-2.** Memory requires a nonempty required-source manifest, all durable required sources, expected count, every stored source live and eligible, and latest valid human authority. Search/Ask revalidate live provenance regardless of cached flags. No consumer may silently weaken the same proven source contract.

**PROOF-3.** Ask context ≤8 sources and **global** claims ≤3 including deterministic/version/provider claims; one excerpt/file. Deterministic bounded selection cannot conceal ambiguity or incomplete family proof. Notebook prose and bare metadata filenames cannot substitute for required typed evidence.

## J. Privacy and cloud boundary

**PRIVACY-1.** Original local files/unrestricted absolute paths/media remain local physical truth. Only explicitly authorized temporary extraction and the approved bounded derived evidence cross to server/provider. Follow the exact boundaries in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and existing Bridge/answering documents. Raw temporary command replies are stripped before cloud result persistence; local outboxes are temporary delivery state. No logging/error/retry can expand the authorized disclosure.

**PRIVACY-2.** Human APIs require allowlisted human sessions and same-origin state-changing requests. Only exact implemented signed-machine routes are public; release manifest and one-use pairing redemption are explicit exceptions. Device signatures/nonce/expiry and root bindings are independently checked. Revoked/hidden/historical evidence cannot indirectly ground current answers.

**PRIVACY-3.** Ordinary validation uses only disposable 127.0.0.1:5432/nsn_library_machine_test, synthetic local files, mocked AI and **unset** OPENAI_API_KEY. Never use production Neon/private production files/paid AI without explicit authorization. No generated Bridge dist, master changes, push, publication or promotion in this audit workflow.

## Permanent invariant gate

The mandatory suite must exercise real service/DB/native paths, not duplicate implementation logic. Integrate its named package script into the existing CI quality job. Reuse existing expensive fixtures once per gate where possible. New regressions cover observation authority barriers, canonical read admission and sibling parity, pending derived recovery, partial scan import, generation ownership, root/device revocation, native journal/collision behavior, graph/Notebook human decisions and batch complexity. Existing structural, publication, eligibility, typed/version/QA and execution tests remain controls.

| Required category | Existing permanent controls and new coverage required by the register |
| --- | --- |
| Concurrent human authority | Observation ACCEPT/REJECT/MODIFY deterministic DB barriers; structural plan/preference CAS; graph/Notebook serialization |
| Older worker/newer state | Structural derived-state tests, root publication contention/death, observation leases, recommendation generation fences |
| Authority → derived crash | Atomic preference disputes, correction/publication pending work; durable observation Memory admission |
| Partial derived retry | Memory manifest/source fault tests; scan import child fault/replay and local action journal |
| Canonical readable-root parity | Every individual field + valid/device mismatch at actual read admission and dispatch; retained history control |
| Eligibility before cap | knowledge-eligibility-caps and structural tests; Notebook category isolation; graph live provenance |
| Latest per owner | QA per-document latest, preference source context, typed candidate pagination; per-root recovery independence |
| Human authority over bounds | Confirmed correction/SEPARATE and 20,000-file controls; graph and Notebook backfill cannot overwrite review |
| Strong file identity | Physical-file-identity, resolver, typed provenance, reuse; changed local read/checksum and event replacement |
| Current/history | Search/QA history-intent, explicit typed/family controls; monitoring full snapshot and execution report history |
| Publication recovery | scan-publication-recovery, structural stage atomicity/backend death, repeated recovery |
| Execution/Undo | connected-library-execution/native tests; atomic queue, concurrent Undo, report replay, collision and mid-operation death |

Keep exact full Phase1–3/Search/QA/organization/remaining-plan/availability command, complete QA, Bridge, Memory, auth, protocol, lint, web build and source/Bridge types. Deploy/status all 34 baseline migrations plus any forward audit migration on a fresh disposable schema. Validation logs and commit identities remain external; repository documentation records stable guarantees and test entry points. No commit while a confirmed P0/P1/P2 remains unresolved or required validation is incomplete.
