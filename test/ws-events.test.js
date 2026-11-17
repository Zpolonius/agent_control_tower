'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const cfg = require('../server/config');
const { createApp } = require('../server/app');

process.env.SHELL = '/bin/bash';
const FAKE = path.join(__dirname, '..', 'test-fixtures', 'fake-agent.js');
const TOKEN = 'b'.repeat(64);
const AUTH = `Bearer ${TOKEN}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ws-events-'));
const root = path.join(tmp, 'projects');

let port;
let origin;
let app;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
  });
}

function sh(cwd, ...args) { execFileSync(args[0], args.slice(1), { cwd, stdio: 'ignore' }); }
function makeRepo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return dir;
}

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method,
      headers: { Host: `127.0.0.1:${port}`, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const get = (url) => req('GET', url, { headers: { Authorization: AUTH } });
const post = (url, body) => req('POST', url, { headers: { Authorization: AUTH, Origin: origin }, body });
const del = (url) => req('DELETE', url, { headers: { Authorization: AUTH, Origin: origin } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectEvents(headers = { Origin: origin }, protocols = ['ct', `ct.${TOKEN}`]) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, protocols, { headers });
    const events = [];
    ws.on('message', (raw) => {
      events.push(JSON.parse(raw.toString('utf8')));
    });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}

function connectTerm(id, headers = { Origin: origin }, protocols = ['ct', `ct.${TOKEN}`]) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${id}`, protocols, { headers });
    const messages = [];
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString('utf8')));
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

async function until(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

const sessionView = async (id) => (await get('/api/state')).json.sessions.find((s) => s.id === id);

test.before(async () => {
  port = await findFreePort();
  origin = `http://127.0.0.1:${port}`;
  fs.mkdirSync(root, { recursive: true });
  makeRepo('alpha');
  const config = cfg.clean({
    root,
    port,
    idleSeconds: 2,
    maxSessions: 10,
    tokensFile: false,
    claudeProjectsDir: false,
    agyBrainDir: false,
    agents: [
      { id: 'claude', name: 'Claude', command: `${process.execPath} ${FAKE} claude` },
      { id: 'quick', name: 'Quick', command: 'echo hi; exit 0' },
      { id: 'spam', name: 'Spam', command: `${process.execPath} -e "let i=0; const t=setInterval(()=>{console.log('chunk-'+i); if(++i===12){clearInterval(t); setTimeout(()=>process.exit(0), 200);}}, 40)"` },
    ],
  });
  app = createApp({ config, token: TOKEN });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});

test.after(async () => {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ws-events afviser uautoriseret adgang, forkert origin og forkert host med 403', async () => {
  await assert.rejects(connectEvents({ Origin: 'https://evil.example' }));
  await assert.rejects(connectEvents({ Origin: `http://127.0.0.1:${port + 1}` }));
  await assert.rejects(connectEvents({ Host: `evil.example:${port}`, Origin: origin }));
  await assert.rejects(connectEvents({ Origin: origin }, ['ct']));
  await assert.rejects(connectEvents({ Origin: origin }, ['ct', `ct.${'c'.repeat(64)}`]));
  await assert.rejects(connectEvents({ Origin: origin, Cookie: `ct_session_${port}=${TOKEN}` }, ['ct']));
  await assert.rejects(connectTerm('f'.repeat(24)));

  const ev = await connectEvents();
  assert.equal(ev.ws.protocol, 'ct');
  ev.ws.close();
});

test('ws-events sender letvægts state-changed ved create, paste, exit og remove, mens terminal-WS ikke modtager dem', async () => {
  const ev = await connectEvents();
  try {
    const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'claude' })).json;
    assert.ok(await until(() => ev.events.some((e) => e.type === 'state-changed' && e.sessionId === s.id && e.reason === 'create')), 'create event modtaget');

    const createEv = ev.events.find((e) => e.sessionId === s.id && e.reason === 'create');
    assert.deepEqual(Object.keys(createEv).sort(), ['reason', 'sessionId', 'type']);

    const term = await connectTerm(s.id);
    try {
      const beforeCount = ev.events.length;
      const pr = await post(`/api/sessions/${s.id}/paste`, { text: 'hello' });
      assert.equal(pr.status, 200);
      assert.ok(await until(() => ev.events.slice(beforeCount).some((e) => e.type === 'state-changed' && e.sessionId === s.id)), 'paste event modtaget');

      // Luk sessionen via 'q' eller delete/exit
      await del(`/api/sessions/${s.id}`);
      assert.ok(await until(() => ev.events.some((e) => e.type === 'state-changed' && e.sessionId === s.id && e.reason === 'exit')), 'exit event modtaget');
      assert.equal(term.messages.some((m) => m.type === 'state-changed'), false, 'terminal WS må ikke modtage state-changed');

      const beforeRemove = ev.events.length;
      const dr = await del(`/api/sessions/${s.id}`);
      assert.equal(dr.status, 200);
      assert.ok(await until(() => ev.events.slice(beforeRemove).some((e) => e.type === 'state-changed' && e.sessionId === s.id && e.reason === 'remove')), 'remove event modtaget');
    } finally {
      term.ws.close();
    }
  } finally {
    ev.ws.close();
  }
});

