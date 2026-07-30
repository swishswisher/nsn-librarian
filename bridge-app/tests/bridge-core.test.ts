import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { createBridgeServer } from "../src/api/server";
import { readBridgeRootFile } from "../src/filesystem/reader";
import { resolveBridgeRootFile } from "../src/filesystem/resolver";
import { scanBridgeRoot } from "../src/filesystem/scanner";
import { resolveInsideRoot } from "../src/filesystem/safety";
import {
  createFolderSelection,
  disconnectRoot,
  registerRootFromSelection,
  requireExecutionPermissions,
  requireRootPermission,
} from "../src/main/registry";
import { getOrCreatePairingSecret } from "../src/security/pairing";
import {
  isWatching,
  pauseBridgeWatcher,
  resumeBridgeWatcher,
  startBridgeWatcher,
  stopBridgeWatcher,
  takeBridgeWatcherEvents,
} from "../src/watcher/watcher";
import { defaultBridgePermissions } from "../src/permissions/defaults";
import { BridgeAppError, type BridgePermissions } from "../src/types";

let tempRoot: string;

async function makeSafeFolder(name: string) {
  const folder = path.join(tempRoot, name);

  await mkdir(folder, { recursive: true });

  return folder;
}

async function connectFolder(
  folderPath: string,
  permissions: Partial<BridgePermissions> = {},
) {
  const selection = await createFolderSelection(folderPath);

  return registerRootFromSelection({
    permissions: {
      ...defaultBridgePermissions,
      ...permissions,
    },
    selectionToken: selection.selectionToken,
  });
}

async function waitForWatcherEvents(rootId: string, timeoutMs = 2500) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const events = await takeBridgeWatcherEvents(rootId);

    if (events.length > 0) {
      return events;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return [] as Awaited<ReturnType<typeof takeBridgeWatcherEvents>>;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-bridge-test-"));
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".bridge-data");
});

afterEach(async () => {
  await rm(tempRoot, { force: true, recursive: true });
  delete process.env.NSN_BRIDGE_DATA_DIR;
});

