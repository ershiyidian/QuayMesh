import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../src/ui/fleet/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/ui/fleet/', import.meta.url));
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
