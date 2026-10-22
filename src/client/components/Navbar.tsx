import { useState } from 'react';
import type { Agent } from '../../shared/types.ts';
import type { OfficeState } from '../useOffice.ts';
import { api } from '../api.ts';
import { byStatus, displayName, runningIn, STATUS_LABEL } from '../util.ts';
import { useDialog } from '../dialog.tsx';

interface Props {
  office: OfficeState;
  selected?: Agent;
  onSelect: (id: string | undefined) => void;
  onOpenLog: (id: string) => void;
  onOpenSettings: () => void;
  /** Projects hidden by the display settings (shown as a badge on the gear). */
  hiddenCount: number;
}

export function Navbar({ office, selected, onSelect, onOpenLog, onOpenSettings, hiddenCount }: Props) {
  const dialog = useDialog();
  const [prompt, setPrompt] = useState('');
  const [launchRepo, setLaunchRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string }>();

  const agents = Object.values(office.agents).sort((a, b) => a.repo.localeCompare(b.repo) || byStatus(a, b));
  const launchable = office.repos.filter((r) => r.path);
  const canSend = !!selected?.controllable;
  const max = office.maxAgentsPerRepo;
  const chosenRepo = launchRepo || launchable[0]?.name;
  const repoFull = !!chosenRepo && runningIn(office.agents, chosenRepo) >= max;
  const usagePct = Math.max(
    office.usage.fiveHour && office.usage.fiveHour.resetsAt * 1000 > Date.now() ? office.usage.fiveHour.usedPercentage : 0,
    office.usage.sevenDay && office.usage.sevenDay.resetsAt * 1000 > Date.now() ? office.usage.sevenDay.usedPercentage : 0,
  );

  const notify = (kind: 'ok' | 'err', text: string) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash(undefined), 3500);
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !prompt.trim()) return;
    setBusy(true);
    try {
      await api.prompt(selected.id, prompt);
      setPrompt('');
      notify('ok', `Sent to ${displayName(selected)}`);
    } catch (err) {
      notify('err', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const launch = async () => {
    const repo = chosenRepo;
    if (!repo) return;
    if (
      usagePct >= 80 &&
      !(await dialog.confirm({
        eyebrow: 'Usage limit',
        title: 'Your usage is high',
        message: (
          <>
            You've used <strong>{Math.round(usagePct)}%</strong> of your Claude usage limit. A new agent in{' '}
            <strong>{repo}</strong> will use more of it.
          </>
        ),
        warning: 'If you hit the limit, every agent pauses until it resets.',
        confirmLabel: 'Start anyway',
        cancelLabel: 'Not now',
      }))
    )
      return;
    setBusy(true);
    try {
      const { agent } = await api.launch(repo);
      onSelect(agent.id);
      notify('ok', `Launched ${agent.id}`);
    } catch (err) {
      notify('err', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="navbar">
      <div className="brand">
        <img src="/logo.svg" alt="" className="brand-logo" />
        <div className="brand-text">
          <span className="brand-name">Agent Office</span>
          <span className="brand-sub">
            <span className={`conn ${office.connected ? 'on' : 'off'}`} title={office.connected ? 'connected' : 'disconnected'} />
            Claude agents
          </span>
        </div>
      </div>

      <select className="agent-select" value={selected?.id ?? ''} onChange={(e) => onSelect(e.target.value || undefined)}>
        <option value="">Select an agent…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {displayName(a)} — {STATUS_LABEL[a.status]}
          </option>
        ))}
      </select>

      <div className="now" onClick={() => selected && onOpenLog(selected.id)} title="Open event log">
        {selected ? (
          <>
            <span className={`pill status-${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
            <code>{selected.currentTask ?? 'No activity yet'}</code>
          </>
        ) : (
          <span className="hint">Pick an agent to see what it is running</span>
        )}
      </div>

      <form className="prompt" onSubmit={send}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            !selected
              ? 'Select an agent first'
              : canSend
                ? `Prompt ${displayName(selected)}…`
                : 'Read-only: open its log and click Take over'
          }
          disabled={!canSend || busy}
        />
        <button type="submit" disabled={!canSend || busy || !prompt.trim()}>
          Send
        </button>
      </form>

      <div className="launch">
        <select value={launchRepo} onChange={(e) => setLaunchRepo(e.target.value)} disabled={!launchable.length}>
          {launchable.length === 0 && <option>no repos configured</option>}
          {launchable.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name} ({runningIn(office.agents, r.name)}/{max})
            </option>
          ))}
        </select>
        <button
          onClick={launch}
          disabled={busy || !launchable.length || !office.canLaunch || repoFull}
          title={
            !office.canLaunch
              ? 'Launching is not available on the server'
              : repoFull
                ? `${chosenRepo} already runs ${max} agents (limit per repo)`
                : 'Start claude in a new terminal in this repo'
          }
        >
          + New agent
        </button>
      </div>

      <button
        className="settings-btn"
        onClick={onOpenSettings}
        title={hiddenCount ? `Settings: ${hiddenCount} project(s) hidden` : 'Settings: choose which projects to show'}
        aria-label="Settings"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"
          />
        </svg>
        {hiddenCount > 0 && <span className="settings-badge">{hiddenCount}</span>}
      </button>

      {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}
    </header>
  );
}
