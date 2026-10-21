# NSN presentation overhaul

The Librarian and Bridge presentation changes are implemented on the isolated `design/figma-overhaul` branch. A website preview has been published for review; production and `master` remain unchanged. Preview sign-in still requires deployment configuration described below. Zero regression is the acceptance goal, not a guarantee supplied by the visual changes or the checks completed here.

## What changed

The approved Figma palette, Inter interface typography, Lora reading typography, spacing, surfaces and responsive navigation now form the shared presentation system. Fonts are bundled locally, including the Bridge font, without a new runtime font-service dependency.

| Area | Presentation changes |
| --- | --- |
| Shared workspace | Grouped sidebar; compact workspace header; account menu; breadcrumbs; mobile modal navigation; skip link; visible keyboard focus; reduced-motion support. The duplicated quick-navigation banner is removed. |
| Home | Compact greeting, current review work, Notebook preview, quick access and recent activity. Knowledge, additional tools and Bridge details remain available in a labelled disclosure. |
| Notebook and entry/archive pages | Reading typography, calmer cards, responsive action groups, compact digest, searchable existing filters, and a disclosure for earlier entries. Full entry text remains available on the existing detail route. |
| Library | Flatter file rows and folder hierarchy; existing filters and search; file metadata and Ask in labelled disclosures. |
| Recommendations | Accessible Observations / File organization tabs. Both panels stay mounted, preserving inputs and action state when switching. Existing observation, file-examination and recommendation-detail components use the shared visual system. |
| Plans and scans | Existing routes and decisions retained; consistent action colors; readable metric bands; scan diagnostics and secondary totals in disclosures. Titles no longer compete with long action rows. |
| Connected Libraries | Compact connection rows; per-folder controls and permissions remain mounted inside disclosures; separate access to bulk controls and connection diagnostics. Reconnection warnings remain visible. |
| Knowledge, relationships, topics, Memory and Library Map | Shared typography, responsive shell, calmer surfaces and consistent controls. Existing data, evidence and review behavior retained. |
| Activity | Existing placeholder retained and restyled. The Figma illustration does not create an activity-history feature. |
| Login, Mac setup and download | Consistent typography, spacing, color and responsive actions. Existing sign-in, pairing and download destinations retained. |
| Bridge | Folders / Connection / Updates tabs, compact header, responsive folder rows, pairing form, download/verification/install states and activity feedback. Native window chrome remains native. |

## Functional boundaries

No changes were made to application service logic under `src/lib`, API routes, database schema or migrations, authentication middleware, Bridge IPC or filesystem operations, protocol packages, dependencies or deployment configuration.

The admin layout still calls `requireHumanSession`. Account presentation moved into the workspace header; sign-out still posts to the existing endpoint. Existing state, totals, permissions, approval requirements, execution and Undo behavior have not been rewritten. Existing loading boundaries and navigation-pending feedback are retained.

The new interactions are presentation controls: tabs, disclosures and the mobile menu. They do not submit business actions. Tabs keep their panels mounted. The Bridge retains its original element IDs and action handlers. Its content security policy permits the locally embedded font through `font-src data:`.

A source comparison found all 103 existing event-handler, form-action and disabled-state expressions in the changed web components still present. This is supplementary evidence, not a substitute for service and end-to-end testing.

## Verification

- Website production build: passed.
- Bridge TypeScript check: passed.
- ESLint and whitespace check: passed.
- Existing Bridge/native unit tests, human-auth tests, organization-plan review tests and page-loading performance tests: 243 passed, zero failed, one platform-specific test skipped. The skipped control requires Windows NTFS.
- Bridge renderer tests include three new regressions for keyboard tabs, preservation of pairing input through tab changes/status refresh, and preservation of update state. All 49 renderer tests passed.
- Website browser coverage: 26 screen routes at 320, 390, 768, 1024 and 1440 pixels. This covers Home; Notebook, entry and archive; Library; Recommendations and observation review; Plans and scan selector; Connected Libraries; Monitoring; Knowledge, graph and topic; Memory; Activity; Library Map; scan history, detail, recommendations, recommendation detail, final plan and file examination; Login; Mac setup; Bridge download.
- The browser harness checks successful rendering, session redirects, horizontal overflow, browser exceptions, mobile-menu Escape/focus/navigation/resize behavior, account-menu bounds, keyboard review tabs and form-state retention.
- Bridge browser coverage: 1040, 600, 390 and 320 pixels, with pairing, connected folders, selected folders, update available, downloading, ready to install, and interrupted connection. Pairing input, folder-selection state and update actions are checked using a mocked native API.

