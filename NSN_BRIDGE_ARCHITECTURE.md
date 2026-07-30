# NSN Bridge Architecture

## Purpose

The NSN Bridge is the local companion application that gives NSN Librarian safe
access to the user's approved library locations.

The Bridge exists because the user's computer remains the source of truth.

Within the NSN Librarian system:

- The web application is the control center.
- The database is the Librarian's Memory.
- The Bridge is the Librarian's eyes and hands.

The Bridge observes approved local locations, reports what it finds, and
executes approved file operations. It does not reason, classify, recommend, or
decide.

## Constitutional Boundary

The Bridge must always obey the product constitution.

The Bridge is not a second authority. It is a local executor under strict human
and Librarian control.

It must preserve these boundaries:

- The Bridge observes.
- The Librarian understands.
- The human decides.
- The Bridge executes approved actions only.

The Bridge must never claim ownership over the user's files, library structure,
or decisions.

## System Architecture

The intended architecture is:

User

to

Web Application

to

Local Bridge

to

Operating System

to

File System

to

Documents

The Bridge communicates upward.

The Librarian decides.

The Bridge executes.

The web application presents the user's choices, displays observations, requests
approval, and sends approved instructions to the Bridge. The Bridge performs
local file-system work through the operating system and reports the outcome
back to the web application.

## Connected Libraries

Connected Libraries are the approved local roots the Librarian may work with.
The application may keep metadata about a connected library, but the local
computer remains the source of truth for the files themselves.

A Connected Library records:

- A display name.
- The Bridge root identifier.
- A safe location description.
- Platform.
- Connection status.
- Scan and monitoring timestamps.
- Permission flags for reading, watching, recommendations, planning, folder
  creation, file moves, and file renames.

The database must not become a copy of the user's files. It stores knowledge
work: Memory, observations, relationships, decisions, preferences, suggestions,
Notebook entries, scan sessions, execution history, undo history, and metadata
needed to verify safe Bridge work.

The Bridge retains the private mapping from Bridge root identifier to actual
local path. The web database must not be treated as the authoritative store for
raw filesystem paths.

Older records created before the local Bridge are marked as legacy connections.
They remain available as history, but they must be reconnected through the
native Bridge picker before they can scan, watch, or execute again.

## Local Companion App

The local Bridge companion app lives under:

```text
bridge-app/
  src/
    main/
    picker/
    watcher/
    filesystem/
    permissions/
    security/
    api/
    types/
```

The companion app runs on the local computer and exposes a localhost API bound
to `127.0.0.1`. It opens the native operating-system folder picker, owns the
root registry, scans approved roots, watches approved roots, reads temporary
content for examination, and executes approved filesystem operations.

The web app remains the review and control surface.

## Windows Development Commands

Run the applications separately:

```bash
npm run dev:web
npm run dev:bridge
```

Or run both from one terminal:

```bash
npm run dev:all
```

The Bridge defaults to:

```text
http://127.0.0.1:4777
```

The web app talks to that address through server-side API routes. The pairing
secret is stored locally under the Bridge data directory and is not sent to the
browser.

A hidden development fallback can remain for automated tests, but the normal UI
must not ask Deanne for a manual filesystem path.

## Core Responsibilities

The Bridge is responsible for:

- Connecting to approved library locations.
- Reading approved directory structures.
- Watching approved folders.
- Reading approved files.
- Returning file metadata.
- Returning extracted text when requested.
- Executing approved file operations.
- Reporting file-system changes.
- Preserving an auditable record of its activity.
- Refusing work outside approved boundaries.

The Bridge never makes autonomous decisions.

## Responsibilities Excluded From the Bridge

The Bridge is not responsible for:

- AI reasoning.
- Classification.
- OpenAI communication.
- Taxonomy decisions.
- Writing assistance.
- Recommendation generation.
- Editorial judgment.
- Product philosophy.

Those responsibilities belong to NSN Librarian.

The Bridge may provide observations. It may not convert those observations into
judgment.

## Supported Platforms

Version One supports:

- Windows local development.
- macOS-compatible architecture.

Future platform support may include:

- Linux.
- Network drives.
- External drives.
- Cloud storage folders.

