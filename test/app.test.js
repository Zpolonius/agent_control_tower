'use strict';
// QA- og sikkerhedstest. Kører mod en rigtig server på en midlertidig mappe med prøve-repos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const cfg = require('../server/config');
const { createApp } = require('../server/app');

process.env.SHELL = '/bin/bash';
const PORT = 4399;
const TOKEN = 'a'.repeat(64);
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
const root = path.join(tmp, 'projects');
let app;

function sh(cwd, ...args) { execFileSync(args[0], args.slice(1), { cwd, stdio: 'ignore' }); }
function makeRepo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'docs', 'brain.md'), '# Hjerne\n\n- [x] færdig\n- [ ] mangler\n');
  fs.writeFileSync(path.join(dir, 'docs', 'plans', 'next.md'), 'Næste skridt');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Regler');
  fs.writeFileSync(path.join(dir, 'secret.env'), 'KEY=1');
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'Første commit');
  return dir;
}

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method,
      headers: { Host: `127.0.0.1:${PORT}`, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* ikke json */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const get = (url) => req('GET', url, { headers: { Authorization: AUTH } });
const post = (url, body) => req('POST', url, { headers: { Authorization: AUTH, Origin: ORIGIN }, body });
const del = (url) => req('DELETE', url, { headers: { Authorization: AUTH, Origin: ORIGIN } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(id, headers = { Origin: ORIGIN }, protocols = ['ct', `ct.${TOKEN}`]) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}`, protocols, { headers });
    const c = { ws, out: '', exit: null, first: null };
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (!c.first) c.first = m; if (m.type === 'data') c.out += m.data; else if (m.type === 'exit') c.exit = m.code; });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
}
const sessionState = async (id) => (await get('/api/state')).json.sessions.find((s) => s.id === id);

test.before(async () => {
  fs.mkdirSync(root, { recursive: true });
  const alpha = makeRepo('alpha');
  makeRepo('beta');
  fs.writeFileSync(path.join(alpha, 'ny-fil.txt'), 'ikke committet');
  fs.mkdirSync(path.join(root, 'ikke-git'));
  fs.writeFileSync(path.join(tmp, 'udenfor.md'), 'HEMMELIGT');
  fs.symlinkSync(path.join(tmp, 'udenfor.md'), path.join(alpha, 'docs', 'link.md'));
  // Personlige skills i en midlertidig "hjemmemappe" med en hemmelig fil ved siden af.
  const home = path.join(tmp, 'home', '.claude');
  const mk = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  mk(path.join(home, 'skills', 'commit', 'SKILL.md'), '---\nname: commit\ndescription: "Skriv gode commit-beskeder"\ndisable-model-invocation: true\n---\n# Commit\nBrug bydeform.');
  mk(path.join(home, 'skills', 'synced', 'abc_def', 'hedwig', 'SKILL.md'), '---\nname: hedwig\ndescription: >\n  Posten Bring design\n  i flere linjer\n---\nIndhold');
  mk(path.join(home, 'skills', 'uden-frontmatter', 'SKILL.md'), 'Bare tekst <script>alert(1)</script>');
  mk(path.join(home, '.credentials.json'), '{"token":"HEMMELIGT"}');
  mk(path.join(home, 'skills', 'commit', 'noter.md'), 'ikke en skill');
  fs.mkdirSync(path.join(home, 'skills', 'luskeri'));
  fs.symlinkSync(path.join(home, '.credentials.json'), path.join(home, 'skills', 'luskeri', 'SKILL.md'));
  mk(path.join(alpha, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: Udrul til test\nwhen_to_use: når brugeren siger deploy\n---\nTrin 1');
  mk(path.join(alpha, '.claude', 'skills', 'commit', 'SKILL.md'), '---\nname: commit\ndescription: Projektets egen\n---\nx');
  mk(path.join(alpha, '.claude', 'commands', 'review.md'), 'Gennemgå $ARGUMENTS');
  mk(path.join(alpha, '.claude', 'commands', 'front', 'knap.md'), 'Lav en knap');
  mk(path.join(alpha, '.claude', 'settings.local.json'), '{"hemmelig":true}');
  const config = cfg.clean({ root, port: PORT, personalSkillsDir: path.join(home, 'skills'), idleSeconds: 2, maxSessions: 4, agents: [
    { id: 'echo', name: 'Ekko', command: 'while IFS= read -r l; do echo "GOT[$l]"; done' },
    { id: 'paste', name: 'Indsæt', command: 'printf "\\033[?2004h"; while IFS= read -r l; do echo "GOT[$l]"; done' },
    { id: 'fail', name: 'Fejler', command: 'echo starter; exit 3' },
    { id: 'sig9', name: 'Nedbrud', command: 'echo starter; kill -9 $$' },
    { id: 'hup', name: 'Stædig', command: "trap '' HUP; echo klar; while :; do sleep 1; done" },
    { id: 'winch', name: 'Tegner om', command: `exec sh -c "trap 'echo tegner-om' WINCH; echo klar; while :; do sleep 0.2; done"` },
    // "raw" opfører sig som et rigtigt skærmprogram: terminalen sender hvert tegn direkte videre uden linjegrænse.
    { id: 'raw', name: 'Rå', command: 'stty raw -echo; echo klar; cat' },
  ] });
  app = createApp({ config, token: TOKEN });
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
});
test.after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------- sikkerhed ----------------
test('serveren lytter kun på 127.0.0.1', () => {
  assert.equal(app.server.address().address, '127.0.0.1');
});

test('fremmed værtsnavn afvises (DNS rebinding)', async () => {
  const r = await req('GET', '/api/state', { headers: { Host: 'evil.example:4399', Authorization: AUTH } });
  assert.equal(r.status, 403);
  assert.equal((await req('GET', '/', { headers: { Host: 'evil.example:4399' } })).status, 403);
});

test('uden nøgle er alle data låst – kun selve siden kan hentes', async () => {
  for (const url of ['/api/state', '/api/brain?repo=alpha', '/api/skills', '/api/issues?repo=alpha', '/api/prs?repo=alpha']) {
    assert.equal((await req('GET', url)).status, 401, url);
  }
  for (const bad of [`Bearer ${'b'.repeat(64)}`, 'Bearer', `Basic ${TOKEN}`, TOKEN, `bearer ${TOKEN.toUpperCase()}`]) {
    assert.equal((await req('GET', '/api/state', { headers: { Authorization: bad } })).status, 401, bad);
  }
  assert.equal((await req('GET', '/')).status, 200, 'siden selv indeholder ingen data og kan vises');
  assert.equal((await req('GET', `/api/state?token=${TOKEN}`)).status, 401, 'nøglen virker ikke i adressen');
});

test('der bruges ingen cookies – en nøgle i en cookie giver ikke adgang', async () => {
  // Browsere sender cookies til alle porte på 127.0.0.1. Derfor må en cookie aldrig være nok.
  for (const c of [`ct_session_${PORT}=${TOKEN}`, `token=${TOKEN}`]) {
    assert.equal((await req('GET', '/api/state', { headers: { Cookie: c } })).status, 401, c);
  }
  for (const url of ['/', `/?token=${TOKEN}`, '/app.js']) {
    assert.equal((await req('GET', url)).headers['set-cookie'], undefined, url);
  }
  const page = (await req('GET', '/')).text + (await req('GET', '/app.js')).text;
  assert.ok(!page.includes(TOKEN), 'nøglen står ikke i siden');
});

test('en skæv forespørgsel kan ikke vælte serveren', async () => {
  const raw = (lines) => new Promise((resolve) => {
    const sock = require('node:net').connect(PORT, '127.0.0.1', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`));
    sock.on('data', () => {}); sock.on('error', () => {}); sock.on('close', resolve);
    setTimeout(() => sock.destroy(), 800);
  });
  const up = ['Host: 127.0.0.1:4399', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
  for (const target of ['//', '//[', '/ws?session=%', 'http://[::1', '/\\\\x']) await raw([`GET ${target} HTTP/1.1`, ...up]);
  await raw(['GET / HTTP/1.1', 'Host: 127.0.0.1:4399', 'Content-Length: abc']);
  await raw(['GARBAGE']);
  assert.equal((await get('/api/state')).status, 200, 'serveren kører stadig');
  assert.notEqual((await get('//')).status, 200);
});

