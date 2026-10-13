#!/usr/bin/env node
/** Run the network/runtime suites independently of provider and database dependencies. */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.federation-tests');
const typeRoots = process.env.QUAYMESH_NODE_TYPE_ROOT;
const include = ['types', 'transport', 'replica', 'routing', 'egress', 'health', 'runtime'].map((name) => resolve(root, `src/federation/${name}.ts`));
include.push(resolve(root, 'test/federation/core.test.ts'), resolve(root, 'test/federation/runtime.test.ts'));
await mkdir(output, { recursive: true });
const config = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
  types: ['node'], ...(typeRoots ? { typeRoots: [typeRoots] } : {}), rootDir: root, outDir: resolve(output, 'js') }, include };
await writeFile(resolve(output, 'tsconfig.json'), JSON.stringify(config, null, 2));
await writeFile(resolve(output, 'package.json'), '{"type":"module"}');
const tsc = process.env.QUAYMESH_TSC || resolve(root, 'node_modules/typescript/bin/tsc');
const compiled = spawnSync(process.execPath, [tsc, '-p', resolve(output, 'tsconfig.json')], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const tested = spawnSync(process.execPath, ['--test', resolve(output, 'js/test/federation/core.test.js'), resolve(output, 'js/test/federation/runtime.test.js')], { stdio: 'inherit' });
process.exitCode = tested.status ?? 1;
