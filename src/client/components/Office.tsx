import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Agent } from '../../shared/types.ts';
import type { OfficeState } from '../useOffice.ts';
import { activeFirst, atDesk, byStatus, runningIn, timeAgo } from '../util.ts';
import { useLayout, type RoomSize } from '../useLayout.ts';
import { Avatar } from './Avatar.tsx';

interface Props {
  office: OfficeState;
  selectedId?: string;
  onSelect: (id: string) => void;
}

/** Fixed row height of the office grid; rooms span whole rows (keep in sync with .rooms grid-auto-rows). */
const ROW_HEIGHT = 230;

export function Office({ office, selectedId, onSelect }: Props) {
  const agents = Object.values(office.agents).sort(byStatus);
  const waiting = agents.filter((a) => !atDesk(a));
  const layout = useLayout();
  // Your arrangement, with projects that have a busy agent moved to the top.
  const repos = activeFirst(layout.arrange(office.repos), office.agents);
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ name: string; after: boolean }>();

  /** Snap a pixel size to whole grid columns/rows. */
  const toSpans = (width: number, height: number): RoomSize => {
    const grid = gridRef.current;
    if (!grid) return { cols: 1, rows: 1 };
    const style = getComputedStyle(grid);
    const colCount = style.gridTemplateColumns.split(' ').length;
    const gap = parseFloat(style.columnGap) || 0;
    const colWidth = (grid.clientWidth - gap * (colCount - 1)) / colCount;
    return {
      cols: Math.min(colCount, Math.max(1, Math.round((width + gap) / (colWidth + gap)))),
      rows: Math.max(1, Math.round((height + gap) / (ROW_HEIGHT + gap))),
    };
  };

  return (
    <div className="floor">
      {office.repos.length === 0 && (
        <div className="empty-floor">
          No sessions found yet. Start <code>claude</code> in a repo, or list repos in <code>agent-office.config.json</code>.
        </div>
      )}
      {/* The lounge sits on top, above the project rooms. */}
      <WaitingRoom agents={waiting} selectedId={selectedId} onSelect={onSelect} />
      {layout.customized && (
        <div className="floor-tools">
          <button onClick={layout.reset} title="Restore the default room order and sizes">
            Reset layout
          </button>
        </div>
      )}
      <div className="rooms" ref={gridRef}>
        {repos.map((repo) => (
          <RepoRoom
            key={repo.name}
            name={repo.name}
            agents={agents.filter((a) => a.repo === repo.name && atDesk(a))}
            away={agents.filter((a) => a.repo === repo.name && !atDesk(a)).length}
            running={runningIn(office.agents, repo.name)}
            max={office.maxAgentsPerRepo}
            size={layout.sizeOf(repo.name)}
            selectedId={selectedId}
            onSelect={onSelect}
            dragging={dragging === repo.name}
            dropHint={dropTarget?.name === repo.name ? (dropTarget.after ? 'after' : 'before') : undefined}
            onDragStart={() => setDragging(repo.name)}
            onDragEnd={() => {
              setDragging(undefined);
              setDropTarget(undefined);
            }}
            onDragOverRoom={(after) => dragging && dragging !== repo.name && setDropTarget({ name: repo.name, after })}
            onDropRoom={(after) => {
              if (dragging) layout.move(repos.map((r) => r.name), dragging, repo.name, after);
              setDragging(undefined);
              setDropTarget(undefined);
            }}
            onResize={(w, h) => layout.resize(repo.name, toSpans(w, h))}
          />
        ))}
      </div>
    </div>
  );
}

const WAITING_EXPANDED_KEY = 'agent-office.waiting-room-expanded';
const lastUsed = (a: Agent) => a.lastEventAt ?? a.startedAt;

/**
 * Idle/finished agents, most recently used first. Collapsed to one row by default; "Show all" opens it.
 * The choice is remembered in this browser.
 */
