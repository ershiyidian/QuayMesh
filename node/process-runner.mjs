import { spawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';

let child;
let started = false;
process.on('message', message => {
  if (!message || message.type !== 'start' || started) return;
  started = true;
  child = message.program ? crossSpawn(message.program.executable,message.program.args,{
    cwd:message.cwd,env:process.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
  }) : spawn(message.command, {
    cwd: message.cwd,
    env: process.env,
    shell: message.shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.once('spawn', () => process.send?.({ type: 'started', pid: child.pid }));
  child.once('error', error => {
    process.send?.({ type: 'start-error', message: error.message });
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => process.send?.({ type: 'root-exit', code, signal }));
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') process.send?.({ type: 'stream-error', message: error.message });
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.once('close', code => {
    process.exitCode = code ?? 1;
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    if (process.connected) process.disconnect();
  });
});
process.on('disconnect', () => {
  if (!started) process.exitCode = 1;
});
