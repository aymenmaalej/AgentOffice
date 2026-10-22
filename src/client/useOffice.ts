import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentEvent, RepoInfo, ServerMessage, UsageLimits } from '../shared/types.ts';
import { labelAgents, type LabeledAgent } from './util.ts';

export interface OfficeState {
  /** Agents with their display labels ("API #1") once returned by useOffice. */
  agents: Record<string, LabeledAgent>;
  events: Record<string, AgentEvent[]>;
  repos: RepoInfo[];
  canLaunch: boolean;
  maxAgentsPerRepo: number;
  connected: boolean;
  usage: UsageLimits;
}

const MAX_EVENTS = 300;

/** Live office state, kept in sync with the server over a self-reconnecting WebSocket. */
export function useOffice(): OfficeState {
  const [state, setState] = useState<OfficeState>({
    agents: {},
    events: {},
    repos: [],
    canLaunch: false,
    maxAgentsPerRepo: 2,
    connected: false,
    usage: {},
  });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data) as ServerMessage;
        setState((s) => apply(s, msg));
      };
      ws.onopen = () => setState((s) => ({ ...s, connected: true }));
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  // Project-based display names ("API #1"), frontend only; numbers stay put for the page's lifetime.
  const numbers = useRef(new Map<string, number>());
  const agents = useMemo(() => labelAgents(state.agents, numbers.current), [state.agents]);
  return useMemo(() => ({ ...state, agents }), [state, agents]);
}

function apply(s: OfficeState, msg: ServerMessage): OfficeState {
  switch (msg.type) {
    case 'snapshot':
      return {
        ...s,
        agents: Object.fromEntries(msg.agents.map((a) => [a.id, a])),
        events: msg.events,
        repos: msg.repos,
        canLaunch: msg.canLaunch,
        maxAgentsPerRepo: msg.maxAgentsPerRepo,
        usage: msg.usage,
      };
    case 'agent':
      return { ...s, agents: { ...s.agents, [msg.agent.id]: msg.agent } };
    case 'agentRemoved': {
      const { [msg.id]: _a, ...agents } = s.agents;
      const { [msg.id]: _e, ...events } = s.events;
      return { ...s, agents, events };
    }
    case 'event': {
      const list = [...(s.events[msg.event.agentId] ?? []), msg.event].slice(-MAX_EVENTS);
      return { ...s, events: { ...s.events, [msg.event.agentId]: list } };
    }
    case 'agentEvents':
      return { ...s, events: { ...s.events, [msg.agentId]: msg.events } };
    case 'repos':
      return { ...s, repos: msg.repos };
    case 'usage':
      return { ...s, usage: msg.usage };
  }
}
