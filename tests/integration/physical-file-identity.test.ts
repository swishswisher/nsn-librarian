import assert from "node:assert/strict";
import { test } from "node:test";

import {
  samePhysicalFile,
  type PhysicalFileIdentityInput,
} from "../../src/lib/bridge/physical-file-identity";

function file(
  connectedFolder: PhysicalFileIdentityInput["scanSession"]["connectedFolder"],
  relativePath: string,
): PhysicalFileIdentityInput {
  return { relativePath, scanSession: { connectedFolder } };
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
