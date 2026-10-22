#!/usr/bin/env node
// Installs the Agent Office status line in your *user* Claude Code settings (~/.claude/settings.json),
// so every session reports usage limits and context fill. Usage limits are account-wide, so user level
// is the right scope.
//
//   node scripts/install-statusline.mjs              # install (refuses to replace a different status line)
//   node scripts/install-statusline.mjs --force      # replace an existing status line
//   node scripts/install-statusline.mjs --uninstall  # remove ours
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'statusline.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'hooks', MARKER).replace(/\\/g, '/');
const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
const flags = new Set(process.argv.slice(2));

const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const existing = settings.statusLine;
const ours = typeof existing?.command === 'string' && existing.command.includes(MARKER);

if (flags.has('--uninstall')) {
  if (!ours) {
    console.log('Agent Office status line is not installed; nothing to do.');
    process.exit(0);
  }
  delete settings.statusLine;
} else {
  if (existing && !ours && !flags.has('--force')) {
    console.error(`You already have a status line:\n  ${JSON.stringify(existing)}\nRe-run with --force to replace it.`);
    process.exit(1);
  }
  settings.statusLine = { type: 'command', command: `node "${script}"`, padding: 0 };
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(`${flags.has('--uninstall') ? 'removed from' : 'installed in'} ${file}`);
