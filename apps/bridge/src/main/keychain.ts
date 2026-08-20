import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const serviceName = "NSN Bridge";

export type BridgeSecretReadResult =
  | {
      account: string;
      status: "PRESENT";
      value: string;
    }
  | {
      account: string;
      safeErrorCategory: "SECRET_MISSING";
      status: "MISSING";
    }
  | {
      account: string;
      safeErrorCategory: "KEYCHAIN_UNAVAILABLE" | "SECRET_READ_FAILED";
      status: "UNAVAILABLE";
    };

class SecurityCliError extends Error {
  code: number | null;
  stderr: string;

  constructor(code: number | null, stderr: string) {
    super("KEYCHAIN_READ_FAILED");
    this.name = "SecurityCliError";
    this.code = code;
    this.stderr = stderr;
  }
}

function localSecretsDir() {
  const configuredDataDir = process.env.NSN_BRIDGE_DATA_DIR?.trim();
  const baseDir = configuredDataDir || path.join(os.homedir(), ".nsn-bridge");

  return path.join(baseDir, "secure");
}

function fallbackSecretPath(account: string) {
  return path.join(localSecretsDir(), `${account}.json`);
}

function shouldUseMacKeychain() {
  return (
    process.platform === "darwin" &&
    process.env.NSN_BRIDGE_FORCE_FILE_SECRETS_FOR_TESTS !== "1"
  );
}

function runSecurityCli(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorOutput.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString("utf8").trim());
      } else {
        reject(
          new SecurityCliError(
            code,
            Buffer.concat(errorOutput).toString("utf8"),
          ),
        );
      }
    });
  });
}

function isMissingMacSecret(error: unknown) {
  if (!(error instanceof SecurityCliError)) {
    return false;
  }

  const stderr = error.stderr.toLowerCase();

  return (
    error.code === 44 ||
    stderr.includes("could not be found") ||
    stderr.includes("not found") ||
    stderr.includes("no such keychain item")
  );
}

export async function saveBridgeSecret(account: string, value: string) {
  if (shouldUseMacKeychain()) {
    await runSecurityCli([
      "add-generic-password",
      "-U",
      "-s",
      serviceName,
      "-a",
      account,
      "-w",
      value,
    ]);
    return;
  }

  await mkdir(localSecretsDir(), { recursive: true });
  await writeFile(
    fallbackSecretPath(account),
    `${JSON.stringify({ value }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

export async function readBridgeSecret(account: string) {
  const result = await readBridgeSecretState(account);

  return result.status === "PRESENT" ? result.value : null;
}

export async function readBridgeSecretState(
  account: string,
): Promise<BridgeSecretReadResult> {
  try {
    if (shouldUseMacKeychain()) {
      const value = await runSecurityCli([
        "find-generic-password",
        "-s",
        serviceName,
        "-a",
        account,
        "-w",
      ]);

      return value
        ? {
            account,
            status: "PRESENT",
            value,
          }
        : {
            account,
            safeErrorCategory: "SECRET_MISSING",
            status: "MISSING",
          };
    }

    const parsed = JSON.parse(
      await readFile(fallbackSecretPath(account), "utf8"),
    ) as { value?: unknown };

    return typeof parsed.value === "string" && parsed.value.length > 0
      ? {
          account,
          status: "PRESENT",
          value: parsed.value,
        }
      : {
          account,
          safeErrorCategory: "SECRET_MISSING",
          status: "MISSING",
        };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      isMissingMacSecret(error)
    ) {
      return {
        account,
        safeErrorCategory: "SECRET_MISSING",
        status: "MISSING",
      };
    }

    return {
      account,
      safeErrorCategory:
        shouldUseMacKeychain()
          ? "KEYCHAIN_UNAVAILABLE"
          : "SECRET_READ_FAILED",
      status: "UNAVAILABLE",
    };
  }
}
