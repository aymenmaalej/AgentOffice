import type { OfficeState } from '../useOffice.ts';
import { activeFirst, displayName, STATUS_LABEL, timeAgo } from '../util.ts';
import { ContextChip, UsagePanel } from './UsagePanel.tsx';

interface Props {
  office: OfficeState;
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function Sidebar({ office, selectedId, onSelect }: Props) {
  const agents = Object.values(office.agents);

  return (
    <aside className="sidebar">
      <UsagePanel usage={office.usage} />
      {activeFirst(office.repos, office.agents).map((repo) => {
        // Same order as the "#n" labels.
        const list = agents.filter((a) => a.repo === repo.name).sort((a, b) => (a.num ?? 0) - (b.num ?? 0) || a.id.localeCompare(b.id));
        return (
          <div className="repo-group" key={repo.name}>
            <h3>
              {repo.name}
              <span className="count">{list.length}</span>
            </h3>
            {list.length === 0 && <div className="hint">no agents</div>}
            {list.map((a) => (
              <button
                key={a.id}
                className={`agent-row ${a.id === selectedId ? 'selected' : ''}`}
                onClick={() => onSelect(a.id)}
              >
                <div className="agent-row-top">
                  <span className="agent-name" title={a.title ?? undefined}>
                    {displayName(a)}
                  </span>
                  <span className={`pill status-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                </div>
                <div className="agent-task" title={a.currentTask}>
                  {a.currentTask ?? '—'}
                </div>
                <div className="agent-meta">
                  {!a.controllable &&
                    (a.livePid !== undefined ? (
                      <span className="open-elsewhere" title="Open in another terminal window right now: monitor only">
                        ● open elsewhere ·{' '}
                      </span>
                    ) : (
                      <span title="Runs outside Agent Office: monitor only (Take over to control it)">👁 read-only · </span>
                    ))}
                  {timeAgo(a.lastEventAt ?? a.startedAt)}
                  <ContextChip pct={a.contextPercent} />
                </div>
              </button>
            ))}
          </div>
        );
      })}
    </aside>
  );
}
