'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cfg = require('../server/config');
const { createApp } = require('../server/app');
const { createWaitChecker, inspectProcessTree, inspectBuffer, hasApprovalPrompt, inspectQuota, isTaskDone, sanitizeDetail } = require('../server/wait-check');
const { createSessions, lastLine } = require('../server/sessions');

test('inspectProcessTree: ignorerer hovedagent, konsol-hjælpere, MCP og sleep', () => {
  const procs = [
    { pid: 100, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo -Command "claude; exit $LASTEXITCODE"' },
    { pid: 101, ppid: 100, name: 'conhost.exe', cmd: '\\??\\C:\\Windows\\system32\\conhost.exe 0x4' },
    { pid: 102, ppid: 100, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c claude.cmd' },
    { pid: 103, ppid: 102, name: 'node.exe', cmd: 'node.exe "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"' },
    { pid: 104, ppid: 103, name: 'node.exe', cmd: 'node.exe C:\\tools\\mcp-server.js --mcp' },
    { pid: 105, ppid: 103, name: 'bash.exe', cmd: 'bash.exe' }, // tom interaktiv skal uden børn
    { pid: 106, ppid: 100, name: 'sleep', cmd: 'sleep 0.2' },
  ];
  assert.equal(inspectProcessTree(100, procs), null);

  // OpenAI Codex CLI via npm node-wrapper -> native codex.exe må ikke ligne en subagent
  const codexWrapped = [
    { pid: 100, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo -Command "codex; exit $LASTEXITCODE"' },
    { pid: 101, ppid: 100, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c codex.cmd' },
    { pid: 102, ppid: 101, name: 'node.exe', cmd: 'node.exe "C:\\Users\\u\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"' },
    { pid: 103, ppid: 102, name: 'codex.exe', cmd: 'codex.exe' },
  ];
  assert.equal(inspectProcessTree(100, codexWrapped), null);
  assert.equal(inspectProcessTree(100, [
    ...codexWrapped,
    { pid: 200, ppid: 103, name: 'codex.exe', cmd: 'codex.exe exec "audit tests"' },
  ]).waitingFor, 'subagenter');
});

test('inspectProcessTree: genkender subagenter, e2e-tests, tests, emulator, build og generiske kommandoer', () => {
  const base = [
    { pid: 100, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo -Command "claude"' },
    { pid: 102, ppid: 100, name: 'claude.exe', cmd: 'claude.exe' },
  ];

  const sub = inspectProcessTree(100, [
    ...base,
    { pid: 200, ppid: 102, name: 'claude.exe', cmd: 'claude.exe -p "check auth"' },
  ]);
  assert.equal(sub.waitingFor, 'subagenter');

  const e2e = inspectProcessTree(100, [
    ...base,
    { pid: 200, ppid: 102, name: 'powershell.exe', cmd: 'powershell.exe -Command "npx playwright test"' },
    { pid: 201, ppid: 200, name: 'node.exe', cmd: 'node.exe node_modules/.bin/playwright test' },
  ]);
  assert.equal(e2e.waitingFor, 'e2e-tests');

  const unit = inspectProcessTree(100, [
    ...base,
    { pid: 200, ppid: 102, name: 'bash', cmd: 'bash -c "flutter test"' },
    { pid: 201, ppid: 200, name: 'flutter_tester', cmd: 'flutter_tester --run' },
  ]);
  assert.equal(unit.waitingFor, 'tests');

  const emu = inspectProcessTree(100, [
    ...base,
    { pid: 200, ppid: 102, name: 'emulator.exe', cmd: 'emulator.exe -avd Pixel_8_API_34' },
  ]);
  assert.equal(emu.waitingFor, 'emulator');

  const bld = inspectProcessTree(100, [
    ...base,
    { pid: 200, ppid: 102, name: 'java.exe', cmd: 'java.exe -jar gradle-wrapper.jar assembleDebug' },
  ]);
  assert.equal(bld.waitingFor, 'build');

  const custom = inspectProcessTree(100, [
    ...base,
    { pid: 200, ppid: 102, name: 'python.exe', cmd: 'python.exe scripts/migrate.py --token=secret123' },
  ]);
  assert.equal(custom.waitingFor, 'kommando');
  assert.doesNotMatch(custom.detail, /secret123/);
});

test('inspectBuffer: skelner mellem aktiv venten og bruger-prompts', () => {
  // Claude Code med kørende subagenter og persistent prompt-linje nedenunder
  const claudeSubagents = [
    '\x1b[32m●\x1b[0m 3 Agent tools running…',
    '  ├─ Agent(Audit auth) · Running…',
    '  └─ Agent(Check DB) · Running…',
    '──────────────────────────',
    '❯ ',
    '? for shortcuts · esc to interrupt',
  ].join('\r\n');
  assert.equal(inspectBuffer(claudeSubagents).waitingFor, 'subagenter');

  // Farvekoder midt i linjen må ikke splitte teksten
  assert.equal(inspectBuffer('\x1b[33m⠋\x1b[0m Running \x1b[1mflutter test\x1b[0m').waitingFor, 'tests');

  // Playwright e2e tests der kører stille
  assert.equal(inspectBuffer('Running e2e tests with Playwright...\r\n[1/8] chromium › checkout.spec.ts').waitingFor, 'e2e-tests');

  // Emulator der starter
  assert.equal(inspectBuffer('Waiting for Android emulator to boot...\r\n').waitingFor, 'emulator');

  // Generisk spinner / interrupt uden specifikt nøgleord
  assert.equal(inspectBuffer('✻ Thinking…\r\nesc to interrupt').waitingFor, 'baggrundsopgave');

  // Gamle tests der er afsluttet efterfulgt af tom prompt -> venter på brugeren!
  const finishedTests = [
    'Running playwright e2e tests...',
    '  12 passed (14s)',
    'All tests passed.',
    '❯ ',
    '? for shortcuts',
  ].join('\r\n');
  assert.equal(inspectBuffer(finishedTests), null);

  // Godkendelses-prompt før kørsel af playwright -> venter på brugeren!
  const permissionPrompt = [
    'Bash command',
    '  npx playwright test',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No (esc)',
  ].join('\r\n');
  assert.equal(inspectBuffer(permissionPrompt), null);

  // Gemini / Antigravity CLI "Run this command?" med ●-ikon, testkommando og interrupt-linje -> venter på brugeren!
  const geminiRunPrompt = [
    '● Run command',
    'Run this command?',
    '  flutter test',
    '❯ Yes',
    '  Always allow',
    '  No',
    'esc to interrupt',
  ].join('\r\n');
  assert.equal(inspectBuffer(geminiRunPrompt), null);

  // Gemini "Run this command?" i ramme med ConPTY cursor-forward (\x1b[1C) og lang flerlinje-kommando
  const geminiBoxedPrompt = [
    '╭────────────────────────────────────────╮',
    '│ Run\x1b[1Cthis\x1b[1Ccommand?                      │',
    '│   cd C:\\app                            │',
    '│   git fetch origin                     │',
    '│   npm run build                        │',
    '│   npm test                             │',
    '│   --reporter=dot                       │',
    '│   --timeout=5000                       │',
    '│   [Run]  [Cancel]                      │',
    '╰────────────────────────────────────────╯',
    'esc to interrupt',
  ].join('\r\n');
  assert.equal(inspectBuffer(geminiBoxedPrompt), null);

  // Enkeltstående "Proceed?" med aktiv interrupt-linje -> venter på brugeren!
  assert.equal(inspectBuffer('Proceed?\r\nesc to interrupt'), null);

  // OpenAI Codex CLI: struktureret spørgsmål (request_user_input), Approve and run og placeholder-prompt
  const codexQuestion = [
    'Question 1/2',
    'Which test runner should we use?',
    '› 1. Vitest (Recommended)',
    '  2. Jest',
    '  3. Type your own answer',
    'esc to dismiss',
    'Working (12s • esc to interrupt)',
  ].join('\r\n');
  assert.equal(inspectBuffer(codexQuestion), null);
  assert.equal(inspectBuffer('Approve and run\r\n  npm test\r\nesc to interrupt'), null);
  assert.equal(inspectBuffer('● Finished updating tests.\r\n› Ask Codex to do anything'), null);

  // Claude Code: afsluttet svar med ●-prik + tomt prompt + shift+tab-statuslinje -> venter på brugeren!
  const claudeFinished = [
    '● I fixed the docker build pipeline and verified everything.',
    '──────────────────────────',
    '❯ ',
    '──────────────────────────',
    '⏵⏵ accept edits on (shift+tab to cycle) · 42% context left',
  ].join('\r\n');
  assert.equal(inspectBuffer(claudeFinished), null);

  // Aider: (Y)es/(N)o-prompts med [Yes]: -> venter på brugeren!
  assert.equal(inspectBuffer('pytest\r\nRun shell command? (Y)es/(N)o/(D)on\'t ask again [Yes]:'), null);
  assert.equal(inspectBuffer('Add server/app.js to the chat? (Y)es/(N)o [Yes]:'), null);

  // Gemini CLI / OpenCode: MCP-godkendelse, mappe-tillid og placeholder-input
  assert.equal(inspectBuffer('Allow MCP tool github/list_issues?\r\nesc to interrupt'), null);
  assert.equal(inspectBuffer('Do you trust this folder?\r\n● Yes\r\nesc to interrupt'), null);
  assert.equal(inspectBuffer('● Ready.\r\n> Type your message or @path/to/file'), null);

  // Et gammelt godkendelses-prompt højere oppe må ikke skjule en ny aktiv spinner nedenunder
  const spinnerAfterOldPrompt = [
    'Run this command?',
    '  npm test',
    '  line 2',
    '  line 3',
    '  line 4',
    '  line 5',
    '  line 6',
    '  line 7',
    '⠋ Running npm test…',
    'esc to interrupt',
  ].join('\r\n');
  assert.equal(inspectBuffer(spinnerAfterOldPrompt).waitingFor, 'tests');

  // Spørgsmål til brugeren -> venter på brugeren!
  assert.equal(inspectBuffer('Skal jeg køre e2e tests med Playwright nu?'), null);
  assert.equal(inspectBuffer('Waiting for user input before running flutter test'), null);
  assert.equal(inspectBuffer('I finished building the feature.\r\n> '), null);

  // Afsluttet Claude Code-tur ("✻ Sautéed for 45s · done 4:19 PM") + plan med flutter test + spørgsmål -> venter på brugeren!
  const claudeFinishedPlan = [
    'Til sidst kører jeg flutter analyze og flutter test. firestore.rules skal efter planen ikke ændres.',
    'Skal jeg gå i gang, eller vil du hellere have en bekræftelsesdialog ("Erstat Lasagne?")?',
    '✻ Sautéed for 45s · done 4:19 PM',
    '──────────────────────────',
    '❯ ',
    '──────────────────────────',
    '  ? for shortcuts',
  ].join('\r\n');
  assert.equal(inspectBuffer(claudeFinishedPlan), null);

  // Afsluttet Claude Code-tur med bullet (●) eller uden spørgsmål og med mode-linje -> venter på brugeren!
  const claudeFinishedBullet = [
    '● Jeg har opdateret filen og er klar til næste skridt.',
    '* Brewed for 1m 23s',
    '──────────────────────────',
    '❯ ',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\r\n');
  assert.equal(inspectBuffer(claudeFinishedBullet), null);

  // Aktiv "? for shortcuts · esc to interrupt" må IKKE blive filtreret væk som ren footer
  const claudeSilentWork = [
    '● Bash(git\x1b[1Cstatus)',
    '──────────────────────────',
    '❯ ',
    '? for shortcuts · esc to interrupt',
  ].join('\r\n');
  assert.equal(inspectBuffer(claudeSilentWork).waitingFor, 'baggrundsopgave');

  // Gammel spinner / esc to interrupt fra forrige redraw må ikke overtrumfe ny afsluttet tur
  const claudeStaleInterruptBeforeDone = [
    '✻ Churning…',
    '  ▸▸ auto mode on (shift+tab to cycle) · esc to interrupt',
    '● PR\'en er oprettet: https://github.com/Zpolonius/Skafferiet/pull/71',
    '✻ Churned for 25s · done 4:33 PM',
    '──────────────────────────',
    '❯ ',
    '──────────────────────────',
    '  ▸▸ auto mode on (shift+tab to cycle) · PR #71',
  ].join('\r\n');
  assert.equal(inspectBuffer(claudeStaleInterruptBeforeDone), null);
});

test('isTaskDone: skelner mellem helt færdig opgave og svar/afventer bruger', () => {
  const finishedPlanWithQuestion = [
    'Skal jeg gå i gang, eller vil du hellere have en bekræftelsesdialog ("Erstat Lasagne?")?',
    '✻ Sautéed for 45s · done 4:19 PM',
    '❯ ',
  ].join('\r\n');
  assert.equal(isTaskDone(finishedPlanWithQuestion), false);

  const commitQuestion = [
    'Skal jeg committe og åbne en PR mod main?',
    '✻ Cogitated for 10m 54s · done 4:32 PM',
    '❯ ',
  ].join('\r\n');
  assert.equal(isTaskDone(commitQuestion, { hadInput: true }), false);

  const prDone = [
    '● PR\'en er oprettet: https://github.com/Zpolonius/Skafferiet/pull/71',
    'Den indeholder ét commit på claude/issue-44.',
    '✻ Churned for 25s · done 4:33 PM',
    '──────────────────────────',
    '❯ ',
    '  ▸▸ auto mode on (shift+tab to cycle) · PR #71',
  ].join('\r\n');
  assert.equal(isTaskDone(prDone), true);
  assert.equal(isTaskDone(prDone, { hadInput: true }), true);

  assert.equal(isTaskDone('Welcome to Claude Code\r\n❯ ', { hadInput: false }), false);
  assert.equal(isTaskDone('Opgaven er løst.\r\n> ', { hadInput: false }), false);
  assert.equal(isTaskDone('Opgaven er løst.\r\n> ', { hadInput: true }), true);
  assert.equal(isTaskDone('Request interrupted by user\r\n❯ ', { hadInput: true }), false);
  assert.equal(isTaskDone('Running tests...\r\nAll tests passed.\r\n❯ '), true);
});

test('sanitizeDetail: skjuler tokens og hemmeligheder', () => {
  const s = sanitizeDetail('API_KEY=abc123 python run.py --token=xyz999');
  assert.doesNotMatch(s, /abc123|xyz999/);
  assert.match(s, /\[skjult\]/);
});

test('createWaitChecker: cacher også tomme/fejlende opslag kortvarigt', async () => {
  let calls = 0;
  const checker = createWaitChecker({
    query: async () => { calls += 1; return null; },
  });
  const s = { proc: { pid: 1234 }, buffer: 'Waiting for emulator…', waitState: null };
  await checker.checkAll([s]);
  await checker.checkAll([s]);
  assert.equal(calls, 1);
  assert.equal(s.waitState.waitingFor, 'emulator');
});

test('hasApprovalPrompt & createWaitChecker: godkendelse vinder over kørende baggrundsprocesser og status-gentegninger', async () => {
  // Claude Code godkendelse mens subagenter / baggrundstasks kører og statuslinjen tikker
  const approvalWithBgTicks = [
    '● 2 Agent tools running…',
    '  ├─ Agent(Audit auth) · Running…',
    '  └─ Agent(Check DB) · Running…',
    'Bash command',
    '  git push origin main',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and don\'t ask again for git push commands',
    '  3. No',
    '  4. Type here to tell Claude what to do differently',
    ...Array.from({ length: 18 }, (_, i) => `\x1b[28;1H  2 background tasks · ${10 + i}s · esc to interrupt\r\n  ? for shortcuts · esc to interrupt`),
  ].join('\r\n');
  assert.equal(hasApprovalPrompt(approvalWithBgTicks), true);
  assert.equal(inspectBuffer(approvalWithBgTicks), null);

  // Gemini / Codex godkendelse med baggrundsstatus
  const geminiWithBg = [
    '● Run command',
    'Run this command?',
    '  npm run migrate',
    '❯ Yes, allow once',
    '  Always allow',
    '  No (esc)',
    '2 background tasks running · esc to interrupt',
  ].join('\r\n');
  assert.equal(hasApprovalPrompt(geminiWithBg), true);
  assert.equal(inspectBuffer(geminiWithBg), null);

  const codexWithBg = [
    'Approve and run',
    '  npm test',
    '› 1. Yes, proceed',
    '  2. No',
    'esc to dismiss',
    'Working (12s • esc to interrupt)',
  ].join('\r\n');
  assert.equal(hasApprovalPrompt(codexWithBg), true);
  assert.equal(inspectBuffer(codexWithBg), null);

  // Gammel godkendelse efterfulgt af en aktiv ikke-baggrunds spinner -> tilbage til tests!
  const spinnerAfterOldPrompt = [
    'Run this command?',
    '  npm test',
    '  line 2',
    '  line 3',
    '  line 4',
    '  line 5',
    '  line 6',
    '  line 7',
    '⠋ Running npm test…',
    'esc to interrupt',
  ].join('\r\n');
  assert.equal(hasApprovalPrompt(spinnerAfterOldPrompt), false);
  assert.equal(inspectBuffer(spinnerAfterOldPrompt).waitingFor, 'tests');

  // createWaitChecker: selv med kørende baggrundsproces i procestræet må godkendelse give waitState = null
  const procs = [
    { pid: 100, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo -Command "claude"' },
    { pid: 102, ppid: 100, name: 'claude.exe', cmd: 'claude.exe' },
    { pid: 200, ppid: 102, name: 'node.exe', cmd: 'node.exe server.js' },
    { pid: 201, ppid: 200, name: 'vite', cmd: 'vite --port 5173' },
  ];
  const checker = createWaitChecker({ query: async () => procs });
  const s = { proc: { pid: 100 }, buffer: approvalWithBgTicks, waitState: { waitingFor: 'server', source: 'process' } };
  await checker.checkAll([s]);
  assert.equal(s.waitState, null);
  assert.equal(checker.checkSync(s), null);

  // Når godkendelsen er besvaret og væk, slår baggrundsprocessen igennem igen
  s.buffer = '✻ Working…\r\nesc to interrupt';
  await checker.checkAll([s]);
  assert.equal(s.waitState.waitingFor, 'server');
});

test('sessions integration: agent der mangler godkendelse går til venter trods løbende baggrundsoutput', async () => {
  const ss = createSessions({ idleSeconds: 5, maxSessions: 4 });
  const bgApproval = ss.create({
    repo: 'test',
    cwd: os.tmpdir(),
    kind: 'agent',
    // Skriver godkendelses-prompt og fortsætter med at gentegne baggrundsstatus hvert 250ms (under idleSeconds = 5s)
    agent: {
      id: 'bg-app',
      name: 'BgApp',
      command: 'node -e "console.log(\'Do you want to proceed?\\n❯ 1. Yes\\n  2. No\'); let i=0; setInterval(()=>process.stdout.write(\'\\x1b[20;1H2 background tasks · \'+(++i)+\'s · esc to interrupt\\n\'), 250)"',
    },
  });

  try {
    let view = null;
    const end = Date.now() + 4500;
    while (Date.now() < end) {
      await ss.refreshWaits();
      view = ss.list().find((x) => x.id === bgApproval.id);
      if (view && view.status === 'venter' && view.needsApproval) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(view.status, 'venter');
    assert.equal(view.needsApproval, true);
    assert.equal(view.waitingFor, null);

    // Når brugeren godkender med Enter, ryddes godkendelses-status med det samme
    const client = ss.attach(bgApproval.id, { onData() {}, onExit() {} });
    client.write('\r');
    const afterReply = ss.list().find((x) => x.id === bgApproval.id);
    assert.equal(afterReply.needsApproval, false);
    assert.equal(afterReply.status, 'arbejder');
    client.detach();
  } finally {
    ss.forceAll();
    await new Promise((r) => setTimeout(r, 200));
  }
});

test('API /api/state: returnerer venter + needsApproval når agent har baggrundsproces og kræver godkendelse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wait-approval-api-'));
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const token = 'c'.repeat(64);
  const config = cfg.clean({
    root: dir,
    port: 4318,
    idleSeconds: 2,
    maxSessions: 2,
    agents: [{
      id: 'bg-approve',
      name: 'BgApprove',
      command: 'node -e "const { spawn } = require(\'node:child_process\'); spawn(process.execPath, [\'-e\', \'setInterval(()=>{}, 1000)\']); console.log(\'Run this command?\\n  npm test\\n❯ Yes\\n  No\\nesc to interrupt\'); setInterval(()=>{}, 1000)"',
    }],
  });
  const app = createApp({ config, token });
  const dispatch = (method, url, body) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1:4318',
      authorization: `Bearer ${token}`,
      origin: 'http://127.0.0.1:4318',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end(chunk) { resolve({ status: this.statusCode, json: JSON.parse(String(chunk || '{}')) }); },
    };
    app.server.emit('request', req, res);
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });

  try {
    const created = await dispatch('POST', '/api/sessions', { repo: 'demo', kind: 'agent', agentId: 'bg-approve' });
    assert.equal(created.status, 201);
    const id = created.json.id;
    let found = null;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const st = await dispatch('GET', '/api/state');
      found = st.json.sessions.find((s) => s.id === id);
      if (found && found.status === 'venter' && found.needsApproval) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(found.status, 'venter');
    assert.equal(found.needsApproval, true);
    assert.equal(found.waitingFor, null);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions integration: skifter til afventer ved aktiv venten og venter ved spørgsmål', async () => {
  const ss = createSessions({ idleSeconds: 0.4, maxSessions: 4 });
  const emu = ss.create({
    repo: 'test',
    cwd: os.tmpdir(),
    kind: 'agent',
    agent: { id: 'emu', name: 'Emu', command: 'node -e "console.log(\'Waiting for Android emulator...\'); setInterval(()=>{}, 1000)"' },
  });
  const ask = ss.create({
    repo: 'test',
    cwd: os.tmpdir(),
    kind: 'agent',
    agent: { id: 'ask', name: 'Ask', command: 'node -e "console.log(\'Hvad skal jeg gøre?\'); setInterval(()=>{}, 1000)"' },
  });
  const done = ss.create({
    repo: 'test',
    cwd: os.tmpdir(),
    kind: 'agent',
    agent: { id: 'done', name: 'Done', command: 'node -e "console.log(\'PR oprettet.\\n✻ Churned for 25s · done 4:33 PM\\n❯ \'); setInterval(()=>{}, 1000)"' },
  });

  try {
    const end = Date.now() + 5000;
    let list = [];
    while (Date.now() < end) {
      await ss.refreshWaits();
      list = ss.list();
      const e = list.find((x) => x.id === emu.id);
      const a = list.find((x) => x.id === ask.id);
      const d = list.find((x) => x.id === done.id);
      if (e.status === 'afventer' && a.status === 'venter' && d.status === 'faerdig') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const eView = list.find((x) => x.id === emu.id);
    const aView = list.find((x) => x.id === ask.id);
    const dView = list.find((x) => x.id === done.id);
    assert.equal(eView.status, 'afventer');
    assert.equal(eView.waitingFor, 'emulator');
    assert.equal(aView.status, 'venter');
    assert.equal(aView.waitingFor, null);
    assert.equal(dView.status, 'faerdig');
    assert.equal(dView.waitingFor, null);
  } finally {
    ss.forceAll();
    await new Promise((r) => setTimeout(r, 200));
  }
});

test('API /api/state: returnerer afventer + waitingFor for stille agent med e2e-tests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wait-api-'));
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const token = 'b'.repeat(64);
  const config = cfg.clean({
    root: dir,
    port: 4317,
    idleSeconds: 2,
    maxSessions: 2,
    agents: [{ id: 'e2e', name: 'E2E', command: 'node -e "console.log(\'Running Playwright e2e tests...\'); setInterval(()=>{}, 1000)"' }],
  });
  const app = createApp({ config, token });
  const dispatch = (method, url, body) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1:4317',
      authorization: `Bearer ${token}`,
      origin: 'http://127.0.0.1:4317',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end(chunk) { resolve({ status: this.statusCode, json: JSON.parse(String(chunk || '{}')) }); },
    };
    app.server.emit('request', req, res);
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });

  try {
    const created = await dispatch('POST', '/api/sessions', { repo: 'demo', kind: 'agent', agentId: 'e2e' });
    assert.equal(created.status, 201);
    const id = created.json.id;
    let found = null;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const st = await dispatch('GET', '/api/state');
      found = st.json.sessions.find((s) => s.id === id);
      if (found && found.status === 'afventer') break;
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(found.status, 'afventer');
    assert.equal(found.waitingFor, 'e2e-tests');
    assert.match(found.waitingDetail, /Playwright/i);
    assert.ok(!('waitState' in found) && !('cwd' in found));
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectQuota & createWaitChecker: genkender quota reached og bevarer Resets-detalje', async () => {
  const quotaWithTime = [
    '● Working on task…',
    'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h 15m',
    '❯ ',
    '? for shortcuts',
  ].join('\r\n');
  const q1 = inspectQuota(quotaWithTime);
  assert.ok(q1);
  assert.equal(q1.waitingFor, 'quota reset');
  assert.match(q1.detail, /Individual quota reached/i);
  assert.match(q1.detail, /Resets in 2h 15m/i);
  assert.equal(inspectBuffer(quotaWithTime), null);
  assert.equal(isTaskDone(quotaWithTime, { hadInput: true }), false);

  const quotaBareReset = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets\r\n❯ ';
  const q2 = inspectQuota(quotaBareReset);
  assert.ok(q2);
  assert.equal(q2.waitingFor, 'quota reset');
  assert.match(q2.detail, /Individual quota reached/i);
  assert.match(q2.detail, /Resets/i);

  const quotaTwoLine = [
    'Individual quota reached. Please upgrade your subscription to increase your limits.',
    'Resets at 8:00pm (Europe/Copenhagen)',
    '❯ ',
  ].join('\r\n');
  const q3 = inspectQuota(quotaTwoLine);
  assert.ok(q3);
  assert.match(q3.detail, /Resets at 8:00pm/i);

  // createWaitChecker: quota reached vinder over kørende baggrundsproces
  const procs = [
    { pid: 100, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo -Command "claude"' },
    { pid: 102, ppid: 100, name: 'claude.exe', cmd: 'claude.exe' },
    { pid: 200, ppid: 102, name: 'node.exe', cmd: 'node.exe server.js' },
  ];
  const checker = createWaitChecker({ query: async () => procs });
  const s = { proc: { pid: 100 }, buffer: quotaWithTime, waitState: { waitingFor: 'kommando', source: 'process' } };
  await checker.checkAll([s]);
  assert.equal(s.waitState, null);
  assert.equal(checker.checkSync(s), null);
});