test('sikkerheds-headers er sat', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(r.headers['content-security-policy'], /script-src[^;]*unsafe/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('kun filer på den faste liste kan hentes', async () => {
  for (const url of ['/../server/app.js', '/%2e%2e/package.json', '/node_modules/ws/package.json', '/control-tower.config.json', '/vendor/../app.js.map']) {
    assert.notEqual((await get(url)).status, 200, url);
  }
  assert.equal((await get('/vendor/xterm.js')).status, 200);
});

test('ændringer kræver at forespørgslen kommer fra Control Tower selv (CSRF)', async () => {
  const body = { repo: 'alpha', kind: 'shell' };
  assert.equal((await req('POST', '/api/sessions', { headers: { Authorization: AUTH }, body })).status, 403);
  assert.equal((await req('POST', '/api/sessions', { headers: { Authorization: AUTH, Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await req('POST', '/api/sessions', { headers: { Authorization: AUTH, Origin: 'http://127.0.0.1:4471' }, body })).status, 403, 'en anden lokal port er også en fremmed afsender');
  assert.equal((await req('DELETE', `/api/sessions/${'0'.repeat(24)}`, { headers: { Authorization: AUTH, Origin: 'null' } })).status, 403);
  assert.equal((await req('POST', '/api/sessions', { headers: { Origin: ORIGIN }, body })).status, 401, 'rigtig afsender uden nøgle er heller ikke nok');
  assert.equal((await get('/api/state')).json.sessions.length, 0);
});

test('hjernen kan ikke bruges til at læse andre filer', async () => {
  for (const p of ['../../udenfor.md', '../beta/CLAUDE.md', 'secret.env', '/etc/passwd', 'docs/link.md', 'docs/../secret.env']) {
    assert.equal((await get(`/api/brain/file?repo=alpha&path=${encodeURIComponent(p)}`)).status, 404, p);
  }
  for (const r of ['..', '../projects/alpha', 'ikke-git', '', 'alpha/docs', '/etc']) {
    assert.equal((await get(`/api/brain?repo=${encodeURIComponent(r)}`)).status, 404, r);
  }
  const files = (await get('/api/brain?repo=alpha')).json.files.map((f) => f.path);
  assert.ok(!files.includes('docs/link.md'), 'symlink ud af repoet må ikke vises');
});

test('browseren kan ikke selv vælge hvilken kommando en agent kører', async () => {
  assert.equal((await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'rm -rf /' })).status, 400);
  assert.equal((await post('/api/sessions', { repo: 'alpha', kind: 'agent', command: 'touch /tmp/pwned' })).status, 400);
  assert.equal((await post('/api/sessions', { repo: '../..', kind: 'shell' })).status, 404);
  assert.equal((await post('/api/sessions', { repo: 'alpha', kind: 'andet' })).status, 400);
  const state = (await get('/api/state')).json;
  assert.ok(state.agents.every((a) => !('command' in a)), 'kommandoer sendes ikke til browseren');
});

test('terminal-forbindelsen kræver både nøgle og rigtig afsender', async () => {
  const s = (await post('/api/sessions', { repo: 'beta', kind: 'shell' })).json;
  await assert.rejects(connect(s.id, { Origin: 'https://evil.example' }));
  await assert.rejects(connect(s.id, { Origin: 'http://127.0.0.1:4471' }));
  await assert.rejects(connect(s.id, { Origin: ORIGIN }, ['ct']));
  await assert.rejects(connect(s.id, { Origin: ORIGIN }, ['ct', `ct.${'b'.repeat(64)}`]));
  await assert.rejects(connect(s.id, { Origin: ORIGIN, Cookie: `ct_session_${PORT}=${TOKEN}` }, ['ct']), 'en cookie er ikke nok');
  await assert.rejects(connect('f'.repeat(24)));
  const good = await connect(s.id);
  assert.equal(good.ws.protocol, 'ct', 'nøglen sendes ikke tilbage i svaret');
  good.ws.close();
  await del(`/api/sessions/${s.id}`);
  await until(async () => (await sessionState(s.id)).status === 'afsluttet');
  await del(`/api/sessions/${s.id}`);
});

// ---------------- funktion ----------------
test('overblik: finder repos, status og springer mapper uden git over', async () => {
  const s = (await get('/api/state?fresh=1')).json;
  assert.deepEqual(s.repos.map((r) => r.name), ['alpha', 'beta']);
  assert.equal(s.skipped, 1);
  const [alpha, beta] = s.repos;
  assert.equal(alpha.branch, 'main');
  assert.equal(alpha.untracked, 3); // ny-fil.txt + docs/link.md + .claude/
  assert.equal(beta.untracked + beta.changed, 0);
  assert.equal(beta.lastCommit.subject, 'Første commit');
  assert.equal(beta.brainFiles, 3);
});

test('hjerne: viser filer og indhold', async () => {
  const files = (await get('/api/brain?repo=beta')).json.files.map((f) => f.path);
  assert.deepEqual(files, ['CLAUDE.md', 'docs/brain.md', 'docs/plans/next.md']);
  const f = (await get('/api/brain/file?repo=beta&path=docs%2Fbrain.md')).json;
  assert.match(f.content, /# Hjerne/);
});

test('terminal: åbner i repoet, tager imod kommandoer og kan genåbnes med historik', async () => {
  const s = (await post('/api/sessions', { repo: 'alpha', kind: 'shell' })).json;
  assert.equal(s.status, 'aaben');
  const c = await connect(s.id);
  c.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  c.ws.send(JSON.stringify({ type: 'resize', cols: 99999, rows: -1 }));
  c.ws.send('ikke json');
  c.ws.send(JSON.stringify({ type: 'input', data: 'echo svar-$((40+2)); basename "$PWD"; tput cols\r' }));
  assert.ok(await until(() => /svar-42\r?\n.*alpha\r?\n.*120/s.test(c.out)), c.out);
  c.ws.close();
  const again = await connect(s.id);
  assert.ok(await until(() => again.out.includes('svar-42')), 'historik genafspilles');
  again.ws.close();
  assert.equal((await del(`/api/sessions/${s.id}`)).status, 200);
  assert.ok(await until(async () => (await sessionState(s.id)).status === 'afsluttet'));
  assert.equal((await del(`/api/sessions/${s.id}`)).status, 200);
  assert.equal(await sessionState(s.id), undefined);
});

test('agent: status går fra arbejder til venter, og en fejl vises som fejlet', async () => {
  const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo' })).json;
  assert.equal(s.status, 'arbejder');
  assert.equal(s.name, 'Ekko');
  assert.ok(await until(async () => (await sessionState(s.id)).status === 'venter', 5000));
  const c = await connect(s.id);
  c.ws.send(JSON.stringify({ type: 'input', data: 'hej\r' }));
  assert.ok(await until(() => c.out.includes('GOT[hej]')));
  c.ws.close();
  await del(`/api/sessions/${s.id}`);
  const f = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'fail' })).json;
  assert.ok(await until(async () => (await sessionState(f.id)).status === 'fejlet'));
  assert.equal((await sessionState(f.id)).exitCode, 3);
  await del(`/api/sessions/${f.id}`);
  await until(async () => (await sessionState(s.id)).status === 'afsluttet');
  await del(`/api/sessions/${s.id}`);
});

test('send review til agent: indsættes uden at blive sendt, og styretegn fjernes', async () => {
  const shell = (await post('/api/sessions', { repo: 'alpha', kind: 'shell' })).json;
  assert.equal((await post(`/api/sessions/${shell.id}/paste`, { text: 'touch pwned\n' })).status, 400, 'aldrig til en almindelig terminal');
  await del(`/api/sessions/${shell.id}`);

  const a = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo' })).json;
  const c = await connect(a.id);
  await sleep(400);
  assert.equal((await post(`/api/sessions/${a.id}/paste`, { text: ' \n' })).status, 400);
  const evil = 'linje et\nlinje to\x1b[201~\r\x03\x04 slut';
  assert.equal((await post(`/api/sessions/${a.id}/paste`, { text: evil })).status, 200);
  await sleep(500);
  assert.ok(!c.out.includes('GOT['), 'intet må være sendt før brugeren trykker Enter');
  c.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
  assert.ok(await until(() => c.out.includes('GOT[linje et linje to[201~ slut]')), JSON.stringify(c.out));
  assert.equal((c.out.match(/GOT\[/g) || []).length, 1);
  c.ws.close();
  await del(`/api/sessions/${a.id}`);

  const b = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'paste' })).json;
  const cb = await connect(b.id);
  await until(() => cb.out.includes('\x1b[?2004h'));
  assert.equal((await post(`/api/sessions/${b.id}/paste`, { text: 'a\nb' })).status, 200);
  assert.ok(await until(() => /GOT\[.*200~a\]/.test(cb.out)), 'indsæt-tilstand bruges når agenten understøtter den');
  cb.ws.close();
  await del(`/api/sessions/${b.id}`);
  assert.equal((await post(`/api/sessions/${'e'.repeat(24)}/paste`, { text: 'x' })).status, 404);
  await until(async () => (await get('/api/state')).json.sessions.every((s) => s.exitCode != null));
  for (const s of (await get('/api/state')).json.sessions) await del(`/api/sessions/${s.id}`);
});

