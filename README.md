# Agent Office

**A local control room for your Claude Code agents.**

Agent Office is a web app that runs on your own machine at http://127.0.0.1:5173. It shows every Claude Code session across your projects as people working in an office. You can see what each one is doing, how much of your Claude usage is left, and step in to talk to any of them, all from one browser tab. There's no login or database, and nothing leaves your computer.

## What it does

**Watches all your Claude sessions automatically**
- It reads Claude Code's own session history (`~/.claude/projects`), so sessions from the last 3 days appear without any setup.
- Each project gets a room: shop-api, shop-frontend, website, and so on.
- It updates live every 1.5 seconds as Claude reads files, runs commands or finishes a task.

**Shows the office**
- Each agent is an avatar named after its project, like `shop-api #1` or `SF 2`. An agent keeps its number: removing `#1` leaves `#2` as `#2`, and the next new agent takes the free `#1`.
- Projects with an agent busy right now (working, needing input, starting) move to the top of the office and the sidebar.
- Busy agents sit at a desk with a glowing monitor. Finished or idle agents move to the **Waiting Room**.
- A room turns red when an agent there needs your answer (a permission dialog or a question). This works for every open session, with no setup: Claude Code publishes each session's live status, and the app reads it.

**Tells you exactly what each agent is doing**
- The sidebar lists agents by project, with status (working / needs input / done / idle) and current task.
- The top bar shows the exact command or file the selected agent is working on right now.
- Clicking an agent opens its **event log**: your prompts, **Claude's replies**, every tool call, and the end of each turn.

**Helps you manage usage**
- A **usage panel** shows your **5-hour session** and **weekly** limits: % used and when each resets. It also gives a plain verdict: keep going, keep it focused, wrap up, or stop.
- Each agent shows how full its conversation is (`ctx 63%`), so you know when to `/compact` or start fresh.
- At most **2 running agents per project**, and the app asks you to confirm before starting a new agent when usage is at 80% or more.

**Lets you control agents directly**
- **+ New agent** starts Claude Code in any project.
- **Live terminal** inside the page: type, approve permissions, run slash commands. Drag the panel's edge to resize it.
- **Send prompts** from the top bar to any agent the app controls.
- **Take over** reopens a session you started in a normal terminal inside the app, with its full history. While that session is still open in another window, Take over is blocked (it shows "open elsewhere") so two Claude processes never write to the same conversation.
- **Agents keep running when the app restarts.** Each agent lives in its own small background process; a restarted server reconnects to it, with its terminal history.
- **Stop** ends an agent.

## What you can do with it, day to day

- **Run several projects in parallel.** For example, start one agent on the frontend and one on the API, then watch both from one screen.
- **Catch blocked agents quickly.** A red room or a bouncing "!" means an agent is waiting for you; the task line says what for (e.g. "Waiting for you: permission: Bash").
- **Pick up where you left off.** Open yesterday's session from the Waiting Room, read what it did, and take it over to continue.
- **Pace your usage.** Before starting something big, check the session and weekly bars. If the session bar is nearly full, wait for the reset time shown.
- **Review what an agent did** without scrolling a terminal: the event log lists every command and file it touched.

## Ideas for what could be added next

- **Rename agents yourself** (e.g. "frontend – invoices"), saved in the browser.
- **Desktop notifications** when an agent needs input or finishes.
- **Quick-approve buttons** for permission prompts, without opening the terminal.
- **Cost and token history** per project and per day.
- **Prompt templates** you can send to an agent in one click ("run tests", "write a changelog").
- **Search** across all event logs.
- **Git status per room**: current branch and uncommitted changes.
- **Translations** of the interface.

## How it fits together

```
 ~/.claude/projects/*.jsonl ──(tail every 1.5 s)──┐
 status line (limits, ctx %) ──POST /usage──────┐ │      Agent Office server (:4317)        Browser (:5173)
 hooks (optional) ─────────────POST /events───┐ │ │   ┌────────────────────────────────┐ ws ┌───────────────────────────┐
                                              └─┴─┴──▶│ in-memory agents, events, usage │───▶│ office · sidebar · usage  │
                                                      │ terminals: node-pty (or tmux)   │◀───│ prompt bar · event log    │
 claude processes ◀──── launch / resume / keys ───────│ launch · take over · prompt     │ws  │ live terminal (xterm.js)  │
                                                      └────────────────────────────────┘    └───────────────────────────┘
```

