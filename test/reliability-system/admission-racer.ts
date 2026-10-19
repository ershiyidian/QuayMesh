import {appendFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {openDatabase} from "../../src/db/client.js";
import {SessionStore} from "../../src/session/store.js";
import {createInvocationContext, executeRecorded} from "../../src/session/invocations.js";

const [stateDir, identityJson, inputJson, path] = process.argv.slice(2) as [string, string, string, string];
const database = openDatabase(stateDir);
try {
  process.send?.({ready: true});
  await new Promise<void>(resolve => process.once("message", () => resolve()));
  const context = createInvocationContext(JSON.parse(identityJson));
  const result = await executeRecorded(new SessionStore(database.sqlite), context, JSON.parse(inputJson), {
    invoke: async () => {
      await appendFile(path, `${process.pid}\n`);
      await delay(100);
      return {operation_id: context.operation_id, pid: process.pid};
    },
    sideEffecting: true,
  });
  process.send?.({result});
} finally {
  database.close();
  process.disconnect?.();
}
