import { EventEmitter } from 'node:events';
import type { Agent, AgentEvent, IncomingEvent, IncomingUsage, ServerMessage, UsageLimits } from '../shared/types.ts';
import type { LiveSession } from './live-sessions.ts';
import { repoFromCwd } from '../shared/repo.ts';

const MAX_EVENTS = 300;
const OFFLINE_TTL_MS = 2 * 60 * 1000;

const trunc = (s: string | undefined, n = 120) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

export type EventSource = 'hook' | 'transcript';

/** In-memory agent registry. Emits 'message' with a ServerMessage on every change. */
export class AgentStore extends EventEmitter {
  agents = new Map<string, Agent>();
  events = new Map<string, AgentEvent[]>();
  private nextEventId = 1;
  private offlineSince = new Map<string, number>();
  /** Event types each session reports through hooks; the same types from its transcript would be duplicates. */
  private hookSessions = new Map<string, Set<string>>();
  /** Last live status seen per session, so we only react when Claude Code's status actually changes. */
  private lastLive = new Map<string, string>();
  /**
   * Sessions whose agent you stopped/removed. Ignored until Claude Code no longer lists them as open; otherwise the
   * live registry (or a last transcript line) would re-create a read-only "ghost" during the second claude needs to exit.
   */
  private suppressed = new Set<string>();
  /** Latest account-wide subscription limits. */
  usage: UsageLimits = {};
  /** Status-line info for sessions we have no agent for yet. */
  private sessionInfo = new Map<string, Pick<Agent, 'contextPercent' | 'model'>>();

  private broadcast(msg: ServerMessage) {
    this.emit('message', msg);
  }

  private upsert(agent: Agent) {
    this.agents.set(agent.id, agent);
    if (agent.status === 'offline') {
      if (!this.offlineSince.has(agent.id)) this.offlineSince.set(agent.id, Date.now());
    } else {
      this.offlineSince.delete(agent.id);
    }
    this.broadcast({ type: 'agent', agent });
  }

  /** Register a tmux session we launched (or discovered) before any hook has fired. */
  ensureTmuxAgent(tmuxSession: string, repo: string, status: Agent['status'] = 'idle'): Agent {
    const existing = this.agents.get(tmuxSession);
    if (existing) {
      if (!existing.controllable || existing.status === 'offline') {
        this.upsert({ ...existing, controllable: true, status: existing.status === 'offline' ? status : existing.status });
      }
      return this.agents.get(tmuxSession)!;
    }
    const agent: Agent = {
      id: tmuxSession,
      repo,
      tmuxSession,
      runner: 'tmux',
      status,
      currentTask: status === 'starting' ? 'Launching claude…' : undefined,
      startedAt: new Date().toISOString(),
      controllable: true,
    };
    this.upsert(agent);
    return agent;
  }

  /** Register an agent running in a server-owned terminal (new launch, or a taken-over session). */
  ensurePtyAgent(id: string, repo: string, fields: Partial<Agent>): Agent {
    const existing = this.agents.get(id);
    const agent: Agent = existing
      ? { ...existing, ...fields, runner: 'pty', controllable: true }
      : { id, repo, status: 'starting', startedAt: new Date().toISOString(), ...fields, runner: 'pty', controllable: true };
    this.upsert(agent);
    return agent;
  }

  /** The tmux session or terminal behind an agent went away. */
  markRunnerGone(id: string, reason: string) {
    const a = this.agents.get(id);
    if (a && a.controllable) this.upsert({ ...a, controllable: false, status: 'offline', currentTask: reason });
  }

  /** Update fields of an existing agent (no-op if unknown). */
  patch(id: string, fields: Partial<Agent>) {
    const a = this.agents.get(id);
    if (a) this.upsert({ ...a, ...fields });
  }

  /** Status line report: account limits + per-session context fill. */
  reportUsage(u: IncomingUsage) {
    if (u.fiveHour || u.sevenDay) {
      this.usage = {
        fiveHour: u.fiveHour ?? this.usage.fiveHour,
        sevenDay: u.sevenDay ?? this.usage.sevenDay,
        updatedAt: new Date().toISOString(),
      };
      this.broadcast({ type: 'usage', usage: this.usage });
    }
    if (!u.sessionId) return;
    const info = { contextPercent: u.contextPercent, model: u.model };
    const agent = this.findBySession(u.sessionId);
    if (!agent) this.sessionInfo.set(u.sessionId, info);
    else if (agent.contextPercent !== info.contextPercent || agent.model !== info.model) this.patch(agent.id, info);
  }

  findBySession(sessionId: string): Agent | undefined {
    for (const a of this.agents.values()) if (a.sessionId === sessionId) return a;
    // Earlier ids of an agent whose claude switched session (/clear, "start new"): its old history belongs to it too.
    for (const a of this.agents.values()) if (a.previousSessionIds?.includes(sessionId)) return a;
    return undefined;
  }

