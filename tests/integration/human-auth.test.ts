import assert from "node:assert/strict";
import test from "node:test";

import { authConfigurationStatus } from "../../src/lib/auth/config";
import { requestIsSameOrigin, safeInternalPath } from "../../src/lib/auth/http";
import { verifyNsnPassword } from "../../src/lib/auth/password";
import {
  isHumanApiPath,
  isPublicMachinePath,
} from "../../src/lib/auth/route-policy";
import {
  createHumanSessionToken,
  verifyHumanSessionToken,
} from "../../src/lib/auth/token";

const passwordHash =
  "scrypt$16384$8$1$P8jHqWKy4BTWAxtbx0F4KA$lJEt1Uo6FGfSbOhXh4BdNhks_I_olwzdWWIUMCEPUMmSoc4y1WshMpXT8HgvnEC0W_YfGE18U-OAc-8RMvQXwQ";
const originalSecret = process.env.NSN_AUTH_SECRET;
const originalUsers = process.env.NSN_AUTH_USERS_JSON;

function approvedUser(email: string, name: string, role: "OWNER" | "LIBRARIAN") {
  return { email, name, passwordHash, role };
}

function configureAuth() {
  process.env.NSN_AUTH_SECRET =
    "test-auth-secret-that-is-longer-than-thirty-two-characters";
  process.env.NSN_AUTH_USERS_JSON = JSON.stringify([
    approvedUser("david@example.com", "David", "OWNER"),
    approvedUser("deanne@example.com", "Deanne", "LIBRARIAN"),
  ]);
}

test.after(() => {
  if (originalSecret === undefined) {
    delete process.env.NSN_AUTH_SECRET;
  } else {
    process.env.NSN_AUTH_SECRET = originalSecret;
  }

  if (originalUsers === undefined) {
    delete process.env.NSN_AUTH_USERS_JSON;
  } else {
    process.env.NSN_AUTH_USERS_JSON = originalUsers;
  }
});

test("accepts only configured users and rejects a tampered session", () => {
  configureAuth();
  assert.equal(authConfigurationStatus().configured, true);

  const token = createHumanSessionToken({
    email: "david@example.com",
    name: "David",
    passwordHash,
    role: "OWNER",
  });
  const session = verifyHumanSessionToken(token);

  assert.equal(session?.email, "david@example.com");
  assert.equal(session?.role, "OWNER");
  assert.equal(verifyHumanSessionToken(`${token}tampered`), null);

  process.env.NSN_AUTH_USERS_JSON = JSON.stringify([
    approvedUser("deanne@example.com", "Deanne", "LIBRARIAN"),
  ]);
  assert.equal(verifyHumanSessionToken(token), null);
});

test("refuses an auth configuration with more than two human accounts", () => {
  configureAuth();
  process.env.NSN_AUTH_USERS_JSON = JSON.stringify([
    approvedUser("david@example.com", "David", "OWNER"),
    approvedUser("deanne@example.com", "Deanne", "LIBRARIAN"),
    approvedUser("third@example.com", "Third User", "LIBRARIAN"),
  ]);

  const status = authConfigurationStatus();
  assert.equal(status.tooManyUsers, true);
  assert.equal(status.configured, false);
});

test("verifies the scrypt password hash without storing a plain password", async () => {
  assert.equal(await verifyNsnPassword("not-a-real-password", passwordHash), true);
  assert.equal(await verifyNsnPassword("wrong-password-value", passwordHash), false);
});

test("protects human APIs but exempts signed Bridge device traffic", () => {
  assert.equal(
    isPublicMachinePath("/api/bridge/cloud/devices/device-1/commands"),
    true,
  );
  assert.equal(
    isPublicMachinePath("/api/bridge/cloud/pairing-codes/redeem"),
    true,
  );
  assert.equal(isHumanApiPath("/api/bridge/scan"), true);
  assert.equal(
    isHumanApiPath("/api/bridge/organization-plans/plan-1/execute"),
    true,
  );
  assert.equal(isHumanApiPath("/api/library/review"), true);
});

test("blocks open redirects and cross-origin state-changing requests", () => {
  assert.equal(safeInternalPath("https://example.com"), "/admin/library");
  assert.equal(safeInternalPath("//example.com"), "/admin/library");
  assert.equal(safeInternalPath("/admin/library/review"), "/admin/library/review");

  assert.equal(
    requestIsSameOrigin(
      new Request("https://nsn-librarian.vercel.app/api/library/review", {
        headers: {
          host: "nsn-librarian.vercel.app",
          origin: "https://nsn-librarian.vercel.app",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
    ),
    true,
  );
  assert.equal(
    requestIsSameOrigin(
      new Request("https://nsn-librarian.vercel.app/api/library/review", {
        headers: {
          host: "nsn-librarian.vercel.app",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "POST",
      }),
    ),
    false,
  );
});
