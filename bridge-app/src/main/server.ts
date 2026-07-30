import { createBridgeServer } from "../api/server";
import { requirePairingSecret } from "../security/pairing";

const bridgePort = Number(process.env.NSN_BRIDGE_PORT ?? 4777);
const bridgeHost = "127.0.0.1";

async function main() {
  await requirePairingSecret();

  const server = createBridgeServer();

  server.listen(bridgePort, bridgeHost, () => {
    process.stdout.write(
      `NSN Bridge ready at http://${bridgeHost}:${bridgePort}\n`,
    );
  });
}

main().catch(() => {
  process.stderr.write("The NSN Bridge could not start safely.\n");
  process.exitCode = 1;
});