  /**
   * The claude process in an agent's terminal is now running a different session (it ran /clear, or chose "start a new
   * conversation" when resumed). Make that the agent's session; if the new session already showed up as a separate,
   * read-only agent, merge it in (events + latest state) and drop the duplicate.
   */
  relinkSession(agentId: string, sessionId: string) {
    const a = this.agents.get(agentId);
    if (!a || a.sessionId === sessionId) return;
    const dup = [...this.agents.values()].find((x) => x.id !== agentId && x.sessionId === sessionId);
    let events = this.events.get(agentId) ?? [];
    if (dup) {
      events = [...events, ...(this.events.get(dup.id) ?? []).map((ev) => ({ ...ev, agentId }))]
        .sort((x, y) => x.timestamp.localeCompare(y.timestamp))
        .slice(-MAX_EVENTS);
      this.remove(dup.id);
    }
    this.events.set(agentId, events);
    this.lastLive.delete(sessionId); // re-apply its live status to the merged agent on the next poll
    const previous = [...new Set([...(a.previousSessionIds ?? []), ...(a.sessionId ? [a.sessionId] : [])])];
    this.upsert({
      ...a,
      sessionId,
      previousSessionIds: previous,
      ...(dup && {
        title: dup.title ?? a.title,
        status: dup.status,
        currentTask: dup.currentTask,
        lastPrompt: dup.lastPrompt ?? a.lastPrompt,
        lastEventAt: dup.lastEventAt ?? a.lastEventAt,
        contextPercent: dup.contextPercent ?? a.contextPercent,
        model: dup.model ?? a.model,
      }),
    });
    this.broadcast({ type: 'agentEvents', agentId, events });
  }

  isHookTracked(sessionId: string) {
    return this.hookSessions.has(sessionId);
  }

  /**
   * Apply Claude Code's live session registry (~/.claude/sessions): which sessions are open, and whether each is
   * busy, idle or waiting for the user (permission dialog, question…). Works for every open session, no hooks needed.
   */
  applyLive(live: Map<string, LiveSession>) {
    // A stopped session that is no longer open may show up again later, e.g. if you resume it in a terminal.
    for (const sid of this.suppressed) if (!live.has(sid)) this.suppressed.delete(sid);
    for (const [sessionId, s] of live) {
      if (this.suppressed.has(sessionId)) continue;
      if (!this.findBySession(sessionId) && s.cwd) {
        // Open but not seen yet (no transcript lines): show it right away.
        this.ingest({ repo: repoFromCwd(s.cwd), sessionId, cwd: s.cwd, type: 'SessionStart', message: 'open' }, 'transcript');
      }
      const a = this.findBySession(sessionId);
      if (!a) continue;
      const fields: Partial<Agent> = {};
      if (a.livePid !== s.pid) fields.livePid = s.pid;
      if (a.liveStatus !== s.status) fields.liveStatus = s.status;
      if (a.waitingFor !== s.waitingFor) fields.waitingFor = s.waitingFor;

      // Status transitions only when the live status changes (edge-triggered), so transcript events still win in between.
      const key = `${s.status}|${s.waitingFor ?? ''}`;
      if (this.lastLive.get(sessionId) !== key) {
        this.lastLive.set(sessionId, key);
        if (s.status === 'waiting') {
          fields.status = 'needs_input';
          fields.currentTask = `Waiting for you: ${s.waitingFor ?? 'input needed'}`;
        } else if (s.status === 'busy' && a.status !== 'working') {
          fields.status = 'working';
          if (a.status === 'needs_input') fields.currentTask = 'Working…';
        } else if (s.status === 'idle' && (a.status === 'working' || a.status === 'needs_input' || a.status === 'starting')) {
          fields.status = a.status === 'starting' ? 'idle' : 'done';
          fields.currentTask = a.status === 'starting' ? 'Ready, waiting for a prompt' : a.lastPrompt ? `Finished: ${trunc(a.lastPrompt)}` : 'Finished';
        }
      }
      if (Object.keys(fields).length) this.patch(a.id, fields);
    }
    // Sessions that were open and no longer are.
    for (const a of this.agents.values()) {
      if (a.livePid === undefined || (a.sessionId && live.has(a.sessionId))) continue;
      if (a.sessionId) this.lastLive.delete(a.sessionId);
      const busy = a.status === 'working' || a.status === 'needs_input';
      this.patch(a.id, {
        livePid: undefined,
        liveStatus: undefined,
        waitingFor: undefined,
        ...(busy && { status: 'idle', currentTask: 'Session closed' }),
      });
    }
  }

