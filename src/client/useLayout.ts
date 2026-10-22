import { useCallback, useEffect, useState } from 'react';

/** Room spans on the office grid. */
export interface RoomSize {
  cols: number;
  rows: number;
}
interface Layout {
  /** Repo names in the order you arranged them; repos not listed follow in their default order. */
  order: string[];
  sizes: Record<string, RoomSize>;
}

const KEY = 'agent-office.layout';
export const MAX_SPAN = 3;
const DEFAULT_SIZE: RoomSize = { cols: 1, rows: 1 };

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && Array.isArray(raw.order) && raw.sizes && typeof raw.sizes === 'object') return raw;
  } catch {
    /* storage unavailable or corrupt: default layout */
  }
  return { order: [], sizes: {} };
}

/** Room order and sizes on the office floor, arranged by drag & drop and remembered in this browser. */
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      /* ignore */
    }
  }, [layout]);

  /** Apply the saved order to the current repo list (unknown repos keep their default position at the end). */
  const arrange = useCallback(
    <T extends { name: string }>(repos: T[]): T[] => {
      const rank = new Map(layout.order.map((n, i) => [n, i]));
      return [...repos].sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity));
    },
    [layout.order],
  );

  const sizeOf = useCallback((name: string) => layout.sizes[name] ?? DEFAULT_SIZE, [layout.sizes]);

  /** Move `dragged` to `target`'s slot (before it, or after it when `after`). */
  const move = useCallback((current: string[], dragged: string, target: string, after: boolean) => {
    if (dragged === target) return;
    const next = current.filter((n) => n !== dragged);
    const i = next.indexOf(target);
    next.splice(after ? i + 1 : i, 0, dragged);
    setLayout((l) => ({ ...l, order: next }));
  }, []);

  const resize = useCallback((name: string, size: RoomSize) => {
    const clamp = (n: number) => Math.max(1, Math.min(MAX_SPAN, Math.round(n)));
    const s = { cols: clamp(size.cols), rows: clamp(size.rows) };
    setLayout((l) => {
      const cur = l.sizes[name] ?? DEFAULT_SIZE;
      return cur.cols === s.cols && cur.rows === s.rows ? l : { ...l, sizes: { ...l.sizes, [name]: s } };
    });
  }, []);

  const reset = useCallback(() => setLayout({ order: [], sizes: {} }), []);
  const customized = layout.order.length > 0 || Object.keys(layout.sizes).length > 0;

  return { arrange, sizeOf, move, resize, reset, customized };
}
