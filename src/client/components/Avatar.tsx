import type { Agent } from '../../shared/types.ts';
import { agentHue, displayName, shortName, STATUS_LABEL } from '../util.ts';

const BUBBLE: Partial<Record<Agent['status'], string>> = {
  needs_input: '!',
  done: '✓',
  idle: 'z',
  starting: '…',
  offline: '×',
};

interface Props {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
}

export function Avatar({ agent, selected, onClick }: Props) {
  return (
    <button
      className={`avatar status-${agent.status} ${selected ? 'selected' : ''}`}
      style={{ '--hue': agentHue(agent.id) } as React.CSSProperties}
      onClick={onClick}
      title={`${displayName(agent)} — ${STATUS_LABEL[agent.status]}\n${agent.currentTask ?? ''}`}
    >
      <span className="bubble">
        {agent.status === 'working' ? (
          <span className="typing">
            <i />
            <i />
            <i />
          </span>
        ) : (
          BUBBLE[agent.status]
        )}
      </span>
      <span className="person">
        <span className="head" />
        <span className="torso" />
      </span>
      <span className="nametag">{shortName(agent)}</span>
    </button>
  );
}