The rest of this README is the technical reference.

## Requirements

- Node 20+ (uses the built-in `fetch`)
- `claude` on the PATH
- Nothing else on Windows/macOS/Linux: agents run in terminals owned by the server (`node-pty`, using ConPTY on Windows). **tmux 3.0+** is optional, for agents that survive server restarts (see [Runners](#runners-terminal-vs-tmux)).

> **Windows:** works natively. The default runner is the built-in terminal (ConPTY), with no WSL or tmux needed.

## Quick start

```bash
npm install
npm run dev                    # server :4317 + Vite UI :5173
```

Use `127.0.0.1` rather than `localhost`: the servers listen on IPv4 only, and `localhost` can resolve to IPv6 and time out.

Open http://127.0.0.1:5173. Your recent Claude Code sessions appear right away, one room per project. A config file is optional. Add one (`cp agent-office.config.example.json agent-office.config.json`) to pin repos or change settings, and run `npm run install-hooks` for "needs input" alerts.

Production-style (one port): `npm run build && npm start`, then open http://127.0.0.1:4317.

## Guardrails against running out of usage

- **2 agents per repo**: at most `maxAgentsPerRepo` (default 2) agents run at once per repo. The launcher shows `repo (1/2)` and disables itself when the repo is full; room badges show the same count.
- **Usage check**: when your session or weekly usage is at 80% or more, "+ New agent" asks you to confirm first.

## Theme

The UI uses a dark blueprint look: navy `#071426` with a blueprint grid, primary blue `hsl(225 100% 57%)`, silver text, **Exo 2** headings and **Poppins** body text (Google Fonts), and the logo in `public/logo.svg`. The tokens live at the top of `src/client/styles.css`.

## Runners: terminal vs tmux

| | **pty** (built-in terminal) | **tmux** |
| --- | --- | --- |
| Works on | Windows, macOS, Linux | Linux, macOS, WSL |
| Terminal tab | live, interactive (xterm.js): type, approve permissions, slash commands | read-only snapshot, refreshed every 2 s |
| Survives server restart | yes (each agent runs in its own detached agent host) | yes |
| Default when | Windows, or tmux missing | tmux is available (not on Windows) |

Force one with `"runner": "pty" | "tmux"` in the config.

**Launch** (`+ New agent`) starts `claude --session-id <uuid>` in the repo. The known id links the transcript to the agent right away.

**Take over**: any read-only session (imported from transcripts) has a **▶ Take over** button in its log panel. It reopens the conversation in a server-owned terminal with `claude --resume <session-id>`, keeping its full history, and then it's fully controllable. Two Claude processes on one session would conflict, so Take over is **refused while the session is open anywhere else**: the app reads Claude Code's own registry of running sessions (`~/.claude/sessions`) and shows such sessions as "open elsewhere". Close it there, then take over.

**Session switches.** The claude in an agent's terminal can move to a new session id: `/clear`, or choosing "start a new conversation" when resuming an old session. The app matches open sessions to its terminals by process (claude runs inside the shell its agent host started), so the agent follows its new session: one agent, its terminal, the combined history, and the previous ids remembered (also across restarts).

Prompts from the navbar are typed into the terminal as a bracketed paste followed by Enter, so multi-line prompts work.

**Agents survive restarts.** Each agent the app starts runs inside its own small detached process, the *agent host* (`host/agent-host.mjs`), which owns Claude's terminal and keeps a copy of its scrollback. The server talks to each host over a local pipe. When the server stops (window closed, crash, update), the hosts and their Claude processes keep running; on the next start the server finds them in `~/.agent-office/agents/`, reconnects, and the terminal replays its scrollback. **Stop** in the UI ends the agent and its host; until that Claude process has actually exited, its session is ignored, so it can't come back as a read-only "ghost". Rebooting the computer ends them too. A host that dies or stops answering mid-handshake is given up after 5 s, so it never blocks the server's start-up.

## Configuration: `agent-office.config.json`

```json
{
  "port": 4317,
  "tmuxCommand": ["tmux"],
  "claudeCommand": "claude",
  "repos": [
    { "name": "api", "path": "/home/me/code/api" },
    { "name": "web", "path": "/home/me/code/web" }
  ]
}
```

| key | meaning |
| --- | --- |
| `repos` | One room per repo. `name` is the room label and the tmux session prefix. `path` is where new agents start. |
| `maxAgentsPerRepo` | Max agents the app runs at once per repo (default `2`). "+ New agent" and "Take over" are refused beyond it; each room has that many desks. Sessions you start outside the app aren't counted. |
| `runner` | `"auto"` (default), `"pty"` or `"tmux"`. See [Runners](#runners-terminal-vs-tmux). |
| `tmuxCommand` | How to call tmux: `["tmux"]`, or `["wsl", "tmux"]`. |
| `claudeCommand` | Run in each new session: a command with flags, e.g. `"claude --model opus"`, or the full path to the executable. A path containing spaces (e.g. `C:\Users\Your Name\…\claude.cmd`) is quoted automatically. |
| `port` | Server port. Also settable with `AGENT_OFFICE_PORT`. |
| `importDays` | Import sessions active in the last N days at startup (default `3`, `0` disables transcript import). |
| `claudeProjectsDir` | Transcript folder (default `~/.claude/projects`). |

Restart the server after editing the config. Repos discovered from transcripts or hooks get a room automatically; their launch path is the directory the session started in. Use `AGENT_OFFICE_CONFIG=/path/to/file.json` to keep the config somewhere else.

## Session import (`~/.claude/projects`)

Claude Code writes one JSONL transcript per session to `~/.claude/projects/<project>/<session-id>.jsonl`. At startup, the server imports every session modified in the last `importDays`:

- **room**: the basename of the session's first `cwd` (e.g. `/home/me/code/shop-api` becomes `shop-api`)
- **name**: Claude's generated session title (`ai-title`)
- **events**: your prompts (`UserPromptSubmit`), Claude's replies (`AssistantMessage`), each tool call (`PreToolUse`) and turn ends (`Stop`), taken from the last 2 MB of the file. Big transcripts are not read in full. A session appears as soon as its file exists, even before its first prompt.

After that, it checks the folder every 1.5 s and reads only the newly appended bytes, so running sessions update live, and new sessions (or resumed old ones) show up on their own. A session left "working" with no writes for 10 minutes is shown as idle, since it was probably closed or interrupted. Subagent transcripts and compaction summaries are ignored.

**Live status (`~/.claude/sessions`).** Every open `claude` keeps a small file there with its live status: `busy`, `idle`, or `waiting` plus what it waits for (a permission dialog, a question). The app reads these files (only the `.json` ones, never the `.key` token files) every 1.5 s. That gives, for every open session and without hooks:
- **needs input**: `waiting` turns the agent red with "Waiting for you: …"; it goes back to working or done when you answer;
- **open elsewhere**: which sessions are running and in which process, which is what blocks Take over;
- **precise status**: an open session is never marked "inactive", however long a command runs.

Hooks are optional. When a session also sends hook events, the hook versions of those event types replace the transcript's (nothing is shown twice), and if it runs in tmux, the transcript agent is merged into the tmux agent.

## Usage limits (session & weekly)

The top of the sidebar shows your Claude subscription's **Session (5-hour)** and **Weekly** limits: % used, when each resets, and a verdict (keep going / keep it focused / wrap up / stop). Each agent also gets a **`ctx N%`** chip showing how full its context window is. Above 80%, `/compact` or start a fresh session.

The data comes from Claude Code's **status line** feed, which includes `rate_limits.five_hour`, `rate_limits.seven_day` and `context_window.used_percentage`. No credentials are read and no extra API is called. Install it once, in your user settings:

```bash
npm run install-statusline              # writes statusLine to ~/.claude/settings.json
npm run install-statusline -- --force   # replace a status line you already have
npm run install-statusline -- --uninstall
```

`hooks/statusline.mjs` also prints a compact line in each terminal, e.g. `Opus 5.5 · 5h 42% · wk 84% · ctx 63%`.

Notes:

- Limits are account-wide, so they appear after the next reply in any session running with the status line. "Updated N ago" shows how fresh they are.
- Claude Code only sends `rate_limits` for claude.ai subscribers (Pro/Max), after the first API response. With an API key you'll see "not reported".
- When a reset time passes, the window shows 0% until the next report.
- The server keeps this in memory, so after a restart the panel fills in again on the next reply.

## Hooks

`hooks/send-event.mjs` is the only hook. Claude Code pipes each hook's JSON to it on stdin. It condenses that JSON and POSTs it to `http://127.0.0.1:4317/events`. It has a 1.5 s timeout, prints nothing and always exits 0, so a stopped server never slows Claude down or breaks it.

### Install

```bash
node scripts/install-hooks.mjs                       # every repo in agent-office.config.json
node scripts/install-hooks.mjs ~/code/a ~/code/b     # explicit paths
node scripts/install-hooks.mjs --shared ...          # write .claude/settings.json (default: settings.local.json)
node scripts/install-hooks.mjs --uninstall ...       # remove only our hooks
node scripts/install-hooks.mjs --print               # print the snippet
```

The installer merges into existing settings: your other hooks and permissions are kept, and running it twice is a no-op. It writes `.claude/settings.local.json` by default because the hook command contains an absolute path on *this* machine, and that file is not committed.

### settings.json snippet

This is equivalent to what the installer writes (`hooks/settings.snippet.json` holds a copy; replace the path with yours):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node \"/abs/path/agent-office/hooks/send-event.mjs\"", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"/abs/path/agent-office/hooks/send-event.mjs\"", "timeout": 5 }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/abs/path/agent-office/hooks/send-event.mjs\"", "timeout": 5 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "node \"/abs/path/agent-office/hooks/send-event.mjs\"", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node \"/abs/path/agent-office/hooks/send-event.mjs\"", "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node \"/abs/path/agent-office/hooks/send-event.mjs\"", "timeout": 5 }] }]
  }
}
```

`SessionEnd` is beyond the five events you asked for. It lets the office remove agents promptly when you `/exit`.

### Event payload (`POST /events`)

```json
{
  "repo": "api",
  "sessionId": "5f2c…",
  "tmuxSession": "api-1",
  "type": "PreToolUse",
  "tool": "Bash",
  "command": "npm test",
  "message": null,
  "cwd": "/home/me/code/api",
  "timestamp": "2026-10-16T01:20:56.004Z"
}
```

- `repo`: `$AGENT_OFFICE_REPO` (set by the server on launch), otherwise the basename of `cwd`
- `tmuxSession`: `$AGENT_OFFICE_SESSION` (set on launch), otherwise `tmux display-message -p '#S'` when inside tmux
- `command`: a one-line summary of the tool input (the Bash command, a file path, a grep pattern, a URL, …)
- `message`: the prompt text (UserPromptSubmit), the notification text (Notification), or the start source/end reason

`AGENT_OFFICE_URL` overrides where the hook posts.

## How state works

The server keeps everything in memory and rebuilds it from transcripts at startup. The agent id is the tmux session name, or the Claude session id when the agent is not in tmux.

| event | status | where |
| --- | --- | --- |
| launched, no events yet | `starting` | desk |
| `SessionStart` | `idle` | Waiting Room |
| `UserPromptSubmit`, `PreToolUse` | `working` (current task = tool + command) | desk |
| `Notification` | `needs input` (room glows red) | desk |
| `Stop` | `done` | Waiting Room |
| `SessionEnd` / tmux session gone | `offline` (removed after 2 min) | Waiting Room |

Every 3 s the server runs `tmux list-sessions`. A session named `<repo>-<n>` for a configured repo shows up even if it was started by hand. Agents whose tmux session has disappeared become `offline`. Each agent keeps its last 300 events. Restarting the server re-imports recent transcripts, and the poll picks up live tmux sessions again. If a transcript is truncated or rewritten, the watcher continues from its new end instead of re-reading it, so old events are never duplicated.

**Controllable vs read-only:** you can prompt or stop only agents the server runs (its own terminals, or live tmux sessions). Sessions started in a normal terminal are monitored read-only until you **Take over**.

## Using the UI

- **Navbar:** pick an agent to see the exact tool/command it is running. Type a prompt and press **Send** (controllable agents only). **+ New agent** starts `claude` as `<repo>-<n>` in the repo directory.
- **Settings (⚙, top right):** choose which projects are shown, e.g. only those inside `D:\Work`, plus a tick per project; the badge counts hidden projects. It's a display filter saved in your browser: hidden agents keep running.
- **Confirmations** (Take over, Stop/Remove, the high-usage warning, errors) use in-app dialogs that explain what will happen; Enter confirms, Esc cancels.
- **Sidebar:** agents grouped by repo, with status, current task and last activity. Repos with a busy agent come first; within a repo, agents are listed in `#n` order.
- **Layout:** rooms with a busy agent are always shown first; your arrangement applies within that. Drag a room by its header to reorder it, and drag its bottom-right corner to resize it (1 to 3 columns × 1 to 3 rows, snapped to the grid). **Reset layout** restores the default. The layout is saved in your browser. Drag the log panel's left edge to resize the panel (double-click resets).
- **Office:** click an avatar (or a sidebar row) to open its **live event log**. For controllable agents, the **Terminal** tab is the real terminal: answer permission prompts, run `/compact`, and so on. For read-only ones, **▶ Take over** is in its place. **Stop** ends claude.


