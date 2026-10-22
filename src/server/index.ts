import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config.ts';
import { AgentStore } from './state.ts';
import { Tmux, sessionSafe } from './tmux.ts';
import { PtyManager } from './pty.ts';
import { TranscriptWatcher } from './transcripts.ts';
import { LiveSessionWatcher, type LiveSession } from './live-sessions.ts';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { Agent, IncomingEvent, IncomingUsage, RepoInfo, ServerMessage } from '../shared/types.ts';

const config = loadConfig();
const tmux = new Tmux(config.tmuxCommand);
const ptys = new PtyManager();
const store = new AgentStore();
/** Claude Code's own registry of open sessions (live status + "open elsewhere"). */
const liveSessions = new LiveSessionWatcher(
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'sessions'),
  store,
  (sessions) => void followSessionSwitches(sessions),
);

/** Parent process id (cached: a pid's parent never changes). */
const ppidCache = new Map<number, number | null>();
function parentPid(pid: number): Promise<number | null> {
  if (ppidCache.has(pid)) return Promise.resolve(ppidCache.get(pid)!);
  return new Promise((resolve) => {
    const done = (out: string) => {
      const n = parseInt(out.trim(), 10);
      const v = Number.isFinite(n) && n > 0 ? n : null;
      ppidCache.set(pid, v);
      resolve(v);
    };
    if (process.platform === 'win32') {
      const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) =>
        done(err ? '' : String(out)),
      );
    } else {
      execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 5000 }, (err, out) => done(err ? '' : String(out)));
    }
  });
}

/**
 * The claude in an agent's terminal can switch to a new session id: `/clear`, or choosing "start a new conversation"
 * when a resumed session is old. Claude Code then reports the new id, which would otherwise show up as a separate
 * read-only agent ("open elsewhere") while the terminal stays on the old one. Match open sessions to our terminals by
 * process (claude runs inside the shell the agent host started) and make the agent follow its new session.
 */
let following = false;
async function followSessionSwitches(sessions: Map<string, LiveSession>) {
  if (following) return;
  following = true;
  try {
    for (const s of sessions.values()) {
      const owner = store.findBySession(s.sessionId);
      if (owner?.runner === 'pty' && owner.sessionId === s.sessionId) continue; // already the agent's current session
      const agentId = ptys.agentForProcess(s.pid) ?? ptys.agentForProcess((await parentPid(s.pid)) ?? -1);
      const agent = agentId ? store.agents.get(agentId) : undefined;
      if (!agentId || !agent || agent.sessionId === s.sessionId) continue;
      console.log(`[sessions] ${agentId}: its claude switched to session ${s.sessionId} (was ${agent.sessionId}); following it`);
      store.relinkSession(agentId, s.sessionId);
      const linked = store.agents.get(agentId)!;
      ptys.updateMeta(agentId, { sessionId: linked.sessionId, previousSessionIds: linked.previousSessionIds });
    }
  } catch (e) {
    console.warn('[sessions] following session switches failed', e);
  } finally {
    following = false;
  }
}
const tmuxAvailable = await tmux.available();

/** Which runner new agents use. */
const runner: 'tmux' | 'pty' | undefined = (() => {
  if (config.runner === 'tmux') return tmuxAvailable ? 'tmux' : undefined;
  if (config.runner === 'pty') return ptys.available ? 'pty' : undefined;
  if (tmuxAvailable && process.platform !== 'win32') return 'tmux';
  return ptys.available ? 'pty' : tmuxAvailable ? 'tmux' : undefined;
})();
console.log(`[runner] new agents run in: ${runner ?? 'nothing (launch disabled)'}  (tmux ${tmuxAvailable ? 'available' : 'not available'})`);

