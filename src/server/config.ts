import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RepoInfo } from '../shared/types.ts';

export interface Config {
  port: number;
  /** How to invoke tmux, e.g. ["tmux"] or ["wsl", "tmux"]. */
  tmuxCommand: string[];
  /** How new agents run: "pty" = terminal owned by the server, "tmux" = tmux session, "auto" = tmux if available (not on Windows), else pty. */
  runner: 'auto' | 'pty' | 'tmux';
  /** Max agents the app runs at once per repo (launch / take over are refused beyond it). */
  maxAgentsPerRepo: number;
  /** Command that starts Claude Code for new agents. */
  claudeCommand: string;
  repos: Required<RepoInfo>[];
  /** Where Claude Code keeps session transcripts. */
  claudeProjectsDir: string;
  /** Import sessions active within this many days at startup (0 disables the import). */
  importDays: number;
}

export const CONFIG_PATH = path.resolve(process.env.AGENT_OFFICE_CONFIG ?? 'agent-office.config.json');

export function loadConfig(): Config {
  let raw: Partial<Config> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    console.warn(`[config] ${CONFIG_PATH} not found; using defaults (repos are discovered from ~/.claude/projects).`);
  }
  return {
    port: Number(process.env.AGENT_OFFICE_PORT ?? raw.port ?? 4317),
    tmuxCommand: raw.tmuxCommand?.length ? raw.tmuxCommand : ['tmux'],
    claudeCommand: raw.claudeCommand ?? 'claude',
    runner: raw.runner ?? 'auto',
    maxAgentsPerRepo: Math.max(1, Number(raw.maxAgentsPerRepo ?? 2)),
    repos: (raw.repos ?? []).map((r) => ({ name: r.name, path: r.path ?? '' })),
    claudeProjectsDir: raw.claudeProjectsDir ?? path.join(os.homedir(), '.claude', 'projects'),
    importDays: Number(raw.importDays ?? 3),
  };
}
