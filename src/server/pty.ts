import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scrollback mirrored per terminal so a newly opened browser tab can replay the screen. */
const BUFFER_MAX = 256 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

/** Where agent hosts announce themselves; survives server restarts. */
export const REGISTRY_DIR = path.join(os.homedir(), '.agent-office', 'agents');
const HOST_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'host', 'agent-host.mjs');

// Per-session markers Claude Code sets for its own child processes. An agent must not inherit them: e.g. with
// CLAUDE_CODE_CHILD_SESSION, claude believes it is a sub-session and stops saving its transcript (seen in testing
// when the server itself was started from inside a Claude session). User config (CLAUDE_CONFIG_DIR, ANTHROPIC_*) is kept.
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

/** What a host records about its agent, so a restarted server can re-register it. */
export interface AgentMeta {
  id: string;
  repo: string;
  /** Display/session name for launched agents ("<repo>-<n>"). */
  name?: string;
  sessionId?: string;
  /** Session ids this agent's claude ran before switching (kept across restarts). */
  previousSessionIds?: string[];
  cwd: string;
}

interface Entry {
  sock?: net.Socket;
  buffer: string;
  alive: boolean;
  /** Writes made before the connection is up. */
  queue: string[];
  /** The process the host started in the terminal (the shell that runs claude); claude is it or its child. */
  procPid?: number;
}

let ptyAvailable = false;
try {
  await import('node-pty');
  ptyAvailable = true;
} catch (e) {
  console.warn(`[pty] node-pty failed to load: ${(e as Error).message}`);
}

const safeId = (id: string) => id.replace(/[^\w.-]/g, '_');
/** A host that accepted the connection must greet within this time, or the connection counts as failed. */
const HELLO_TIMEOUT_MS = 5000;

