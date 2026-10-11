# Library search (Phase 3A development)

Library search uses the existing single-human session boundary and connected-root read
permission. Queries select connected, enabled, readable roots in PostgreSQL before
retrieving index candidates. Disconnected, merged, hidden, and read-revoked roots are
excluded. The database does not yet model per-user or per-tenant root ownership; this
implementation must not be treated as a multi-tenant authorization design.

`LibrarySearchEntry` is a root/path/checksum/version-derived search record, not an
original-file store. It retains at most eight previously verified source excerpts of
240 characters each, their character ranges, bounded normalized terms, supported
subject IDs, resolved root-scoped identity hashes, and review state. Human correction
wording contributes at most 240 characters to normalized terms; the wording itself is
not copied into this table. No full document text, binary media, or absolute Mac path
is added to the index. No embedding or paid AI request is made by indexing or search.

The index is updated after scan-wide understanding is persisted. An unchanged checksum
and fingerprint reuses its entry; changed content supersedes its old entry. The latest
scan is authoritative for active entries. A human observation edit or identity
correction refreshes the affected file without re-reading the Mac. Existing completed
scans can be indexed through **Prepare search** using retained evidence only. The
manual path processes at most 20 files per request, stores a per-file outcome, and
continues automatically in the browser. A refresh or interruption can resume without
repeating completed files. Failed files are isolated and may be retried. No paid AI
or Bridge command is issued by search preparation. Incomplete indexing leaves
filename/path fallback available.

New approved Memory records carry explicit contributing observation sessions and
connected-root IDs. All contributing roots must remain connected, enabled, and
readable for a Memory result to appear; the contributing observations must remain
approved or corrected. Multi-root Memory is never attributed to one arbitrary root.
The expected source count is retained so cascading deletion of one source cannot
turn a multi-root Memory into an apparently single-root result.
Memory is displayed as a distinct human-approved result with no source quotation or
document-content claim. Archived Memory is excluded at query time, and human wording
edits are reflected by the live query without altering source provenance.

Older Memory defaults to unverified provenance and is not searchable. The explicit
Prepare search action attempts a bounded historical check: only single-occurrence
term/theme entries whose exact stored evidence matches one uniquely named approved
observation and one physical root/path can be reconstructed. Every ambiguous,
generalized, or manually entered entry remains in the existing Memory/Notebook but
is excluded from permission-sensitive search. The check records that an entry was
examined, so repeated preparations do not guess or repeatedly scan it.

Retrieval reserves exact filename/path candidates, then uses bounded lexical and
source-supported subject-taxonomy candidates. Supported synonyms (such as seminar
for workshop material) can retrieve files without matching filename words. Generic
partial filename overlap ranks below verified subject support, while exact filenames
retain priority. Retrieval also expands from root-scoped identity hashes when
the query identifies a matching entity. Candidate retrieval is capped at 120 entries
and final results at 20. Scores are internal ordering signals, never probabilities.
Verified excerpts retain source ranges; metadata-only media is never described as OCR
or transcript content. Old scan entries are labeled historical and link to the scan
session, not to a presumed-current physical file.

Historical index rows remain until their scanned-file or connected-root record is
deleted. This is an additional bounded retention of source quotations beyond Phase 1.
**Production privacy decision required:** approve or change this retention before
deploying the Phase 1/2/3 migration chain. Existing scans are not backfilled by the
migration and require the explicit Prepare search action or a later scan.

Limitations: the deterministic subject taxonomy is narrower than open-ended semantic
or embedding search. Historical Memory that fails strict reconstruction remains
unsearchable, intentionally. A future multi-user system must introduce explicit
per-user or tenant ownership before enabling this search for more than the current
single-human installation. The two retention/privacy decisions (Phase 1 quotations
and Phase 3A historical index excerpts) remain outstanding for deployment.