test('der er et loft over antal samtidige sessioner', async () => {
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push((await post('/api/sessions', { repo: 'beta', kind: 'shell' })).json.id);
  const r = await post('/api/sessions', { repo: 'beta', kind: 'shell' });
  assert.equal(r.status, 429);
  for (const id of ids) await del(`/api/sessions/${id}`);
  await until(async () => (await get('/api/state')).json.sessions.every((s) => s.exitCode != null));
  for (const id of ids) await del(`/api/sessions/${id}`);
});

test('pull requests: læser reviews via gh, og forklarer når gh mangler', async () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const list = JSON.stringify([{ number: 7, title: 'Ny checkout', headRefName: 'feat/x', reviewDecision: 'CHANGES_REQUESTED', isDraft: false, updatedAt: '2026-11-14T10:00:00Z', url: 'https://github.com/o/r/pull/7', author: { login: 'zac' } }]);
  const view = JSON.stringify({ number: 7, title: 'Ny checkout', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', reviewDecision: 'CHANGES_REQUESTED',
    reviews: [{ author: { login: 'rev' }, state: 'CHANGES_REQUESTED', body: 'Ret <script>alert(1)</script> validering', submittedAt: '2026-11-14T09:00:00Z' }, { author: { login: 'rev' }, state: 'COMMENTED', body: '' }],
    comments: [{ author: { login: 'bot' }, body: 'CI fejlede', createdAt: '2026-11-14T09:30:00Z' }] });
  const inline = JSON.stringify([{ user: { login: 'rev' }, path: 'src/a.js', line: 12, body: 'Mangler null-tjek', created_at: '2026-11-14T09:01:00Z' }]);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$1 $2" in\n "pr list") echo '${list}';;\n "pr view") echo '${view}';;\n "api "*) echo '${inline}';;\nesac\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const l = (await get('/api/prs?repo=alpha&fresh=1')).json;
    assert.equal(l.available, true);
    assert.equal(l.prs[0].number, 7);
    assert.equal(l.prs[0].decision, 'CHANGES_REQUESTED');
    const d = (await get('/api/prs/detail?repo=alpha&number=7')).json;
    assert.equal(d.reviews.length, 1, 'tomme kommentar-reviews sorteres fra');
    assert.equal(d.inline[0].path, 'src/a.js');
    assert.equal(d.inline[0].line, 12);
    assert.equal(d.comments[0].author, 'bot');
    for (const n of ['7;id', '-1', '0', 'abc', '7 --web', '']) {
      assert.equal((await get(`/api/prs/detail?repo=alpha&number=${encodeURIComponent(n)}`)).status, 400, n);
    }
  } finally { process.env.PATH = oldPath; }
  process.env.PATH = '/nonexistent';
  try {
    const l = (await get('/api/prs?repo=beta&fresh=1')).json;
    assert.equal(l.available, false);
    assert.match(l.reason, /ikke installeret/);
  } finally { process.env.PATH = oldPath; }
});

