import fs from 'node:fs';
import path from 'node:path';
import type { IncomingEvent } from '../shared/types.ts';
import { describeTool } from '../shared/describeTool.ts';
import { repoFromCwd } from '../shared/repo.ts';
import type { AgentStore } from './state.ts';

/** How much of a transcript to read on first sight. Older history is skipped (files can be tens of MB). */
const TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const POLL_MS = 1500;
/** A "working" session with no transcript writes for this long is shown as idle (closed or interrupted). */
const STALE_MS = 10 * 60 * 1000;

interface Tracked {
  file: string;
  sessionId: string;
  offset: number;
  remainder: Buffer;
  repo?: string;
  cwd?: string;
  mtimeMs: number;
  lastType?: string;
  /** Read from the first line (not a mid-file tail), so the start of the session is in view. */
  fromStart?: boolean;
  /** The session has been registered with the store. */
  announced?: boolean;
}

const trunc = (s: string | undefined, n = 400) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

function readRange(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial or corrupt line */
    }
  }
  return out;
}

/** The text of a human-typed prompt, or undefined for tool results, meta and system-injected messages. */
function promptText(o: any): string | undefined {
  if (o.isCompactSummary || o.isVisibleInTranscriptOnly) return undefined;
  const c = o.message?.content;
  let text: string | undefined;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return undefined;
    text = c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  }
  if (!text?.trim() || text.startsWith('[Request interrupted')) return undefined;
  const kind = o.origin?.kind;
  if (kind) return kind === 'human' ? text : undefined;
  if (o.isMeta || text.startsWith('<')) return undefined;
  return text;
}

/**
 * Imports Claude Code sessions from ~/.claude/projects/<project>/<session>.jsonl and follows them live.
 * Works without hooks; when hooks are installed for a session, the store ignores the duplicate transcript events.
 */
