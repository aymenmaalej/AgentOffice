#!/usr/bin/env node
// Claude Code status line -> Agent Office bridge.
// Claude Code pipes session info (incl. rate_limits and context_window) to this script on stdin
// whenever the status line refreshes. We print a short line for the terminal and forward the numbers
// to the Agent Office server. Never slow: the line is printed first, the POST has a short timeout.
const URL = (process.env.AGENT_OFFICE_URL ?? 'http://127.0.0.1:4317/events').replace(/\/events$/, '/usage');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000);
  });
}

const pct = (n) => (typeof n === 'number' ? `${Math.round(n)}%` : undefined);

async function main() {
  let s = {};
  try {
    s = JSON.parse((await readStdin()) || '{}');
  } catch {
    /* ignore */
  }
  const five = s.rate_limits?.five_hour;
  const week = s.rate_limits?.seven_day;
  const ctx = s.context_window?.used_percentage;

  const parts = [
    s.model?.display_name,
    five && `5h ${pct(five.used_percentage)}`,
    week && `wk ${pct(week.used_percentage)}`,
    typeof ctx === 'number' && `ctx ${pct(ctx)}`,
  ].filter(Boolean);
  process.stdout.write(parts.join(' · '));

  await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: s.session_id,
      cwd: s.cwd,
      model: s.model?.display_name,
      contextPercent: ctx ?? undefined,
      fiveHour: five ? { usedPercentage: five.used_percentage, resetsAt: five.resets_at } : undefined,
      sevenDay: week ? { usedPercentage: week.used_percentage, resetsAt: week.resets_at } : undefined,
    }),
    signal: AbortSignal.timeout(800),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
