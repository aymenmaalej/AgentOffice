import { useEffect, useRef, useState } from 'react';
import type { Agent, AgentEvent } from '../../shared/types.ts';
import { api } from '../api.ts';
import { displayName, STATUS_LABEL } from '../util.ts';
import { ContextChip } from './UsagePanel.tsx';
import { LiveTerminal } from './LiveTerminal.tsx';
import { usePanelWidth } from '../usePanelWidth.ts';
import { useDialog } from '../dialog.tsx';

interface Props {
  agent: Agent;
  events: AgentEvent[];
  canTakeOver: boolean;
  onClose: () => void;
}

const ICON: Record<string, string> = {
  SessionStart: '🟢',
  UserPromptSubmit: '💬',
  PreToolUse: '🔧',
  Notification: '🔔',
  Stop: '✅',
  SessionEnd: '⏹',
  AssistantMessage: '🤖',
};

/** Friendlier names for event types in the log. */
const LABEL: Record<string, string> = {
  AssistantMessage: 'Claude',
  UserPromptSubmit: 'You',
  SessionStart: 'Session started',
  Stop: 'Turn finished',
};

/** Polled snapshot of a tmux pane (tmux agents only; pty agents get a live terminal). */
function TmuxScreen({ agentId }: { agentId: string }) {
  const [screen, setScreen] = useState<string>();
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .screen(agentId)
        .then((r) => alive && setScreen(r.screen))
        .catch((e) => alive && setScreen(`(${e.message})`));
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agentId]);
  return <pre className="terminal">{screen ?? 'Loading…'}</pre>;
}

export function LogPanel({ agent, events, canTakeOver, onClose }: Props) {
  const [tab, setTab] = useState<'events' | 'terminal'>(agent.runner === 'pty' && agent.controllable ? 'terminal' : 'events');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { width, dragging, handle } = usePanelWidth(tab);
  const dialog = useDialog();

  // Keep the newest event in view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [events.length, tab]);

  // Fall back to the event log when the terminal goes away.
  useEffect(() => {
    if (!agent.controllable) setTab('events');
  }, [agent.controllable]);

  /** Open in another window right now (Claude Code's live registry): taking over would put two processes on it. */
  const openElsewhere = !agent.controllable && agent.livePid !== undefined;
  const resumable = !agent.controllable && !!agent.sessionId && !!agent.cwd && canTakeOver && !openElsewhere;

  const takeOver = async () => {
    const recent = agent.lastEventAt && Date.now() - new Date(agent.lastEventAt).getTime() < 5 * 60_000;
    const ok = await dialog.confirm({
      eyebrow: 'Take over',
      title: `Continue “${displayName(agent)}” here?`,
      message: (
        <>
          The conversation reopens in a live terminal inside Agent Office, with its full history
          {agent.title && (
            <>
              {' '}
              (<em>{agent.title}</em>)
            </>
          )}
          . You can then type, approve permissions and send prompts from here. It keeps running even if you close Agent
          Office.
        </>
      ),
      warning: recent
        ? 'This session was active in the last few minutes. If it is still open in another terminal, close it there first: two Claude processes must not write to the same conversation.'
        : undefined,
      confirmLabel: 'Take over',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.takeover(agent.id);
      setTab('terminal');
    } catch (e) {
      await dialog.alert({ eyebrow: 'Take over', title: "Couldn't take over this session", message: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const kill = async () => {
    const ok = await dialog.confirm(
      agent.controllable
        ? {
            eyebrow: 'Stop agent',
            title: `Stop ${displayName(agent)}?`,
            message: 'This ends the Claude process and its terminal. The conversation history is kept, so you can resume it later.',
            warning: agent.status === 'working' ? 'It is working right now: the current task will be interrupted.' : undefined,
            confirmLabel: 'Stop agent',
            tone: 'danger',
          }
        : {
            eyebrow: 'Remove',
            title: `Remove ${displayName(agent)} from the office?`,
            message: 'This only removes it from this view. The session itself is not touched and comes back if it becomes active again.',
            confirmLabel: 'Remove',
          },
    );
    if (!ok) return;
    await api.kill(agent.id).catch((e) => dialog.alert({ title: "Couldn't stop the agent", message: e.message, tone: 'danger' }));
  };

  return (
    <aside className={`log-panel ${dragging ? 'dragging' : ''}`} style={{ width }}>
      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize · double-click to reset"
        {...handle}
      />
      <header>
        <div>
          <h2>{displayName(agent)}</h2>
          {agent.title && <div className="session-title">{agent.title}</div>}
          <div className="sub">
            <span className={`pill status-${agent.status}`}>{STATUS_LABEL[agent.status]}</span> {agent.repo}
            {agent.sessionId && <span className="mono"> · {agent.sessionId.slice(0, 8)}</span>}
            {agent.model && <span> · {agent.model}</span>} <ContextChip pct={agent.contextPercent} />
          </div>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="tabs">
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
          Events ({events.length})
        </button>
        {agent.controllable ? (
          <button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}>
            Terminal
          </button>
        ) : (
          <button
            className="takeover"
            onClick={takeOver}
            disabled={!resumable || busy}
            title={
              openElsewhere
                ? 'This session is open in another window. Close it there first, then take over.'
                : resumable
                  ? 'Reopen this session in a terminal owned by Agent Office'
                  : 'Not available (no resumable session, or this project already runs its maximum number of agents)'
            }
          >
            ▶ Take over
          </button>
        )}
        <span className="spacer" />
        <button className="danger" onClick={kill}>
          {agent.controllable ? 'Stop' : 'Remove'}
        </button>
      </div>

      {tab === 'events' ? (
        <div className="events" ref={listRef}>
          {events.length === 0 && <div className="hint">No events yet.</div>}
          {!agent.controllable && (
            <div className="readonly-note">
              {openElsewhere ? (
                <>
                  Open in another window right now (claude process {agent.livePid}). Its status here stays live; to
                  control it from Agent Office, close it there first, then click <strong>Take over</strong>.
                </>
              ) : (
                <>
                  Read-only: this session runs outside Agent Office. Click <strong>Take over</strong> to continue it here.
                </>
              )}
            </div>
          )}
          {events.map((e) => (
            <div key={e.id} className={`event ev-${e.type}`}>
              <span className="ev-icon">{ICON[e.type] ?? '•'}</span>
              <div className="ev-body">
                <div className="ev-head">
                  <strong>{e.tool ?? LABEL[e.type] ?? e.type}</strong>
                  <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
                </div>
                {(e.command || e.message) && <pre>{e.command ?? e.message}</pre>}
              </div>
            </div>
          ))}
        </div>
      ) : agent.runner === 'pty' ? (
        <LiveTerminal agentId={agent.id} />
      ) : (
        <TmuxScreen agentId={agent.id} />
      )}
    </aside>
  );
}
