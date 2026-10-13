import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const mode = argv[0];
const args = argv.slice(1);
const scriptPath = fileURLToPath(import.meta.url);

if (mode === 'append') {
  const path = args[0];
  const text = args[1];
  if (!path || text === undefined) usage('append <path> <text>');
  appendFileSync(path, text + '\n', 'utf8');
  process.stdout.write('APPENDED\n');
} else if (mode === 'utf8') {
  const path = args[0];
  if (!path) usage('utf8 <path> [boundary-indexes]');
  const content = '中文🙂 ASCII\n第二行\n';
  const buffer = Buffer.from(content, 'utf8');
  writeFileSync(path, buffer);
  const boundaries = args[1]
    ? args[1].split(',').map((value) => Number.parseInt(value, 10))
    : [1, 4, 7, 13, buffer.length];
  const sorted = boundaries
    .filter((value, index, list) => Number.isInteger(value) && value >= 0 && value <= buffer.length && list.indexOf(value) === index)
    .sort((left, right) => left - right);
  if (sorted[sorted.length - 1] !== buffer.length) sorted.push(buffer.length);
  let offset = 0;
  for (const boundary of sorted) {
    if (boundary > offset) {
      process.stdout.write(buffer.subarray(offset, boundary));
      offset = boundary;
      await delay(10);
    }
  }
} else if (mode === 'wait') {
  const resultPath = args[0];
  if (!resultPath) usage('wait <result-path>');
  process.stdout.write('READY\n');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.split(/\r?\n/u).includes('GO')) break;
  }
  writeFileSync(resultPath, 'DONE\n', 'utf8');
  process.stdout.write('DONE\n');
} else if (mode === 'fail') {
  const code = Number.parseInt(args[0] || '', 10);
  const description = args[1];
  if (!Number.isInteger(code) || code <= 0 || !description) usage('fail <code> <description>');
  process.stderr.write(description + '\n');
  process.exitCode = code;
} else if (mode === 'hold-stdio') {
  const delayMs = Number.parseInt(args[0] || '150', 10);
  const child = spawn(process.execPath, [scriptPath, 'stdout-child', String(delayMs), 'child-output'], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.unref();
  process.stdout.write('ROOT-EXIT\n');
} else if (mode === 'stdout-child') {
  const delayMs = Number.parseInt(args[0] || '150', 10);
  await delay(delayMs);
  process.stdout.write((args[1] || 'child-output') + '\n');
} else if (mode === 'bulk') {
  const count = Number.parseInt(args[0] || '', 10);
  const sentinel = args[1];
  if (!Number.isInteger(count) || count < 0 || sentinel === undefined) usage('bulk <byte-count> <sentinel>');
  let written = 0;
  while (written < count) {
    const size = Math.min(8192, count - written);
    process.stdout.write(Buffer.alloc(size, 'x'));
    written += size;
  }
  process.stdout.write('\n' + sentinel + '\n');
} else if (mode === '--help' || mode === undefined) {
  process.stdout.write(usageText() + '\n');
} else {
  usage('unknown mode: ' + mode);
}

function usage(detail) {
  process.stderr.write(detail + '\n' + usageText() + '\n');
  process.exit(2);
}

function usageText() {
  return 'usage: node process-worker.mjs <mode> [args]\nmodes: append, utf8, wait, fail, hold-stdio, stdout-child, bulk';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
