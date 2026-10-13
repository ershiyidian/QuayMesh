import {copyFile,mkdir,stat} from "node:fs/promises";
import {resolve,dirname} from "node:path";

const source=resolve("dist/ui-card/workspace-app.html");
await stat(source).catch(()=>{throw new Error("CARD_BUILD_MISSING: run pnpm build:app before exporting the preview");});
const target=resolve(process.argv[2]??"releases/session-card-preview.html");
await mkdir(dirname(target),{recursive:true});
await copyFile(source,target);
console.log(target);
