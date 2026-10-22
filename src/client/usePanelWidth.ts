import { useCallback, useEffect, useState } from 'react';

const MIN = 320;
/** Always leave this much room for the sidebar + office. */
const KEEP_FREE = 360;
const DEFAULTS = { events: 420, terminal: 760 } as const;
type Mode = keyof typeof DEFAULTS;

const key = (mode: Mode) => `agent-office.panel-width.${mode}`;
const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(w, window.innerWidth - KEEP_FREE)));

function load(mode: Mode): number {
  try {
    const v = Number(localStorage.getItem(key(mode)));
    if (v > 0) return v;
  } catch {
    /* storage unavailable: use the default */
  }
  return DEFAULTS[mode];
}

/**
 * Drag-resizable side panel width, remembered per mode (events vs terminal) in this browser.
 * Returns the width plus pointer/double-click handlers for the drag handle.
 */
export function usePanelWidth(mode: Mode) {
  const [widths, setWidths] = useState<Record<Mode, number>>(() => ({ events: load('events'), terminal: load('terminal') }));
  const [dragging, setDragging] = useState(false);

  const set = useCallback(
    (w: number) => {
      setWidths((prev) => ({ ...prev, [mode]: clamp(w) }));
    },
    [mode],
  );

  // Persist once a drag ends (not on every pixel).
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(key(mode), String(widths[mode]));
    } catch {
      /* ignore */
    }
  }, [dragging, mode, widths]);

  // Keep the panel inside the window when the window shrinks.
  useEffect(() => {
    const onResize = () => setWidths((prev) => ({ events: clamp(prev.events), terminal: clamp(prev.terminal) }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add('resizing');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) set(window.innerWidth - e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    document.body.classList.remove('resizing');
  };
  const onDoubleClick = () => set(DEFAULTS[mode]);

  return {
    width: clamp(widths[mode]),
    dragging,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick },
  };
}
