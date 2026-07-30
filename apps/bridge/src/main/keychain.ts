import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const serviceName = "NSN Bridge";

function localSecretsDir() {
  return path.join(os.homedir(), ".nsn-bridge", "secure");
}

function fallbackSecretPath(account: string) {
  return path.join(localSecretsDir(), `${account}.json`);
}

function runSecurityCli(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString("utf8").trim());
      } else {
        reject(new Error("KEYCHAIN_UNAVAILABLE"));
      }
    });
  });
}

export async function saveBridgeSecret(account: string, value: string) {
  if (process.platform === "darwin") {
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
  if (process.platform === "darwin") {
    return runSecurityCli([
      "find-generic-password",
      "-s",
      serviceName,
      "-a",
      account,
      "-w",
    ]);
  }

  const parsed = JSON.parse(
    await readFile(fallbackSecretPath(account), "utf8"),
  ) as { value?: unknown };

  return typeof parsed.value === "string" ? parsed.value : null;
}
