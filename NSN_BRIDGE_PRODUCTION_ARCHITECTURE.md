# NSN Bridge Production Architecture

Milestone 12J turns the local Bridge prototype into a production companion-app architecture.

The intended production shape is:

```text
NSN Librarian Web on Vercel
  <-> authenticated cloud coordination
NSN Bridge installed on Deanne's MacBook
  <-> folders explicitly selected and permitted by Deanne
```

The Mac remains the source of truth. The Vercel database stores observations, decisions, Memory, Notebook entries, scan sessions, recommendations, plans, execution history, device records, pairing audit entries, and command history. It does not store unrestricted access to Deanne's filesystem.

## Repository Layout

The current Next.js app remains at the repository root to avoid breaking existing routes. The production layout is added incrementally:

- `apps/bridge`: macOS desktop Bridge shell.
- `bridge-app`: existing Node Bridge core used by local development and the desktop shell.
- `packages/bridge-protocol`: shared pairing, command, device, and release-manifest types.
- `packages/security`: shared key and signing helpers.
- `packages/filesystem-plans`: shared relative-path and execution-order rules.
- `packages/shared-types`: shared public TypeScript exports.

## Desktop Framework

The selected desktop framework is Electron because the existing Bridge depends on Node filesystem, watcher, reader, media, and execution capabilities.

The Bridge source is configured for:

- `contextIsolation: true`
- `nodeIntegration: false`
- secure preload exposure
- sandboxing where compatible
- native macOS folder selection
- menu-bar behavior
- login-item support defaulting off
- local localhost development compatibility

Actual production DMGs must be built on macOS.

## Folder Selection and Permissions

The desktop shell uses the native macOS directory picker. The intended flow is:

Choose Folders -> Finder picker -> selection basket -> permission review -> Connect Selected Folders

Deanne does not type local paths into the web browser. The Bridge stores actual paths locally. The web database stores safe descriptions, root IDs, permissions, statuses, and history.

## Local Root Registry

Actual local paths belong inside the installed Bridge in its application-data area. The local registry tracks:

- `bridgeRootId`
- actual selected path
- stable root fingerprint
- granted permissions
- watcher state
- last reconciliation state

The cloud database may store `connectedLibraryId`, `bridgeDeviceId`, `bridgeRootId`, display name, safe location description, permission flags, statuses, and intelligence history.

## Device Identity

Each installed Bridge generates its own device identity and key pair. The web database stores:

- `bridgeDeviceId`
- device display name
- platform
- architecture
- app version
- public key
- paired time
- last seen time
- revoked time
- status

The Bridge must not use invasive hardware fingerprints or device serial numbers.

## Pairing Protocol

The web app creates a short-lived one-time pairing code. The installed Bridge sends that code with a locally generated public key and device identity. The server verifies:

- code hash
- expiry
- one-time use
- intended account
- public key presence
- rate limits

Pairing writes audit history. Revocation disables queued commands and disconnects cloud-owned connected libraries.

## Cloud Command Protocol

Production Bridge communication is outbound from the Mac to the cloud. The browser does not call `127.0.0.1` as the production path.

The Bridge:

- sends heartbeat
- fetches pending commands
- acknowledges receipt
- validates each command locally
- reports completion or safe failure

The server:

- queues commands
- signs command envelopes
- validates ownership
- stores expiry
- prevents stale command use through status and idempotency records
- records acknowledgement and completion

The initial implementation uses polling. Active UI sessions can poll every few seconds; idle sessions should back off.

## Execution Authorization

The web app must never send arbitrary file operations from the browser to the Bridge.

Execution remains:

AI recommendation -> human review -> Organization Plan -> plan approval -> typed EXECUTE -> short-lived execution command -> Bridge validates locally -> Bridge executes -> server records result -> Bridge reconciles affected paths.

The Bridge independently validates device identity, root identity, permissions, paths, checksums, destination conflicts, command expiry, and idempotency before any filesystem change.

## Secrets and Logs

Production secrets must be configured outside source control:

- `NSN_BRIDGE_PAIRING_SECRET`
- `NSN_BRIDGE_COMMAND_SIGNING_SECRET`
- Apple signing/notarization credentials
- database credentials
- OpenAI credentials

The Bridge uses macOS Keychain where practical for private keys and cloud pairing credentials. Development fallback storage is for local non-production use only.

Logs must not contain private keys, full tokens, API keys, source file contents, transcripts, or unrestricted local paths.

## Download Distribution

The web page `/download/bridge` reads a controlled release manifest and shows:

- Apple Silicon download
- Intel Mac download
- version
- release date
- system requirements
- SHA-256 checksum
- installation steps
- privacy explanation
- troubleshooting
- release notes

DMGs are not committed to the repo. GitHub Releases should publish:

- `NSN-Bridge-vX.Y.Z-mac-arm64.dmg`
- `NSN-Bridge-vX.Y.Z-mac-x64.dmg`
- `latest-mac.json`
- `SHA256SUMS.txt`

## Signing, Notarization, and Updates

The workflow `.github/workflows/release-bridge-macos.yml` is prepared for macOS release builds. Production release requires Apple Developer ID signing, hardened runtime, notarization, stapling, checksum generation, and GitHub Release upload.

Auto-update is represented by release-manifest and command-polling infrastructure in this milestone. The first production updater must verify signed updates and require user approval before installation.

## Development Commands

- `npm run dev:web`: run the Next.js web app.
- `npm run dev:bridge`: run the Bridge development process.
- `npm run dev:all`: run web and Bridge development processes together.
- `npm run build:web`: build the web app.
- `npm run build:bridge`: type-check the desktop Bridge shell.
- `npm run package:bridge:mac`: package macOS DMGs on a Mac or macOS CI runner.
- `npm run test:bridge`: run Bridge behavior tests.
- `npm run test:protocol`: run protocol and release-manifest tests.

## Remaining Production Setup

Before Deanne installs a production Bridge, these still need real credentials and release execution:

- production authentication integration
- Apple Developer ID certificate
- Apple notarization credentials
- release asset URLs and SHA-256 values
- auto-update signing verification
- production command consumers for every cloud command type