test('ws-events pusher straks ved statusskift arbejder -> faerdig/venter uden at spamme pr. dataklump', async () => {
  const ev = await connectEvents();
  try {
    // 1. Test at hurtig datastrøm ikke spammer state-changed pr. chunk
    const spam = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'spam' })).json;
    assert.ok(await until(() => ev.events.some((e) => e.sessionId === spam.id && e.reason === 'exit')), 'spam session afsluttede');
    const spamEvents = ev.events.filter((e) => e.sessionId === spam.id);
    assert.ok(spamEvents.length <= 3, `forventede højst få events for spam-chunks, fik ${spamEvents.length}: ${JSON.stringify(spamEvents)}`);
    await del(`/api/sessions/${spam.id}`);

    // 2. Test arbejder -> faerdig når idleSeconds udløber
    const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'claude' })).json;
    assert.ok(await until(() => ev.events.some((e) => e.sessionId === s.id && e.reason !== 'create')), 'agent blev klar efter idleSeconds');
    const term = await connectTerm(s.id);
    try {
      const before = ev.events.length;
      term.ws.send(JSON.stringify({ type: 'input', data: 'fpdone\r' }));
      // Skifter til arbejder med det samme, og derefter til faerdig når idleSeconds (2s) er gået
      assert.ok(await until(() => ev.events.slice(before).some((e) => e.sessionId === s.id && e.reason === 'status'), 10000), 'arbejder/status event');
      assert.ok(await until(async () => {
        const recent = ev.events.slice(before);
        if (recent.length < 2) return false;
        const v = await sessionView(s.id);
        return v && v.status === 'faerdig';
      }, 10000), 'skiftede til faerdig via idle-timer');
      await del(`/api/sessions/${s.id}`);
      await until(() => ev.events.some((e) => e.sessionId === s.id && e.reason === 'exit'));
      await del(`/api/sessions/${s.id}`);
    } finally {
      term.ws.close();
    }
  } finally {
    ev.ws.close();
  }
});

test('ws-events pusher straks når godkendelse dukker op og når den besvares/ryddes', async () => {
  const ev = await connectEvents();
  try {
    const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'claude' })).json;
    const term = await connectTerm(s.id);
    try {
      assert.ok(await until(async () => (await sessionView(s.id)).status === 'venter'));
      let mark = ev.events.length;
      term.ws.send(JSON.stringify({ type: 'input', data: 'approve\r' }));

      // Skal modtage state-changed når godkendelsesprompten opdages
      assert.ok(await until(async () => {
        const got = ev.events.slice(mark).some((e) => e.sessionId === s.id && e.reason === 'approval');
        if (!got) return false;
        const v = await sessionView(s.id);
        return v && v.needsApproval === true;
      }, 12000), 'godkendelsesprompt udløste approval state-changed');

      mark = ev.events.length;
      const appRes = await post(`/api/sessions/${s.id}/approve`, { key: '1' });
      assert.equal(appRes.status, 200);
      assert.ok(await until(() => ev.events.slice(mark).some((e) => e.sessionId === s.id && (e.reason === 'approve' || e.reason === 'approval'))), 'approve udløste state-changed');
      const vAfter = await sessionView(s.id);
      assert.equal(vAfter.needsApproval, false);

      await del(`/api/sessions/${s.id}`);
      await until(() => ev.events.some((e) => e.sessionId === s.id && e.reason === 'exit'));
      await del(`/api/sessions/${s.id}`);
    } finally {
      term.ws.close();
    }
  } finally {
    ev.ws.close();
  }
});

