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
const { createWaitChecker, inspectProcessTree, inspectBuffer, isTaskDone, sanitizeDetail } = require('../server/wait-check');
const { createSessions } = require('../server/sessions');

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
