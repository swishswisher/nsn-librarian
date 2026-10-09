<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Engineering constitution

The machine suggests. Deanne decides. Nothing moves without approval.

Before changing production behavior, read [PRODUCT_CONSTITUTION.md](PRODUCT_CONSTITUTION.md), [SYSTEM_INVARIANTS.md](SYSTEM_INVARIANTS.md), and the relevant rows in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and [CHANGE_IMPACT.md](CHANGE_IMPACT.md). Inspect the listed sibling modules before choosing a local fix. Architectural invariants outrank implementation convenience.

Use the existing detailed Bridge architecture documents for native/protocol/filesystem changes, LIBRARY_SEARCH_ARCHITECTURE.md for indexing/retrieval, LIBRARY_ANSWERING_ARCHITECTURE.md for Ask/provenance/privacy, and LIBRARIAN_MIND_ARCHITECTURE.md / KNOWLEDGE_ITEM_ARCHITECTURE.md for observation/Knowledge work. Read STRUCTURAL_DERIVED_STATE_AUDIT.md for known defects, recovery contracts and test gaps.

Human event/status/meaning must agree under concurrent review. Preserve corrections, SEPARATE, current/history boundaries, complete provenance, root/device/fileKey/checksum authorization and durable recovery. Reuse canonical predicates and shared ownership protocols; document and test deliberate stronger/different contexts.

Run production-path invariant regressions and the applicable existing release gate. A change is incomplete without required concurrency, recovery, authorization, history or scale regressions. Never delete/weaken safety checks or reduce 20,000/50,000 fixtures to get green.

Ordinary validation uses only disposable localhost PostgreSQL, synthetic local files, mocked AI and unset OPENAI_API_KEY. Production Neon and paid AI require explicit authorization. Do not commit generated apps/bridge/dist output. Do not modify/merge master, push, publish or promote production in this audit workflow. Keep ephemeral logs outside the repository.
