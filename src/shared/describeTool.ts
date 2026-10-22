/** One-line summary of what a tool call does. Keep in sync with hooks/send-event.mjs. */
export function describeTool(name: string | undefined, input: Record<string, any> = {}): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return input.file_path ?? input.notebook_path;
    case 'Grep':
    case 'Glob':
      return input.pattern + (input.path ? ` in ${input.path}` : '');
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Task':
    case 'Agent':
      return input.description ?? input.prompt;
    case 'Skill':
      return input.skill;
    case 'TodoWrite':
      return `${input.todos?.length ?? 0} todos`;
    default:
      return JSON.stringify(input);
  }
}
