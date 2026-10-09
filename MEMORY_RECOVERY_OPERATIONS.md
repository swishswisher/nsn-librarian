# Independent Memory recovery

The application can recover existing reviewed Memory without a human page visit or a connected Bridge. Vercel Cron invokes `GET /api/cron/memory-recovery`, registered in `vercel.json`. The endpoint requires `Authorization: Bearer <CRON_SECRET>` in both Proxy and the handler. The secret must have 32–256 characters with no surrounding whitespace; use an independently generated random value in the deployment's server-side environment, never Git. Human cookies, anonymous calls, weak/missing secrets and other authorization schemes fail closed.

## Work and safety

The existing `PENDING@<review-generation>` marker is the durable work item. Each invocation selects at most 20 eligible owners, stops admitting work at a 45-second deadline, and gives each owner at most 15 seconds. Bounded selection/health/progress transactions leave margin below the route's 60-second `maxDuration`. Each owner commits independently under Serializable isolation and a nonblocking transaction-scoped owner lock. Killing a process releases its locks; completed owners stay completed and unfinished generations remain discoverable by the next delivery. Overlap or duplicate delivery cannot double-publish sources. New review generations supersede captured work.

The consumer reuses the canonical Memory builder and live review/root/latest-snapshot/document/checksum predicates. Complete source manifests remain mandatory. Rejection cleanup is permitted without granting the rejected source trust. Unknown, obsolete or revoked evidence stays outside current Memory. Human decisions, original observations, provenance history and standalone curation are retained. The consumer performs no filesystem operations, new observations or AI calls.

Additive migration `20261008120000_memory_recovery_scheduler` is necessary for failure fairness and observability across separate serverless processes: it stores a failure count, exact failure generation and UTC next-attempt timestamp on existing owners, plus one aggregate scheduler-health row. A new review and successful reconciliation clear the failure metadata atomically. Failure rotates an owner behind healthy work and backs off 1, 2, 4 seconds, up to 300 seconds. Three failures flag inspection; pending work is never marked successful to hide failure. Metadata contention does not cancel subsequent healthy owners. Migration 35 and all earlier SQL definitions remain immutable.

An owner that continually exceeds 15 seconds requires inspection, query improvement or a separately validated runtime/budget increase. It remains pending and untrusted. The daily schedule is an eventual recovery fallback, not a promise of rapid restoration or recovery of permanently invalid work.

## Schedule and activation

The checked-in expression is `0 3 * * *`: once daily at 03:00 UTC. Vercel documents daily scheduling on Hobby and minute-level scheduling on Pro/Enterprise. Hobby timing can vary within the scheduled hour. At the demonstrated 20-owner throughput, the 119-owner remainder needs six successful deliveries: roughly six days if daily deliveries occur and finish at that throughput. Deadline-limited batches, slower production database queries, missed deliveries, larger backlogs and persistent failures take longer; this is not a completion-time guarantee. Vercel may miss or duplicate cron deliveries and does not retry failed HTTP invocations; later independent recurring deliveries rediscover persisted work.

The read-only connected project is `nsn-librarian` (`prj_58wInB0R9uVeApqmrObbArVRgGIj`, team `swishswishers-projects`), Next.js on Node 24. Its available API metadata does not expose billing plan, Fluid/runtime limits, current cron activation or secret provisioning. It reports SSO protection `all_except_custom_domains`. Therefore daily config compatibility is established for the documented plan tiers, while actual deployment acceptance is unverified. No live request, secret creation, deployment, promotion or project-setting change is authorized by this implementation task.

Before claiming automatic recovery is live, the operator must verify:

1. This exact validated tree and forward migration are accepted through the authorized release workflow and become a production deployment. Vercel Cron does not activate on PR previews.
2. A strong server-side `CRON_SECRET` is provisioned outside Git and the registered cron sends its Bearer header. Do not paste the value into logs or reports.
3. Production Cron settings show the exact path and schedule enabled, and the deployed function artifact has the Node runtime and 60-second duration. Fluid Compute's documented limits allow this budget, but the actual project's runtime must be checked.
4. An actual scheduled production invocation reaches the handler without SSO/password/firewall redirects and returns the safe aggregate response. A local Proxy test cannot prove deployment-protection reachability. If protection applies to an external scheduler, configure a provider-supported protection bypass separately from the application's Bearer secret; do not weaken human authentication.
5. Two or more independent deliveries reduce eligible backlog with no human Memory/Search/Ask traffic. Inspect last-success time and failures. Local simulated delivery proves code behavior, not provider activation.

If daily latency is unsuitable, confirm Pro/Enterprise and change the cadence through a reviewed configuration update, or use an authorized external recurring scheduler calling this same endpoint at the required cadence, with deployment-protection bypass where necessary. Both alternatives require separate operator authorization and live verification. Neither relies on browser polling, recursive callbacks or self-HTTP.

## Observability

Memory displays “Existing Memory is still being restored,” eligible restored/pending counts, repeated-failure inspection counts and the last successful restoration check. Missing configuration and an unverified first run are explicit. A secret alone is not presented as proof that scheduling is enabled. Invalid/ineligible owners are retained but excluded from eligible progress counts.

Each authenticated scheduler reply contains only aggregate attempts/completions/failures/busy work, eligible backlog/inspection counts, elapsed duration and last-success time. Failures return 503 and static safe log messages; authentication failures return 401 with no database mutation. Inspect Vercel invocation status/logs and the durable aggregate `MemoryRecoveryState` row. A stale `RUNNING` row indicates an interrupted delivery; its pending work is still recoverable. Monitoring should alert on repeated 503s or lack of a successful run beyond the configured cadence plus timing margin. No owner IDs, private contents, local paths, raw observations or provider/SQL diagnostics are exposed.

## Permanent proof

`npm run test:memory-scheduler` and `npm run test:invariants` include the populated actual-migration fixture. It performs exactly one authenticated Memory visit, then only configured scheduler HTTP calls. Tests cover 120-owner convergence, slow/failing owners, durable backoff, concurrent/duplicate delivery, process death/restart, review-generation supersession, rejection/revocation races, invalid provenance, complete multi-source families, history/curation retention, closed authentication, UI truth and the deployment route contract. Production-build validation additionally checks the route artifact, and release validation validates `vercel.json` against the official provider schema.

Official references: [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Cron authentication and delivery behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [function duration](https://vercel.com/docs/functions/configuring-functions/duration), [deployment protection for automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation), [deployment schema](https://openapi.vercel.sh/vercel.json).
