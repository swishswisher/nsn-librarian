import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { bridgeDataDir } from "../security/pairing";
import type { BridgeChangeEvent } from "../types";

type WatcherEventOutboxFile = {
  events: BridgeChangeEvent[];
};

const maxOutboxEvents = 1_000;
let outboxMutation = Promise.resolve();

function outboxPath() {
  return path.join(bridgeDataDir(), "watcher-event-outbox.json");
}

function validEvent(value: unknown): value is BridgeChangeEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const event = value as Partial<BridgeChangeEvent>;

  return (
    typeof event.id === "string" &&
    typeof event.rootId === "string" &&
    typeof event.relativePath === "string" &&
    typeof event.detectedAt === "string" &&
    (event.eventType === "FILE_ADDED" ||
      event.eventType === "FILE_MODIFIED" ||
      event.eventType === "FILE_RENAMED" ||
      event.eventType === "FILE_MOVED" ||
      event.eventType === "FILE_DELETED" ||
      event.eventType === "FOLDER_ADDED" ||
      event.eventType === "FOLDER_RENAMED" ||
      event.eventType === "FOLDER_MOVED" ||
      event.eventType === "FOLDER_DELETED")
  );
}

async function readOutbox(): Promise<WatcherEventOutboxFile> {
  try {
    const parsed = JSON.parse(
      await readFile(outboxPath(), "utf8"),
    ) as Partial<WatcherEventOutboxFile>;

    return {
      events: Array.isArray(parsed.events)
        ? parsed.events.filter(validEvent)
        : [],
    };
  } catch {
    return { events: [] };
  }
}

async function writeOutbox(outbox: WatcherEventOutboxFile) {
  const filePath = outboxPath();
  const tmpPath = `${filePath}.tmp`;

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(outbox, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmpPath, filePath);
}

async function mutateOutbox<T>(mutation: () => Promise<T>) {
  const nextMutation = outboxMutation.then(mutation, mutation);

  outboxMutation = nextMutation.then(
    () => undefined,
    () => undefined,
  );

  return nextMutation;
}

export async function queueBridgeWatcherEvent(event: BridgeChangeEvent) {
  return mutateOutbox(async () => {
    const outbox = await readOutbox();

    if (outbox.events.some((item) => item.id === event.id)) {
      return;
    }

    outbox.events.push(event);
    outbox.events = outbox.events.slice(-maxOutboxEvents);
    await writeOutbox(outbox);
  });
}

export async function listBridgeWatcherEvents(options: {
  limit?: number;
  rootId?: string;
} = {}) {
  const outbox = await readOutbox();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));

  return outbox.events
    .filter((event) => !options.rootId || event.rootId === options.rootId)
    .slice(0, limit);
}

export async function acknowledgeBridgeWatcherEvents(eventIds: string[]) {
  return mutateOutbox(async () => {
    const acceptedIds = new Set(eventIds);

    if (acceptedIds.size === 0) {
      return;
    }

    const outbox = await readOutbox();
    const nextEvents = outbox.events.filter(
      (event) => !acceptedIds.has(event.id),
    );

    if (nextEvents.length === outbox.events.length) {
      return;
    }

    await writeOutbox({ events: nextEvents });
  });
}

export async function takeBridgeWatcherEventsFromOutbox(rootId: string) {
  const events = await listBridgeWatcherEvents({ rootId });

  await acknowledgeBridgeWatcherEvents(events.map((event) => event.id));

  return events;
}