test('taleboble: seneste linje renses for farvekoder og styretegn', async () => {
  const { lastLine } = require('../server/sessions');
  assert.equal(lastLine('\x1b[32mRetter pdf.ts\x1b[0m\r\n\x1b[2K> '), 'Retter pdf.ts');
  assert.equal(lastLine('gammel linje\r\n\x1b]0;titel\x07⠋ Arbejder… 3\r⠙ Arbejder… 4'), '⠙ Arbejder… 4');
  assert.equal(lastLine('Skal jeg pushe?\r\n╭────────╮\r\n│ > \x1b[7m \x1b[0m │\r\n╰────────╯'), 'Skal jeg pushe?');
  assert.equal(lastLine('<script>alert(1)</script>\x07\x00'), '<script>alert(1)</script>', 'sendes som ren tekst – browseren viser den med textContent');
  assert.equal(lastLine('x'.repeat(10) + ' ord '.repeat(60)).length, 140);
  assert.equal(lastLine('\x1b[2J\x1b[H   \r\n'), '');
  const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'fail' })).json;
  assert.ok(await until(async () => (await sessionState(s.id)).lastLine === 'starter'));
  const t = (await post('/api/sessions', { repo: 'alpha', kind: 'shell' })).json;
  assert.equal((await sessionState(t.id)).lastLine, '', 'almindelige terminaler deler ikke indhold i overblikket');
  await del(`/api/sessions/${t.id}`);
  await until(async () => (await get('/api/state')).json.sessions.every((x) => x.exitCode != null));
  for (const x of (await get('/api/state')).json.sessions) await del(`/api/sessions/${x.id}`);
});