export class TranscriptWatcher {
  private tracked = new Map<string, Tracked>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private root: string,
    private store: AgentStore,
    private importDays: number,
  ) {}

  start() {
    if (!fs.existsSync(this.root)) {
      console.warn(`[transcripts] ${this.root} not found; session import disabled`);
      return;
    }
    const cutoff = Date.now() - this.importDays * 86400_000;
    let imported = 0;
    for (const { file, mtimeMs, size } of this.listFiles()) {
      if (mtimeMs >= cutoff) {
        this.track(file, mtimeMs, size);
        imported++;
      } else {
        // Remember old sessions without importing; they show up if they get resumed.
        this.tracked.set(file, { file, sessionId: path.basename(file, '.jsonl'), offset: size, remainder: Buffer.alloc(0), mtimeMs });
      }
    }
    // Once for the whole import, not once per file.
    this.markStale();
    console.log(`[transcripts] imported ${imported} session(s) from the last ${this.importDays} day(s) in ${this.root}`);
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (e) {
        console.warn('[transcripts] poll failed', e);
      }
    }, POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Top-level session transcripts only (subagent transcripts live in subfolders). */
  private listFiles() {
    const out: { file: string; mtimeMs: number; size: number }[] = [];
    for (const dir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const full = path.join(this.root, dir.name);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const file = path.join(full, f.name);
        try {
          const st = fs.statSync(file);
          if (st.size > 0) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* deleted meanwhile */
        }
      }
    }
    return out;
  }

  private poll() {
    for (const { file, mtimeMs, size } of this.listFiles()) {
      const t = this.tracked.get(file);
      if (!t) this.track(file, mtimeMs, size);
      else if (size > t.offset) this.readNew(t, size, mtimeMs);
      else if (size < t.offset) {
        // The file was truncated or rewritten: follow it from its current end. Re-reading it from the start would
        // re-ingest every past event (duplicates) and could mean one huge synchronous read.
        t.offset = size;
        t.remainder = Buffer.alloc(0);
        t.mtimeMs = mtimeMs;
      }
    }
    this.markStale();
  }

  private track(file: string, mtimeMs: number, size: number) {
    const t: Tracked = {
      file,
      sessionId: path.basename(file, '.jsonl'),
      offset: 0,
      remainder: Buffer.alloc(0),
      mtimeMs,
      fromStart: size <= TAIL_BYTES,
    };
    this.tracked.set(file, t);
    this.findCwd(t);
    if (size > TAIL_BYTES) {
      // Start mid-file and drop the partial first line.
      const chunk = readRange(file, size - TAIL_BYTES, size);
      const nl = chunk.indexOf(0x0a);
      t.offset = size - TAIL_BYTES + nl + 1;
    }
    this.readNew(t, size, mtimeMs);
  }

  /** The session's first cwd decides its room; read it from the start of the file. */
  private findCwd(t: Tracked) {
    const head = readRange(t.file, 0, Math.min(HEAD_BYTES, fs.statSync(t.file).size)).toString('utf8');
    for (const o of parseLines(head)) {
      if (typeof o.cwd === 'string') {
        t.cwd = o.cwd;
        t.repo = repoFromCwd(o.cwd);
        return;
      }
    }
  }

  private readNew(t: Tracked, size: number, mtimeMs: number) {
    const buf = Buffer.concat([t.remainder, readRange(t.file, t.offset, size)]);
    t.offset = size;
    t.mtimeMs = mtimeMs;
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      t.remainder = buf;
      return;
    }
    t.remainder = Buffer.from(buf.subarray(lastNl + 1));
    for (const o of parseLines(buf.subarray(0, lastNl).toString('utf8'))) this.handle(t, o);
  }

  private handle(t: Tracked, o: any) {
    if (o.isSidechain) return;
    if (!t.repo && typeof o.cwd === 'string') {
      t.cwd = o.cwd;
      t.repo = repoFromCwd(o.cwd);
    }
    if (!t.repo) return;

    // Show a session as soon as it exists, even before its first prompt (e.g. opened, or only ran /resume).
    if (!t.announced && t.fromStart) {
      t.announced = true;
      this.store.ingest(
        {
          repo: t.repo,
          sessionId: t.sessionId,
          cwd: t.cwd,
          type: 'SessionStart',
          timestamp: o.timestamp ?? new Date(t.mtimeMs).toISOString(),
        },
        'transcript',
      );
    }

    if (o.type === 'ai-title' && o.aiTitle) {
      const agent = this.store.findBySession(t.sessionId);
      if (agent) this.store.patch(agent.id, { title: o.aiTitle });
      else this.pendingTitles.set(t.sessionId, o.aiTitle);
      return;
    }

    const base = { repo: t.repo, sessionId: t.sessionId, cwd: t.cwd, timestamp: o.timestamp };
    const events: IncomingEvent[] = [];
    if (o.type === 'user') {
      const text = promptText(o);
      if (text) events.push({ ...base, type: 'UserPromptSubmit', message: trunc(text, 2000) });
    } else if (o.type === 'assistant') {
      const content = Array.isArray(o.message?.content) ? o.message.content : [];
      for (const b of content) {
        // Claude's own words: explanations, questions, and the final summary of a turn.
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          events.push({ ...base, type: 'AssistantMessage', message: trunc(b.text.trim(), 4000) });
        } else if (b?.type === 'tool_use') {
          events.push({ ...base, type: 'PreToolUse', tool: b.name, command: trunc(describeTool(b.name, b.input ?? {})) });
        }
      }
      if (o.message?.stop_reason === 'end_turn') events.push({ ...base, type: 'Stop' });
    }

    for (const e of events) {
      if (e.type === 'Stop' && t.lastType === 'Stop') continue;
      t.lastType = e.type;
      this.store.ingest(e, 'transcript');
    }
    const title = this.pendingTitles.get(t.sessionId);
    if (title && events.length) {
      const agent = this.store.findBySession(t.sessionId);
      if (agent) {
        this.store.patch(agent.id, { title });
        this.pendingTitles.delete(t.sessionId);
      }
    }
  }

  private pendingTitles = new Map<string, string>();

  /** Sessions left "working" without new writes were most likely closed or interrupted. */
  private markStale() {
    const now = Date.now();
    for (const t of this.tracked.values()) {
      if (now - t.mtimeMs < STALE_MS || this.store.isHookTracked(t.sessionId)) continue;
      const a = this.store.findBySession(t.sessionId);
      // Sessions known to be open (live registry) are never "stale", however long a command runs.
      if (a && !a.controllable && a.status === 'working' && a.livePid === undefined) {
        this.store.patch(a.id, { status: 'idle', currentTask: `Inactive · last: ${a.currentTask ?? ''}`.slice(0, 200) });
      }
    }
  }
}