test('ws-events pusher straks ved kvote-stop og til klienter der forbinder mens en session allerede kører', async () => {
  const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'claude' })).json;
  // Forbind event-WS EFTER sessionen allerede er startet
  const ev = await connectEvents();
  const term = await connectTerm(s.id);
  try {
    assert.ok(await until(async () => (await sessionView(s.id)).status === 'venter'));
    const mark = ev.events.length;
    term.ws.send(JSON.stringify({ type: 'input', data: 'quota\r' }));

    assert.ok(await until(async () => {
      const got = ev.events.slice(mark).some((e) => e.sessionId === s.id && e.reason === 'quota');
      if (!got) return false;
      const v = await sessionView(s.id);
      return v && v.status === 'kvote';
    }, 12000), 'kvote-stop udløste quota state-changed til ny event-klient');

    await del(`/api/sessions/${s.id}`);
    await until(() => ev.events.some((e) => e.sessionId === s.id && e.reason === 'exit'));
    await del(`/api/sessions/${s.id}`);
  } finally {
    term.ws.close();
    ev.ws.close();
  }
});

test('ws-events pusher straks ved terminal-write svar på godkendelse og ved arbejder -> afventer', async () => {
  const ev = await connectEvents();
  try {
    const s = (await post('/api/sessions', { repo: 'alpha', kind: 'agent', agentId: 'claude' })).json;
    const term = await connectTerm(s.id);
    try {
      assert.ok(await until(async () => (await sessionView(s.id)).status === 'venter'));

      // Godkendelse besvares via terminal-input ('1') -> skal rydde og pushe straks
      let mark = ev.events.length;
      term.ws.send(JSON.stringify({ type: 'input', data: 'approve\r' }));
      assert.ok(await until(async () => {
        const got = ev.events.slice(mark).some((e) => e.sessionId === s.id && e.reason === 'approval');
        return got && (await sessionView(s.id)).needsApproval === true;
      }, 12000));

      mark = ev.events.length;
      term.ws.send(JSON.stringify({ type: 'input', data: '1' }));
      assert.ok(await until(() => ev.events.slice(mark).some((e) => e.sessionId === s.id && (e.reason === 'approval' || e.reason === 'status'))), 'terminal write svar på godkendelse udløste state-changed');
      assert.equal((await sessionView(s.id)).needsApproval, false);

      // Vent til agenten er færdig efter approve-scenarioet, og test arbejder -> afventer
      assert.ok(await until(async () => (await sessionView(s.id)).status === 'faerdig', 12000));
      mark = ev.events.length;
      term.ws.send(JSON.stringify({ type: 'input', data: 'bg\r' }));
      assert.ok(await until(async () => {
        const got = ev.events.slice(mark).some((e) => e.sessionId === s.id);
        if (!got) return false;
        const v = await sessionView(s.id);
        return v && v.status === 'afventer';
      }, 12000), 'arbejder -> afventer via idle-timer udløste state-changed');

      await del(`/api/sessions/${s.id}`);
      await until(() => ev.events.some((e) => e.sessionId === s.id && e.reason === 'exit'));
      await del(`/api/sessions/${s.id}`);
    } finally {
      term.ws.close();
    }
  } finally {
    ev.ws.close();
  }
});