test('skills: viser projekt-skills, gamle kommandoer og personlige skills', async () => {
  const r = (await get('/api/skills?repo=alpha')).json;
  assert.deepEqual(r.project.map((s) => [s.name, s.source]), [['commit', 'skill'], ['deploy', 'skill'], ['front:knap', 'command'], ['review', 'command']]);
  assert.equal(r.project.find((s) => s.name === 'deploy').description, 'Udrul til test når brugeren siger deploy');
  assert.deepEqual(r.personal.map((s) => [s.name, s.source, s.manualOnly]), [['commit', 'skill', true], ['hedwig', 'synced', false], ['uden-frontmatter', 'skill', false]]);
  assert.equal(r.personal.find((s) => s.name === 'hedwig').description, 'Posten Bring design i flere linjer');
  assert.deepEqual((await get('/api/skills?repo=beta')).json.project, [], 'repo uden skills giver en tom liste');
  const all = (await get('/api/skills')).json;
  assert.deepEqual(all.repos.map((x) => [x.repo, x.skills.length]), [['alpha', 4], ['beta', 0]]);
  const f = (await get('/api/skills/file?scope=personal&id=commit%2FSKILL.md')).json;
  assert.match(f.content, /^# Commit/, 'frontmatter vises ikke som indhold');
  assert.equal((await get('/api/skills/file?scope=project&repo=alpha&id=skills%2Fdeploy%2FSKILL.md')).json.content, 'Trin 1');
});

test('skills: kan ikke bruges til at læse andre filer i hjemmemappen eller repoet', async () => {
  const personal = (await get('/api/skills?repo=alpha')).json.personal.map((s) => s.name);
  assert.ok(!personal.includes('luskeri'), 'symlink til en hemmelig fil vises ikke');
  for (const id of ['../.credentials.json', 'luskeri/SKILL.md', 'commit/noter.md', '/etc/passwd', 'commit/../../.credentials.json', '']) {
    assert.equal((await get(`/api/skills/file?scope=personal&id=${encodeURIComponent(id)}`)).status, 404, id);
  }
  for (const id of ['settings.local.json', '../secret.env', 'skills/deploy/../../settings.local.json']) {
    assert.equal((await get(`/api/skills/file?scope=project&repo=alpha&id=${encodeURIComponent(id)}`)).status, 404, id);
  }
  assert.equal((await get('/api/skills/file?scope=project&repo=..&id=x')).status, 404);
  assert.equal((await get('/api/skills/file?scope=andet&id=x')).status, 400);
  assert.equal((await get('/api/skills?repo=..')).status, 404);
  assert.equal((await req('GET', '/api/skills')).status, 401);
});

test('skills: en manglende personlig mappe giver bare en tom liste', () => {
  const { createSkills } = require('../server/skills');
  const s = createSkills({ personalSkillsDir: path.join(tmp, 'findes-ikke') });
  assert.deepEqual(s.personal(), []);
  assert.deepEqual(s.project(path.join(tmp, 'findes-heller-ikke')), []);
  assert.equal(cfg.clean({}).personalSkillsDir, path.join(os.homedir(), '.claude', 'skills'));
  assert.equal(cfg.clean({ personalSkillsDir: 'relativ/sti' }).personalSkillsDir, path.join(os.homedir(), '.claude', 'skills'));
  assert.deepEqual(cfg.clean({}).personalSkillsDirs, [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.gemini', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ]);
});

test('skills: henter fra flere personlige mapper samt .gemini og .agents i et repo', () => {
  const { createSkills } = require('../server/skills');
  const dirClaude = path.join(tmp, 'multi-claude', '.claude', 'skills');
  const dirGemini = path.join(tmp, 'multi-gemini', '.gemini', 'skills');
  const dirCustom = path.join(tmp, 'mine-egne-skills');
  const repoMulti = path.join(tmp, 'repo-multi');
  const mk = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  mk(path.join(dirClaude, 'claude-skill', 'SKILL.md'), '---\nname: claude-skill\ndescription: Fra Claude\n---\nClaude body');
  mk(path.join(dirGemini, 'gemini-skill', 'SKILL.md'), '---\nname: gemini-skill\ndescription: Fra Gemini\n---\nGemini body');
  mk(path.join(dirCustom, 'delt-skill', 'SKILL.md'), '---\nname: delt-skill\ndescription: Fra egen mappe\n---\nDelt body');
  mk(path.join(repoMulti, '.claude', 'skills', 'c-proj', 'SKILL.md'), '---\nname: c-proj\ndescription: Claude proj\n---\nC');
  mk(path.join(repoMulti, '.gemini', 'skills', 'g-proj', 'SKILL.md'), '---\nname: g-proj\ndescription: Gemini proj\n---\nG');
  mk(path.join(repoMulti, '.agents', 'skills', 'a-proj', 'SKILL.md'), '---\nname: a-proj\ndescription: Agents proj\n---\nA');

  const cleaned = cfg.clean({ personalSkillsDirs: [dirClaude, dirGemini, dirCustom, dirClaude, 'relativ/ignoreres'] });
  assert.deepEqual(cleaned.personalSkillsDirs, [dirClaude, dirGemini, dirCustom]);
  const s = createSkills(cleaned);
  const pers = s.personal();
  assert.deepEqual(pers.map((x) => [x.name, x.id, x.dirLabel]), [
    ['claude-skill', 'claude-skill/SKILL.md', 'Claude (~/.claude/skills)'],
    ['delt-skill', '2:delt-skill/SKILL.md', 'mine-egne-skills'],
    ['gemini-skill', '1:gemini-skill/SKILL.md', 'Gemini (~/.gemini/skills)'],
  ]);
  assert.equal(s.read('personal', null, '1:gemini-skill/SKILL.md').content, 'Gemini body');
  assert.equal(s.read('personal', null, '2:delt-skill/SKILL.md').content, 'Delt body');

  const proj = s.project(repoMulti);
  assert.deepEqual(proj.map((x) => [x.name, x.id, x.dirLabel]), [
    ['a-proj', '.agents/skills/a-proj/SKILL.md', 'Delt (.agents)'],
    ['c-proj', 'skills/c-proj/SKILL.md', null],
    ['g-proj', '.gemini/skills/g-proj/SKILL.md', 'Gemini (.gemini)'],
  ]);
  assert.equal(s.read('project', repoMulti, '.gemini/skills/g-proj/SKILL.md').content, 'G');
  assert.equal(s.read('project', repoMulti, '.agents/skills/a-proj/SKILL.md').content, 'A');
});

test('issues: læser åbne issues via gh, afviser snydenumre og forklarer når gh mangler', async () => {
  const bin = path.join(tmp, 'bin-issues');
  const data = path.join(tmp, 'ghdata');
  fs.mkdirSync(bin); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'list.json'), JSON.stringify([
    { number: 12, title: 'Eksport til PDF fejler', labels: [{ name: 'bug' }, { name: 'checkout' }], assignees: [{ login: 'zac' }], comments: [{}, {}], updatedAt: '2026-11-14T10:00:00Z', url: 'https://github.com/o/r/issues/12', author: { login: 'zac' } },
    { number: 9, title: 'Uden labels', updatedAt: '2026-11-10T10:00:00Z', url: 'https://github.com/o/r/issues/9', author: null }]));
  fs.writeFileSync(path.join(data, 'view.json'), JSON.stringify({ number: 12, title: 'Eksport til PDF fejler', body: 'Trin:\n1. Åbn <script>alert(1)</script>\n2. Tryk eksport', labels: [{ name: 'bug' }], url: 'https://github.com/o/r/issues/12', author: { login: 'zac' }, updatedAt: '2026-11-14T10:00:00Z', comments: [{ author: { login: 'kollega' }, body: 'Sker også i Safari', createdAt: '2026-11-14T11:00:00Z' }] }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$1 $2" in\n "issue list") cat '${data}/list.json';;\n "issue view") echo "$3" > '${data}/asked'; cat '${data}/view.json';;\nesac\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const l = (await get('/api/issues?repo=alpha&fresh=1')).json;
    assert.equal(l.available, true);
    assert.deepEqual(l.issues.map((i) => [i.number, i.labels, i.comments, i.author]), [[12, ['bug', 'checkout'], 2, 'zac'], [9, [], 0, 'ukendt']]);
    const d = (await get('/api/issues/detail?repo=alpha&number=12')).json;
    assert.match(d.body, /Tryk eksport/);
    assert.equal(d.comments[0].author, 'kollega');
    assert.equal(fs.readFileSync(path.join(data, 'asked'), 'utf8').trim(), '12');
    for (const n of ['12;id', '-1', '0', 'abc', '12 --web', '--repo=x/y', '']) {
      assert.equal((await get(`/api/issues/detail?repo=alpha&number=${encodeURIComponent(n)}`)).status, 400, n);
    }
    assert.equal((await get('/api/issues?repo=..')).status, 404);
    assert.equal((await req('GET', '/api/issues?repo=alpha')).status, 401);
  } finally { process.env.PATH = oldPath; }
  process.env.PATH = '/nonexistent';
  try {
    const l = (await get('/api/issues?repo=beta&fresh=1')).json;
    assert.equal(l.available, false);
    assert.match(l.reason, /ikke installeret/);
  } finally { process.env.PATH = oldPath; }
});

test('resumé: viser kun det der er sket siden agenten startede', async () => {
  const { baseline, summarize } = require('../server/summary');
  const dir = path.join(tmp, 'resume-repo');
  fs.mkdirSync(dir);
  const g = (...a) => sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'en\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'en\n');
  g('add', '.'); g('commit', '-q', '-m', 'Start');
  // Eksisterende tilstand: en fil du selv har ændret, og en ny fil du selv har lagt – før agenten starter.
  fs.appendFileSync(path.join(dir, 'b.txt'), 'din egen ændring\n');
  fs.writeFileSync(path.join(dir, 'din-kladde.txt'), 'x');
  const base = await baseline(dir);
  assert.deepEqual([base.ok, base.untracked, base.dirty], [true, ['din-kladde.txt'], ['b.txt']]);
  const none = await summarize(dir, base);
  assert.deepEqual([none.commits.length, none.files.map((f) => f.path)], [0, ['b.txt']], 'intet nyt endnu – kun din egen ændring, markeret');
  assert.equal(none.files[0].preexisting, true);
  // "Agenten" arbejder: ændrer, committer, laver en ny fil og efterlader en ucommittet ændring.
  fs.appendFileSync(path.join(dir, 'a.txt'), 'to\ntre\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'Agent: udvid a <script>');
  fs.writeFileSync(path.join(dir, 'ny fil æøå.txt'), 'ny');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'fire\n');
  const r = await summarize(dir, base);
  assert.equal(r.available, true);
  assert.deepEqual(r.commits.map((c) => c.subject), ['Agent: udvid a <script>']);
  assert.deepEqual(r.files.map((f) => [f.path, f.added, f.isNew, f.preexisting]), [['a.txt', 3, false, false], ['b.txt', 1, false, true], ['ny fil æøå.txt', 0, true, false]]);
  assert.ok(!r.files.some((f) => f.path === 'din-kladde.txt'), 'filer der lå der i forvejen tælles ikke med');
  assert.deepEqual([r.added, r.removed, r.uncommitted], [4, 0, true]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.git', 'a.txt', 'b.txt', 'din-kladde.txt', 'ny fil æøå.txt'], 'resuméet skriver ikke noget i repoet');
  assert.equal((await summarize(dir, null)).available, false);
  assert.equal((await summarize(dir, { ok: true, sha: '--output=/tmp/x', untracked: [], dirty: [] })).available, false, 'kun rigtige commit-id\'er gives videre til git');
  // Repo helt uden commits ved start
  const empty = path.join(tmp, 'tomt-repo'); fs.mkdirSync(empty); sh(empty, 'git', 'init', '-q', '-b', 'main');
  const eb = await baseline(empty);
  assert.equal(eb.sha, null);
  fs.writeFileSync(path.join(empty, 'første.txt'), 'x');
  assert.deepEqual((await summarize(empty, eb)).files.map((f) => f.path), ['første.txt']);
});

test('resumé via API: kun for agenter, og låst som alt andet', async () => {
  const a = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'fail' })).json;
  await until(async () => (await sessionState(a.id)).status === 'fejlet');
  const r = (await get(`/api/sessions/${a.id}/summary`)).json;
  assert.deepEqual([r.available, r.commits.length, r.fileCount], [true, 0, 0]);
  assert.ok(r.endedAt >= r.startedAt);
  const t = (await post('/api/sessions', { repo: 'beta', kind: 'shell' })).json;
  assert.equal((await get(`/api/sessions/${t.id}/summary`)).json.available, false);
  assert.equal((await get(`/api/sessions/${'c'.repeat(24)}/summary`)).status, 404);
  assert.equal((await req('GET', `/api/sessions/${a.id}/summary`)).status, 401);
  assert.ok(!('baseline' in (await sessionState(a.id))) && !('cwd' in (await sessionState(a.id))), 'interne felter sendes ikke til browseren');
  await del(`/api/sessions/${t.id}`); await del(`/api/sessions/${a.id}`);
  await until(async () => (await get('/api/state')).json.sessions.every((x) => x.exitCode != null));
  for (const x of (await get('/api/state')).json.sessions) await del(`/api/sessions/${x.id}`);
});

