// Simuleret kodeagent til test/status.test.js. Tegner som Claude Code ("claude") eller Codex ("codex"):
// rammer, spinnere der overskrives, godkendelses-menuer, baggrundsarbejde, kvote, nedbrud. Kommandoen skrives i feltet.
const flavor = process.argv[2] || 'claude';
const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SP = '✻✶✳✢';
async function spin(ms, label = 'Thinking') { const end = Date.now() + ms; let i = 0; while (Date.now() < end) { out(`\r\x1b[2K\x1b[38;5;214m${SP[i++ % 4]}\x1b[39m ${label}… \x1b[2m(${i}s · esc to interrupt)\x1b[22m`); await sleep(250); } out('\r\x1b[2K'); }
let typed = '';
const promptBox = () => { typed = ''; if (flavor === 'codex') out('\r\n› Ask Codex to do anything\r\n'); else out('\r\n\x1b[2m╭────────────╮\x1b[22m\r\n│ > │\r\n╰────────────╯\r\n  ? for shortcuts\r\n'); };
const done = (ms) => { if (flavor !== 'codex') out(`\x1b[38;5;214m✻\x1b[39m Worked for ${Math.round(ms / 1000)}s\r\n`); promptBox(); };
let waiter = null;
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (waiter && waiter.key) { const w = waiter; waiter = null; return w.res(d); }
  for (const ch of d) {
    if (ch === '\r') { const line = typed; typed = ''; if (waiter) { const w = waiter; waiter = null; w.res(line); } continue; }
    if (ch === '\x15') { typed = ''; } else if (ch === '\x7f') typed = typed.slice(0, -1); else typed += ch;
    if (flavor === 'codex') out(`\r\x1b[2K› ${typed}`); else out(`\x1b[3A\r\x1b[2K│ > ${typed}│\x1b[3B\r`);
  }
});
const line = () => new Promise((res) => { waiter = { res }; });
const key = () => new Promise((res) => { waiter = { res, key: true }; });
(async () => {
  out(flavor === 'codex' ? '>_ Fake Codex (research preview)\r\n' : 'Welcome to Fake Claude Code!\r\n');
  promptBox();
  for (;;) {
    const cmd = (await line()).trim();
    const t0 = Date.now();
    if (cmd === 'q') { out('bye\r\n'); process.exit(0); }
    if (cmd === 'exit1') { await spin(1500); out('Error: build failed: cannot find module x\r\n'); process.exit(1); }
    if (cmd === 'crash') { await spin(2500); process.kill(process.pid, 'SIGKILL'); }
    if (cmd === 'approve') {
      await spin(3000);
      out('\r\n● Bash(npm test)\r\n\r\n Bash command\r\n   npm test\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again\r\n   3. No (esc)\r\n');
      { let k; do { k = await key(); } while (k !== '1'); } out('\r\n● Running npm test\r\n'); await spin(3000, 'Running'); out('● Done. 12 tests pass.\r\n'); done(Date.now() - t0); continue;
    }
    if (cmd === 'approvebg') { // approval while background spinner keeps redrawing
      await spin(2000);
      out('\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No (esc)\r\n');
      let answered = false; (async () => { let k; do { k = await key(); } while (k !== '1'); answered = true; })();
      let i = 0; while (!answered) { out(`\r\x1b[2K✶ 2 background tasks running… (${i++}s)`); await sleep(500); }
      out('\r\n'); await spin(2000); out('● ok\r\n'); done(Date.now() - t0); continue;
    }

    if (cmd.startsWith('appr') && cmd !== 'approve' && cmd !== 'approvebg') {
      const BOX = '\r\n╭──────────────────────────────╮\r\n│ Bash command │\r\n│   git push origin main │\r\n│ Do you want to proceed? │\r\n│ ❯ 1. Yes │\r\n│   2. Yes, and don\'t ask again for git push commands │\r\n│   3. No, and tell Claude what to do differently (esc) │\r\n╰──────────────────────────────╯\r\n';
      await spin(1500);
      if (cmd === 'apprdiff') out('\x1b[38;5;174m✶\x1b[39m Running… (1s · esc to interrupt)\r\n');
      out(BOX);
      let answered = false; (async () => { let k; do { k = await key(); } while (k !== '1'); answered = true; })();
      let i = 0;
      while (!answered && i < 40) {
        i++;
        if (cmd === 'apprlines') out(i === 8 ? '  ⎿  Tests: 12 passed, 12 total\r\n' : `  ⎿  PASS src/mod${i}.test.js (${i * 0.3}s)\r\n`);
        else if (cmd === 'apprspin') out(`\r\x1b[2K\x1b[38;5;174m✳\x1b[39m Running 2 agents… (${i}s · esc to interrupt)`);
        else if (cmd === 'apprdiff') out(`\x1b[10A\x1b[1G\x1b[2K\x1b[38;5;174m${SP[i % 4]}\x1b[39m Running… (${i}s · esc to interrupt)\x1b[10B\x1b[1G`);
        else if (cmd === 'apprsub') out(`\x1b[2K● Task(Run e2e suite)\r\n  ⎿  Bash(npx playwright test) · ${i} tool uses\r\n`);
        await sleep(600);
      }
      while (!answered) await sleep(200);
      out('\r\n'); await spin(1500); out('● Pushed.\r\n'); done(Date.now() - t0); continue;
    }
    if (cmd === 'devsrv') { await spin(1500); require('child_process').spawn('bash', ['-c', 'node -e "setInterval(()=>{},1000)" vite --port 5173; true'], { stdio: 'ignore' }); out('\r\n● Bash(npm run dev) running in background\r\n● Dev-serveren kører på http://localhost:5173. Opgaven er løst.\r\n'); done(Date.now() - t0); continue; }
    if (cmd === 'quota') { await spin(2000); out('\r\n● 5-hour limit reached ∙ resets 3pm\r\n  /upgrade to increase your usage limit.\r\n'); promptBox(); const l = await line(); await spin(2500); out(`● resumed: ${l}\r\n`); done(Date.now() - t0); continue; }
    if (cmd === 'bg') { await spin(2000); out('\r\n● Waiting for Android emulator to boot...\r\n'); await sleep(9000); out('● Emulator ready\r\n'); await spin(2000); out('● Done.\r\n'); done(Date.now() - t0); continue; }
    if (cmd === 'question') { await spin(2000); out('\r\n● Skal jeg committe og åbne en PR?\r\n'); done(Date.now() - t0); continue; }
    if (cmd === 'silent') { out('\r\n● Analyzing large repo\r\n'); await sleep(10000); await spin(1000); out('● Done.\r\n'); done(Date.now() - t0); continue; }
    if (cmd === 'fpstream') { for (let i = 0; i < 24; i++) { out(i === 2 ? 'Create new file src/upload.js\r\n' : i === 12 ? 'Handle 429: rate limit exceeded → retry\r\n' : `edit step ${i}: updated src/file${i}.js\r\n`); await sleep(350); } out('● Done.\r\n'); done(Date.now() - t0); continue; }
    if (cmd === 'fpdone') { await spin(1500); out('\r\n● I added a "Create new file" button and handled the "rate limit exceeded" error.\r\n'); done(Date.now() - t0); continue; }
    await spin(2500); out(`\r\n● Done with: ${cmd}\r\n`); done(Date.now() - t0);
  }
})();
