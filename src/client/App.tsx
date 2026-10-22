import { useEffect, useMemo, useState } from 'react';
import { useOffice } from './useOffice.ts';
import { useVisibility } from './useVisibility.ts';
import { Navbar } from './components/Navbar.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Office } from './components/Office.tsx';
import { LogPanel } from './components/LogPanel.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { runningIn } from './util.ts';

export function App() {
  const all = useOffice();
  const visibility = useVisibility();
  const [selectedId, setSelectedId] = useState<string>();
  const [logOpen, setLogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // What the office shows: only the projects you chose in Settings (display filter; hidden agents keep running).
  const office = useMemo(() => {
    const repos = all.repos.filter(visibility.isVisible);
    const names = new Set(repos.map((r) => r.name));
    const agents = Object.fromEntries(Object.entries(all.agents).filter(([, a]) => names.has(a.repo)));
    return { ...all, repos, agents };
  }, [all, visibility.isVisible]);

  const selected = selectedId ? office.agents[selectedId] : undefined;

  // Forget the selection when its agent disappears (or its project gets hidden).
  useEffect(() => {
    if (selectedId && !office.agents[selectedId]) {
      setSelectedId(undefined);
      setLogOpen(false);
    }
  }, [office.agents, selectedId]);

  const openLog = (id: string) => {
    setSelectedId(id);
    setLogOpen(true);
  };

  const hiddenCount = all.repos.length - office.repos.length;

  return (
    <div className="app">
      <Navbar
        office={office}
        selected={selected}
        onSelect={setSelectedId}
        onOpenLog={openLog}
        onOpenSettings={() => setSettingsOpen(true)}
        hiddenCount={hiddenCount}
      />
      <div className="body">
        <Sidebar office={office} selectedId={selectedId} onSelect={openLog} />
        <main className="main">
          <Office office={office} selectedId={selectedId} onSelect={openLog} />
        </main>
        {logOpen && selected && (
          <LogPanel
            agent={selected}
            events={office.events[selected.id] ?? []}
            canTakeOver={office.canLaunch && runningIn(all.agents, selected.repo) < office.maxAgentsPerRepo}
            onClose={() => setLogOpen(false)}
          />
        )}
      </div>
      {settingsOpen && (
        <SettingsPanel repos={all.repos} agents={all.agents} visibility={visibility} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
