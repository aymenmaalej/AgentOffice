import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Interactive view of a server-owned terminal, streamed over /pty?id=…. */
export function LiveTerminal({ agentId }: { agentId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: '#050b17', foreground: '#d5d9e0', cursor: '#245aff', selectionBackground: '#245aff55' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/pty?id=${encodeURIComponent(agentId)}`);
    const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    const resize = () => {
      try {
        fit.fit();
      } catch {
        /* hidden / zero-size */
      }
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    ws.onopen = resize;
    ws.onmessage = (m) => term.write(typeof m.data === 'string' ? m.data : '');
    ws.onclose = () => term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    const input = term.onData((data) => send({ type: 'input', data }));

    const ro = new ResizeObserver(resize);
    ro.observe(el);
    term.focus();

    return () => {
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [agentId]);

  return <div className="xterm-host" ref={host} />;
}
