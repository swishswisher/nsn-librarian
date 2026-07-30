import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PairingFile = {
  createdAt: string;
  secret: string;
};

export function localBridgeDataDir() {
  return path.resolve(
    process.env.NSN_BRIDGE_DATA_DIR?.trim() ||
      path.join(os.homedir(), ".nsn-bridge"),
  );
}

export function localBridgePairingSecretPath() {
  return path.join(localBridgeDataDir(), "pairing-secret.json");
}

function validPairingSecret(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export async function getOrCreateLocalBridgePairingSecret() {
  const filePath = localBridgePairingSecretPath();

  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as PairingFile;

    if (validPairingSecret(parsed.secret)) {
      return parsed.secret;
    }
  } catch {
    // Missing or unreadable pairing files are replaced with a new local secret.
  }

  await mkdir(path.dirname(filePath), { recursive: true });

  const payload: PairingFile = {
    createdAt: new Date().toISOString(),
    secret: randomBytes(32).toString("hex"),
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return payload.secret;
}