describe("NSN Bridge core", () => {
  it("requires pairing authentication for operational requests", async () => {
    const server = createBridgeServer();
    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const value = server.address() as AddressInfo | null;

        assert.ok(value);
        resolve({ port: value.port });
      });
    });
    const secret = await getOrCreatePairingSecret();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const unauthorized = await fetch(`${baseUrl}/bridge/v1/roots`);
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`${baseUrl}/bridge/v1/roots`, {
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      });

      assert.equal(authorized.status, 200);
      assert.equal((await authorized.json()).ok, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("registers a root from a selection token and consumes the token", async () => {
    const folder = await makeSafeFolder("library-a");
    const selection = await createFolderSelection(folder);
    const root = await registerRootFromSelection({
      permissions: defaultBridgePermissions,
      selectionToken: selection.selectionToken,
    });

    assert.equal(root.displayName, "library-a");
    assert.equal(root.status, "CONNECTED");
    assert.match(root.id, /^root_[a-f0-9]{24}$/);

    await assert.rejects(
      () =>
        registerRootFromSelection({
          permissions: defaultBridgePermissions,
          selectionToken: selection.selectionToken,
        }),
      /expired/i,
    );
  });

  it("deduplicates reconnects for the same folder", async () => {
    const folder = await makeSafeFolder("library-b");
    const first = await connectFolder(folder);

    await disconnectRoot(first.id);

    const second = await connectFolder(folder);

    assert.equal(second.id, first.id);
    assert.equal(second.status, "CONNECTED");
  });

  it("uses the same root identity for path slash and casing variants", async () => {
    const folder = await makeSafeFolder("library-b-variants");
    const first = await connectFolder(folder);
    const slashVariant = `${folder.replaceAll(path.sep, "/")}/`;
    const second = await connectFolder(slashVariant);

    assert.equal(second.id, first.id);

    if (process.platform === "win32") {
      const lowerCaseVariant = `${folder.toLowerCase()}\\`;
      const third = await connectFolder(lowerCaseVariant);

      assert.equal(third.id, first.id);
    }
  });

  it("enforces read and watch permissions", async () => {
    const folder = await makeSafeFolder("library-c");
    await writeFile(path.join(folder, "note.txt"), "one note");
    const root = await connectFolder(folder, {
      readPermission: false,
      watchPermission: false,
    });

    await assert.rejects(
      () => requireRootPermission(root.id, "readPermission", "scan files"),
      /permission/i,
    );
    await assert.rejects(() => scanBridgeRoot(root.id), /permission/i);
    await assert.rejects(() => startBridgeWatcher(root.id), /permission/i);
  });

  it("starts the watcher idempotently and drains detected events", async () => {
    const folder = await makeSafeFolder("library-c-watch");
    const root = await connectFolder(folder, {
      watchPermission: true,
    });

    const firstStart = await startBridgeWatcher(root.id);
    const secondStart = await startBridgeWatcher(root.id);

    assert.equal(firstStart.watcherState, "WATCHING");
    assert.equal(secondStart.watcherState, "WATCHING");
    assert.equal(isWatching(root.id), true);

    await writeFile(
      path.join(folder, "watcher-live-test.txt"),
      "Attachment, safety, regulation, and Becoming.",
    );

    const events = await waitForWatcherEvents(root.id);

    assert.equal(events.length > 0, true);
    assert.equal(
      events.some(
        (event) => event.relativePath === "watcher-live-test.txt",
      ),
      true,
    );

    await stopBridgeWatcher(root.id);
  });

  it("pauses and resumes the watcher without losing the root connection", async () => {
    const folder = await makeSafeFolder("library-c-pause");
    const root = await connectFolder(folder, {
      watchPermission: true,
    });

    await startBridgeWatcher(root.id);
    const paused = await pauseBridgeWatcher(root.id);

    assert.equal(paused.watcherState, "PAUSED");
    assert.equal(isWatching(root.id), false);

    await writeFile(path.join(folder, "created-while-paused.txt"), "paused");
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.deepEqual(await takeBridgeWatcherEvents(root.id), []);

    const resumed = await resumeBridgeWatcher(root.id);

    assert.equal(resumed.watcherState, "WATCHING");
    assert.equal(isWatching(root.id), true);

    await writeFile(path.join(folder, "created-after-resume.txt"), "resumed");

    const events = await waitForWatcherEvents(root.id);

    assert.equal(
      events.some((event) => event.relativePath === "created-after-resume.txt"),
      true,
    );

    await stopBridgeWatcher(root.id);
  });

  it("reports an unavailable root safely when watching starts", async () => {
    const folder = await makeSafeFolder("library-c-missing");
    const root = await connectFolder(folder, {
      watchPermission: true,
    });

    await rm(folder, { force: true, recursive: true });

    await assert.rejects(
      () => startBridgeWatcher(root.id),
      (error) =>
        error instanceof BridgeAppError && error.code === "ROOT_UNAVAILABLE",
    );
  });

  it("stops the watcher when watch permission is revoked through the Bridge API", async () => {
    const folder = await makeSafeFolder("library-c-revoke");
    const root = await connectFolder(folder, {
      watchPermission: true,
    });
    const server = createBridgeServer();
    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const value = server.address() as AddressInfo | null;

        assert.ok(value);
        resolve({ port: value.port });
      });
    });
    const secret = await getOrCreatePairingSecret();

    try {
      await startBridgeWatcher(root.id);
      assert.equal(isWatching(root.id), true);

      const response = await fetch(
        `http://127.0.0.1:${address.port}/bridge/v1/roots/${encodeURIComponent(
          root.id,
        )}`,
        {
          body: JSON.stringify({
            watchPermission: false,
          }),
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          method: "PATCH",
        },
      );
      const payload = (await response.json()) as {
        root: { watcherState: string };
      };

      assert.equal(response.status, 200);
      assert.equal(payload.root.watcherState, "STOPPED");
      assert.equal(isWatching(root.id), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("requires read permission before watch permission can be granted", async () => {
    const folder = await makeSafeFolder("library-d");
    const selection = await createFolderSelection(folder);

    await assert.rejects(
      () =>
        registerRootFromSelection({
          permissions: {
            ...defaultBridgePermissions,
            readPermission: false,
            watchPermission: true,
          },
          selectionToken: selection.selectionToken,
        }),
      /Watching requires/i,
    );
  });

  it("rejects traversal and cross-library relative paths", async () => {
    const folderA = await makeSafeFolder("library-e-a");
    const folderB = await makeSafeFolder("library-e-b");
    const rootA = await connectFolder(folderA);

    await writeFile(path.join(folderB, "outside.txt"), "outside");

    await assert.rejects(
      () => resolveInsideRoot(folderA, "../library-e-b/outside.txt"),
      /relative path/i,
    );
    await assert.rejects(
      () => readBridgeRootFile(rootA.id, "../library-e-b/outside.txt"),
      /relative path/i,
    );
    await assert.rejects(
      () => resolveBridgeRootFile(rootA.id, "../library-e-b/outside.txt"),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "PATH_TRAVERSAL_REJECTED",
    );
  });

  it("resolves nested MP3 and WAV files with normalized slash variants", async () => {
    const folder = await makeSafeFolder("library-media-a");
    const meetingFolder = path.join(folder, "Audio", "Meetings");
    const workshopFolder = path.join(folder, "Audio", "Workshops");
    const mp3Path = path.join(
      meetingFolder,
      "attachment-planning-meeting.mp3",
    );
    const wavPath = path.join(
      workshopFolder,
      "becoming-workshop-recording.wav",
    );
    const root = await connectFolder(folder);

    await mkdir(meetingFolder, { recursive: true });
    await mkdir(workshopFolder, { recursive: true });
    await writeFile(mp3Path, "mp3 placeholder");
    await writeFile(wavPath, "wav placeholder");

    const resolvedMp3 = await resolveBridgeRootFile(
      root.id,
      "Audio\\Meetings\\attachment-planning-meeting.mp3",
    );
    const resolvedWav = await resolveBridgeRootFile(
      root.id,
      "Audio/Workshops/becoming-workshop-recording.wav",
    );

    assert.equal(
      resolvedMp3.relativePath,
      "Audio/Meetings/attachment-planning-meeting.mp3",
    );
    assert.equal(
      path.normalize(resolvedMp3.localPath),
      path.normalize(mp3Path),
    );
    assert.equal(
      resolvedWav.relativePath,
      "Audio/Workshops/becoming-workshop-recording.wav",
    );
    assert.equal(
      path.normalize(resolvedWav.localPath),
      path.normalize(wavPath),
    );
  });

  it("classifies scanned JPG, PNG, and WEBP files as images", async () => {
    const folder = await makeSafeFolder("library-image-a");
    const imageFolder = path.join(folder, "Images", "Website Candidates");
    const root = await connectFolder(folder);

    await mkdir(imageFolder, { recursive: true });
    await writeFile(path.join(imageFolder, "becoming-workshop-hero.jpg"), "jpg placeholder");
    await writeFile(path.join(imageFolder, "attachment-slide.png"), "png placeholder");
    await writeFile(path.join(imageFolder, "landing-card.webp"), "webp placeholder");

    const scan = await scanBridgeRoot(root.id);
    const byPath = new Map(scan.files.map((file) => [file.relativePath, file]));

    assert.equal(
      byPath.get("Images/Website Candidates/becoming-workshop-hero.jpg")?.fileType,
      "IMAGE_JPG",
    );
    assert.equal(
      byPath.get("Images/Website Candidates/attachment-slide.png")?.fileType,
      "IMAGE_PNG",
    );
    assert.equal(
      byPath.get("Images/Website Candidates/landing-card.webp")?.fileType,
      "IMAGE_WEBP",
    );
    assert.equal(
      byPath.get("Images/Website Candidates/becoming-workshop-hero.jpg")?.readStatus,
      "SUPPORTED",
    );
  });

  it("reports stale roots, revoked read permission, and missing files safely", async () => {
    const folder = await makeSafeFolder("library-media-b");
    const root = await connectFolder(folder);

    await assert.rejects(
      () => resolveBridgeRootFile("root_missing_for_resolver", "note.mp3"),
      (error) =>
        error instanceof BridgeAppError && error.code === "ROOT_NOT_FOUND",
    );
    await assert.rejects(
      () => resolveBridgeRootFile(root.id, "Audio/missing.mp3"),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "SOURCE_FILE_MISSING",
    );

    await registerRootFromSelection({
      permissions: {
        ...defaultBridgePermissions,
        readPermission: false,
      },
      selectionToken: (await createFolderSelection(folder)).selectionToken,
    });

    await assert.rejects(
      () => resolveBridgeRootFile(root.id, "Audio/missing.mp3"),
      (error) =>
        error instanceof BridgeAppError && error.code === "PERMISSION_DENIED",
    );
  });

  it("blocks resolver reads after disconnect", async () => {
    const folder = await makeSafeFolder("library-media-c");
    const root = await connectFolder(folder);

    await disconnectRoot(root.id);

    await assert.rejects(
      () => resolveBridgeRootFile(root.id, "Audio/missing.mp3"),
      (error) =>
        error instanceof BridgeAppError && error.code === "ROOT_DISCONNECTED",
    );
  });

  it("rejects symlink escapes when the OS allows symlink creation", async (t) => {
    const folderA = await makeSafeFolder("library-f-a");
    const folderB = await makeSafeFolder("library-f-b");
    const rootA = await connectFolder(folderA);
    const outsideFile = path.join(folderB, "outside.txt");
    const linkPath = path.join(folderA, "linked-outside.txt");

    await writeFile(outsideFile, "outside");

    try {
      await symlink(outsideFile, linkPath);
    } catch {
      t.skip("This Windows account cannot create symlinks.");
      return;
    }

    await assert.rejects(
      () => readBridgeRootFile(rootA.id, "linked-outside.txt"),
      /symlink/i,
    );
    await assert.rejects(
      () => resolveBridgeRootFile(rootA.id, "linked-outside.txt"),
      (error) =>
        error instanceof BridgeAppError &&
        (error.code === "SYMLINK_ESCAPE_REJECTED" ||
          error.code === "UNSAFE_SYMLINK"),
    );
  });

  it("blocks execution after permissions are revoked", async () => {
    const folder = await makeSafeFolder("library-g");
    const root = await connectFolder(folder, {
      moveFilePermission: true,
    });

    await requireExecutionPermissions(root.id, [
      {
        actionType: "MOVE_FILE",
      },
    ]);

    await registerRootFromSelection({
      permissions: {
        ...defaultBridgePermissions,
        moveFilePermission: false,
      },
      selectionToken: (await createFolderSelection(folder)).selectionToken,
    });

    await assert.rejects(
      () =>
        requireExecutionPermissions(root.id, [
          {
            actionType: "MOVE_FILE",
          },
        ]),
      /permission/i,
    );
  });

  it("disconnect preserves the root record but blocks future operations", async () => {
    const folder = await makeSafeFolder("library-h");
    const root = await connectFolder(folder);
    const disconnected = await disconnectRoot(root.id);

    assert.equal(disconnected.status, "DISCONNECTED");

    await assert.rejects(
      () => requireRootPermission(root.id, "readPermission", "scan files"),
      /disconnected/i,
    );
  });
});
