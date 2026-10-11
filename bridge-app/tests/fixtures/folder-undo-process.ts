import { journaledRemoveFolder } from "../../src/filesystem/physical-journal";

const [target, owner, originalOwner] = process.argv.slice(2);
void journaledRemoveFolder(owner, originalOwner, target, undefined, async () => {
  process.stdout.write("OWNED_FOLDER_CAPTURED\n");
  await new Promise<void>(() => { setInterval(() => undefined, 1000); });
}).catch(error => { console.error(error); process.exitCode = 1; });