test('API /api/state: returnerer status kvote når agent rammer Individual quota reached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wait-quota-api-'));
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const token = 'd'.repeat(64);
  const config = cfg.clean({
    root: dir,
    port: 4319,
    idleSeconds: 4,
    maxSessions: 2,
    agents: [{
      id: 'quota-agent',
      name: 'QuotaAgent',
      command: 'node -e "console.log(\'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h 30m\\n❯ \'); setInterval(()=>{}, 1000)"',
    }],
  });
  const app = createApp({ config, token });
  const dispatch = (method, url, body) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1:4319',
      authorization: `Bearer ${token}`,
      origin: 'http://127.0.0.1:4319',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end(chunk) { resolve({ status: this.statusCode, json: JSON.parse(String(chunk || '{}')) }); },
    };
    app.server.emit('request', req, res);
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });

  try {
    const created = await dispatch('POST', '/api/sessions', { repo: 'demo', kind: 'agent', agentId: 'quota-agent' });
    assert.equal(created.status, 201);
    const id = created.json.id;
    let found = null;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const st = await dispatch('GET', '/api/state');
      found = st.json.sessions.find((s) => s.id === id);
      if (found && found.status === 'kvote') break;
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(found.status, 'kvote');
    assert.equal(found.waitingFor, 'quota reset');
    assert.match(found.waitingDetail, /Individual quota reached/i);
    assert.match(found.waitingDetail, /Resets in 1h 30m/i);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lastLine: filtrerer TUI-rammer, footers, prompts og tur-tidsstempler for Claude Code, Gemini og Codex', () => {
  // Claude Code afsluttet tur med PR-link, tur-tidsstempel, rammer, tom prompt og auto-mode footer
  const claudePrDone = [
    '● PR\'en er oprettet: https://github.com/Zpolonius/Skafferiet/pull/71',
    '✻ Churned for 25s · done 4:33 PM',
    '──────────────────────────',
    '❯ ',
    '──────────────────────────',
    '  ▸▸ auto mode on (shift+tab to cycle) · PR #71',
  ].join('\r\n');
  assert.equal(lastLine(claudePrDone), 'PR\'en er oprettet: https://github.com/Zpolonius/Skafferiet/pull/71');

  // Claude Code spørgsmål med Sautéed/Brewed tidsstempel, accept edits footer og shortcuts
  const claudeQuestion = [
    '⏺ Jeg har opdateret testen.',
    '● Skal jeg pushe?',
    '✻ Sautéed for 45s · done 4:19 PM',
    '* Brewed for 1m 23s',
    '──────────────────────────',
    '❯ ',
    '⏵⏵ accept edits on (shift+tab to cycle) · 42% context left',
    '? for shortcuts',
  ].join('\r\n');
  assert.equal(lastLine(claudeQuestion), 'Skal jeg pushe?');

  // Gemini / Antigravity TUI med boks-kanter, ConPTY \x1b[1C, placeholder-prompt og interrupt-linje
  const geminiBoxed = [
    '╭────────────────────────────────────────╮',
    '│ ● Skal\x1b[1Cjeg\x1b[1Ckøre\x1b[1Cflutter\x1b[1Ctest\x1b[1Cnu?       │',
    '╰────────────────────────────────────────╯',
    '╭────────────────────────────────────────╮',
    '│ > Type your message or @path/to/file   │',
    '╰────────────────────────────────────────╯',
    'ctrl+c to interrupt · ctrl+b to run in background',
  ].join('\r\n');
  assert.equal(lastLine(geminiBoxed), 'Skal jeg køre flutter test nu?');

  // OpenAI Codex TUI med bullet (•), placeholder-prompt og esc to interrupt
  const codexDone = [
    '• Alle 14 tests i wait-check.test.js består.',
    '╭────────────────────────────────────────╮',
    '│ › Ask Codex to do anything             │',
    '╰────────────────────────────────────────╯',
    'shift+tab to cycle · esc to interrupt',
  ].join('\r\n');
  assert.equal(lastLine(codexDone), 'Alle 14 tests i wait-check.test.js består.');

  // Aktive spinner-linjer bevares fortsat, når de er den seneste meningsfulde linje
  const activeSpinner = [
    '● Starter testkørsel',
    '⠋ Arbejder… 3\r⠙ Arbejder… 4',
    '──────────────────────────',
    '❯ ',
    '? for shortcuts · esc to interrupt',
  ].join('\r\n');
  assert.equal(lastLine(activeSpinner), '⠙ Arbejder… 4');

  // Eksisterende garantier fra app.test.js samt errorsFirst med TUI-bundlinjer
  assert.equal(lastLine('\x1b[32mRetter pdf.ts\x1b[0m\r\n\x1b[2K> '), 'Retter pdf.ts');
  assert.equal(lastLine('Skal jeg pushe?\r\n╭────────╮\r\n│ > \x1b[7m \x1b[0m │\r\n╰────────╯'), 'Skal jeg pushe?');
  const failedWithFooter = [
    '● Fatal error: migrations failed',
    'Efterfølgende oprydning færdig',
    '✻ Churned for 5s · done 4:35 PM',
    '❯ ',
    '? for shortcuts',
  ].join('\r\n');
  assert.equal(lastLine(failedWithFooter, true), 'Fatal error: migrations failed');
});