The architecture must isolate platform-specific behavior. File permissions,
file watching, path handling, operating-system prompts, and external-drive
behavior should be implemented behind platform-specific boundaries so that the
Bridge's higher-level contract remains stable.

The web application should not depend on macOS-specific details.

## Watched Library Locations

Watched library locations are persistent, user-approved places the Bridge may
observe.

Examples include:

- Research.
- Articles.
- Website.
- Desktop.
- Speaker Notes.
- Books.
- External Drives.

The user may:

- Add watched locations.
- Remove watched locations.
- Pause watched locations.
- Resume watched locations.

The Bridge remembers watched locations only after explicit user approval.

Each watched location should have a clear state, such as active, paused,
unavailable, revoked, or disconnected. These states help the Librarian explain
what is happening without exposing unnecessary infrastructure details to the
user.

## Background Monitoring

The Bridge quietly watches approved locations.

It notices:

- New files.
- Modified files.
- Renamed files.
- Deleted files.
- Moved files.

The Bridge reports these observations so the Librarian's Memory can be updated.

The Bridge never moves files on its own.

Background monitoring must remain respectful. It should observe only approved
locations, avoid unnecessary work, and report meaningful changes without
overwhelming the user.

## Permissions

The Bridge never scans anything without permission.

Every watched location must be explicitly approved by the user.

The user can revoke access at any time.

The Bridge should follow the native permission model of each operating system.
On macOS, that means respecting system privacy prompts, folder access rules, and
security boundaries. Future platforms must follow their equivalent native
permission models.

The Bridge must treat revoked access as final until the user grants access
again.

## File Operations

The Bridge may support these file operations:

- Read.
- Copy.
- Move.
- Rename.
- Delete, as a future capability only.

Every destructive or meaningfully altering operation requires explicit approval
from the Librarian and ultimately from the user.

The Bridge must not infer that approval from a prior scan, a recommendation, or
an automation setting.

Approved file operations should be specific. A file operation should identify
the source, destination, intended action, and expected result before execution.

The Bridge should report the result of every operation, including success,
failure, skipped work, partial completion, or permission denial.

## Communication Model

Communication between the web application and the Bridge should happen through
a secure local API.

The web application sends requests.

The Bridge executes permitted local work.

The Bridge reports results.

The communication model should support:

- Bridge availability checks.
- Permission status.
- Watched location management.
- Scan requests.
- File metadata responses.
- Extracted text responses.
- File operation requests.
- File operation results.
- Background change notifications.
- Audit events.
- Version and update status.

The Bridge should expose only the minimum surface area needed for NSN Librarian
to operate safely.

## Communication Security

The local API must not expose unrestricted filesystem access.

Only approved folders are accessible.

There must be no arbitrary filesystem browsing through the Bridge.

There must be no hidden privilege escalation.

The web application should be able to confirm that it is communicating with the
expected local Bridge instance. The Bridge should be able to reject unauthorized
or malformed requests.

Every sensitive request should be auditable.

The implemented local API uses:

- `127.0.0.1` binding only.
- A randomly generated local pairing secret.
- Bearer authentication for operational requests.
- Origin validation for browser-originated requests.
- Request body size limits.
- Tokenized folder selection.
- Bridge root identifiers instead of arbitrary path arguments.
- Short request timeouts from the web app.
- Safe user-facing errors.

The API must never expose pairing secrets, stack traces, arbitrary filesystem
APIs, or unrestricted absolute path operations.

## Offline Operation

The Bridge should continue monitoring approved local folders even if the web
application is temporarily unavailable.

When the web application becomes available again, synchronization should resume
automatically.

Offline observations should be preserved locally only as operational state until
they can be reported to the Librarian's Memory.

The Bridge does not become the permanent memory of the system while offline. It
remains a local observer waiting to synchronize.

## The Librarian's Memory

The Bridge never stores permanent knowledge.

The Bridge forwards observations.

The Librarian's Memory stores:

- Metadata.
- Checksums.
- Relationships.
- Classification.
- Reasoning.
- History.
- Review decisions.

The Bridge may temporarily retain operational state needed to monitor folders,
retry failed work, or synchronize changes. That state must remain subordinate to
the Librarian's Memory and must not become an independent knowledge store.