Browser fixtures use synthetic information only. No production data, paid AI calls or real user file operations were used. The website runs its production build against a disposable local PGlite database for visual verification. PGlite is not a substitute for native PostgreSQL concurrency, recovery or authorization release gates.

The reusable website browser harness is `tests/ui/presentation-browser.mjs`. It exports `checkPresentation(page, { baseUrl, routes, screenshotDir, widths })`, accepts a Playwright Page authenticated against a synthetic local fixture, and rejects non-localhost servers. It does not invoke business mutations. The Bridge regressions are in the existing `bridge-app/tests/bridge-desktop-ui.test.ts` suite.

## Release checks still required

The project's `AGENTS.md` and `SYSTEM_INVARIANTS.md` require the full native PostgreSQL and applicable Mac acceptance gates before release. A native PostgreSQL service could not be started under this container's process restrictions, and this is not a macOS host. Therefore full database concurrency/recovery suites, actual macOS packaging/installation and native OS integration have not been certified here. Existing CI in `.github/workflows/mac-acceptance-ci.yml` provides those environments; its gates were not weakened.

The Figma connector reached its Starter-plan read limit after the core design references were retrieved. The implementation follows those references and the existing component inventory, but a fresh pixel-level comparison of every Figma frame remains outstanding. Differences needed to preserve real controls, real states, longer text and existing placeholders are intentional; illustrative Figma data has not replaced application data. Exact visual parity across every frame is not yet certified.

At the initial preview checkpoint, no commit, push, merge, production deployment, production database migration or Bridge release had been performed. The user subsequently authorized merging the redesign to `master`. The existing isolated-database and native Mac CI gates apply before that merge; the preview-only OAuth configuration is not needed on the existing production domain.

## Review deployment — 21 October 2026

At the user's request, the uncommitted working tree was uploaded directly to the existing Vercel project as a Preview deployment. No GitHub branch was pushed and no production alias was reassigned.

- Stable review address: https://nsn-librarian-design-preview.vercel.app
- Deployment: `dpl_7ikY3DR56vgSAeZyjb9KdB9JAcp8`, status `READY`, Preview target.
- Vercel build completed successfully. The redesigned login page returned HTTP 200 and rendered in the browser with authentication configured.
- Production `nsn-librarian.vercel.app` was verified still pointing to `dpl_EG5wtuBzXjcL26ripQWVV3KB6X4Y`, the existing `4883b6b` deployment.
- The website preview does not update the installed native Bridge. A Mac package/release and its acceptance checks remain outstanding.

### Preview access blockers

Google returned `Error 400: redirect_uri_mismatch` for both the generated deployment URL and the stable review address. The existing OAuth client needs this additional exact authorized redirect URI:

```text
https://nsn-librarian-design-preview.vercel.app/api/auth/google/callback
```

The preview's mutation-origin configuration must also include its exact origin. A narrowly scoped branch setting was prepared:

```text
Project: nsn-librarian
Environment: Preview only
Git branch: design/figma-overhaul
NSN_LIBRARIAN_APP_URL=https://nsn-librarian-design-preview.vercel.app
```

The Vercel connector returned HTTP 403 for both inspecting environment-variable metadata and creating that branch-scoped variable. No environment variable was changed; no authenticated CLI credentials were available. The application authentication code and allowlist checks were not weakened. Configuration requires an authorized dashboard session, followed by a new Preview build and verification of sign-in and same-origin behavior. Until then, the published preview reaches the login page but is not ready for a complete signed-in design review.