/** Configured repos plus any repo seen in transcripts or hook events (its path = the session's start dir). */
function repos(): RepoInfo[] {
  const list: RepoInfo[] = config.repos.map((r) => ({ ...r }));
  for (const a of store.agents.values()) {
    const known = list.find((r) => r.name === a.repo);
    if (!known) list.push({ name: a.repo, path: a.cwd });
    else if (!known.path && a.cwd) known.path = a.cwd;
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Map a tmux session name "<repo>-<n>" back to its repo. */
function repoForSession(name: string): string | undefined {
  const m = name.match(/^(.*)-(\d+)$/);
  if (!m) return undefined;
  return repos().find((r) => sessionSafe(r.name) === m[1])?.name;
}

const live = (a: Agent) => (a.runner === 'pty' ? ptys.has(a.id) : a.runner === 'tmux' && a.controllable);

/** Agents the app is running in a repo; the per-repo cap applies to these. */
const runningIn = (repo: string) => [...store.agents.values()].filter((a) => a.repo === repo && live(a)).length;
const capError = (repo: string) =>
  runningIn(repo) >= config.maxAgentsPerRepo
    ? `"${repo}" already has ${config.maxAgentsPerRepo} running agent(s), the limit per repo. Stop one first.`
    : undefined;

const snapshotMsg = (): ServerMessage => ({
  type: 'snapshot',
  ...store.snapshot(),
  repos: repos(),
  canLaunch: !!runner,
  maxAgentsPerRepo: config.maxAgentsPerRepo,
  usage: store.usage,
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The request is addressed to this machine by a loopback name (blocks DNS-rebinding hostnames). */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return true;
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Browser requests must come from a page served on this machine. Without this, any website open in your browser could
 * open ws://127.0.0.1:4317/pty and type into a Claude session (browsers don't apply CORS to WebSockets), or POST to
 * /kill. Non-browser clients (hooks, status line, scripts) send no Origin and are allowed.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname);
  } catch {
    return false; // includes "null" (sandboxed iframes, file://)
  }
}

const app = express();
app.use((req, res, next) => {
  if (hostAllowed(req.headers.host) && originAllowed(req.headers.origin)) return next();
  console.warn(`[security] refused ${req.method} ${req.url} (origin=${req.headers.origin ?? '-'}, host=${req.headers.host ?? '-'})`);
  res.status(403).json({ error: 'Forbidden: Agent Office only accepts requests from pages on this computer.' });
});
app.use(express.json({ limit: '1mb' }));

app.post('/events', (req, res) => {
  const body = req.body as IncomingEvent;
  if (!body || typeof body.type !== 'string' || typeof body.repo !== 'string') {
    res.status(400).json({ error: 'expected { type, repo, ... }' });
    return;
  }
  store.ingest(body, 'hook');
  res.json({ ok: true });
});

app.post('/usage', (req, res) => {
  store.reportUsage((req.body ?? {}) as IncomingUsage);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/state', (_req, res) => {
  res.json(snapshotMsg());
});

app.get('/api/sessions', async (_req, res) => {
  res.json({ sessions: await tmux.listSessions() });
});

/** Launch a new agent in a repo. */
app.post('/api/agents', async (req, res) => {
  const repo = repos().find((r) => r.name === req.body?.repo);
  if (!repo?.path) {
    res.status(400).json({ error: `Unknown repo "${req.body?.repo}".` });
    return;
  }
  if (!runner) {
    res.status(503).json({ error: 'Neither node-pty nor tmux is available (see README).' });
    return;
  }
  const full = capError(repo.name);
  if (full) {
    res.status(409).json({ error: full });
    return;
  }
  // Include terminals still shutting down (e.g. right after Stop), or the name would collide with them.
  const taken = new Set([...(tmuxAvailable ? await tmux.listSessions() : []), ...store.agents.keys(), ...ptys.ids()]);
  const base = sessionSafe(repo.name);
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  const name = `${base}-${n}`;
  const env = { AGENT_OFFICE_SESSION: name, AGENT_OFFICE_REPO: repo.name };
  try {
    if (runner === 'pty') {
      // A known session id lets transcript events find this agent right away.
      const sessionId = crypto.randomUUID();
      ptys.spawn(name, repo.path, config.claudeCommand, ['--session-id', sessionId], env, {
        id: name,
        repo: repo.name,
        name,
        sessionId,
        cwd: repo.path,
      });
      res.json({ agent: store.ensurePtyAgent(name, repo.name, { tmuxSession: name, sessionId, cwd: repo.path, currentTask: 'Launching claude…' }) });
    } else {
      await tmux.newSession(name, repo.path, config.claudeCommand, env);
      res.json({ agent: store.ensureTmuxAgent(name, repo.name, 'starting') });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Reopen an existing (read-only) session in a server-owned terminal with `claude --resume`. */
app.post('/api/agents/:id/takeover', (req, res) => {
  const agent = store.agents.get(req.params.id);
  if (!agent?.sessionId || !agent.cwd) {
    res.status(400).json({ error: 'This agent has no known session id / directory to resume.' });
    return;
  }
  if (live(agent)) {
    res.status(400).json({ error: 'Agent is already controllable.' });
    return;
  }
  if (!ptys.available) {
    res.status(503).json({ error: 'node-pty is not available.' });
    return;
  }
  const full = capError(agent.repo);
  if (full) {
    res.status(409).json({ error: full });
    return;
  }
  // Two claude processes on one session would both write to it: refuse while it is open anywhere else.
  const open = liveSessions.get(agent.sessionId);
  if (open) {
    res.status(409).json({
      error: `This session is still open in another window (claude process ${open.pid}). Close it there first, then take over.`,
    });
    return;
  }
  try {
    ptys.spawn(agent.id, agent.cwd, config.claudeCommand, ['--resume', agent.sessionId], { AGENT_OFFICE_REPO: agent.repo }, {
      id: agent.id,
      repo: agent.repo,
      sessionId: agent.sessionId,
      cwd: agent.cwd,
    });
    res.json({ agent: store.ensurePtyAgent(agent.id, agent.repo, { status: 'idle', currentTask: 'Resumed in Agent Office' }) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/agents/:id/prompt', async (req, res) => {
  const agent = store.agents.get(req.params.id);
  const text = String(req.body?.text ?? '').trim();
  if (!agent || !live(agent)) {
    res.status(400).json({ error: 'Agent is read-only. Open its log and click "Take over" first.' });
    return;
  }
  if (!text) {
    res.status(400).json({ error: 'Empty prompt.' });
    return;
  }
  try {
    if (agent.runner === 'pty') await ptys.sendPrompt(agent.id, text);
    else await tmux.sendPrompt(agent.tmuxSession!, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/agents/:id/screen', async (req, res) => {
  const agent = store.agents.get(req.params.id);
  if (!agent?.tmuxSession || agent.runner !== 'tmux' || !agent.controllable) {
    res.status(404).json({ error: 'No live tmux session.' });
    return;
  }
  try {
    res.json({ screen: await tmux.capture(agent.tmuxSession) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/agents/:id/kill', async (req, res) => {
  const agent = store.agents.get(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Unknown agent.' });
    return;
  }
  if (agent.runner === 'pty') ptys.kill(agent.id);
  else if (agent.runner === 'tmux' && agent.controllable && agent.tmuxSession) {
    await tmux.kill(agent.tmuxSession).catch((err) => console.warn(`[tmux] kill ${agent.tmuxSession}: ${err.message}`));
  }
  // Claude needs a moment to exit: ignore its session until it's closed, or it would come back as a read-only ghost.
  store.remove(agent.id, { suppressSession: true });
  res.json({ ok: true });
});

// Serve the built client in production (`npm run build && npm start`).
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/events|\/usage|\/ws|\/pty).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = http.createServer(app);

// Two WebSocket endpoints on one server: /ws (office state) and /pty?id=… (one live terminal).
const wss = new WebSocketServer({ noServer: true });
const ptyWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
    console.warn(`[security] refused WebSocket ${req.url} (origin=${req.headers.origin ?? '-'}, host=${req.headers.host ?? '-'})`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (url.pathname === '/pty') ptyWss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, url.searchParams.get('id') ?? ''));
  else socket.destroy();
});

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}
// Rooms appear as soon as a new repo shows up.
let repoKey = '';
store.on('message', (msg: ServerMessage) => {
  broadcast(msg);
  if (msg.type !== 'agent') return;
  const key = JSON.stringify(repos());
  if (key !== repoKey) {
    repoKey = key;
    broadcast({ type: 'repos', repos: repos() });
  }
});

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify(snapshotMsg()));
});

/** Stream one terminal to a browser: replay scrollback, then live output; accept keystrokes and resizes. */
function attachTerminal(ws: WebSocket, id: string) {
  if (!ptys.has(id)) {
    ws.send('\r\n\x1b[90m[no live terminal for this agent]\x1b[0m\r\n');
    ws.close();
    return;
  }
  ws.send(ptys.buffer(id));
  const onData = (pid: string, chunk: string) => pid === id && ws.readyState === WebSocket.OPEN && ws.send(chunk);
  const onExit = (pid: string, code: number) => {
    if (pid !== id) return;
    ws.send(`\r\n\x1b[90m[claude exited with code ${code}]\x1b[0m\r\n`);
    ws.close();
  };
  ptys.on('data', onData);
  ptys.on('exit', onExit);
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'input' && typeof m.data === 'string') ptys.write(id, m.data);
      else if (m.type === 'resize') ptys.resize(id, Number(m.cols), Number(m.rows));
    } catch {
      /* ignore malformed */
    }
  });
  ws.on('close', () => {
    ptys.off('data', onData);
    ptys.off('exit', onExit);
  });
}

ptys.on('exit', (id: string, code: number) => store.markRunnerGone(id, `claude exited (code ${code})`));

// A fresh claude has no transcript until its first prompt: once its UI has drawn, show it as ready.
const readyTimers = new Set<string>();
ptys.on('data', (id: string) => {
  if (readyTimers.has(id) || store.agents.get(id)?.status !== 'starting') return;
  readyTimers.add(id);
  setTimeout(() => {
    readyTimers.delete(id);
    if (store.agents.get(id)?.status === 'starting') store.patch(id, { status: 'idle', currentTask: 'Ready, waiting for a prompt' });
  }, 2500);
});

/** Reconcile in-memory agents with live tmux sessions. */
async function pollTmux() {
  if (tmuxAvailable) {
    const sessions = new Set(await tmux.listSessions());
    for (const name of sessions) {
      const repo = repoForSession(name);
      if (repo && store.agents.get(name)?.runner !== 'pty') store.ensureTmuxAgent(name, repo);
    }
    for (const a of store.agents.values()) {
      if (a.runner === 'tmux' && a.controllable && a.tmuxSession && !sessions.has(a.tmuxSession)) {
        store.markRunnerGone(a.id, 'tmux session ended');
      }
    }
  }
  store.sweep();
}
// Agents started by a previous server are still running in their agent hosts: reconnect before importing
// transcripts, so their history attaches to them instead of creating duplicate read-only agents.
for (const meta of await ptys.restore()) {
  store.ensurePtyAgent(meta.id, meta.repo, {
    tmuxSession: meta.name,
    sessionId: meta.sessionId,
    previousSessionIds: meta.previousSessionIds,
    cwd: meta.cwd,
    status: 'idle',
    currentTask: 'Reconnected after restart',
  });
}
console.log(`[pty] reconnected to ${[...store.agents.values()].filter((a) => a.runner === 'pty').length} running agent(s)`);

if (config.importDays > 0) new TranscriptWatcher(config.claudeProjectsDir, store, config.importDays).start();
liveSessions.start();

setInterval(() => pollTmux().catch((e) => console.warn('[tmux] poll failed', e)), 3000);
await pollTmux();

// Agents live in their own host processes: on shutdown just disconnect, they keep running for the next start.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    ptys.detachAll();
    process.exit(0);
  });
}

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Agent Office server on http://127.0.0.1:${config.port}`);
});
