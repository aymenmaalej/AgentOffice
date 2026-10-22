import fs from 'node:fs';
import path from 'node:path';
import type { AgentStore } from './state.ts';

const POLL_MS = 1500;

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  status: 'busy' | 'idle' | 'waiting';
  waitingFor?: string;
}

/** True if a process with this pid exists (EPERM = exists but not ours to signal). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads Claude Code's registry of running sessions (~/.claude/sessions/<pid>.json). Each open `claude` keeps its file
 * up to date with `status` (busy / idle / waiting) and `waitingFor` (e.g. a permission dialog), which tells us
 * - which sessions are open right now, and where (pid), and
 * - which ones are blocked on you,
 * for every session on the machine, without hooks. Only the .json files are read (never the .key files).
 */
export class LiveSessionWatcher {
  sessions = new Map<string, LiveSession>();
  /** Last good reading per file, reused if a file is caught mid-rewrite (avoids a one-poll "closed" flicker). */
  private byFile = new Map<string, LiveSession>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private dir: string,
    private store: AgentStore,
    /** Called after each poll with the open sessions (the server uses it to follow session switches). */
    private onPoll?: (sessions: Map<string, LiveSession>) => void,
  ) {}

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The open session with this id, if any. */
  get(sessionId: string | undefined) {
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  private poll() {
    const next = new Map<string, LiveSession>();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      /* no sessions dir yet */
    }
    const byFile = new Map<string, LiveSession>();
    for (const f of files) {
      let s: LiveSession | undefined;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (typeof o.sessionId !== 'string' || typeof o.pid !== 'number') continue;
        const status = o.status === 'busy' || o.status === 'waiting' ? o.status : 'idle';
        s = {
          pid: o.pid,
          sessionId: o.sessionId,
          cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
          status,
          waitingFor: status === 'waiting' && typeof o.waitingFor === 'string' ? o.waitingFor : undefined,
        };
      } catch {
        s = this.byFile.get(f); // caught mid-rewrite: keep the last good reading
      }
      if (!s || !alive(s.pid)) continue;
      byFile.set(f, s);
      next.set(s.sessionId, s);
    }
    this.byFile = byFile;
    this.sessions = next;
    this.store.applyLive(next);
    this.onPoll?.(next);
  }
}
