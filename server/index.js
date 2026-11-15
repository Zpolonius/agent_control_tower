#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cfg = require('./config');
const { newToken } = require('./security');
const { createApp } = require('./app');

const CONFIG_FILE = process.env.CONTROL_TOWER_CONFIG || path.join(__dirname, '..', 'control-tower.config.json');
const HELP = `Control Tower

  npm start -- "/sti/til/projektmappe"   første gang, eller for at skifte mappe
  npm start                              derefter

  --no-open   åbn ikke browseren automatisk
  --help      vis denne hjælp
`;

// Læser kommandolinjen. Ukendte tilvalg er en fejl, så en tastefejl ikke bare bliver ignoreret.
function parseArgs(argv) {
  const out = { noOpen: false, help: false, root: null, error: null };
  let onlyPaths = false;
  for (const a of argv) {
    if (!onlyPaths && a === '--') onlyPaths = true;
    else if (!onlyPaths && a === '--no-open') out.noOpen = true;
    else if (!onlyPaths && (a === '--help' || a === '-h')) out.help = true;
    else if (!onlyPaths && a.startsWith('-')) out.error = `Ukendt tilvalg: ${a}`;
    else if (out.root) out.error = 'Angiv kun én mappe.';
    else out.root = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.error) { console.error(`${args.error}\n\n${HELP}`); process.exit(1); }
  const noOpen = args.noOpen;
  let { config, existed, raw } = cfg.load(CONFIG_FILE);

  if (args.root) {
    const root = cfg.expand(args.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`Mappen findes ikke: ${root}`);
      process.exit(1);
    }
    // Kun rodmappen ændres. Dine øvrige indstillinger (agenter, port m.m.) bliver stående.
    raw = cfg.save(CONFIG_FILE, existed ? raw : cfg.DEFAULTS, { root });
    config = cfg.clean(raw);
    console.log(`${existed ? 'Opdaterede' : 'Oprettede'} indstillinger i ${CONFIG_FILE}`);
  }
  if (!config.root) {
    console.error('Fortæl Control Tower hvor dine repos ligger, første gang du starter:\n\n  npm start -- "/sti/til/din/projektmappe"\n');
    process.exit(1);
  }
  if (!fs.existsSync(config.root) || !fs.statSync(config.root).isDirectory()) {
    console.error(`Rodmappen fra indstillingerne findes ikke (eller er ikke en mappe): ${config.root}`);
    process.exit(1);
  }

  const token = newToken();
  const app = createApp({ config, token });
  app.server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${config.port} er optaget. Kører Control Tower allerede? Ellers ret "port" i ${CONFIG_FILE}.`
      : `Serveren kunne ikke starte: ${err.message}`);
    process.exit(1);
  });
  // 127.0.0.1 = kun denne maskine. Andre enheder på netværket kan ikke nå serveren.
  app.server.listen(config.port, '127.0.0.1', () => {
    // Nøglen står efter #, og den del af en adresse sendes aldrig til en server – kun siden selv kan læse den.
    const url = `http://127.0.0.1:${config.port}/#token=${token}`;
    console.log(`\n  Control Tower kører\n  Rodmappe: ${config.root}\n\n  Åbn: ${url}\n\n  Stop med Ctrl+C (alle terminaler lukkes).\n`);
    if (!noOpen) {
      const [cmd, a] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
      try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* åbn linket selv */ }
    }
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.close().then(() => process.exit(0));
    setTimeout(() => { app.sessions.forceAll(); process.exit(0); }, 4000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

try {
  main();
} catch (err) {
  // Vis en klar besked i stedet for en lang teknisk fejludskrift.
  console.error(err.message);
  process.exit(1);
}
