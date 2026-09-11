import assert from "node:assert/strict";
import { test } from "node:test";

import {
  samePhysicalFile,
  type PhysicalFileIdentityInput,
} from "../../src/lib/bridge/physical-file-identity";

function file(
  connectedFolder: PhysicalFileIdentityInput["scanSession"]["connectedFolder"],
  relativePath: string,
  localPath?: string,
): PhysicalFileIdentityInput {
  return { localPath, relativePath, scanSession: { connectedFolder } };
}

const canonicalRoot = {
  bridgeRootId: "root-a",
  canonicalConnectedLibraryId: null,
  folderFingerprint: "root-a",
  id: "canonical-library",
  localPath: "bridge://root-a",
  platform: "MACOS",
};

test("canonical and legacy root aliases identify the same physical file", () => {
  const legacyRoot = {
    ...canonicalRoot,
    bridgeRootId: null,
    canonicalConnectedLibraryId: canonicalRoot.id,
    folderFingerprint: null,
    id: "legacy-library",
    localPath: "bridge://ROOT-A/historical-record",
  };

  assert.equal(
    samePhysicalFile(
      file(canonicalRoot, "Clients/Loose/Alice_Client_Intake.docx"),
      file(legacyRoot, "clients\\loose\\ALICE_CLIENT_INTAKE.docx"),
    ),
    true,
  );
});

test("different paths in one physical root remain distinct files", () => {
  assert.equal(
    samePhysicalFile(
      file(canonicalRoot, "Mixed_Loose/same-content-copy-1.txt"),
      file(canonicalRoot, "Mixed_Loose/same-content-copy-2.txt"),
    ),
    false,
  );
});

test("different connected roots remain distinct even when paths match", () => {
  assert.equal(
    samePhysicalFile(
      file(canonicalRoot, "Damaged/broken-video.mp4"),
      file(
        {
          ...canonicalRoot,
          bridgeRootId: "root-b",
          folderFingerprint: "root-b",
          id: "other-library",
          localPath: "bridge://root-b",
        },
        "Damaged/broken-video.mp4",
      ),
    ),
    false,
  );
});

test("file-level Bridge paths identify stale root aliases as the same physical file", () => {
  const staleRoot = {
    ...canonicalRoot,
    bridgeRootId: "stale-root-id",
    canonicalConnectedLibraryId: null,
    folderFingerprint: "stale-root-id",
    id: "stale-library",
    localPath: "bridge://stale-root-id",
  };

  assert.equal(
    samePhysicalFile(
      file(
        canonicalRoot,
        "Damaged/broken-video.mp4",
        "bridge://root-a/Damaged/broken-video.mp4",
      ),
      file(
        staleRoot,
        "damaged\\BROKEN-VIDEO.mp4",
        "bridge://ROOT-A/damaged/BROKEN-VIDEO.mp4",
      ),
    ),
    true,
  );
});

test("identical relative paths remain distinct when stable Bridge file paths use different roots", () => {
  const otherRoot = {
    ...canonicalRoot,
    bridgeRootId: "root-b",
    folderFingerprint: "root-b",
    id: "other-library",
    localPath: "bridge://root-b",
  };

  assert.equal(
    samePhysicalFile(
      file(
        canonicalRoot,
        "Media/shared.mp3",
        "bridge://root-a/Media/shared.mp3",
      ),
      file(
        otherRoot,
        "Media/shared.mp3",
        "bridge://root-b/Media/shared.mp3",
      ),
    ),
    false,
  );
});
