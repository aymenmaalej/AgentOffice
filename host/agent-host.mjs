#!/usr/bin/env node
// Agent host: one small background process per agent. It owns claude's pseudo-terminal and keeps running when the
// Agent Office server stops or restarts; the server (re)connects to it over a local pipe.
//
//   node agent-host.mjs <base64 JSON spec>      (started detached by src/server/pty.ts, never by hand)
//
// spec: { id, file, args, cwd, cols, rows, registryDir, meta }. The environment is inherited from the spawner.
// Protocol (newline-delimited JSON):
//   host -> client: {type:"hello", buffer, alive, code} on connect, then {type:"data", data} / {type:"exit", code}
//   client -> host: {type:"input", data} / {type:"resize", cols, rows} / {type:"kill"}
// While running, <registryDir>/<id>.json describes the agent (so a restarted server can find it); it is deleted on exit.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';

const BUFFER_MAX = 256 * 1024;
const spec = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
const safeId = String(spec.id).replace(/[^\w.-]/g, '_');
const regFile = path.join(spec.registryDir, `${safeId}.json`);
const pipe =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-office-${safeId}-${process.pid}`
    : path.join(spec.registryDir, `${safeId}.sock`);

let buffer = '';
let exitCode = null;
const clients = new Set();
const send = (sock, msg) => {
  try {
    sock.write(JSON.stringify(msg) + '\n');
  } catch {
    /* client gone */
  }
};

const proc = pty.spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  cols: spec.cols ?? 120,
  rows: spec.rows ?? 32,
  name: 'xterm-256color',
});

proc.onData((data) => {
  buffer = (buffer + data).slice(-BUFFER_MAX);
  for (const c of clients) send(c, { type: 'data', data });
});

proc.onExit(({ exitCode: code }) => {
  exitCode = code;
  for (const c of clients) send(c, { type: 'exit', code });
  try {
    fs.unlinkSync(regFile);
  } catch {
    /* already gone */
  }
  // Give the server a moment to receive the exit, then go away.
  setTimeout(() => process.exit(0), 1500);
});

const server = net.createServer((sock) => {
  clients.add(sock);
  sock.setEncoding('utf8');
  send(sock, { type: 'hello', buffer, alive: exitCode === null, code: exitCode });
  let rest = '';
  sock.on('data', (chunk) => {
    rest += chunk;
    let nl;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (exitCode !== null) continue;
      if (m.type === 'input' && typeof m.data === 'string') proc.write(m.data);
      else if (m.type === 'resize' && m.cols > 0 && m.rows > 0) proc.resize(Math.floor(m.cols), Math.floor(m.rows));
      else if (m.type === 'kill') proc.kill();
    }
  });
  const drop = () => clients.delete(sock);
  sock.on('close', drop);
  sock.on('error', drop);
});

fs.mkdirSync(spec.registryDir, { recursive: true });
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(pipe);
  } catch {
    /* no stale socket */
  }
}
server.listen(pipe, () => {
  const info = { ...spec.meta, id: spec.id, pipe, hostPid: process.pid, claudePid: proc.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(regFile, JSON.stringify(info, null, 2));
});
