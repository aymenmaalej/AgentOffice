import { execFile } from 'node:child_process';

/** Thin wrapper around the tmux CLI. All calls use execFile (no shell), so prompts are never shell-interpreted. */
export class Tmux {
  constructor(private cmd: string[]) {}

  private run(args: string[]): Promise<string> {
    const [bin, ...pre] = this.cmd;
    return new Promise((resolve, reject) => {
      execFile(bin, [...pre, ...args], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).toString().trim()));
        else resolve(stdout.toString());
      });
    });
  }

  async available(): Promise<boolean> {
    try {
      await this.run(['-V']);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const out = await this.run(['list-sessions', '-F', '#{session_name}']);
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      // "no server running" / "no sessions" / tmux missing -> nothing to list
      return [];
    }
  }

  /** Start a detached session in `cwd` running `command`. Env vars let the hook script identify the agent. */
  async newSession(name: string, cwd: string, command: string, env: Record<string, string>): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    await this.run(['new-session', '-d', '-s', name, '-c', cwd, ...envArgs, command]);
  }

  async sendPrompt(name: string, text: string): Promise<void> {
    const target = `=${name}:`;
    await this.run(['send-keys', '-t', target, '-l', '--', text]);
    // Give Claude's TUI a moment to treat the text as typed input before submitting.
    await new Promise((r) => setTimeout(r, 150));
    await this.run(['send-keys', '-t', target, 'Enter']);
  }

  async capture(name: string, lines = 60): Promise<string> {
    return this.run(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`]);
  }

  async kill(name: string): Promise<void> {
    await this.run(['kill-session', '-t', `=${name}`]);
  }
}

/** tmux treats "." and ":" specially in targets. */
export function sessionSafe(repo: string): string {
  return repo.replace(/[.:\s]/g, '_');
}
