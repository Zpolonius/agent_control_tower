#!/usr/bin/env node
'use strict';
// Sikrer at node-pty's spawn-helper har eksekveringsrettigheder på macOS.
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const prebuildsDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (!fs.existsSync(prebuildsDir)) process.exit(0);

for (const entry of fs.readdirSync(prebuildsDir)) {
  if (!entry.startsWith('darwin-')) continue;
  const helper = path.join(prebuildsDir, entry, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