// ---------------- fund fra den uafhængige gennemgang ----------------
const cleanup = async () => {
  for (const x of (await get('/api/state')).json.sessions) if (x.exitCode == null) await del(`/api/sessions/${x.id}`);
  await until(async () => (await get('/api/state')).json.sessions.every((x) => x.exitCode != null), 8000);
  for (const x of (await get('/api/state')).json.sessions) await del(`/api/sessions/${x.id}`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('en agent der bliver slået ned (nedbrud, kill -9) vises som fejlet – ikke afsluttet', async () => {
  const a = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'sig9' })).json;
  assert.ok(await until(async () => (await sessionState(a.id)).exitCode != null));
  const st = await sessionState(a.id);
  assert.deepEqual([st.status, st.exitCode], ['fejlet', 137]);
  await cleanup();
});

test('Stop virker også på et program der ignorerer det første signal, og efterlader ingen processer', async () => {
  const a = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'hup' })).json;
  await until(async () => (await sessionState(a.id)).lastLine === 'klar');
  const pid = app.sessions.get(a.id).proc.pid;
  assert.ok(alive(pid));
  assert.equal((await del(`/api/sessions/${a.id}`)).status, 200);
  assert.ok(await until(async () => (await sessionState(a.id)).status === 'afsluttet', 6000), 'sessionen slutter, selvom SIGHUP ignoreres');
  assert.equal(alive(pid), false);
  await cleanup();
});

test('når Control Tower lukker, bliver ingen terminaler hængende', async () => {
  const { createSessions } = require('../server/sessions');
  const ss = createSessions({ idleSeconds: 2, maxSessions: 3 });
  const v = ss.create({ repo: 'x', cwd: tmp, kind: 'agent', agent: { id: 'h', name: 'H', command: "trap '' HUP TERM; echo klar; while :; do sleep 1; done" } });
  const pid = ss.get(v.id).proc.pid;
  await until(() => ss.list()[0].lastLine === 'klar');
  ss.closeAll();
  await sleep(300);
  assert.ok(alive(pid), 'ignorerer de pæne signaler');
  ss.forceAll();
  assert.ok(await until(() => !alive(pid), 3000), 'bliver tvunget ned');
  assert.ok(await until(() => ss.running() === 0, 3000));
});

