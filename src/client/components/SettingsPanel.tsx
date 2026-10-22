import { useEffect } from 'react';
import type { Agent, RepoInfo } from '../../shared/types.ts';
import type { useVisibility } from '../useVisibility.ts';

interface Props {
  /** All projects, including hidden ones. */
  repos: RepoInfo[];
  /** All agents, including those in hidden projects. */
  agents: Record<string, Agent>;
  visibility: ReturnType<typeof useVisibility>;
  onClose: () => void;
}

/** Choose which projects the office shows (e.g. work projects only). Purely a display filter; nothing is stopped. */
export function SettingsPanel({ repos, agents, visibility, onClose }: Props) {
  const { settings, isVisible, outsideFolder, setVisible, setFolder, showAll } = visibility;
  const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name));
  const shownCount = repos.filter(isVisible).length;
  const agentCount = (repo: string) => Object.values(agents).filter((a) => a.repo === repo).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-eyebrow">Settings</div>
        <h2 id="settings-title">Which projects to show</h2>
        <p className="dialog-message">
          Hide projects you don't want to see (e.g. learning exercises). Hidden projects disappear from the office, the
          sidebar and the agent list. Nothing is stopped; you can show them again anytime.
        </p>

        <label className="settings-field">
          <span>Only show projects inside this folder</span>
          <div className="settings-folder">
            <input
              value={settings.folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="e.g. D:\Work  (leave empty to show every folder)"
              spellCheck={false}
            />
            {!settings.folder && (
              <button className="chip" onClick={() => setFolder('D:\\Work')}>
                Use D:\Work
              </button>
            )}
          </div>
          <small>New projects outside this folder stay hidden automatically.</small>
        </label>

        <div className="settings-list-head">
          <span>Projects</span>
          <span className="hint">
            showing {shownCount} of {repos.length}
          </span>
        </div>
        <ul className="settings-list">
          {sorted.map((r) => {
            const visible = isVisible(r);
            return (
              <li key={r.name} className={visible ? '' : 'off'}>
                <label>
                  <input type="checkbox" checked={visible} onChange={(e) => setVisible(r, e.target.checked)} />
                  <span className="settings-repo">
                    <strong>{r.name}</strong>
                    <small>{r.path ?? 'folder unknown'}</small>
                  </span>
                  {outsideFolder(r) && !settings.shown.includes(r.name) && <span className="tag">outside folder</span>}
                  <span className="hint">{agentCount(r.name)} agent(s)</span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={showAll} title="Clear the folder rule and show every project">
            Show all
          </button>
          <button className="dialog-confirm" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
