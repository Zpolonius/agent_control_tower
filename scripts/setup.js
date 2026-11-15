#!/usr/bin/env node
'use strict';
// Opretter skrivebords- og systemgenveje til Control Tower på Windows eller macOS.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');

if (process.platform === 'win32') {
  const script = path.join(__dirname, 'install-windows.ps1');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: 'inherit',
  });
  process.exit(res.status ?? 1);
}

if (process.platform === 'darwin') {
  for (const rel of [
    'scripts/install-mac.sh',
    'scripts/mac-helper.sh',
    'Start Control Tower.command',
    'Opret app (Mac).command',
  ]) {
    const file = path.join(rootDir, rel);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }
  const script = path.join(__dirname, 'install-mac.sh');
  const res = spawnSync('bash', [script], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

console.log('Automatisk genvej understøttes i øjeblikket på Windows og macOS.');
console.log('På Linux kan du starte Control Tower med: npm start');
process.exit(0);