test('at ændre vinduets størrelse får ikke en ventende agent til at se ud som om den arbejder', async () => {
  const a = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'winch' })).json;
  assert.ok(await until(async () => (await sessionState(a.id)).status === 'venter', 6000));
  const c = await connect(a.id);
  c.ws.send(JSON.stringify({ type: 'resize', cols: 131, rows: 41 }));
  assert.ok(await until(() => c.out.includes('tegner-om'), 3000), 'programmet tegner om');
  assert.equal((await sessionState(a.id)).status, 'venter');
  c.ws.close();
  await cleanup();
});

test('historik afspilles mærket som gammel, og flere sessioner af samme agent får numre', async () => {
  const a = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'echo' })).json;
  const b = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'echo' })).json;
  const t = (await post('/api/sessions', { repo: 'beta', kind: 'shell' })).json;
  assert.deepEqual([a.name, b.name, t.name], ['Ekko', 'Ekko 2', 'Terminal']);
  const c = await connect(a.id);
  await until(() => c.first != null);
  assert.equal(c.first.replay, false, 'første åbning er ny – programmets spørgsmål må besvares');
  const again = await connect(a.id);
  await until(() => again.first != null);
  assert.equal(again.first.replay, true, 'senere åbninger er gammel historik');
  again.ws.close();
  c.ws.send(JSON.stringify({ type: 'input', data: 'hej\r' }));
  await until(() => c.out.includes('GOT[hej]'));
  c.ws.close();
  await cleanup();
});

test('for lang tekst afvises tydeligt i stedet for at blive klippet, og usendt tekst stables ikke', async () => {
  const a = (await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'raw' })).json;
  const c = await connect(a.id);
  await until(() => c.out.includes('klar'));
  const long = await post(`/api/sessions/${a.id}/paste`, { text: `${'x'.repeat(60001)}` });
  assert.equal(long.status, 413);
  assert.match(long.json.error, /for lang/);
  const huge = await post(`/api/sessions/${a.id}/paste`, { text: 'æ'.repeat(400000) });
  assert.equal(huge.status, 413, 'også meget store forespørgsler får et rigtigt svar');
  assert.ok(huge.json && huge.json.error);
  await sleep(300);
  assert.ok(!c.out.includes('xxxx') && !c.out.includes('ææ'), 'intet af den afviste tekst er skrevet til agenten');
  assert.equal((await post(`/api/sessions/${a.id}/paste`, { text: `${'y'.repeat(59000)} SLUT` })).status, 200, 'op til grænsen går igennem');
  assert.ok(await until(() => c.out.includes(' SLUT'), 5000), 'hele teksten kom med, også slutningen');
  assert.equal((c.out.match(/y/g) || []).length, 59000);
  assert.equal((await sessionState(a.id)).pendingPaste, true);
  const again = await post(`/api/sessions/${a.id}/paste`, { text: 'mere' });
  assert.deepEqual([again.status, again.json.pending], [409, true]);
  c.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
  assert.ok(await until(async () => (await sessionState(a.id)).pendingPaste === false), 'Enter betyder at teksten er sendt');
  assert.equal((await post(`/api/sessions/${a.id}/paste`, { text: 'mere' })).status, 200);
  c.ws.close();
  await cleanup();
});

test('resumé: tomt repo ved start, mange filer i forvejen, branch-skift og omdøbning', async () => {
  const { baseline, summarize } = require('../server/summary');
  const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d); sh(d, 'git', 'init', '-q', '-b', 'main'); return d; };
  const g = (d, ...a) => sh(d, 'git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a);
  // 1) Repo uden commits ved start: det første commit skal tælle som ændrede filer.
  const e = mk('r-tom');
  const eb = await baseline(e);
  fs.writeFileSync(path.join(e, 'a.txt'), '1\n2\n'); fs.writeFileSync(path.join(e, 'b c.txt'), '1\n');
  g(e, 'add', '.'); g(e, 'commit', '-q', '-m', 'Første');
  const er = await summarize(e, eb);
  assert.deepEqual([er.commits.length, er.files.map((f) => f.path).sort(), er.added], [1, ['a.txt', 'b c.txt'], 3]);
  // 2) 2.500 filer der lå der i forvejen må ikke tilskrives agenten.
  const m = mk('r-mange');
  fs.writeFileSync(path.join(m, 'x.txt'), 'x'); g(m, 'add', '.'); g(m, 'commit', '-q', '-m', 'Start');
  for (let i = 0; i < 2500; i += 1) fs.writeFileSync(path.join(m, `fil-${i}.tmp`), '');
  const mb = await baseline(m);
  assert.equal((await summarize(m, mb)).fileCount, 0);
  // 3) Branch-skift undervejs markeres, så gamle commits ikke bare kaldes nye.
  const b = mk('r-branch');
  fs.writeFileSync(path.join(b, 'f.txt'), '1\n'); g(b, 'add', '.'); g(b, 'commit', '-q', '-m', 'et');
  g(b, 'checkout', '-q', '-b', 'anden'); fs.writeFileSync(path.join(b, 'f.txt'), '2\n'); g(b, 'commit', '-qam', 'to');
  g(b, 'checkout', '-q', 'main');
  const bb = await baseline(b);
  assert.equal((await summarize(b, bb)).moved, false);
  g(b, 'checkout', '-q', 'anden');
  assert.equal((await summarize(b, bb)).moved, true);
  // 4) Omdøbning vises som "gammel → ny", og din egen fil fra før start markeres, selv når den bliver committet.
  const r = mk('r-omdoeb');
  fs.writeFileSync(path.join(r, 'gammel.md'), 'en\nto\ntre\n'); g(r, 'add', '.'); g(r, 'commit', '-q', '-m', 'Start');
  fs.writeFileSync(path.join(r, 'mine noter.txt'), 'mit');
  const rb = await baseline(r);
  g(r, 'mv', 'gammel.md', 'ny "æ".md'); g(r, 'add', '.'); g(r, 'commit', '-q', '-m', 'Flyt');
  const rr = await summarize(r, rb);
  assert.deepEqual(rr.files.map((f) => [f.path, f.preexisting]).sort(), [['gammel.md → ny "æ".md', false], ['mine noter.txt', true]]);
});

