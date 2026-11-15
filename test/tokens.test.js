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
const { createTokens, encodeClaudePath } = require('../server/tokens');

function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T12:00:00`;
}

function makeTempSetup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tokens-'));
  const root = path.join(tmp, 'projects');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: alpha });
  execFileSync('git', ['init', '-q'], { cwd: beta });

  const agyBrainDir = path.join(tmp, 'agy-brain');
  const claudeProjectsDir = path.join(tmp, 'claude-projects');
  const tokensFile = path.join(tmp, 'control-tower.tokens.json');
  fs.mkdirSync(agyBrainDir, { recursive: true });
  fs.mkdirSync(claudeProjectsDir, { recursive: true });

  const config = cfg.clean({
    root,
    port: 4317,
    tokensFile,
    agyBrainDir,
    claudeProjectsDir,
    agents: [
      { id: 'claude', name: 'Claude Code', command: 'claude' },
      { id: 'gemini', name: 'Gemini', command: 'agy' },
    ],
  });
  return { tmp, root, alpha, beta, agyBrainDir, claudeProjectsDir, tokensFile, config };
}

test('tokens: parser Claude og agy logs, deduplikerer streaming og afviser symlinks ud af logmappen', async () => {
  const { tmp, alpha, beta, agyBrainDir, claudeProjectsDir, config } = makeTempSetup();
  try {
    // Hemmelig fil udenfor logmapperne – symlinks hertil må aldrig læses.
    const secretFile = path.join(tmp, 'secret.jsonl');
    fs.writeFileSync(secretFile, JSON.stringify({ input_tokens: 999999, output_tokens: 999999 }) + '\n');

    // 1) Claude Code JSONL med streaming-dublet på samme message.id + ekstra besked for 10 dage siden.
    const claudeProj = path.join(claudeProjectsDir, encodeClaudePath(alpha));
    fs.mkdirSync(claudeProj, { recursive: true });
    const todayIso = new Date(localDay(0)).toISOString();
    const oldIso = new Date(localDay(-10)).toISOString();
    const claudeLines = [
      JSON.stringify({ type: 'user', cwd: alpha, timestamp: todayIso, message: { role: 'user', content: 'HEMMELIG PROMPT' } }),
      // Første streaming-chunk
      JSON.stringify({
        type: 'assistant', cwd: alpha, timestamp: todayIso, requestId: 'req_1',
        message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 10 } },
      }),
      // Endelig chunk for samme msg_1 – må erstatte, ikke lægges oveni
      JSON.stringify({
        type: 'assistant', cwd: alpha, timestamp: todayIso, requestId: 'req_1',
        message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 80 } },
      }),
      // Ældre tur (10 dage siden)
      JSON.stringify({
        type: 'assistant', cwd: alpha, timestamp: oldIso, requestId: 'req_old',
        message: { id: 'msg_old', model: 'claude-sonnet-4-5', usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 } },
      }),
    ];
    fs.writeFileSync(path.join(claudeProj, 'sess-1.jsonl'), claudeLines.join('\n') + '\n');
    try { fs.symlinkSync(secretFile, path.join(claudeProj, 'evil.jsonl')); } catch { /* Windows uden symlink-rettigheder */ }

    // 2) Antigravity (agy) transcript.jsonl med tool_calls der peger ind i beta.
    const agyLog = path.join(agyBrainDir, 'conv-1', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(agyLog), { recursive: true });
    const agyLines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: todayIso, content: 'PRIVAT BESKED' }),
      JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', created_at: todayIso, model: 'gemini-4-hydrogen-high',
        input_tokens: 1000, cache_read_tokens: 500, output_tokens: 250,
        tool_calls: [{ name: 'read_file', args: { Path: path.join(beta, 'README.md') } }],
      }),
    ];
    fs.writeFileSync(agyLog, agyLines.join('\n') + '\n');
    const evilAgy = path.join(agyBrainDir, 'conv-evil', '.system_generated', 'logs');
    fs.mkdirSync(evilAgy, { recursive: true });
    try { fs.symlinkSync(secretFile, path.join(evilAgy, 'transcript.jsonl')); } catch { /* Windows uden symlink-rettigheder */ }

    const tokens = createTokens(config, { getRepoNames: async () => ['alpha', 'beta'] });
    const all = await tokens.report({ period: 'all', fresh: true });
    // Claude: (100+400+50+80) + (200+40) = 630 + 240 = 870
    // Agy: 1000 + 500 + 250 = 1750
    // Total = 2620 (og secretFile's 999999*2 er IKKE med)
    assert.equal(all.totals.total, 2620);
    assert.equal(all.totals.input, 1300);
    assert.equal(all.totals.cacheRead, 900);
    assert.equal(all.totals.cacheWrite, 50);
    assert.equal(all.totals.output, 370);
    assert.equal(all.totals.turns, 3);

    const claudeAgent = all.byAgent.find((a) => a.agentId === 'claude');
    const geminiAgent = all.byAgent.find((a) => a.agentId === 'gemini');
    assert.equal(claudeAgent.total, 870);
    assert.equal(geminiAgent.total, 1750);

    const alphaRepo = all.byRepo.find((r) => r.repo === 'alpha');
    const betaRepo = all.byRepo.find((r) => r.repo === 'beta');
    assert.equal(alphaRepo.total, 870);
    assert.equal(betaRepo.total, 1750);
    assert.equal(alphaRepo.inRoot, true);

    // Periodefilter "today" må kun tælle dagens tal (630 + 1750 = 2380), ikke den 10 dage gamle tur.
    const today = await tokens.report({ period: 'today', fresh: false });
    assert.equal(today.totals.total, 2380);
    assert.equal(today.totals.turns, 2);

    // Indhold fra samtaler må aldrig lækkes i rapporten.
    const serialized = JSON.stringify(all);
    assert.doesNotMatch(serialized, /HEMMELIG PROMPT|PRIVAT BESKED/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tokens: knytter Control Tower-session til log uden dobbelttælling og gemmer på disk', async () => {
  const { tmp, beta, agyBrainDir, tokensFile, config } = makeTempSetup();
  try {
    const startedAt = Date.now() - 2000;
    const ctIso = new Date(startedAt + 500).toISOString();
    const agyLog = path.join(agyBrainDir, 'conv-live', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(agyLog), { recursive: true });
    fs.writeFileSync(agyLog, JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', created_at: ctIso, model: 'gemini-4-hydrogen-high',
      input_tokens: 300, cache_read_tokens: 100, output_tokens: 50,
      tool_calls: [{ name: 'read_file', args: { Path: path.join(beta, 'a.txt') } }],
    }) + '\n');

    const t1 = createTokens(config, { getRepoNames: async () => ['alpha', 'beta'] });
    t1.recordSession('start', {
      id: 'aaaa1111bbbb2222cccc3333',
      repo: 'beta',
      kind: 'agent',
      agentId: 'gemini',
      name: 'Gemini',
      status: 'arbejder',
      startedAt,
      endedAt: null,
    });

    const rep1 = await t1.report({ period: 'all', fresh: true });
    assert.equal(rep1.totals.total, 450, 'loggen tælles kun én gang (ikke både som CT-session og ekstern)');
    assert.equal(rep1.sessions.length, 1);
    assert.equal(rep1.sessions[0].source, 'control-tower');
    assert.equal(rep1.sessions[0].repo, 'beta');

    t1.recordSession('exit', {
      id: 'aaaa1111bbbb2222cccc3333',
      repo: 'beta',
      kind: 'agent',
      agentId: 'gemini',
      name: 'Gemini',
      status: 'afsluttet',
      startedAt,
      endedAt: Date.now(),
    });
    t1.flush();
    assert.ok(fs.existsSync(tokensFile), 'regnskabsfilen gemmes på disk');

    // Simuler at logfilen slettes senere og Control Tower genstartes: regnskabet husker stadig sessionen!
    fs.rmSync(path.join(agyBrainDir, 'conv-live'), { recursive: true, force: true });
    const t2 = createTokens(config, { getRepoNames: async () => ['alpha', 'beta'] });
    const rep2 = await t2.report({ period: 'all', fresh: true });
    assert.equal(rep2.totals.total, 450);
    assert.equal(rep2.byRepo.find((r) => r.repo === 'beta').total, 450);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('API /api/tokens og /api/state: kræver nøgle og returnerer samlet token-regnskab', async () => {
  const { tmp, alpha, agyBrainDir, config } = makeTempSetup();
  const agyLog = path.join(agyBrainDir, 'conv-api', '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(agyLog), { recursive: true });
  fs.writeFileSync(agyLog, JSON.stringify({
    step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date().toISOString(), model: 'gemini-4-hydrogen-high',
    input_tokens: 700, cache_read_tokens: 200, output_tokens: 100,
    tool_calls: [{ name: 'read_file', args: { Path: path.join(alpha, 'index.js') } }],
  }) + '\n');

  const token = 'c'.repeat(64);
  const app = createApp({ config, token });
  const dispatch = (url, withAuth = true) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = url;
    req.headers = { host: '127.0.0.1:4317', ...(withAuth ? { authorization: `Bearer ${token}` } : {}) };
    const res = {
      statusCode: 200,
      headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end(chunk) { resolve({ status: this.statusCode, json: JSON.parse(String(chunk || '{}')) }); },
    };
    app.server.emit('request', req, res);
  });

  try {
    assert.equal((await dispatch('/api/tokens', false)).status, 401);
    const tokRes = await dispatch('/api/tokens?period=today&fresh=1');
    assert.equal(tokRes.status, 200);
    assert.equal(tokRes.json.totals.total, 1000);
    assert.equal(tokRes.json.byRepo[0].repo, 'alpha');

    const stRes = await dispatch('/api/state');
    assert.equal(stRes.status, 200);
    assert.equal(stRes.json.tokenSummary.total.total, 1000);
    assert.equal(stRes.json.tokenSummary.byRepo.alpha.total, 1000);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