test('inspectBuffer: almindelig samtale med ordet subagenter udløser ikke falsk venten på subagenter', () => {
  const prose = [
    '● Alle 3 subagenter er nu færdige med deres opgaver.',
    'Vi kan starte et nyt hold subagenter på de næste issues.',
  ].join('\r\n');
  assert.equal(inspectBuffer(prose), null);
  assert.equal(inspectBuffer('● 2 subagents running…\r\nesc to interrupt').waitingFor, 'subagenter');
  assert.equal(inspectBuffer('● Kører subagenter i baggrunden').waitingFor, 'subagenter');
});

test('summary.diff: viser diff for commit, ændret fil og ny ucommittet fil og afviser ulovlige stier', async () => {
  const { baseline, diff } = require('../server/summary');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-diff-test-'));
  try {
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'linje 1\n');
    g('add', '.');
    g('commit', '-q', '-m', 'Start');
    const base = await baseline(dir);
    fs.appendFileSync(path.join(dir, 'a.txt'), 'linje 2\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'Tilføj linje 2');
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(dir, 'ny.txt'), 'helt ny fil\n');

    const fileDiff = await diff(dir, base, { file: 'a.txt' });
    assert.equal(fileDiff.available, true);
    assert.match(fileDiff.diff, /\+linje 2/);

    const newFileDiff = await diff(dir, base, { file: 'ny.txt' });
    assert.equal(newFileDiff.available, true);
    assert.match(newFileDiff.diff, /\+helt ny fil/);

    const commitDiff = await diff(dir, base, { commit: sha });
    assert.equal(commitDiff.available, true);
    assert.match(commitDiff.diff, /Tilføj linje 2/);
    assert.match(commitDiff.diff, /\+linje 2/);

    assert.equal((await diff(dir, base, { file: '../udenfor.txt' })).available, false);
    assert.equal((await diff(dir, base, { commit: '--output=/tmp/x' })).available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API: initialPaste ved opstart, POST /approve og GET /diff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-api-features-'));
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'fil.txt'), 'start\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: repo });
  const token = 'e'.repeat(64);
  const config = cfg.clean({
    root: dir,
    port: 4321,
    idleSeconds: 2,
    maxSessions: 2,
    agents: [{
      id: 'paste-agent',
      name: 'PasteAgent',
      command: 'node -e "process.stdout.write(\'\\x1b[?2004hKlar\\n\'); process.stdin.on(\'data\', d => process.stdout.write(\'MODTOG:\' + d.toString()))"',
    }],
  });
  const app = createApp({ config, token });
  const dispatch = (method, url, body) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1:4321',
      authorization: `Bearer ${token}`,
      origin: 'http://127.0.0.1:4321',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end(chunk) { resolve({ status: this.statusCode, json: JSON.parse(String(chunk || '{}')) }); },
    };
    app.server.emit('request', req, res);
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });

  try {
    const created = await dispatch('POST', '/api/sessions', {
      repo: 'demo', kind: 'agent', agentId: 'paste-agent', initialPaste: 'Løs issue #42',
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    let st = null;
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const r = await dispatch('GET', '/api/state');
      st = r.json.sessions.find((s) => s.id === id);
      if (st && st.pendingPaste) break;
      await new Promise((r2) => setTimeout(r2, 80));
    }
    assert.equal(st.pendingPaste, true, 'initialPaste blev sat ind automatisk');

    // Godkend/send via /approve
    assert.equal((await dispatch('POST', `/api/sessions/${id}/approve`, { key: 'ugyldig' })).status, 400);
    const appRes = await dispatch('POST', `/api/sessions/${id}/approve`, { key: 'enter' });
    assert.equal(appRes.status, 200);
    const afterApprove = (await dispatch('GET', '/api/state')).json.sessions.find((s) => s.id === id);
    assert.equal(afterApprove.pendingPaste, false, 'pendingPaste nulstilles efter approve(enter)');

    // Ændr en fil og tjek /diff-endpointet
    fs.appendFileSync(path.join(repo, 'fil.txt'), 'ny linje\n');
    const diffRes = await dispatch('GET', `/api/sessions/${id}/diff?file=fil.txt`);
    assert.equal(diffRes.status, 200);
    assert.equal(diffRes.json.available, true);
    assert.match(diffRes.json.diff, /\+ny linje/);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