test('repos: løs HEAD og genveje (symlinks) til repos håndteres', async () => {
  const { createScanner } = require('../server/repos');
  const { createBrain } = require('../server/brain');
  const r2 = path.join(tmp, 'rod2'); fs.mkdirSync(r2);
  const d = path.join(r2, 'loes'); fs.mkdirSync(d);
  const g = (...a) => sh(d, 'git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a);
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'f'), '1'); g('add', '.'); g('commit', '-q', '-m', 'et');
  fs.writeFileSync(path.join(d, 'f'), '2'); g('commit', '-qam', 'to'); g('checkout', '-q', 'HEAD~1');
  fs.symlinkSync(path.join(root, 'beta'), path.join(r2, 'genvej'));
  fs.writeFileSync(path.join(r2, 'en-fil.txt'), 'x');
  const conf = cfg.clean({ root: r2 });
  const scan = await createScanner(conf, createBrain(conf)).scan(true);
  assert.deepEqual(scan.repos.map((x) => x.name), ['genvej', 'loes']);
  const loes = scan.repos.find((x) => x.name === 'loes');
  assert.deepEqual([loes.branch, loes.detached, /^[0-9a-f]{7}$/.test(loes.oid)], [null, true, true]);
});

test('filer med BOM og skæv frontmatter læses rigtigt', async () => {
  const { parseFrontmatter } = require('../server/skills');
  assert.deepEqual(parseFrontmatter('---\n---\nKrop').meta, {});
  assert.equal(parseFrontmatter('---\n---\nKrop').body, 'Krop');
  assert.equal(parseFrontmatter('--- \nname: x\n--- \nKrop').meta.name, 'x');
  assert.equal(parseFrontmatter("---\r\ndescription: 'it''s: fint'\r\n---\r\nKrop").meta.description, "it's: fint");
  const dir = path.join(root, 'alpha', '.claude', 'skills', 'med-bom');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '\ufeff---\nname: bom-skill\ndescription: Har BOM\n---\n# Titel');
  fs.writeFileSync(path.join(root, 'alpha', 'docs', 'bom.md'), '\ufeff# Overskrift');
  const sk = (await get('/api/skills?repo=alpha')).json.project.find((x) => x.id === 'skills/med-bom/SKILL.md');
  assert.deepEqual([sk.name, sk.description], ['bom-skill', 'Har BOM']);
  assert.equal((await get('/api/brain/file?repo=alpha&path=docs%2Fbom.md')).json.content, '# Overskrift');
  fs.rmSync(dir, { recursive: true }); fs.rmSync(path.join(root, 'alpha', 'docs', 'bom.md'));
});

test('kommandolinje og indstillinger giver klare beskeder', () => {
  const { spawnSync } = require('node:child_process');
  const run = (args, conf) => {
    const file = path.join(tmp, `cli-${Math.random().toString(36).slice(2)}.json`);
    if (conf !== undefined) fs.writeFileSync(file, conf);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), ...args], { env: { ...process.env, CONTROL_TOWER_CONFIG: file }, encoding: 'utf8', timeout: 5000 });
    return { code: r.status, out: r.stdout + r.stderr, file };
  };
  assert.match(run(['--help']).out, /npm start/);
  assert.equal(run(['-h']).code, 0);
  const typo = run(['--no-opne']);
  assert.deepEqual([typo.code, /Ukendt tilvalg: --no-opne/.test(typo.out)], [1, true]);
  const bad = run([], '{ikke json');
  assert.deepEqual([bad.code, /ikke gyldig JSON/.test(bad.out), /\n\s+at /.test(bad.out)], [1, true, false], 'ingen teknisk fejludskrift');
  const arr = run([root], '[1,2]');
  assert.deepEqual([arr.code, /JSON-objekt/.test(arr.out), fs.readFileSync(arr.file, 'utf8')], [1, true, '[1,2]'], 'filen røres ikke');
  const file = run([], JSON.stringify({ root: path.join(root, 'alpha', 'CLAUDE.md') }));
  assert.deepEqual([file.code, /ikke en mappe/.test(file.out)], [1, true]);
  assert.equal(cfg.clean({ root: '~/projekter' }).root, path.join(os.homedir(), 'projekter'));
  assert.equal(run(['--', path.join(tmp, '--findes-ikke')]).code, 1);
});

// ---------------- indstillinger: ny og eksisterende ----------------
test('indstillinger: ny fil oprettes med standardværdier', () => {
  const file = path.join(tmp, 'ny.json');
  const { config, existed, raw } = cfg.load(file);
  assert.equal(existed, false);
  assert.equal(config.agents[0].id, 'claude');
  cfg.save(file, existed ? raw : cfg.DEFAULTS, { root });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.root, root);
  assert.equal(saved.agents[0].command, 'claude');
});

test('indstillinger: en eksisterende fil beholder egne agenter og felter når rodmappen ændres', () => {
  const file = path.join(tmp, 'eksisterende.json');
  fs.writeFileSync(file, JSON.stringify({ root: '/gammel', port: 5000, agents: [{ id: 'min', name: 'Min agent', command: 'min-agent --x' }], egetFelt: 'bliver' }));
  const { existed, raw } = cfg.load(file);
  assert.equal(existed, true);
  cfg.save(file, raw, { root });
  const after = cfg.load(file);
  assert.equal(after.config.root, root);
  assert.equal(after.config.port, 5000);
  assert.deepEqual(after.config.agents, [{ id: 'min', name: 'Min agent', command: 'min-agent --x' }]);
  assert.equal(after.raw.egetFelt, 'bliver');
});

test('indstillinger: ugyldige værdier ryddes væk, og ødelagt JSON giver en klar fejl', () => {
  const c = cfg.clean({ port: 'abc', idleSeconds: 0, brainPaths: ['docs', '../..', '/etc', 5],
    agents: [{ id: 'ok', command: 'x' }, { id: 'ok', command: 'dublet' }, { id: 'bad id!', command: 'x' }, { id: 'tom', command: ' ' }, null] });
  assert.equal(c.port, 4317);
  assert.equal(c.idleSeconds, 8);
  assert.deepEqual(c.brainPaths, ['docs']);
  assert.deepEqual(c.agents.map((a) => a.id), ['ok']);
  const file = path.join(tmp, 'itu.json');
  fs.writeFileSync(file, '{ikke json');
  assert.throws(() => cfg.load(file), /ikke gyldig JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ikke json', 'en ødelagt fil overskrives ikke');
});
