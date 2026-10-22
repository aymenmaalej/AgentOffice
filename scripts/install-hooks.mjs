#!/usr/bin/env node
// Installs Agent Office hooks into one or more repos.
//
//   node scripts/install-hooks.mjs                    # every repo in agent-office.config.json
//   node scripts/install-hooks.mjs ~/code/a ~/code/b  # explicit repo paths
//   node scripts/install-hooks.mjs --shared ...       # write .claude/settings.json instead of settings.local.json
//   node scripts/install-hooks.mjs --uninstall ...    # remove the hooks again
//   node scripts/install-hooks.mjs --print            # just print the settings snippet
//
// Existing settings and other hooks are preserved; running it twice is harmless.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse']);
const MARKER = 'send-event.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(here, '..', 'hooks', MARKER).replace(/\\/g, '/');
const command = `node "${hookScript}"`;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
let repos = args.filter((a) => !a.startsWith('--'));

function snippet() {
  const hooks = {};
  for (const ev of EVENTS) {
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (TOOL_EVENTS.has(ev)) entry.matcher = '*';
    hooks[ev] = [entry];
  }
  return { hooks };
}

if (flags.has('--print')) {
  console.log(JSON.stringify(snippet(), null, 2));
  process.exit(0);
}

if (repos.length === 0) {
  const cfgPath = path.resolve(here, '..', 'agent-office.config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('No repo paths given and agent-office.config.json not found.');
    process.exit(1);
  }
  repos = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).repos.map((r) => r.path);
}

const fileName = flags.has('--shared') ? 'settings.json' : 'settings.local.json';
const isOurs = (entry) => entry?.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(MARKER));

for (const repo of repos) {
  const dir = path.resolve(repo.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~'));
  if (!fs.existsSync(dir)) {
    console.warn(`skip  ${dir} (does not exist)`);
    continue;
  }
  const file = path.join(dir, '.claude', fileName);
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  settings.hooks ??= {};

  for (const ev of EVENTS) {
    const kept = (settings.hooks[ev] ?? []).filter((e) => !isOurs(e));
    if (!flags.has('--uninstall')) kept.push(snippet().hooks[ev][0]);
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${flags.has('--uninstall') ? 'removed' : 'ok   '} ${file}`);
}
