import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scanAvailability } from "../../src/lib/bridge/permission-ux";

const connectedLibrary = {
  bridgeReachable: true,
  isEnabled: true,
  readPermission: true,
  requiresReconnect: false,
  status: "CONNECTED" as const,
};

test("Scan Now availability distinguishes ready, pending, Bridge, and permission states", () => {
  assert.equal(
    scanAvailability({ library: connectedLibrary, pending: {} }).reason,
    "AVAILABLE",
  );
  assert.equal(
    scanAvailability({
      library: connectedLibrary,
      pending: {
        readPermission: { status: "updating", value: true },
      },
    }).reason,
    "UPDATING",
  );
  assert.equal(
    scanAvailability({
      library: { ...connectedLibrary, bridgeReachable: false },
      pending: {},
    }).reason,
    "BRIDGE_UNAVAILABLE",
  );
  assert.equal(
    scanAvailability({
      library: { ...connectedLibrary, readPermission: false },
      pending: {},
    }).reason,
    "READ_PERMISSION_REQUIRED",
  );
});

test("Connected Libraries keeps Scan Now visible with an explanation", async () => {
  const source = await readFile(
    "src/components/library/ConnectedLibrariesManager.tsx",
    "utf8",
  );

  assert.match(source, /scanAvailability/);
  assert.match(source, /Scan Now/);
  assert.match(source, /Check Bridge Status/);
  assert.match(source, /scanState\.message/);
});
