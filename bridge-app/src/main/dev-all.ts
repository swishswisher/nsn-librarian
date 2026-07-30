import { spawn } from "node:child_process";

const commands = [
  {
    args: ["run", "dev:web"],
    label: "web",
  },
  {
    args: ["run", "dev:bridge"],
    label: "bridge",
  },
];

const children = commands.map((command) => {
  const child = spawn("npm", command.args, {
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    if (code && code !== 0) {
      process.stderr.write(`${command.label} exited with code ${code}\n`);
    }
  });

  return child;
});

function stopChildren() {
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", () => {
  stopChildren();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopChildren();
  process.exit(0);
});
