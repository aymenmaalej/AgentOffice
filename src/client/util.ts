import type { Agent, AgentStatus } from '../shared/types.ts';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  needs_input: 'needs input',
  done: 'done',
  offline: 'offline',
};

/** Agents that are busy (or blocked on you) stay at their desk; everyone else goes to the waiting room. */
export const atDesk = (a: Agent) => a.status === 'working' || a.status === 'needs_input' || a.status === 'starting';

/** Stable per-agent shirt colour. */
export function agentHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Mix the bits so ids differing only in the last char ("api-1" / "api-2") get distinct colours.
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % 360;
}

/** Display-only names, computed in the browser (the server keeps its own ids). */
export interface AgentLabel {
  /** "API #1" */
  label: string;
  /** "API 1": fits on an avatar's name tag */
  short: string;
  /** The agent's number within its project (the "1" above); also the sidebar order. */
  num: number;
}
export type LabeledAgent = Agent & Partial<AgentLabel>;

/** "Price Tool" -> "PT", "Shop-Frontend" -> "SF", "API" -> "API", "inventorymanagement" -> "INVE". */
export function repoAbbrev(repo: string): string {
  const parts = repo
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  if (parts.length > 1) return parts.map((p) => p[0]).join('').toUpperCase().slice(0, 4);
  const word = parts[0] ?? repo;
  return (word.length <= 6 ? word : word.slice(0, 4)).toUpperCase();
}

/**
 * Name every agent after its project and give it a number within that project. Numbers are kept in `numbers` for the
 * page's lifetime, so an agent's number never changes: removing "API #1" leaves "API #2" as #2, and the next new
 * agent takes the lowest free number. New agents are numbered oldest first.
 */
export function labelAgents(agents: Record<string, Agent>, numbers: Map<string, number>): Record<string, LabeledAgent> {
  const byRepo = new Map<string, Agent[]>();
  for (const a of Object.values(agents)) byRepo.set(a.repo, [...(byRepo.get(a.repo) ?? []), a]);
  const out: Record<string, LabeledAgent> = {};
  for (const [repo, list] of byRepo) {
    list.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const used = new Set<number>();
    const unnumbered: Agent[] = [];
    // Keep existing numbers (unless two agents now claim the same one), then fill the gaps for the rest.
    for (const a of list) {
      const n = numbers.get(a.id);
      if (n !== undefined && !used.has(n)) used.add(n);
      else unnumbered.push(a);
    }
    for (const a of unnumbered) {
      let n = 1;
      while (used.has(n)) n++;
      used.add(n);
      numbers.set(a.id, n);
    }
    for (const a of list) {
      const n = numbers.get(a.id)!;
      out[a.id] = { ...a, num: n, label: `${repo} #${n}`, short: `${repoAbbrev(repo)} ${n}` };
    }
  }
  return out;
}

export const shortName = (a: LabeledAgent) => a.short ?? a.id.slice(0, 4);
export const displayName = (a: LabeledAgent) => a.label ?? a.tmuxSession ?? a.title ?? `${a.repo} · ${a.id.slice(0, 8)}`;

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export type Level = 'ok' | 'warn' | 'high' | 'stop';
export const level = (pct: number): Level => (pct >= 95 ? 'stop' : pct >= 80 ? 'high' : pct >= 50 ? 'warn' : 'ok');

/** "2h 13m" / "3d 4h" until an epoch-seconds instant. */
export function countdown(epochSec: number): string {
  const m = Math.max(0, Math.round((epochSec * 1000 - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** Agents the app runs in a repo (the ones the per-repo cap counts). */
export const runningIn = (agents: Record<string, Agent>, repo: string) =>
  Object.values(agents).filter((a) => a.repo === repo && a.controllable).length;

/**
 * Projects with an agent busy right now (working, needing input, starting) first; the rest after. Stable: within each
 * group the incoming order is kept, so a custom room arrangement survives.
 */
export function activeFirst<T extends { name: string }>(repos: T[], agents: Record<string, Agent>): T[] {
  const busy = new Set(Object.values(agents).filter(atDesk).map((a) => a.repo));
  return [...repos.filter((r) => busy.has(r.name)), ...repos.filter((r) => !busy.has(r.name))];
}

export const STATUS_ORDER: AgentStatus[] = ['needs_input', 'working', 'starting', 'done', 'idle', 'offline'];
export const byStatus = (a: Agent, b: Agent) =>
  STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id.localeCompare(b.id);
