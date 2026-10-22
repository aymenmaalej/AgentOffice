import { useCallback, useEffect, useState } from 'react';
import type { RepoInfo } from '../shared/types.ts';

/** Which projects the office shows (e.g. work only, not exercises). Saved in this browser. */
export interface VisibilitySettings {
  /** If set, only projects whose folder is inside this one are shown (e.g. "D:\Work"). */
  folder: string;
  /** Projects you unticked. */
  hidden: string[];
  /** Projects you ticked although they are outside the folder. */
  shown: string[];
}

const KEY = 'agent-office.visibility';
const EMPTY: VisibilitySettings = { folder: '', hidden: [], shown: [] };

function load(): VisibilitySettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v.folder === 'string' && Array.isArray(v.hidden) && Array.isArray(v.shown)) return v;
  } catch {
    /* storage unavailable or corrupt: show everything */
  }
  return EMPTY;
}

const norm = (p: string) => p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** True if `path` is `folder` or inside it (case-insensitive, / and \ alike). */
export function inFolder(path: string, folder: string): boolean {
  const f = norm(folder);
  const p = norm(path);
  return p === f || p.startsWith(f + '\\');
}

export function useVisibility() {
  const [settings, setSettings] = useState<VisibilitySettings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  /** Hidden by the folder rule alone (before your per-project ticks). */
  const outsideFolder = useCallback(
    (repo: RepoInfo) => !!settings.folder.trim() && !!repo.path && !inFolder(repo.path, settings.folder),
    [settings.folder],
  );

  const isVisible = useCallback(
    (repo: RepoInfo) => {
      if (settings.hidden.includes(repo.name)) return false;
      if (settings.shown.includes(repo.name)) return true;
      return !outsideFolder(repo);
    },
    [settings, outsideFolder],
  );

  /** Tick/untick one project; the explicit choice wins over the folder rule. */
  const setVisible = useCallback(
    (repo: RepoInfo, visible: boolean) => {
      setSettings((s) => {
        const hidden = s.hidden.filter((n) => n !== repo.name);
        const shown = s.shown.filter((n) => n !== repo.name);
        if (!visible) hidden.push(repo.name);
        else if (outsideFolder(repo)) shown.push(repo.name);
        return { ...s, hidden, shown };
      });
    },
    [outsideFolder],
  );

  const setFolder = useCallback((folder: string) => setSettings((s) => ({ ...s, folder })), []);
  const showAll = useCallback(() => setSettings(EMPTY), []);

  return { settings, isVisible, outsideFolder, setVisible, setFolder, showAll };
}
