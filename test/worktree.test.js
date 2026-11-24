'use strict';
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
const PORT = 4401;
const TOKEN = 'b'.repeat(64);
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wt-test-'));
const root = path.join(tmp, 'projects');
let app;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function makeRepo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  return dir;
}

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: url,
      method,
      headers: {
        Host: `127.0.0.1:${PORT}`,
        ...headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const get = (url) => req('GET', url, { headers: { Authorization: AUTH } });
const post = (url, body) => req('POST', url, { headers: { Authorization: AUTH, Origin: ORIGIN }, body });
const del = (url) => req('DELETE', url, { headers: { Authorization: AUTH, Origin: ORIGIN } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}`, ['ct', `ct.${TOKEN}`], {
      headers: { Origin: ORIGIN },
    });
    const c = { ws, out: '', exit: null };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'data') c.out += m.data;
      else if (m.type === 'exit') c.exit = m.code;
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

const sessionState = async (id) => (await get('/api/state')).json.sessions.find((s) => s.id === id);

async function cleanupSessions() {
  for (const s of (await get('/api/state')).json.sessions) {
    if (s.exitCode == null) await del(`/api/sessions/${s.id}`);
  }
  await until(async () => (await get('/api/state')).json.sessions.every((s) => s.exitCode != null), 8000);
  for (const s of (await get('/api/state')).json.sessions) {
    await del(`/api/sessions/${s.id}`);
  }
}

test.before(async () => {
  fs.mkdirSync(root, { recursive: true });
  const repoA = makeRepo('alpha');
  git(repoA, 'branch', 'existing-feat');
  makeRepo('beta');

  const config = cfg.clean({
    root,
    port: PORT,
    idleSeconds: 2,
    maxSessions: 8,
    agents: [
      { id: 'echo', name: 'Ekko', command: 'echo "CWD=$PWD"; while IFS= read -r l; do echo "GOT[$l]"; done' },
      { id: 'shellcmd', name: 'Runner', command: 'while IFS= read -r l; do eval "$l"; echo "DONE_CMD"; done' },
    ],
  });
  app = createApp({ config, token: TOKEN });
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
});

test.after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('POST /api/sessions med worktree starter agent i isoleret worktree og eksponerer branch i /api/state', async () => {
  const res = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/agent-one' },
  });
  assert.equal(res.status, 201);
  assert.ok(res.json.worktree, 'session skal have worktree metadata');
  assert.equal(res.json.worktree.branch, 'feat/agent-one');
  assert.equal(res.json.worktree.mode, 'new');

  const st = await sessionState(res.json.id);
  assert.ok(st.worktree, 'GET /api/state skal eksponere worktree');
  assert.equal(st.worktree.branch, 'feat/agent-one');
  assert.ok(!('cwd' in st) && !('path' in st.worktree), 'interne filstier må ikke sendes til browseren');

  const c = await connect(res.json.id);
  assert.ok(await until(() => c.out.includes('CWD=')), c.out);
  const match = c.out.match(/CWD=([^\r\n]+)/);
  assert.ok(match, 'CWD output mangler');
  const agentCwd = fs.realpathSync(match[1].trim());
  const mainRepoReal = fs.realpathSync(path.join(root, 'alpha'));
  const wtBaseReal = fs.realpathSync(path.join(root, '.control-tower-worktrees'));
  assert.notEqual(agentCwd, mainRepoReal, 'agenten må ikke køre i hovedrepoets working tree');
  assert.ok(agentCwd.startsWith(wtBaseReal + path.sep), 'worktree skal ligge indeholdt i worktree-mappen');
  assert.equal(git(agentCwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/agent-one');
  c.ws.close();

  await cleanupSessions();
});

test('parallelle worktree-agenter i samme repo blander ikke ændringer i summary og diff', async () => {
  const s1 = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'shellcmd',
    worktree: { mode: 'new', branch: 'feat/parallel-1' },
  });
  const s2 = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'shellcmd',
    worktree: { mode: 'new', branch: 'feat/parallel-2' },
  });
  assert.equal(s1.status, 201);
  assert.equal(s2.status, 201);

  const c1 = await connect(s1.json.id);
  const c2 = await connect(s2.json.id);

  c1.ws.send(JSON.stringify({ type: 'input', data: 'echo "one" > file1.txt && git add file1.txt && git -c user.name=t -c user.email=t@e commit -q -m "Commit 1"\r' }));
  c2.ws.send(JSON.stringify({ type: 'input', data: 'echo "two" > file2.txt\r' }));

  assert.ok(await until(() => c1.out.includes('DONE_CMD')), c1.out);
  assert.ok(await until(() => c2.out.includes('DONE_CMD')), c2.out);

  const sum1 = (await get(`/api/sessions/${s1.json.id}/summary`)).json;
  const sum2 = (await get(`/api/sessions/${s2.json.id}/summary`)).json;

  assert.equal(sum1.available, true);
  assert.deepEqual(sum1.commits.map((c) => c.subject), ['Commit 1']);
  assert.deepEqual(sum1.files.map((f) => f.path), ['file1.txt']);

  assert.equal(sum2.available, true);
  assert.equal(sum2.commits.length, 0);
  assert.deepEqual(sum2.files.map((f) => f.path), ['file2.txt']);

  const diff1 = (await get(`/api/sessions/${s1.json.id}/diff?file=file1.txt`)).json;
  const diff2 = (await get(`/api/sessions/${s2.json.id}/diff?file=file2.txt`)).json;
  assert.equal(diff1.available, true);
  assert.match(diff1.diff, /\+one/);
  assert.equal(diff2.available, true);
  assert.match(diff2.diff, /\+two/);

  // Hovedrepoet på main er helt uberørt
  assert.equal(fs.existsSync(path.join(root, 'alpha', 'file1.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'alpha', 'file2.txt')), false);

  c1.ws.close();
  c2.ws.close();
  await cleanupSessions();
});

test('worktree afviser usikre branchnavne, path traversal, ugyldige tilstande og dobbelt-checkout', async () => {
  for (const bad of [
    '--upload-pack=evil',
    '-b',
    '../escape',
    'feat/../bad',
    'feat;rm -rf /',
    'feat$(id)',
    '.hidden',
    'a..b',
    'HEAD',
    'bad.lock',
  ]) {
    const r = await post('/api/sessions', {
      repo: 'alpha',
      kind: 'agent',
      agentId: 'echo',
      worktree: { mode: 'new', branch: bad },
    });
    assert.equal(r.status, 400, `skal afvise branchnavn: ${bad}`);
  }

  assert.equal((await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'echo',
    worktree: 'feat/string',
  })).status, 400);

  assert.equal((await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'echo',
    worktree: { mode: 'existing', branch: 'findes-ikke' },
  })).status, 400);

  // Eksisterende branch kan tjekkes ud, men ikke dobbelt
  const ex1 = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'echo',
    worktree: { mode: 'existing', branch: 'existing-feat' },
  });
  assert.equal(ex1.status, 201);
  assert.equal(ex1.json.worktree.branch, 'existing-feat');

  const ex2 = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'echo',
    worktree: { mode: 'existing', branch: 'existing-feat' },
  });
  assert.equal(ex2.status, 409);

  await cleanupSessions();
});

test('GET /api/worktrees kræver auth og viser branches uden rå værtsstier', async () => {
  assert.equal((await req('GET', '/api/worktrees?repo=alpha')).status, 401);
  assert.equal((await get('/api/worktrees?repo=..')).status, 404);
  const res = await get('/api/worktrees?repo=alpha');
  assert.equal(res.status, 200);
  assert.ok(res.json.branches.some((b) => b.name === 'main' && b.current === true));
  assert.ok(res.json.branches.some((b) => b.name === 'existing-feat'));
  assert.ok(res.json.worktrees.every((w) => !('path' in w)), 'må ikke lække rå filstier');
});

test('oprydning og merge af worktree fjerner worktree uden efterladte låse, og afviser usikre operationer', async () => {
  const s = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'shellcmd',
    worktree: { mode: 'new', branch: 'feat/merge-me' },
  });
  assert.equal(s.status, 201);
  const c = await connect(s.json.id);

  // Kan ikke rydde op mens sessionen kører
  const whileRunning = await post(`/api/sessions/${s.json.id}/worktree/cleanup`, { merge: false });
  assert.equal(whileRunning.status, 409);

  // Lav et commit og en ucommittet fil
  c.ws.send(JSON.stringify({ type: 'input', data: 'echo "merged" > merged.txt && git add merged.txt && git -c user.name=t -c user.email=t@e commit -q -m "Merged work" && echo "dirty" > temp.txt\r' }));
  assert.ok(await until(() => c.out.includes('DONE_CMD')), c.out);
  c.ws.close();

  // Stop sessionen
  await del(`/api/sessions/${s.json.id}`);
  await until(async () => (await sessionState(s.json.id)).exitCode != null);

  // Merge med ucommittede ændringer afvises (409)
  const dirtyMerge = await post(`/api/sessions/${s.json.id}/worktree/cleanup`, { merge: true });
  assert.equal(dirtyMerge.status, 409);

  // Fjern uden force afvises når dirty (409 + dirty: true)
  const dirtyRemove = await post(`/api/sessions/${s.json.id}/worktree/cleanup`, { merge: false });
  assert.equal(dirtyRemove.status, 409);
  assert.equal(dirtyRemove.json.dirty, true);

  // Usikkert targetBranch afvises
  const badTarget = await post(`/api/sessions/${s.json.id}/worktree/cleanup`, { merge: true, targetBranch: '../bad' });
  assert.equal(badTarget.status, 400);

  // Ryd op i temp.txt og commit eller fjern den via ny session er ikke nødvendig – test merge på ren worktree i stedet:
  // Opret en ren worktree session til merge-test og tving oprydning af den dirty
  const forceRemove = await post(`/api/sessions/${s.json.id}/worktree/cleanup`, { merge: false, force: true, deleteBranch: true });
  assert.equal(forceRemove.status, 200);
  assert.equal(forceRemove.json.ok, true);
  assert.equal((await sessionState(s.json.id)).worktree.cleaned, true);
  await del(`/api/sessions/${s.json.id}`);

  // Ren worktree -> merge + slet branch
  const m = await post('/api/sessions', {
    repo: 'alpha',
    kind: 'agent',
    agentId: 'shellcmd',
    worktree: { mode: 'new', branch: 'feat/clean-merge' },
  });
  const cm = await connect(m.json.id);
  cm.ws.send(JSON.stringify({ type: 'input', data: 'echo "hello" > hello.txt && git add hello.txt && git -c user.name=t -c user.email=t@e commit -q -m "Hello commit"\r' }));
  assert.ok(await until(() => cm.out.includes('DONE_CMD')), cm.out);
  cm.ws.close();
  await del(`/api/sessions/${m.json.id}`);
  await until(async () => (await sessionState(m.json.id)).exitCode != null);

  const merged = await post(`/api/sessions/${m.json.id}/worktree/cleanup`, { merge: true, deleteBranch: true });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.merged, true);
  assert.equal(merged.json.branchDeleted, true);
  assert.equal(fs.existsSync(path.join(root, 'alpha', 'hello.txt')), true);

  // Ingen efterladte worktrees i git worktree list
  const wtList = git(path.join(root, 'alpha'), 'worktree', 'list', '--porcelain');
  assert.equal((wtList.match(/^worktree /gm) || []).length, 1, 'kun hovedrepoet må være tilbage');

  await cleanupSessions();
});

test('sessioner uden worktree opfører sig uændret', async () => {
  const a = await post('/api/sessions', { repo: 'beta', kind: 'agent', agentId: 'echo' });
  const sh = await post('/api/sessions', { repo: 'beta', kind: 'shell' });
  assert.equal(a.status, 201);
  assert.equal(sh.status, 201);
  assert.equal(a.json.worktree, null);
  assert.equal(sh.json.worktree, null);
  await del(`/api/sessions/${a.json.id}`);
  await until(async () => (await sessionState(a.json.id)).exitCode != null);
  assert.equal((await post(`/api/sessions/${a.json.id}/worktree/cleanup`, {})).status, 400);
  await cleanupSessions();
});

test('merge-konflikt afbrydes pænt, låst worktree ryddes op ved DELETE, og usikre cleanup-stier afvises', async () => {
  const worktreeMod = require('../server/worktree');
  const betaDir = path.join(root, 'beta');
  const wtBase = path.join(root, '.control-tower-worktrees');

  // 1) Merge-konflikt afbryder merge uden at efterlade konflikter i hovedrepoet
  const s = await post('/api/sessions', {
    repo: 'beta',
    kind: 'agent',
    agentId: 'shellcmd',
    worktree: true,
  });
  assert.equal(s.status, 201);
  assert.match(s.json.worktree.branch, /^ct\//);
  const c = await connect(s.json.id);
  c.ws.send(JSON.stringify({ type: 'input', data: 'echo "branch-side" > README.md && git add README.md && git -c user.name=t -c user.email=t@e commit -q -m "Branch edit"\r' }));
  assert.ok(await until(() => c.out.includes('DONE_CMD')), c.out);
  c.ws.close();

  // Lav modstridende ændring i beta's main
  fs.writeFileSync(path.join(betaDir, 'README.md'), 'main-side\n');
  git(betaDir, 'add', 'README.md');
  git(betaDir, 'commit', '-q', '-m', 'Main edit');

  await del(`/api/sessions/${s.json.id}`);
  await until(async () => (await sessionState(s.json.id)).exitCode != null);

  const conflictRes = await post(`/api/sessions/${s.json.id}/worktree/cleanup`, { merge: true });
  assert.equal(conflictRes.status, 409);
  assert.match(conflictRes.json.error, /Merge-konflikt/);
  assert.equal(git(betaDir, 'status', '--porcelain').trim(), '', 'hovedrepoet må ikke efterlades i konflikt-tilstand');

  // 2) Lås worktree med git worktree lock og slet derefter sessionen via DELETE – må ikke efterlade låst worktree
  const wtPath = app.sessions.get(s.json.id).worktree.path;
  git(betaDir, 'worktree', 'lock', wtPath);
  const delRes = await del(`/api/sessions/${s.json.id}`);
  assert.equal(delRes.status, 200);
  assert.equal(fs.existsSync(wtPath), false);
  const wtList = git(betaDir, 'worktree', 'list', '--porcelain');
  assert.equal((wtList.match(/^worktree /gm) || []).length, 1, 'låst worktree skal være fjernet');

  // 3) Direkte cleanup-sikkerhedstjek afviser hovedrepo og stier uden for worktreeBase
  const mainAttempt = await worktreeMod.cleanup({
    repoDir: betaDir,
    worktreeBase: wtBase,
    worktree: { path: betaDir, branch: 'main' },
    force: true,
  });
  assert.equal(mainAttempt.ok, false);
  assert.equal(mainAttempt.status, 400);

  const escapeAttempt = await worktreeMod.cleanup({
    repoDir: betaDir,
    worktreeBase: wtBase,
    worktree: { path: path.join(wtBase, '..', 'beta'), branch: 'main' },
    force: true,
  });
  assert.equal(escapeAttempt.ok, false);
  assert.equal(escapeAttempt.status, 400);

  const nonRegistered = path.join(wtBase, 'beta', 'ikke-en-worktree');
  fs.mkdirSync(nonRegistered, { recursive: true });
  const fakeAttempt = await worktreeMod.cleanup({
    repoDir: betaDir,
    worktreeBase: wtBase,
    worktree: { path: nonRegistered, branch: 'feat/x' },
    force: true,
  });
  assert.equal(fakeAttempt.ok, false);
  assert.equal(fakeAttempt.status, 400);
  assert.equal(fs.existsSync(nonRegistered), true, 'ikke-worktree mappe må aldrig slettes');
  fs.rmSync(nonRegistered, { recursive: true, force: true });

  await cleanupSessions();
});
