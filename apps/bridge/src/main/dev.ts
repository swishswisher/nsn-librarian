async function main() {
  if (process.env.NSN_BRIDGE_DESKTOP === "true") {
    await import("./main");
    return;
  }

  await import("../../../../bridge-app/src/main/server");
}

main().catch(() => {
  process.stderr.write("The NSN Bridge development process could not start.\n");
  process.exitCode = 1;
});
