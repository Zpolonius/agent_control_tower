'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const cfg = require('../server/config');
const { createApp } = require('../server/app');
const worktreeMod = require('../server/worktree');

process.env.SHELL = '/bin/bash';
const PORT = 4409;
const TOKEN = 'c'.repeat(64);
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wt-qa-'));
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
        try { json = JSON.parse(data); } catch { /* ignore */ }
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

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(40);
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
  git(repoA, 'checkout', '-q', '-b', 'base-v2');
  fs.writeFileSync(path.join(repoA, 'v2.txt'), 'v2\n');
  git(repoA, 'add', 'v2.txt');
  git(repoA, 'commit', '-q', '-m', 'V2 base');
  git(repoA, 'checkout', '-q', 'main');

  const repoUnborn = path.join(root, 'unborn');
  fs.mkdirSync(repoUnborn, { recursive: true });
  git(repoUnborn, 'init', '-q', '-b', 'main');

  const repoDetached = makeRepo('detached');
  const sha = git(repoDetached, 'rev-parse', 'HEAD').trim();
  git(repoDetached, 'checkout', '-q', '--detach', sha);

  const config = cfg.clean({
    root,
    port: PORT,
    idleSeconds: 2,
    maxSessions: 2,
    agents: [
      { id: 'echo', name: 'Ekko', command: 'echo "PWD=$PWD"; sleep 1; echo "DONE"' },
    ],
  });
  app = createApp({ config, token: TOKEN });
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
});

test.after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('QA: baseBranch, unborn repo, detached HEAD og .control-tower-worktrees skjult i /api/state', async () => {
  // 1) baseBranch opretter worktree fra valgte basis-branch
  const okBase = await post('/api/sessions', {
    repo: 'alpha', kind: 'agent', agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/from-v2', baseBranch: 'base-v2' },
  });
  assert.equal(okBase.status, 201);
  assert.equal(okBase.json.worktree.baseBranch, 'base-v2');
  const wtPath = app.sessions.get(okBase.json.id).worktree.path;
  assert.equal(fs.existsSync(path.join(wtPath, 'v2.txt')), true);

  // .control-tower-worktrees må ikke dukke op som repo eller skipped i /api/state
  const st = (await get('/api/state?fresh=1')).json;
  assert.ok(!st.repos.some((r) => r.name.includes('worktree')));
  assert.equal(st.skipped, 0);

  // 2) Ikke-eksisterende eller usikkert baseBranch afvises med 400
  assert.equal((await post('/api/sessions', {
    repo: 'alpha', kind: 'agent', agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/bad-base1', baseBranch: 'findes-ikke' },
  })).status, 400);
  assert.equal((await post('/api/sessions', {
    repo: 'alpha', kind: 'agent', agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/bad-base2', baseBranch: '../main' },
  })).status, 400);

  // 3) Unborn repo uden commits afvises med 400
  const unbornRes = await post('/api/sessions', {
    repo: 'unborn', kind: 'agent', agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/unborn' },
  });
  assert.equal(unbornRes.status, 400);

  // 4) Detached HEAD repo kan oprette worktree, men merge cleanup afvises med 409
  const detRes = await post('/api/sessions', {
    repo: 'detached', kind: 'agent', agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/from-detached' },
  });
  assert.equal(detRes.status, 201);
  assert.equal(detRes.json.worktree.baseBranch, null);

  await until(async () => (await sessionState(detRes.json.id)).exitCode != null);
  const detMerge = await post(`/api/sessions/${detRes.json.id}/worktree/cleanup`, { merge: true });
  assert.equal(detMerge.status, 409);

  await cleanupSessions();
});

test('QA: dirty hovedrepo afviser merge pænt uden at slette worktree, og shell worktree fungerer', async () => {
  const alphaDir = path.join(root, 'alpha');
  const sh = await post('/api/sessions', {
    repo: 'alpha', kind: 'shell',
    worktree: { mode: 'new', branch: 'feat/shell-wt' },
  });
  assert.equal(sh.status, 201);
  assert.equal(sh.json.worktree.branch, 'feat/shell-wt');
  const sum = (await get(`/api/sessions/${sh.json.id}/summary`)).json;
  assert.equal(sum.available, false);

  await del(`/api/sessions/${sh.json.id}`);
  await until(async () => (await sessionState(sh.json.id)).exitCode != null);

  // Dirty main repo (ucommittet ændring i hovedrepoet)
  fs.writeFileSync(path.join(alphaDir, 'dirty-main.txt'), 'uncommitted\n');
  try {
    const mergeDirtyMain = await post(`/api/sessions/${sh.json.id}/worktree/cleanup`, { merge: true });
    assert.equal(mergeDirtyMain.status, 409);
    assert.equal(fs.existsSync(app.sessions.get(sh.json.id).worktree.path), true, 'worktree må ikke slettes når merge afvises');
  } finally {
    fs.unlinkSync(path.join(alphaDir, 'dirty-main.txt'));
  }

  await cleanupSessions();
});

