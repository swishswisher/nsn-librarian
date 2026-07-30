# NSN Library Machine

Private internal tool for Domestic Appeal LLC and Neural ~ Synergistic ~ Network.
This is the machine first: a production-grade foundation for Bridge-connected
folder scanning, observation, review, memory, suggestions, and approved
execution planning. Deanne's MacBook remains the source of truth for local
files.

## Tech Stack

- Next.js App Router with a required `src/` directory
- TypeScript
- Tailwind CSS
- Prisma
- PostgreSQL
- OpenAI-ready observation architecture with deterministic fallback

## Setup

```bash
npm install
cp .env.example .env
npm run db:generate
npm run dev:all
```

Then open `http://localhost:3000/admin/library`.

To run the two local processes separately:

```bash
npm run dev:web
npm run dev:bridge
```

## Environment Variables

```bash
DATABASE_URL=
OPENAI_API_KEY=
NSN_LOCAL_BRIDGE_URL=http://127.0.0.1:4777
NSN_BRIDGE_PORT=4777
NSN_BRIDGE_DATA_DIR=
STORAGE_PROVIDER=
STORAGE_BUCKET=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=
```

`OPENAI_API_KEY` enables optional AI-assisted manual observation when present.
The deterministic observer remains the fallback.

The NSN Bridge companion app owns the private mapping from Bridge root
identifier to actual local path. The web database stores knowledge work,
history, permissions, safe location descriptions, and Bridge root IDs.

## Database

Prisma models live in `prisma/schema.prisma`.

Generate the client:

```bash
npm run db:generate
```

Create and apply a local migration after setting `DATABASE_URL`:

```bash
npm run db:migrate -- --name init-library-machine
```

Open Prisma Studio:

```bash
npm run db:studio
```

## App Routes

- `/admin/library`
- `/admin/library/connected-libraries`
- `/admin/library/scan-sessions`
- `/admin/library/documents`
- `/admin/library/review`
- `/admin/library/taxonomy`
- `/admin/library/migration`

## API Routes

- `POST /api/bridge/scan`
- `POST /api/bridge/connected-libraries/folder-picker`
- `POST /api/bridge/connected-libraries`
- `POST /api/library/classify`
- `POST /api/library/review`
- `POST /api/library/migration`

The Bridge is the entry point for folder selection, scanning, watching, and
approved filesystem execution. Legacy scan-session compatibility routes remain
for older links and future cleanup.

## Planned Phases

1. Bridge-connected folders and scan sessions.
2. Metadata-only scanned file records, observations, and review decisions.
3. Review-safe AI observation with deterministic fallback.
4. Memory, relationships, suggestions, and Notebook reflections shaped by human approval.
5. Approved execution back through the local NSN Bridge.

## Architecture Notes

- UI components live under `src/components/library`.
- Route handlers live under `src/app/api/library`.
- AI classification lives under `src/lib/ai`.
- Web Bridge orchestration lives under `src/lib/bridge`.
- The local Bridge companion app lives under `bridge-app`.
- File extraction and checksums live under `src/lib/files`.
- Library orchestration placeholders live under `src/lib/library`.
- Shared domain types live under `src/types/library.ts`.