test('public/app.js forbinder /ws/events, coalescer refresh(), bruger backoff og 30000ms fallback-polling og stopper ved 401', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  function makeNode(tag = 'div') {
    const attrs = {};
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      hidden: false,
      disabled: false,
      value: '',
      dataset: {},
      style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      children: [],
      isConnected: true,
      clientWidth: 100,
      addEventListener() {},
      removeEventListener() {},
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = kids; },
      remove() {},
      focus() {},
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      removeAttribute(k) { delete attrs[k]; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
    };
    return node;
  }

  const byId = new Map();
  const getEl = (id) => {
    if (!byId.has(id)) byId.set(id, makeNode('div'));
    return byId.get(id);
  };

  const intervals = [];
  const timeouts = [];
  const sockets = [];
  const fetchQueue = [];
  let fetchStatus = 200;
  let fetchCalls = 0;

  class MockWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.closed = false;
      sockets.push(this);
    }
    send() {}
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    openNow() {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }
    emitMsg(obj) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
    }
    emitClose() {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }
  }

  const fakeDoc = {
    hidden: false,
    title: '',
    activeElement: null,
    body: makeNode('body'),
    getElementById: getEl,
    createElement: (t) => makeNode(t),
    createElementNS: (_ns, t) => makeNode(t),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const fakeWin = {
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
  };

  const ctx = {
    window: fakeWin,
    document: fakeDoc,
    location: { hash: `#token=${TOKEN}`, host: `127.0.0.1:${port}`, protocol: 'http:', pathname: '/', search: '' },
    history: { replaceState(_s, _t, url) { ctx.location.hash = (url.split('#')[1] ? `#${url.split('#')[1]}` : ''); } },
    localStorage: { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } },
    CSS: { escape: (s) => s },
    WebSocket: MockWebSocket,
    fetch: () => {
      fetchCalls += 1;
      return new Promise((resolve) => {
        fetchQueue.push(() => resolve({
          ok: fetchStatus === 200,
          status: fetchStatus,
          json: async () => (fetchStatus === 200
            ? { repos: [], skipped: 0, sessions: [], agents: [], tokenSummary: null }
            : { error: 'Ikke logget ind' }),
        }));
      });
    },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timeouts.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    URLSearchParams,
    Notification: undefined,
    console,
    Math,
    JSON,
    Promise,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Date,
    encodeURIComponent,
    decodeURIComponent,
  };
  ctx.globalThis = ctx;

  vm.runInNewContext(code, ctx);

  // 1. Verificer fallback-interval på 30000ms (og ingen 3000ms polling)
  assert.ok(intervals.some((i) => i.ms === 30000), 'fallback polling interval skal være 30000ms');
  assert.ok(!intervals.some((i) => i.ms === 3000), '3000ms polling må ikke længere findes');

  // 2. Verificer /ws/events forbindelse med subprotokoller ['ct', 'ct.' + token]
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, `ws://127.0.0.1:${port}/ws/events`);
  assert.deepEqual([...sockets[0].protocols], ['ct', `ct.${TOKEN}`]);
  sockets[0].openNow();

  // 3. Verificer in-flight coalescing: 1 fetch kører allerede; 5 samtidige state-changed giver kun 1 ekstra fetch
  assert.equal(fetchCalls, 1);
  for (let i = 0; i < 5; i += 1) sockets[0].emitMsg({ type: 'state-changed', reason: 'status', sessionId: 'abc' });
  assert.equal(fetchCalls, 1, 'nye parallelle fetches må ikke starte mens én er i gang');

  // Løs første fetch -> præcis én coalesced opfølgnings-fetch starter
  fetchQueue.shift()();
  await sleep(20);
  assert.equal(fetchCalls, 2, '5 samtidige signaler coalesces til præcis 1 opfølgnings-fetch');
  fetchQueue.shift()();
  await sleep(20);
  assert.equal(fetchCalls, 2);

  // 4. Verificer reconnect med eksponentiel backoff ved close
  sockets[0].emitClose();
  const retry1 = timeouts.find((t) => !t.cleared && t.ms === 1000);
  assert.ok(retry1, 'første reconnect skal vente 1000ms');
  retry1.fn();
  assert.equal(sockets.length, 2);
  sockets[1].emitClose();
  const retry2 = timeouts.find((t) => !t.cleared && t.ms === 2000);
  assert.ok(retry2, 'anden reconnect skal bruge backoff 2000ms');

  // 5. Verificer at 401 låser klienten og stopper WS-reconnect
  retry2.fn();
  assert.equal(sockets.length, 3);
  sockets[2].openNow();
  await sleep(20);
  assert.equal(fetchCalls, 3, 'reconnect onopen henter frisk tilstand');
  fetchStatus = 401;
  fetchQueue.shift()();
  await sleep(20);
  assert.equal(sockets[2].closed, true, '401 skal lukke event-WebSocket');
  const activeRetriesAfter401 = timeouts.filter((t) => !t.cleared && t.ms >= 1000 && t !== retry1 && t !== retry2);
  assert.equal(activeRetriesAfter401.length, 0, '401 må ikke planlægge ny reconnect');
});
