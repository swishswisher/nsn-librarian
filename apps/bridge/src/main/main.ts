import { startElectronBridgeApp } from "./electron-main";

startElectronBridgeApp().catch(() => {
  process.stderr.write("NSN Bridge could not start safely.\n");
  process.exitCode = 1;
});