test('QA: parallel opstart, maxSessions rollback, og ugyldig JSON body på cleanup', async () => {
  // Parallel auto-branch start + maxSessions rollback (maxSessions=2)
  const [r1, r2, r3] = await Promise.all([
    post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo', worktree: { mode: 'new' } }),
    post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo', worktree: { mode: 'new' } }),
    post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo', worktree: { mode: 'new' } }),
  ]);
  const statuses = [r1.status, r2.status, r3.status].sort();
  assert.deepEqual(statuses, [201, 201, 429]);

  // Kun 2 ekstra worktrees (plus main) må findes – den afviste må ikke efterlade en orphan worktree
  const wtList = git(path.join(root, 'alpha'), 'worktree', 'list', '--porcelain');
  assert.equal((wtList.match(/^worktree /gm) || []).length, 3);

  // Body 'null' på cleanup bør give 400, ikke 500
  const okId = [r1, r2, r3].find((r) => r.status === 201).json.id;
  await until(async () => (await sessionState(okId)).exitCode != null);
  const nullBodyRes = await post(`/api/sessions/${okId}/worktree/cleanup`, 'null');
  assert.equal(nullBodyRes.status, 400, `forventede 400 for body=null, fik ${nullBodyRes.status}`);

  await cleanupSessions();
});

test('QA: concurrent opstart med samme eksplicitte branchnavn bør give 409 (ikke 500)', async () => {
  const [r1, r2] = await Promise.all([
    post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo', worktree: { mode: 'new', branch: 'feat/concurrent-same' } }),
    post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'echo', worktree: { mode: 'new', branch: 'feat/concurrent-same' } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409], `forventede [201, 409], fik [${statuses}]`);
  await cleanupSessions();
});

test('QA: case-mismatched sti på case-insensitivt filsystem (macOS/Windows) må ikke ødelægge cleanup', async (t) => {
  const caseBase = path.join(tmp, 'CaseRepo');
  fs.mkdirSync(caseBase, { recursive: true });
  git(caseBase, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(caseBase, 'a.txt'), 'a\n');
  git(caseBase, 'add', '.');
  git(caseBase, 'commit', '-q', '-m', 'init');

  // Tjek om filsystemet er case-insensitivt
  const altCaseBase = path.join(tmp, 'caserepo');
  if (!fs.existsSync(altCaseBase)) {
    t.skip('Filsystemet er case-sensitivt');
    return;
  }
  const realWtBase = path.join(tmp, 'CaseWtBase');
  fs.mkdirSync(realWtBase, { recursive: true });
  const altWtBase = path.join(tmp, 'casewtbase');

  const wt = await worktreeMod.create({
    repoDir: caseBase,
    repo: 'CaseRepo',
    worktreeBase: realWtBase,
    opts: { mode: 'new', branch: 'feat/case-test' },
    agentId: 'echo',
  });
  const res = await worktreeMod.cleanup({
    repoDir: altCaseBase,
    worktreeBase: altWtBase,
    worktree: wt,
    force: true,
    deleteBranch: true,
  });
  assert.equal(res.ok, true, `cleanup fejlede pga. case-mismatch: ${res.error}`);
});

test('QA: DELETE session når repoDir er slettet bagefter må ikke blokere fjernelse af session', async () => {
  const tempRepo = makeRepo('vanishing');
  const res = await post('/api/sessions', {
    repo: 'vanishing', kind: 'agent', agentId: 'echo',
    worktree: { mode: 'new', branch: 'feat/vanish' },
  });
  assert.equal(res.status, 201);
  await until(async () => (await sessionState(res.json.id)).exitCode != null);

  fs.rmSync(tempRepo, { recursive: true, force: true });
  // Sikkerhed når repoDir mangler: merge afvises (409), force=false afvises (409), og usikker sti/symlink afvises (400)
  const wtBase = path.join(root, '.control-tower-worktrees');
  const wtPath = app.sessions.get(res.json.id).worktree.path;
  assert.equal((await post(`/api/sessions/${res.json.id}/worktree/cleanup`, { merge: true })).status, 409);
  assert.equal((await post(`/api/sessions/${res.json.id}/worktree/cleanup`, { merge: false })).status, 409);
  assert.equal((await worktreeMod.cleanup({
    repoDir: tempRepo, worktreeBase: wtBase, worktree: { path: path.join(wtBase, '..', 'outside'), branch: 'feat/vanish' }, force: true,
  })).status, 400);
  const symDir = path.join(wtBase, 'vanishing', 'sym-escape');
  const outsideDir = path.join(tmp, 'outside-target');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(path.dirname(symDir), { recursive: true });
  fs.symlinkSync(outsideDir, symDir);
  assert.equal((await worktreeMod.cleanup({
    repoDir: tempRepo, worktreeBase: wtBase, worktree: { path: symDir, branch: 'feat/vanish' }, force: true,
  })).status, 400);
  assert.equal(fs.existsSync(outsideDir), true, 'symlink-mål uden for worktreeBase må ikke røres');
  fs.unlinkSync(symDir);

  const delRes = await del(`/api/sessions/${res.json.id}`);
  assert.equal(delRes.status, 200, `kunne ikke slette session efter repoDir blev slettet: ${delRes.text}`);
  assert.equal(fs.existsSync(wtPath), false, 'worktree-mappen skal være ryddet op ved DELETE');
});
