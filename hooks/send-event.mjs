#!/usr/bin/env node
// Claude Code hook -> Agent Office bridge.
// Reads the hook payload from stdin, condenses it, and POSTs it to the Agent Office server.
// It must never block or break Claude: short timeout, no stdout, always exit 0.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const URL = process.env.AGENT_OFFICE_URL ?? 'http://127.0.0.1:4317/events';

const trunc = (s, n = 400) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000);
  });
}

function tmuxSessionName() {
  if (process.env.AGENT_OFFICE_SESSION) return process.env.AGENT_OFFICE_SESSION;
  if (!process.env.TMUX) return undefined;
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], { timeout: 500 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** One-line summary of what a tool is about to do. Keep in sync with src/shared/describeTool.ts. */
function describeTool(name, input = {}) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return input.file_path ?? input.notebook_path;
    case 'Grep':
    case 'Glob':
      return input.pattern + (input.path ? ` in ${input.path}` : '');
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Task':
    case 'Agent':
      return input.description ?? input.prompt;
    case 'Skill':
      return input.skill;
    case 'TodoWrite':
      return `${input.todos?.length ?? 0} todos`;
    default:
      return JSON.stringify(input);
  }
}

async function main() {
  let hook = {};
  try {
    hook = JSON.parse((await readStdin()) || '{}');
  } catch {
    /* ignore malformed input */
  }
  const type = hook.hook_event_name ?? process.argv[2] ?? 'Unknown';
  const cwd = hook.cwd ?? process.cwd();

  const event = {
    repo: process.env.AGENT_OFFICE_REPO ?? path.basename(cwd),
    sessionId: hook.session_id,
    tmuxSession: tmuxSessionName(),
    type,
    cwd,
    timestamp: new Date().toISOString(),
  };
  if (type === 'PreToolUse') {
    event.tool = hook.tool_name;
    event.command = trunc(describeTool(hook.tool_name, hook.tool_input));
  } else if (type === 'UserPromptSubmit') {
    event.message = trunc(hook.prompt, 2000);
  } else if (type === 'Notification') {
    event.message = trunc(hook.message);
  } else if (type === 'SessionStart') {
    event.message = hook.source;
  } else if (type === 'SessionEnd') {
    event.message = hook.reason;
  }

  await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(1500),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
