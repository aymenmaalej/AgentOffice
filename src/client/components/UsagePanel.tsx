import { useEffect, useState } from 'react';
import type { LimitWindow, UsageLimits } from '../../shared/types.ts';
import { countdown, level, timeAgo, type Level } from '../util.ts';

const VERDICT: Record<Level, string> = {
  ok: 'Plenty left — keep going',
  warn: 'Over half used — keep conversations focused',
  high: 'Getting close — wrap up and avoid starting big tasks',
  stop: 'At the limit — stop until it resets',
};

/** A window whose reset time has passed starts over at 0%. */
function current(w?: LimitWindow): LimitWindow | undefined {
  if (!w) return undefined;
  return w.resetsAt * 1000 <= Date.now() ? { usedPercentage: 0, resetsAt: w.resetsAt } : w;
}

function resetLabel(w: LimitWindow, weekly: boolean): string {
  if (w.resetsAt * 1000 <= Date.now()) return 'reset — new window';
  const at = new Date(w.resetsAt * 1000);
  const when = weekly
    ? at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `resets in ${countdown(w.resetsAt)} · ${when}`;
}

function Meter({ label, w, weekly }: { label: string; w?: LimitWindow; weekly?: boolean }) {
  if (!w) {
    return (
      <div className="meter">
        <div className="meter-head">
          <span>{label}</span>
          <span className="hint">not reported</span>
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, w.usedPercentage));
  return (
    <div className={`meter lvl-${level(pct)}`}>
      <div className="meter-head">
        <span>{label}</span>
        <strong>{Math.round(pct)}%</strong>
      </div>
      <div className="meter-track" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        {/* The track carries the full white→black gradient; this covers the unused part. */}
        <div className="meter-rest" style={{ width: `${100 - pct}%` }} />
      </div>
      <div className="meter-foot">{resetLabel(w, !!weekly)}</div>
    </div>
  );
}

export function UsagePanel({ usage }: { usage: UsageLimits }) {
  // Re-render every 30s so countdowns stay fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!usage.updatedAt) {
    return (
      <div className="usage">
        <h3>Usage limits</h3>
        <div className="hint">
          No data yet. Run <code>npm run install-statusline</code>; limits appear after the next Claude reply.
        </div>
      </div>
    );
  }

  const five = current(usage.fiveHour);
  const week = current(usage.sevenDay);
  const worst = Math.max(five?.usedPercentage ?? 0, week?.usedPercentage ?? 0);
  const lvl = level(worst);
  const which = (week?.usedPercentage ?? 0) > (five?.usedPercentage ?? 0) ? 'weekly' : 'session';

  return (
    <div className="usage">
      <h3>
        Usage limits <span className="hint">updated {timeAgo(usage.updatedAt)}</span>
      </h3>
      <Meter label="Session (5h)" w={five} />
      <Meter label="Weekly" w={week} weekly />
      <div className={`verdict lvl-${lvl}`}>
        {VERDICT[lvl]}
        {lvl !== 'ok' && <span className="hint"> ({which} limit)</span>}
      </div>
    </div>
  );
}

/** Small per-agent context-window chip. */
export function ContextChip({ pct }: { pct?: number }) {
  if (typeof pct !== 'number') return null;
  const lvl = level(pct);
  const tip =
    lvl === 'ok' || lvl === 'warn'
      ? `${Math.round(pct)}% of the context window used`
      : `${Math.round(pct)}% context used — /compact or start a fresh session soon`;
  return (
    <span className={`ctx lvl-${lvl}`} title={tip}>
      ctx {Math.round(pct)}%
    </span>
  );
}