function WaitingRoom({ agents, selectedId, onSelect }: { agents: Agent[]; selectedId?: string; onSelect: (id: string) => void }) {
  const sorted = [...agents].sort((a, b) => lastUsed(b).localeCompare(lastUsed(a)));
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(WAITING_EXPANDED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const listRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState<number>();
  const [beyondFirstRow, setBeyondFirstRow] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(WAITING_EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [expanded]);

  // Measure the first row: its height (for the collapsed size) and how many agents wrap below it.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const items = [...list.querySelectorAll<HTMLElement>('.lounger')];
      if (!items.length) {
        setBeyondFirstRow(0);
        return;
      }
      const top = items[0].offsetTop;
      setRowHeight(Math.max(...items.filter((el) => el.offsetTop === top).map((el) => el.offsetHeight)));
      setBeyondFirstRow(items.filter((el) => el.offsetTop > top + 2).length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [sorted.length]);

  const collapsed = !expanded && beyondFirstRow > 0;

  return (
    <section className="room waiting-room">
      <header className="plaque">
        <span className="plaque-name">
          <small>Lounge</small>
          Waiting Room
        </span>
        <span className="waiting-tools">
          {(beyondFirstRow > 0 || expanded) && (
            <button className="waiting-toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? 'Show less ▲' : `Show all · ${beyondFirstRow} more ▼`}
            </button>
          )}
          <span className="count" title="agents waiting, most recently used first">
            {agents.length}
          </span>
        </span>
      </header>
      <div className="lounge">
        <div className="furniture">
          <div className="couch" />
          <div className="coffee-table" />
          <div className="couch" />
          <div className="coffee-machine" title="coffee" />
          <div className="plant" />
        </div>
        <div
          ref={listRef}
          className={`lounge-agents ${collapsed ? 'collapsed' : ''}`}
          style={collapsed && rowHeight ? { maxHeight: rowHeight } : undefined}
        >
          {agents.length === 0 && <span className="hint">Nobody is waiting — everyone is busy.</span>}
          {sorted.map((a) => (
            <div className="lounger" key={a.id} title={`Last used ${timeAgo(lastUsed(a))}`}>
              <Avatar agent={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} />
              <span className="lounger-repo">{a.repo}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

interface RoomProps {
  name: string;
  agents: Agent[];
  away: number;
  running: number;
  max: number;
  size: RoomSize;
  selectedId?: string;
  onSelect: (id: string) => void;
  dragging: boolean;
  dropHint?: 'before' | 'after';
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRoom: (after: boolean) => void;
  onDropRoom: (after: boolean) => void;
  /** Called while the corner handle is dragged, with the room's would-be pixel size. */
  onResize: (width: number, height: number) => void;
}

function RepoRoom(p: RoomProps) {
  const { name, agents, away, running, max, size, selectedId, onSelect } = p;
  // One desk per allowed agent; extra desks only if outside sessions are busy here too.
  const desks = Math.max(max, agents.length);
  const blocked = agents.some((a) => a.status === 'needs_input');
  const roomRef = useRef<HTMLElement>(null);
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | undefined>(undefined);
  const [resizing, setResizing] = useState(false);

  // Drop on the left/top half = before this room, right/bottom half = after it.
  const isAfter = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX - r.left > r.width / 2;
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const r = roomRef.current!.getBoundingClientRect();
    resizeStart.current = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = resizeStart.current;
    if (resizing && s) p.onResize(s.w + e.clientX - s.x, s.h + e.clientY - s.y);
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    resizeStart.current = undefined;
    setResizing(false);
  };

  return (
    <section
      ref={roomRef}
      className={[
        'room',
        blocked && 'alert',
        p.dragging && 'is-dragging',
        resizing && 'is-resizing',
        p.dropHint && `drop-${p.dropHint}`,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ gridColumn: `span ${size.cols}`, gridRow: `span ${size.rows}` }}
      onDragOver={(e) => {
        e.preventDefault();
        p.onDragOverRoom(isAfter(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        p.onDropRoom(isAfter(e));
      }}
    >
      <header
        className="plaque draggable"
        draggable
        title="Drag to move this room"
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', name);
          p.onDragStart();
        }}
        onDragEnd={p.onDragEnd}
      >
        <span className="plaque-name">
          <small>
            <span className="grip" aria-hidden>
              ⠿
            </span>
            Repo
          </small>
          {name}
        </span>
        <span className={`seats ${running >= max ? 'full' : ''}`} title="agents run by Agent Office / limit per repo">
          {running}/{max}
          {away > 0 && <small> · {away} away</small>}
        </span>
      </header>
      <div className="desks">
        {Array.from({ length: desks }, (_, i) => {
          const a = agents[i];
          return (
            <div key={i} className={`desk-spot ${a ? `occupied status-${a.status}` : ''}`}>
              <div className="desk">
                <div className="monitor" />
                <div className="keyboard" />
              </div>
              <div className="seat">
                {a ? <Avatar agent={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} /> : <div className="chair" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="plant corner" />
      <div
        className="room-resize"
        title={`Drag to resize (${size.cols}×${size.rows})`}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </section>
  );
}
