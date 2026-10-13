import { mkdirSync, writeFileSync } from "node:fs";
import {
  quaymeshConfigJsonSchema,
} from "../src/config-schema.js";

const outputPath = new URL("../schema/v1/quaymesh.schema.json", import.meta.url);

mkdirSync(new URL(".", outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(quaymeshConfigJsonSchema(), null, 2)}\n`);