## API

| method | path | body |
| --- | --- | --- |
| `POST` | `/events` | hook payload above |
| `POST` | `/usage` | `{ sessionId, model, contextPercent, fiveHour, sevenDay }` from the status line |
| `GET` | `/api/state` | full snapshot |
| `GET` | `/api/sessions` | raw `tmux list-sessions` |
| `POST` | `/api/agents` | `{ "repo": "api" }`: launch |
| `POST` | `/api/agents/:id/takeover` | resume a read-only session in a server terminal |
| `POST` | `/api/agents/:id/prompt` | `{ "text": "…" }` |
| `GET` | `/api/agents/:id/screen` | tmux pane text (tmux runner) |
| `POST` | `/api/agents/:id/kill` | stop claude and forget agent |
| `WS` | `/ws` | `snapshot`, then `agent` / `event` / `agentRemoved` / `repos` / `usage` messages |
| `WS` | `/pty?id=…` | terminal stream: server sends output; client sends `{type:"input",data}` / `{type:"resize",cols,rows}` |

## Security

Agent Office has no login: it is for you, on your machine. **Never expose it beyond localhost** (no public server, tunnel or port forwarding): anyone who reaches it can type into your Claude sessions. To keep it that way:

- **Loopback only.** The server listens on `127.0.0.1` and isn't reachable from the network.
- **Only pages on this computer can talk to it.** Every request and WebSocket connection must have a loopback `Host` (`localhost`, `127.0.0.1`, `[::1]`), and a browser `Origin`, when present, must be loopback too. Anything else gets **403** and is logged as `[security] refused …`. This stops a website open in your browser from typing into an agent's terminal (browsers don't apply CORS to WebSockets) or calling Stop/Take over, including via DNS rebinding. Hooks, the status line and scripts send no `Origin`, so they keep working.
- **Local processes are trusted.** Any program running on your computer can still use the API; don't expose port 4317 (e.g. with a tunnel or port forwarding).

## License

MIT, see [LICENSE](LICENSE).

## Layout

```
host/agent-host.mjs         one detached process per agent: owns its terminal, survives server restarts
hooks/send-event.mjs        hook → POST /events
hooks/statusline.mjs        status line → POST /usage (limits + context %)
hooks/settings.snippet.json example settings
scripts/install-statusline.mjs  add the status line to ~/.claude/settings.json
scripts/install-hooks.mjs   merge hooks into repos' .claude settings
src/shared/types.ts         types shared by server and client
src/server/                 Express + ws, in-memory store, pty + tmux runners, transcript + live-session watchers
src/client/                 React UI (Navbar, Sidebar, Office, Avatar, LogPanel, LiveTerminal, UsagePanel)
```
