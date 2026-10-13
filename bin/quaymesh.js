#!/usr/bin/env node
import { main } from "../node/cli.mjs";
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