## Local-First Principle

The user's computer is the primary source of truth.

NSN Librarian must never require the user's files to be copied into the cloud.

Only knowledge is synchronized.

Never ownership.

The Bridge exists to protect this local-first model by allowing the Librarian to
understand approved local files without requiring the user to surrender their
library to the application.

## Audit Log

Every operation performed by the Bridge should be logged.

Audit events may include:

- Folder connected.
- Folder paused.
- Folder resumed.
- Permission revoked.
- Scan started.
- Scan completed.
- File metadata read.
- Text extraction completed.
- File copied.
- File moved.
- File renamed.
- File operation failed.
- External drive disconnected.
- External drive reconnected.
- Bridge updated.

Audit logs should support trust. They should help the user and future
developers understand what happened, when it happened, and why it was allowed.

Audit logs should avoid unnecessary exposure of private document contents.

## Failure Handling

The Bridge must fail calmly and clearly.

If a file cannot be accessed, the Bridge should report it and continue.

If a folder disappears, the Bridge should notify the Librarian.

If an external drive disconnects, the Bridge should pause monitoring and retry
later.

If permissions are revoked, the Bridge should stop observing that location and
report the change.

If a file operation fails, the Bridge should leave the original file state as
intact as possible and report the exact failure condition.

The Bridge should not crash because one file, folder, drive, or permission is
unavailable.

## Lifecycle

The Bridge lifecycle includes these stages:

### Installed

The Bridge is present on the user's computer but has no authority until the user
connects it and approves locations.

### Connected

The web application can communicate with the Bridge through the secure local
API.

### Authorized

The user has approved one or more library locations.

### Observing

The Bridge reads approved structures, watches approved folders, and reports
changes.

### Executing

The Bridge performs a specific approved file operation requested by the
Librarian after human approval.

### Syncing

The Bridge reports observations, operation results, and audit events to the web
application so the Librarian's Memory can be updated.

### Paused

The Bridge remains installed but temporarily stops watching selected locations
or all locations.

### Revoked

The user has removed permission. The Bridge stops observing the affected
location and treats future access as unauthorized until permission is granted
again.

## User Experience

The user should never feel like they are managing infrastructure.

The experience should feel like:

Choose Library

to

Library Connected

to

Scanning

to

Suggestions Ready

The Bridge should remain almost invisible.

The user should see the Bridge only when it needs permission, needs attention,
or needs to explain an issue that affects the library.

The interface should avoid engineering language where human language is clearer.

## Security Rules

The Bridge must follow these security rules:

- Never scan unapproved locations.
- Never expose unrestricted filesystem access.
- Never allow arbitrary filesystem browsing.
- Never elevate privileges silently.
- Never execute destructive operations without explicit approval.
- Never hide file operations from the audit log.
- Never treat convenience as a reason to weaken security.
- Never continue observing a location after access has been revoked.
- Never confuse temporary operational state with permanent knowledge.
- Never follow symlink roots or symlink targets outside the approved root.
- Never treat an old approved plan as permission after access has been revoked.

Security is part of the product's trust model, not a secondary concern.

## Roadmap

### Version One

Version One should focus on:

- Folder connection.
- Folder watching.
- Metadata collection.
- Safe file operations.
- Local-first operation.
- Clear auditability.
- macOS support.

### Version Two

Version Two may expand into:

- Background optimization.
- Multiple libraries.
- Cross-platform support.
- Cloud providers.
- External drives.
- Better offline synchronization.
- More detailed operational history.

Future roadmap decisions must remain subordinate to the product constitution and
the Bridge constitutional rules.

## Bridge Constitutional Rules

The Bridge observes.

The Librarian understands.

The human decides.

The Bridge executes.

Nothing moves without approval.

Nothing is deleted automatically.

Nothing is renamed automatically.

Nothing is overwritten automatically.

The Bridge remains invisible unless attention is needed.

The Bridge never reasons on behalf of the Librarian.

The Bridge never takes ownership of the user's files.

Security is never sacrificed for convenience.

Every meaningful action must be auditable.

The user's library always remains the source of truth.

## Final Commitment

This architecture exists to ensure that the NSN Librarian remains a trusted
steward of knowledge rather than a controller of it.