  /** Pick the agent an event belongs to, merging a transcript-only agent into its tmux agent when they meet. */
  private resolveId(e: IncomingEvent): string {
    const bySession = e.sessionId ? this.findBySession(e.sessionId) : undefined;
    if (e.tmuxSession && bySession && bySession.id !== e.tmuxSession && this.agents.has(e.tmuxSession)) {
      const target = this.agents.get(e.tmuxSession)!;
      const merged = [...(this.events.get(bySession.id) ?? []), ...(this.events.get(target.id) ?? [])]
        .map((ev) => ({ ...ev, agentId: target.id }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      this.remove(bySession.id);
      this.events.set(target.id, merged.slice(-MAX_EVENTS));
      this.agents.set(target.id, { ...target, title: target.title ?? bySession.title, cwd: target.cwd ?? bySession.cwd });
      return target.id;
    }
    return bySession?.id ?? e.tmuxSession ?? e.sessionId ?? `${e.repo}-unknown`;
  }

  ingest(e: IncomingEvent, source: EventSource = 'hook'): AgentEvent | undefined {
    if (e.sessionId && this.suppressed.has(e.sessionId)) return undefined;
    if (e.sessionId) {
      const hooked = this.hookSessions.get(e.sessionId) ?? new Set<string>();
      if (source === 'hook') this.hookSessions.set(e.sessionId, hooked.add(e.type));
      else if (hooked.has(e.type)) return undefined;
    }
    const id = this.resolveId(e);
    const now = e.timestamp ?? new Date().toISOString();
    const prev: Agent = this.agents.get(id) ?? {
      id,
      repo: e.repo,
      tmuxSession: e.tmuxSession,
      status: 'idle',
      cwd: e.cwd,
      startedAt: now,
      controllable: false,
    };
    const next: Agent = {
      ...prev,
      // The first repo wins, so an agent doesn't change rooms when it cd's into a subfolder.
      repo: prev.repo || e.repo,
      cwd: prev.cwd ?? e.cwd,
      // History from an earlier session of this agent attaches to it but must not switch it back to that old id.
      sessionId: e.sessionId && !prev.previousSessionIds?.includes(e.sessionId) ? e.sessionId : prev.sessionId,
      tmuxSession: e.tmuxSession ?? prev.tmuxSession,
      lastEventAt: now,
    };
    const info = e.sessionId ? this.sessionInfo.get(e.sessionId) : undefined;
    if (info) {
      Object.assign(next, info);
      this.sessionInfo.delete(e.sessionId!);
    }

    switch (e.type) {
      case 'SessionStart':
        next.status = 'idle';
        next.currentTask = `Session started${e.message ? ` (${e.message})` : ''}`;
        break;
      case 'UserPromptSubmit':
        next.status = 'working';
        next.lastPrompt = e.message;
        next.currentTask = `Prompt: ${trunc(e.message)}`;
        break;
      case 'PreToolUse':
        next.status = 'working';
        next.currentTask = trunc(`${e.tool ?? 'Tool'}: ${e.command ?? ''}`, 200);
        break;
      case 'Notification':
        next.status = 'needs_input';
        next.currentTask = trunc(e.message) ?? 'Waiting for input';
        break;
      case 'Stop':
        next.status = 'done';
        next.currentTask = next.lastPrompt ? `Finished: ${trunc(next.lastPrompt)}` : 'Finished';
        break;
      case 'SessionEnd':
        next.status = 'offline';
        next.currentTask = 'Session ended';
        break;
    }
    this.upsert(next);

    const event: AgentEvent = {
      id: this.nextEventId++,
      agentId: id,
      repo: next.repo,
      type: e.type,
      tool: e.tool,
      command: e.command,
      message: e.message,
      timestamp: now,
    };
    const list = this.events.get(id) ?? [];
    list.push(event);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.events.set(id, list);
    this.broadcast({ type: 'event', event });
    return event;
  }

  /** Forget an agent. With suppressSession (Stop/Remove in the UI), its session is ignored until it is no longer open. */
  remove(id: string, opts: { suppressSession?: boolean } = {}) {
    const sessionId = this.agents.get(id)?.sessionId;
    if (opts.suppressSession && sessionId) this.suppressed.add(sessionId);
    this.agents.delete(id);
    this.events.delete(id);
    this.offlineSince.delete(id);
    this.broadcast({ type: 'agentRemoved', id });
  }

  /** Drop agents that have been offline for a while. */
  sweep() {
    const now = Date.now();
    for (const [id, since] of this.offlineSince) {
      if (now - since > OFFLINE_TTL_MS) this.remove(id);
    }
  }

  snapshot() {
    return {
      agents: [...this.agents.values()],
      events: Object.fromEntries(this.events),
    };
  }
}
