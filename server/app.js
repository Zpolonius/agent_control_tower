'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const sec = require('./security');
const { createBrain } = require('./brain');
const { createScanner } = require('./repos');
const { createSessions, PASTE_MAX } = require('./sessions');
const { createGithub } = require('./github');
const { createSkills } = require('./skills');
const { createTokens } = require('./tokens');
const summary = require('./summary');

const PUBLIC = path.join(__dirname, '..', 'public');
const MODULES = path.join(__dirname, '..', 'node_modules');

// Fast liste over de filer browseren må hente. Alt andet findes ikke – så der er ingen sti at snyde sig igennem.
const STATIC = {
  '/': [path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(PUBLIC, 'app.js'), 'text/javascript; charset=utf-8'],
  '/md.js': [path.join(PUBLIC, 'md.js'), 'text/javascript; charset=utf-8'],
  '/styles.css': [path.join(PUBLIC, 'styles.css'), 'text/css; charset=utf-8'],
  '/favicon.svg': [path.join(PUBLIC, 'favicon.svg'), 'image/svg+xml'],
  '/vendor/xterm.js': [path.join(MODULES, '@xterm', 'xterm', 'lib', 'xterm.js'), 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': [path.join(MODULES, '@xterm', 'xterm', 'css', 'xterm.css'), 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': [path.join(MODULES, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'text/javascript; charset=utf-8'],
};

function createApp({ config, token }) {
  const port = config.port;
  const brain = createBrain(config);
  const scanner = createScanner(config, brain);
  const tokens = createTokens(config, {
    getRepoNames: async () => (await scanner.scan(false)).repos.map((r) => r.name),
  });
  const sessions = createSessions(config, {
    onSessionEvent: (event, view) => tokens.recordSession(event, view),
  });
  const github = createGithub();
  const skills = createSkills(config);
  const headers = sec.securityHeaders(port);

  function send(res, code, body, type) {
    res.writeHead(code, { ...headers, 'Content-Type': type || 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  const fail = (res, code, message) => send(res, code, { error: message });

  function readJson(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        // For stort: stop med at gemme, men læs forespørgslen færdig, så browseren får et rigtigt svar i stedet for en afbrudt forbindelse.
        if (size <= limit) chunks.push(c);
      });
      req.on('end', () => {
        if (size > limit) { const e = new Error('Teksten er for stor til at sende på én gang'); e.status = 413; return reject(e); }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Ugyldig JSON')); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    if (!sec.hostOk(req, port)) return fail(res, 403, 'Ukendt værtsnavn');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = url.pathname;

    // Selve siden (HTML, CSS, JS) er ikke hemmelig og kan hentes uden nøgle. Alt under /api kræver nøglen.
    if (req.method === 'GET' && STATIC[route]) {
      const [file, type] = STATIC[route];
      return fs.readFile(file, (err, data) => (err ? fail(res, 404, 'Ikke fundet') : send(res, 200, data, type)));
    }

    if (!sec.authed(req, token)) return fail(res, 401, 'Ikke logget ind');

    if (req.method === 'GET' && route === '/api/state') {
      const [data] = await Promise.all([
        scanner.scan(url.searchParams.get('fresh') === '1'),
        sessions.refreshWaits(),
      ]);
      const activeSessions = sessions.list();
      const tok = await tokens.summaryForState(activeSessions);
      return send(res, 200, {
        root: config.root, host: sessions.hostname, idleSeconds: config.idleSeconds,
        agents: config.agents.map((a) => ({ id: a.id, name: a.name })), personalSkillsDir: config.personalSkillsDir,
        repos: data.repos, skipped: data.skipped, error: data.error,
        sessions: activeSessions.map((s) => (s.kind === 'agent' ? { ...s, tokens: tok.sessionTokens[s.id] || null } : s)),
        tokenSummary: tok.tokenSummary,
      });
    }

    if (req.method === 'GET' && route === '/api/tokens') {
      const period = url.searchParams.get('period') || 'all';
      const fresh = url.searchParams.get('fresh') === '1';
      return send(res, 200, await tokens.report({ period, fresh, activeSessions: sessions.list() }));
    }

    if (req.method === 'GET' && route === '/api/brain') {
      const dir = scanner.resolve(url.searchParams.get('repo'));
      if (!dir) return fail(res, 404, 'Ukendt repo');
      return send(res, 200, { files: brain.list(dir) });
    }

    if (req.method === 'GET' && route === '/api/brain/file') {
      const dir = scanner.resolve(url.searchParams.get('repo'));
      if (!dir) return fail(res, 404, 'Ukendt repo');
      const file = brain.read(dir, url.searchParams.get('path'));
      return file ? send(res, 200, file) : fail(res, 404, 'Filen findes ikke i hjernen');
    }

    if (req.method === 'GET' && route === '/api/skills') {
      const personal = skills.personal();
      if (url.searchParams.has('repo')) {
        const dir = scanner.resolve(url.searchParams.get('repo'));
        if (!dir) return fail(res, 404, 'Ukendt repo');
        return send(res, 200, { personal, project: skills.project(dir) });
      }
      const data = await scanner.scan(false);
      return send(res, 200, { personal, repos: data.repos.map((r) => ({ repo: r.name, skills: scanner.resolve(r.name) ? skills.project(scanner.resolve(r.name)) : [] })) });
    }

    if (req.method === 'GET' && route === '/api/skills/file') {
      const scope = url.searchParams.get('scope');
      let dir = null;
      if (scope === 'project') {
        dir = scanner.resolve(url.searchParams.get('repo'));
        if (!dir) return fail(res, 404, 'Ukendt repo');
      } else if (scope !== 'personal') return fail(res, 400, 'Ukendt type');
      const file = skills.read(scope, dir, url.searchParams.get('id'));
      return file ? send(res, 200, file) : fail(res, 404, 'Skillen findes ikke');
    }

    if (req.method === 'GET' && route === '/api/prs') {
      const repo = url.searchParams.get('repo');
      const dir = scanner.resolve(repo);
      if (!dir) return fail(res, 404, 'Ukendt repo');
      return send(res, 200, await github.list(repo, dir, url.searchParams.get('fresh') === '1'));
    }

    if (req.method === 'GET' && route === '/api/prs/detail') {
      const dir = scanner.resolve(url.searchParams.get('repo'));
      if (!dir) return fail(res, 404, 'Ukendt repo');
      const number = url.searchParams.get('number') || '';
      if (!/^[1-9][0-9]{0,8}$/.test(number)) return fail(res, 400, 'Ugyldigt PR-nummer');
      return send(res, 200, await github.detail(dir, number));
    }

    const sm = route.match(/^\/api\/sessions\/([a-f0-9]{24})\/summary$/);
    if (req.method === 'GET' && sm) {
      const s = sessions.get(sm[1]);
      if (!s) return fail(res, 404, 'Ukendt session');
      if (s.kind !== 'agent') return send(res, 200, { available: false, reason: 'Resumé findes kun for agenter.' });
      const data = await summary.summarize(s.cwd, s.baseline);
      return send(res, 200, { ...data, startedAt: s.startedAt, endedAt: s.endedAt, lastOutputAt: s.lastOutputAt });
    }

    if (req.method === 'GET' && route === '/api/issues') {
      const repo = url.searchParams.get('repo');
      const dir = scanner.resolve(repo);
      if (!dir) return fail(res, 404, 'Ukendt repo');
      return send(res, 200, await github.issues(repo, dir, url.searchParams.get('fresh') === '1'));
    }

    if (req.method === 'GET' && route === '/api/issues/detail') {
      const dir = scanner.resolve(url.searchParams.get('repo'));
      if (!dir) return fail(res, 404, 'Ukendt repo');
      const number = url.searchParams.get('number') || '';
      if (!/^[1-9][0-9]{0,8}$/.test(number)) return fail(res, 400, 'Ugyldigt issue-nummer');
      return send(res, 200, await github.issue(dir, number));
    }

    // Alt der ændrer noget kræver, at forespørgslen kommer fra Control Towers egen side.
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (!sec.originOk(req, port)) return fail(res, 403, 'Forespørgslen kom ikke fra Control Tower');
    }

    if (req.method === 'POST' && route === '/api/sessions') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(res, 415, 'Forventede JSON');
      let body;
      try { body = await readJson(req); } catch (err) { return fail(res, err.status || 400, err.message); }
      const cwd = scanner.resolve(body.repo);
      if (!cwd) return fail(res, 404, 'Ukendt repo');
      let agent = null;
      if (body.kind === 'agent') {
        // Browseren sender kun et id. Selve kommandoen slås op i din indstillingsfil.
        agent = config.agents.find((a) => a.id === body.agentId);
        if (!agent) return fail(res, 400, 'Ukendt agent');
      } else if (body.kind !== 'shell') return fail(res, 400, 'Ukendt sessionstype');
      try {
        // For agenter huskes repoets tilstand ved start, så der kan vises et resumé bagefter.
        const baseline = body.kind === 'agent' ? await summary.baseline(cwd) : null;
        return send(res, 201, sessions.create({ repo: body.repo, cwd, kind: body.kind, agent, baseline }));
      } catch (err) {
        return fail(res, err.code === 'LIMIT' ? 429 : 500, err.code === 'LIMIT' ? err.message : 'Terminalen kunne ikke startes');
      }
    }

    const pm = route.match(/^\/api\/sessions\/([a-f0-9]{24})\/paste$/);
    if (req.method === 'POST' && pm) {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(res, 415, 'Forventede JSON');
      let body;
      try { body = await readJson(req, 512 * 1024); } catch (err) { return fail(res, err.status || 400, err.message); }
      if (typeof body.text !== 'string') return fail(res, 400, 'Mangler tekst');
      const result = sessions.paste(pm[1], body.text, body.force === true);
      if (result === 'ok') return send(res, 200, { ok: true });
      if (result === 'pending') return send(res, 409, { error: 'Der ligger allerede en usendt tekst hos agenten.', pending: true });
      return fail(res, { gone: 404, 'too-long': 413 }[result] || 400, {
        gone: 'Agenten kører ikke længere', 'not-agent': 'Tekst kan kun sendes til en agent, ikke en almindelig terminal', empty: 'Der var ingen tekst at sende',
        'too-long': `Teksten er for lang til at sende på én gang (${body.text.length.toLocaleString('da-DK')} tegn, maks. ${PASTE_MAX.toLocaleString('da-DK')}). Send færre kommentarer ad gangen.`,
      }[result]);
    }

    const m = route.match(/^\/api\/sessions\/([a-f0-9]{24})$/);
    if (req.method === 'DELETE' && m) {
      return sessions.remove(m[1]) ? send(res, 200, { ok: true }) : fail(res, 404, 'Ukendt session');
    }

    return fail(res, 404, 'Ikke fundet');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) fail(res, 500, 'Intern fejl'); else res.end(); });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, handleProtocols: () => 'ct' });
  server.on('upgrade', (req, socket, head) => {
    // Alt herinde er pakket ind, så en skæv forespørgsel kun bliver afvist – den må aldrig kunne vælte hele programmet.
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const ok = sec.hostOk(req, port) && sec.originOk(req, port) && sec.wsAuthed(req, token)
        && url.pathname === '/ws' && sessions.get(url.searchParams.get('session'));
      if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sendMsg = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
        const client = { onData: (data) => sendMsg({ type: 'data', data }), onExit: (code) => sendMsg({ type: 'exit', code }) };
        const link = sessions.attach(url.searchParams.get('session'), client);
        // "replay" fortæller browseren, at dette er gammel historik – den må ikke svare på spørgsmål heri en gang til.
        sendMsg({ type: 'data', data: link.scrollback || '', replay: link.replay });
        if (link.exitCode != null) sendMsg({ type: 'exit', code: link.exitCode });
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
          if (msg.type === 'input' && typeof msg.data === 'string') link.write(msg.data);
          else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
            && msg.cols >= 10 && msg.cols <= 500 && msg.rows >= 3 && msg.rows <= 300) link.resize(msg.cols, msg.rows);
        });
        ws.on('close', () => link.detach());
        ws.on('error', () => link.detach());
      });
    } catch {
      socket.destroy();
    }
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* allerede lukket */ } });

  // Lukker alt ned og venter kort på, at terminalerne stopper. Dem der ikke gør, bliver tvunget – ingen må blive hængende.
  async function close() {
    sessions.closeAll();
    for (const c of wss.clients) c.terminate();
    wss.close();
    const done = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    for (let i = 0; i < 12 && sessions.running() > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
    if (sessions.running() > 0) { sessions.forceAll(); await new Promise((r) => setTimeout(r, 150)); }
    tokens.flush();
    await done;
  }

  return { server, sessions, close };
}

module.exports = { createApp };