/** Quote one token for the platform shell when it contains spaces or shell metacharacters. */
function shellQuote(s: string, isWin: boolean): string {
  if (/^[\w@%+=:,./\\-]+$/.test(s)) return s;
  return isWin ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `claudeCommand` is either a command with flags ("claude --model opus"), passed through as-is, or a path to the
 * executable, which may contain spaces ("C:\Program Files\nodejs\claude.cmd") and must then be quoted as one token.
 */
function commandPart(command: string, isWin: boolean): string {
  return fs.existsSync(command) ? shellQuote(command, isWin) : command;
}

/**
 * Runs `claude` in pseudo-terminals (ConPTY on Windows) owned by small detached "agent host" processes
 * (host/agent-host.mjs), one per agent. Agents keep running when this server stops; on start, restore() reconnects.
 * Emits 'data' (id, chunk) and 'exit' (id, code).
 */
export class PtyManager extends EventEmitter {
  readonly available = ptyAvailable;
  private entries = new Map<string, Entry>();

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  has(id: string) {
    return this.entries.get(id)?.alive ?? false;
  }

  /** Ids of terminals still running, including ones asked to stop that haven't exited yet. New names must avoid these. */
  ids(): string[] {
    return [...this.entries].filter(([, e]) => e.alive).map(([id]) => id);
  }

  buffer(id: string) {
    return this.entries.get(id)?.buffer ?? '';
  }

  /** Start `command args…` in `cwd` inside a new agent host (through the platform shell, so `claude.cmd` resolves). */
  spawn(id: string, cwd: string, command: string, args: string[], extraEnv: Record<string, string>, meta: AgentMeta) {
    if (!this.available) throw new Error('node-pty is not available');
    if (this.has(id)) throw new Error(`Terminal ${id} is already running`);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.includes(k)) env[k] = v;
    Object.assign(env, extraEnv, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });

    const isWin = process.platform === 'win32';
    const line = [commandPart(command, isWin), ...args.map((a) => shellQuote(a, isWin))].join(' ');
    const spec = {
      id,
      file: isWin ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh'),
      // /s: cmd strips exactly the outer quotes and runs the rest verbatim, so quoted paths survive.
      args: isWin ? `/d /s /c "${line}"` : ['-lc', line],
      cwd,
      cols: 120,
      rows: 32,
      registryDir: REGISTRY_DIR,
      meta,
    };
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    // Remove a leftover registration so we wait for the new host's own.
    try {
      fs.unlinkSync(path.join(REGISTRY_DIR, `${safeId(id)}.json`));
    } catch {
      /* none */
    }
    const child = spawnProcess(process.execPath, [HOST_SCRIPT, Buffer.from(JSON.stringify(spec)).toString('base64')], {
      cwd,
      env,
      detached: true, // own process group, no console: survives the server and its window closing
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const entry: Entry = { buffer: '', alive: true, queue: [] };
    this.entries.set(id, entry);
    this.waitAndConnect(id, entry).catch((e) => {
      console.warn(`[pty] ${id}: ${(e as Error).message}`);
      this.markDead(id, entry, -1);
    });
  }

  /** Reconnect to agent hosts left running by a previous server. Returns the agents found. */
  async restore(): Promise<AgentMeta[]> {
    if (!fs.existsSync(REGISTRY_DIR)) return [];
    const found: AgentMeta[] = [];
    for (const f of fs.readdirSync(REGISTRY_DIR).filter((n) => n.endsWith('.json'))) {
      const file = path.join(REGISTRY_DIR, f);
      let info: AgentMeta & { pipe: string };
      try {
        info = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (this.entries.has(info.id)) continue;
      const entry: Entry = { buffer: '', alive: true, queue: [] };
      this.entries.set(info.id, entry);
      try {
        entry.procPid = (info as { claudePid?: number }).claudePid;
        await this.connect(info.id, entry, info.pipe);
        if (entry.alive) found.push(info);
      } catch {
        // Host is gone (machine rebooted, process killed): forget it.
        this.entries.delete(info.id);
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    }
    return found;
  }

  private async waitAndConnect(id: string, entry: Entry) {
    const regFile = path.join(REGISTRY_DIR, `${safeId(id)}.json`);
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const info = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        entry.procPid = info.claudePid;
        return await this.connect(id, entry, info.pipe);
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error('agent host did not start in time');
  }

  /**
   * Connect to a host's pipe; resolves once its hello (with the scrollback) arrived. Rejects if the connection fails,
   * closes before the hello, or the hello doesn't come within HELLO_TIMEOUT_MS, so a dead or stuck host can never
   * hang start-up (restore) or leave a launch pending forever.
   */
  private connect(id: string, entry: Entry, pipe: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(pipe);
      let rest = '';
      let greeted = false;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('agent host did not answer')), HELLO_TIMEOUT_MS);
      sock.setEncoding('utf8');
      sock.on('error', (e) => fail(e)); // after the hello, 'close' (below) handles the failure
      sock.on('data', (chunk: string) => {
        rest += chunk;
        let nl;
        while ((nl = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.type === 'hello') {
            if (settled) return; // timed out already
            settled = greeted = true;
            clearTimeout(timer);
            entry.sock = sock;
            entry.buffer = String(m.buffer ?? '').slice(-BUFFER_MAX);
            for (const q of entry.queue.splice(0)) sock.write(q);
            if (!m.alive) this.markDead(id, entry, m.code ?? 0);
            resolve();
          } else if (m.type === 'data') {
            entry.buffer = (entry.buffer + m.data).slice(-BUFFER_MAX);
            this.emit('data', id, m.data);
          } else if (m.type === 'exit') {
            this.markDead(id, entry, m.code ?? 0);
          }
        }
      });
      sock.on('close', () => {
        if (!greeted) fail(new Error('agent host closed the connection before greeting'));
        else if (this.entries.get(id) === entry && entry.sock === sock) this.markDead(id, entry, -1);
      });
    });
  }

  private markDead(id: string, entry: Entry, code: number) {
    if (!entry.alive) return;
    entry.alive = false;
    entry.sock?.destroy();
    this.emit('exit', id, code);
  }

  private send(id: string, msg: object) {
    const e = this.entries.get(id);
    if (!e?.alive) return;
    const line = JSON.stringify(msg) + '\n';
    if (e.sock) e.sock.write(line);
    else e.queue.push(line);
  }

  write(id: string, data: string) {
    this.send(id, { type: 'input', data });
  }

  resize(id: string, cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.send(id, { type: 'resize', cols, rows });
  }

  /** Type a prompt into Claude's input and submit it. Bracketed paste keeps multi-line prompts intact. */
  async sendPrompt(id: string, text: string) {
    if (!this.has(id)) throw new Error('Terminal is not running');
    this.write(id, `\x1b[200~${text}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 150));
    this.write(id, '\r');
  }

  /** Stop claude (the host exits with it). */
  kill(id: string) {
    this.send(id, { type: 'kill' });
    const e = this.entries.get(id);
    if (e) setTimeout(() => this.entries.get(id) === e && this.entries.delete(id), 3000);
  }

  /** Disconnect from all hosts without stopping them (server shutdown). */
  /** The agent whose terminal process is `pid` (pass a claude pid, then its parent: claude runs under the shell). */
  agentForProcess(pid: number): string | undefined {
    for (const [id, e] of this.entries) if (e.alive && e.procPid === pid) return id;
    return undefined;
  }

  /** Update what the host's registry file says about the agent, so a restarted server restores the same state. */
  updateMeta(id: string, fields: Partial<AgentMeta>) {
    const file = path.join(REGISTRY_DIR, `${safeId(id)}.json`);
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...info, ...fields }, null, 2));
    } catch (e) {
      console.warn(`[pty] could not update registry for ${id}: ${(e as Error).message}`);
    }
  }

  detachAll() {
    for (const e of this.entries.values()) {
      e.sock?.removeAllListeners('close');
      e.sock?.destroy();
    }
    this.entries.clear();
  }
}
