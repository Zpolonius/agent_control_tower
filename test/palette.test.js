'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function createHarness(initialState, overrides = {}) {
  const listeners = new Map();
  const timers = new Set();
  const requests = [];
  const terminalInstances = [];

  class FakeElement {
    constructor(tag, doc) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
      this.parentNode = null;
      this.children = [];
      this.attrs = new Map();
      this.listeners = new Map();
      this.dataset = new Proxy({}, {
        get: (_, prop) => {
          const key = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
          return this.attrs.has(key) ? this.attrs.get(key) : undefined;
        },
        set: (_, prop, val) => {
          const key = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
          this.attrs.set(key, String(val));
          return true;
        },
      });
      this._text = '';
      this.value = '';
      this.checked = false;
      this.open = false;
      this.tabIndex = 0;
      this.scrollWidth = 100;
      this.clientWidth = 100;
      this.style = {};
      this.classList = {
        contains: (c) => this.className.split(/\s+/).filter(Boolean).includes(c),
        add: (...cs) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cs) set.add(c);
          this.className = [...set].join(' ');
        },
        remove: (...cs) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cs) set.delete(c);
          this.className = [...set].join(' ');
        },
        toggle: (c, force) => {
          const on = force !== undefined ? !!force : !this.classList.contains(c);
          if (on) this.classList.add(c);
          else this.classList.remove(c);
          return on;
        },
      };
    }

    get id() { return this.attrs.get('id') || ''; }
    set id(v) { this.attrs.set('id', String(v)); }

    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }

    get hidden() { return this.attrs.has('hidden'); }
    set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }

    get textContent() {
      if (this.children.length) return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
      return this._text;
    }
    set textContent(v) {
      this.children = [];
      this._text = v == null ? '' : String(v);
    }

    set innerHTML(_) { throw new Error('innerHTML is forbidden in Control Tower'); }

    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this.ownerDocument.body || cur === this.ownerDocument.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    setAttribute(k, v) {
      this.attrs.set(String(k), String(v));
      if (k === 'value') this.value = String(v);
    }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }

    append(...nodes) {
      for (const n of nodes) {
        if (n == null || n === false) continue;
        if (typeof n === 'string' || typeof n === 'number') {
          const span = new FakeText(String(n));
          this.children.push(span);
        } else {
          if (n.parentNode) n.remove();
          n.parentNode = this;
          this.children.push(n);
        }
      }
    }

    replaceChildren(...nodes) {
      for (const c of this.children) if (c instanceof FakeElement) c.parentNode = null;
      this.children = [];
      this._text = '';
      this.append(...nodes);
    }

    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }

    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }

    dispatchEvent(ev) {
      ev.target = ev.target || this;
      let cur = this;
      while (cur && !ev.cancelBubble) {
        ev.currentTarget = cur;
        const list = (cur.listeners.get(ev.type) || []).slice();
        for (const fn of list) fn.call(cur, ev);
        cur = ev.bubbles === false ? null : cur.parentNode;
      }
      if (!ev.cancelBubble && ev.bubbles !== false) {
        const docList = (this.ownerDocument.listeners.get(ev.type) || []).slice();
        ev.currentTarget = this.ownerDocument;
        for (const fn of docList) fn.call(this.ownerDocument, ev);
        const winList = (this.ownerDocument.defaultView.listeners.get(ev.type) || []).slice();
        ev.currentTarget = this.ownerDocument.defaultView;
        for (const fn of winList) fn.call(this.ownerDocument.defaultView, ev);
      }
      return !ev.defaultPrevented;
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }

    click() {
      this.dispatchEvent(makeEvent('click', { target: this, bubbles: true }));
    }

    scrollIntoView() {}

    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

    querySelectorAll(sel) {
      const out = [];
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const walk = (node) => {
        for (const c of node.children) {
          if (c instanceof FakeElement) {
            if (parts.some((p) => matchesSimple(c, p))) out.push(c);
            walk(c);
          }
        }
      };
      walk(this);
      return out;
    }

    closest(sel) {
      let cur = this;
      while (cur instanceof FakeElement) {
        if (matchesSimple(cur, sel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
  }

  class FakeText {
    constructor(text) { this.textContent = text; }
  }

  function matchesSimple(el, sel) {
    // Supports compound simple selectors like `.tab[aria-current="page"]`, `#id`, `tag.cls`, `[data-key="x"]`.
    const tokens = sel.match(/(?:#[\w-]+|\.[\w-]+|\[[^\]]+\]|[\w-]+)/g) || [];
    if (!tokens.length) return false;
    for (const tok of tokens) {
      if (tok.startsWith('#')) {
        if (el.id !== tok.slice(1)) return false;
      } else if (tok.startsWith('.')) {
        if (!el.classList.contains(tok.slice(1))) return false;
      } else if (tok.startsWith('[')) {
        const inner = tok.slice(1, -1);
        const eq = inner.indexOf('=');
        if (eq === -1) {
          if (!el.hasAttribute(inner)) return false;
        } else {
          const k = inner.slice(0, eq).trim();
          const v = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1');
          if (el.getAttribute(k) !== v) return false;
        }
      } else if (el.tagName !== tok.toUpperCase()) {
        return false;
      }
    }
    return true;
  }

  function makeEvent(type, props = {}) {
    const ev = {
      type,
      bubbles: props.bubbles !== undefined ? props.bubbles : true,
      cancelable: true,
      defaultPrevented: false,
      cancelBubble: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.cancelBubble = true; },
      ...props,
    };
    return ev;
  }

  const doc = {
    title: '',
    hidden: false,
    listeners: new Map(),
    activeElement: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    createElementNS(_, tag) { return new FakeElement(tag, doc); },
    getElementById(id) {
      const walk = (node) => {
        for (const c of node.children) {
          if (c instanceof FakeElement) {
            if (c.id === id) return c;
            const found = walk(c);
            if (found) return found;
          }
        }
        return null;
      };
      return walk(doc.body);
    },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = doc.listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    dispatchEvent(ev) {
      ev.target = ev.target || doc.body;
      const list = (doc.listeners.get(ev.type) || []).slice();
      for (const fn of list) fn.call(doc, ev);
      if (!ev.cancelBubble) {
        const winList = (win.listeners.get(ev.type) || []).slice();
        for (const fn of winList) fn.call(win, ev);
      }
      return !ev.defaultPrevented;
    },
  };

  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;

  for (const [tag, id] of [
    ['p', 'root'], ['ul', 'summary'], ['button', 'notifybtn'], ['button', 'soundbtn'], ['button', 'refresh'],
    ['div', 'banner'], ['p', 'announce'], ['input', 'filter'], ['button', 'reposort'],
    ['button', 'home'], ['button', 'missionnav'], ['button', 'skillsnav'], ['button', 'tokensnav'],
    ['ul', 'repolist'], ['p', 'skipped'], ['main', 'main'], ['div', 'toast'],
  ]) {
    const el = doc.createElement(tag);
    el.id = id;
    doc.body.append(el);
  }

  const storage = new Map();
  const locationObj = { pathname: '/', search: '', hash: '', host: '127.0.0.1:4471' };
  const historyObj = {
    replaceState(_, __, url) {
      const idx = String(url).indexOf('#');
      locationObj.hash = idx === -1 ? '' : String(url).slice(idx);
    },
    pushState(_, __, url) {
      const idx = String(url).indexOf('#');
      locationObj.hash = idx === -1 ? '' : String(url).slice(idx);
    },
  };

  const win = {
    listeners,
    document: doc,
    location: locationObj,
    history: historyObj,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    matchMedia: () => ({ matches: false }),
    focus() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    renderMarkdown: (md) => {
      const p = doc.createElement('p');
      p.textContent = md || '';
      return p;
    },
    Terminal: class FakeTerminal {
      constructor() {
        this.cols = 80;
        this.rows = 24;
        this.customKeyHandler = null;
        this.focused = false;
        this.openedHost = null;
        terminalInstances.push(this);
      }
      loadAddon() {}
      open(host) {
        this.openedHost = host;
        const ta = doc.createElement('textarea');
        ta.className = 'xterm-helper-textarea';
        host.append(ta);
        this.textarea = ta;
      }
      write() {}
      onData() {}
      onResize() {}
      attachCustomKeyEventHandler(fn) { this.customKeyHandler = fn; }
      focus() {
        this.focused = true;
        if (this.textarea) this.textarea.focus();
      }
      dispose() {}
    },
    FitAddon: { FitAddon: class { fit() {} } },
  };
  doc.defaultView = win;

  class FakeWebSocket {
    constructor() { this.readyState = 1; }
    send() {}
    close() {}
  }
  class FakeResizeObserver {
    observe() {}
    disconnect() {}
  }

  let currentState = structuredClone(initialState);
  async function fakeFetch(url, opts = {}) {
    requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (overrides.fetch) {
      const res = await overrides.fetch(url, opts, currentState);
      if (res) return res;
    }
    const okJson = (data) => ({ ok: true, status: 200, json: async () => structuredClone(data), text: async () => JSON.stringify(data) });
    if (url.startsWith('/api/state')) return okJson(currentState);
    if (url.startsWith('/api/summaries')) return okJson({ summaries: {} });
    if (url.startsWith('/api/issues/detail')) return okJson({ available: true, number: 42, title: 'Fix login', body: 'Details', author: 'alice', updatedAt: new Date().toISOString(), url: 'https://github.com/o/r/issues/42', labels: [], comments: [] });
    if (url.startsWith('/api/issues')) return okJson({ available: true, issues: overrides.issues || [] });
    if (url.startsWith('/api/prs/detail')) return okJson({ available: true, number: 7, title: 'Add palette', body: '', author: 'bob', branch: 'feat', baseBranch: 'main', state: 'OPEN', updatedAt: new Date().toISOString(), url: 'https://github.com/o/r/pull/7', reviews: [], inline: [], comments: [], commits: [], checks: [] });
    if (url.startsWith('/api/prs')) return okJson({ available: true, prs: overrides.prs || [] });
    if (url.startsWith('/api/skills')) return okJson({ project: [], personal: [], repos: [] });
    if (url.startsWith('/api/roles')) return okJson({ roles: [], reports: [] });
    if (url.startsWith('/api/tokens')) return okJson({ totals: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, turns: 0 }, byAgent: [], byRepo: [], byModel: [], byDay: [], sessions: [], sources: {} });
    if (url === '/api/sessions' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const created = {
        id: 'new001',
        name: body.agentId === 'gemini' ? 'Gemini' : 'Claude Code',
        kind: body.kind,
        agentId: body.agentId,
        repo: body.repo,
        status: 'arbejder',
        startedAt: Date.now(),
        lastOutputAt: Date.now(),
        exitCode: null,
      };
      currentState.sessions.push(created);
      return okJson(created);
    }
    if (url.endsWith('/approve') && opts.method === 'POST') {
      return okJson({ ok: true });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'Not found' }) };
  }

  const sandbox = {
    window: win,
    document: doc,
    location: locationObj,
    history: historyObj,
    localStorage: win.localStorage,
    fetch: fakeFetch,
    WebSocket: FakeWebSocket,
    ResizeObserver: FakeResizeObserver,
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    URLSearchParams,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: (fn, ms) => { const id = globalThis.setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { globalThis.clearTimeout(id); timers.delete(id); },
    setInterval: (fn, ms) => { const id = globalThis.setInterval(fn, ms); timers.add(id); return id; },
    clearInterval: (id) => { globalThis.clearInterval(id); timers.delete(id); },
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    JSON,
    encodeURIComponent,
    decodeURIComponent,
  };
  win.window = win;

  vm.runInNewContext(APP_JS, sandbox, { filename: 'public/app.js' });

  const flush = () => new Promise((r) => globalThis.setTimeout(r, 10));

  function pressKey(opts, target) {
    const ev = makeEvent('keydown', { bubbles: true, ...opts });
    if (target) target.dispatchEvent(ev);
    else doc.dispatchEvent(ev);
    return ev;
  }

  function cleanup() {
    for (const id of timers) {
      globalThis.clearTimeout(id);
      globalThis.clearInterval(id);
    }
    timers.clear();
  }

  return { doc, win, location: locationObj, requests, terminalInstances, pressKey, makeEvent, flush, cleanup };
}

function baseState() {
  const now = Date.now();
  return {
    root: '/tmp/projects',
    idleSeconds: 10,
    skipped: 0,
    agents: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'gemini', name: 'Gemini' },
    ],
    repos: [
      { name: 'alpha', branch: 'main', changed: 1, untracked: 0, lastCommit: { time: now - 1000 } },
      { name: 'beta', branch: 'feat/x', changed: 0, untracked: 0, lastCommit: { time: now - 5000 } },
    ],
    sessions: [
      { id: 'sess1111', name: 'Claude Code', kind: 'agent', agentId: 'claude', repo: 'alpha', status: 'arbejder', startedAt: now - 5000, lastOutputAt: now - 500, exitCode: null },
      { id: 'sess2222', name: 'Gemini', kind: 'agent', agentId: 'gemini', repo: 'beta', status: 'venter', needsApproval: true, approvalKey: 'ctrl-k', startedAt: now - 4000, lastOutputAt: now - 2000, exitCode: null },
    ],
    tokenSummary: { total: { total: 1200, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 } },
  };
}

test('Ctrl+K og Cmd+K åbner/lukker semantisk Command Palette, fokuserer søgefeltet og gendanner fokus ved Escape/backdrop', async () => {
  const h = createHarness(baseState());
  try {
    await h.flush();
    const homeBtn = h.doc.getElementById('home');
    homeBtn.focus();
    assert.equal(h.doc.activeElement, homeBtn);

    // Ctrl+K åbner dialogen og fokuserer input
    h.pressKey({ key: 'k', ctrlKey: true });
    const dialog = h.doc.querySelector('[role="dialog"]');
    assert.ok(dialog, 'Command Palette dialog skal findes i DOM');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.hidden, false);
    const input = dialog.querySelector('input');
    assert.ok(input, 'Dialog skal indeholde et søgefelt');
    assert.equal(h.doc.activeElement, input, 'Søgefeltet skal have fokus');

    // Escape lukker dialogen og gendanner fokus
    h.pressKey({ key: 'Escape' }, input);
    assert.ok(dialog.hidden || !dialog.isConnected, 'Escape skal lukke dialogen');
    assert.equal(h.doc.activeElement, homeBtn, 'Fokus skal gendannes til forrige element');

    // Cmd+K (metaKey) åbner igen, og klik på backdrop lukker og gendanner fokus
    h.pressKey({ key: 'k', metaKey: true });
    assert.equal(dialog.hidden, false);
    assert.equal(h.doc.activeElement, input);

    const backdrop = dialog.parentNode;
    assert.ok(backdrop, 'Dialog skal have en backdrop');
    backdrop.dispatchEvent(h.makeEvent('click', { target: backdrop, bubbles: true }));
    assert.ok(dialog.hidden || !dialog.isConnected, 'Backdrop-klik skal lukke dialogen');
    assert.equal(h.doc.activeElement, homeBtn, 'Fokus skal gendannes efter backdrop-klik');

    // Ctrl+K når åben lukker den (toggle)
    h.pressKey({ key: 'k', ctrlKey: true });
    assert.equal(dialog.hidden, false);
    h.pressKey({ key: 'k', ctrlKey: true }, input);
    assert.ok(dialog.hidden || !dialog.isConnected, 'Ctrl+K igen skal toggle/lukke dialogen');
  } finally {
    h.cleanup();
  }
});

test('Command Palette filtrerer og udfører skift til repo, start af agent, navigation samt issues/PRs med piletaster og Enter', async () => {
  const h = createHarness(baseState(), {
    issues: [{ number: 42, title: 'Fix login crash', author: 'alice', updatedAt: new Date().toISOString(), comments: 0, assignees: [], labels: [] }],
    prs: [{ number: 7, title: 'Add keyboard palette', author: 'bob', branch: 'feat/palette', decision: null, draft: false, updatedAt: new Date().toISOString() }],
  });
  try {
    await h.flush();

    const openAndSearch = (q) => {
      h.pressKey({ key: 'k', ctrlKey: true });
      const dialog = h.doc.querySelector('[role="dialog"]');
      const input = dialog.querySelector('input');
      input.value = q;
      input.dispatchEvent(h.makeEvent('input', { target: input, bubbles: true }));
      return { dialog, input, options: () => dialog.querySelectorAll('[role="option"]') };
    };

    // 1. Skift til repo med ArrowDown + Enter
    let p = openAndSearch('beta');
    assert.ok(p.options().length >= 1, 'Skal matche repo beta');
    h.pressKey({ key: 'ArrowDown' }, p.input);
    h.pressKey({ key: 'ArrowUp' }, p.input);
    h.pressKey({ key: 'Enter' }, p.input);
    await h.flush();
    assert.equal(h.location.hash, '#repo=beta');

    // 2. Start konfigureret agent (fx Claude Code) i valgt repo (beta)
    p = openAndSearch('start claude');
    assert.ok(p.options().some((o) => /claude/i.test(o.textContent) && /beta/i.test(o.textContent)));
    h.pressKey({ key: 'Enter' }, p.input);
    await h.flush();
    const postSession = h.requests.find((r) => r.url === '/api/sessions' && r.method === 'POST');
    assert.ok(postSession, 'Skal kalde POST /api/sessions');
    assert.deepEqual(postSession.body, { repo: 'beta', kind: 'agent', agentId: 'claude' });
    assert.equal(h.location.hash, '#repo=beta&view=term%3Anew001');

    // 3. Hop til Regnskab, Skills, Mission Control, Overblik
    for (const [query, expectedHash] of [
      ['regnskab', '#page=tokens'],
      ['skills', '#page=skills'],
      ['mission', '#page=mission'],
      ['overblik', ''],
    ]) {
      p = openAndSearch(query);
      assert.ok(p.options().length >= 1, `Skal matche "${query}"`);
      h.pressKey({ key: 'Enter' }, p.input);
      await h.flush();
      assert.equal(h.location.hash, expectedHash, `Skal navigere til ${expectedHash} for "${query}"`);
    }

    // 4. Hop til åbne Issues og Pull requests for repo (inkl. hentede/cachede issues & PRs)
    p = openAndSearch('issues alpha');
    assert.ok(p.options().length >= 1);
    h.pressKey({ key: 'Enter' }, p.input);
    await h.flush();
    assert.equal(h.location.hash, '#repo=alpha&view=issues');

    // Nu er issues for alpha cachet – søg direkte efter #42 i paletten
    p = openAndSearch('#42');
    assert.ok(p.options().some((o) => o.textContent.includes('42') && o.textContent.includes('Fix login crash')));
    h.pressKey({ key: 'Enter' }, p.input);
    await h.flush();
    assert.equal(h.location.hash, '#repo=alpha&view=issues&issue=42');

    // Pull requests for alpha
    p = openAndSearch('pull requests alpha');
    assert.ok(p.options().length >= 1);
    h.pressKey({ key: 'Enter' }, p.input);
    await h.flush();
    assert.equal(h.location.hash, '#repo=alpha&view=prs');

    // Cachet PR #7
    p = openAndSearch('#7');
    assert.ok(p.options().some((o) => o.textContent.includes('7') && o.textContent.includes('Add keyboard palette')));
    h.pressKey({ key: 'Enter' }, p.input);
    await h.flush();
    assert.equal(h.location.hash, '#repo=alpha&view=prs&pr=7');
  } finally {
    h.cleanup();
  }
});

test('Alt+N hopper direkte til første ventende agent og viser venlig besked når ingen venter', async () => {
  const st = baseState();
  const h = createHarness(st);
  try {
    await h.flush();

    // Global Alt+N hopper direkte til waiting[0] (sess2222 i beta)
    h.pressKey({ key: 'n', altKey: true });
    await h.flush();
    assert.equal(h.location.hash, '#repo=beta&view=term%3Asess2222');

    // Også inde i xterm terminalen (Option+N på Mac kan give code='KeyN' og non-ASCII ev.key)
    assert.ok(h.terminalInstances.length >= 1);
    const term = h.terminalInstances[0];
    assert.equal(typeof term.customKeyHandler, 'function');

    // Skift væk først og test Alt+N inde fra xterm
    h.doc.getElementById('home').click();
    await h.flush();
    assert.equal(h.location.hash, '');

    const res = term.customKeyHandler(h.makeEvent('keydown', { key: '˜', code: 'KeyN', altKey: true }));
    assert.equal(res, false, 'Alt+N i xterm skal opsnappes (returnere false)');
    await h.flush();
    assert.equal(h.location.hash, '#repo=beta&view=term%3Asess2222');

    // Når ingen agent venter, vises toast uden fejl-klasse
    const stNoWait = baseState();
    stNoWait.sessions = stNoWait.sessions.filter((s) => s.status !== 'venter');
    const h2 = createHarness(stNoWait);
    try {
      await h2.flush();
      h2.pressKey({ key: 'n', altKey: true });
      await h2.flush();
      const toast = h2.doc.getElementById('toast');
      assert.ok(toast.classList.contains('show'), 'Skal vise toast når ingen venter');
      assert.equal(toast.classList.contains('bad'), false, 'Toast må ikke være markeret som fejl');
      assert.equal(h2.location.hash, '', 'Skal ikke navigere når ingen venter');
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('xterm Ctrl+K toggler paletten, F6 forlader terminalen, og Gemini Godkend (Ctrl+K) knap virker stadig', async () => {
  const h = createHarness(baseState());
  try {
    await h.flush();

    // Gemini's "Godkend (Ctrl+K)" quick-approve knap på overblikket
    const approveBtn = h.doc.querySelector('[data-key="qctrlk:sess2222"]');
    assert.ok(approveBtn, 'Godkend (Ctrl+K) knap skal findes');
    assert.equal(approveBtn.textContent, 'Godkend (Ctrl+K)');
    approveBtn.click();
    await h.flush();
    const approveReq = h.requests.find((r) => r.url === '/api/sessions/sess2222/approve' && r.method === 'POST');
    assert.ok(approveReq, 'Godkend (Ctrl+K) skal sende approve request');
    assert.deepEqual(approveReq.body, { key: 'ctrl-k' });

    // Åbn terminalen for sess1111
    h.pressKey({ key: 'k', ctrlKey: true });
    const dialog = h.doc.querySelector('[role="dialog"]');
    assert.ok(dialog && !dialog.hidden);
    h.pressKey({ key: 'Escape' }, dialog.querySelector('input'));

    // Gå til terminal via Godkend/Vis eller Alt+N
    h.pressKey({ key: 'n', altKey: true });
    await h.flush();
    const term = h.terminalInstances[0];
    assert.ok(term && term.customKeyHandler);

    // F6 inde fra xterm skal stadig fokusere aktiv fane og returnere false
    const activeTab = h.doc.querySelector('.tab[aria-current="page"]');
    assert.ok(activeTab);
    const f6Res = term.customKeyHandler(h.makeEvent('keydown', { key: 'F6' }));
    assert.equal(f6Res, false);
    assert.equal(h.doc.activeElement, activeTab);

    // Ctrl+K inde fra xterm skal åbne Command Palette og returnere false
    const ctrlKRes = term.customKeyHandler(h.makeEvent('keydown', { key: 'k', ctrlKey: true }));
    assert.equal(ctrlKRes, false);
    assert.equal(dialog.hidden, false);
    assert.equal(h.doc.activeElement, dialog.querySelector('input'));
  } finally {
    h.cleanup();
  }
});

test('styles.css respekterer prefers-reduced-motion og app.js bruger aldrig innerHTML', () => {
  assert.doesNotMatch(APP_JS, /\.innerHTML\b/, 'app.js må aldrig bruge innerHTML');
  assert.match(STYLES_CSS, /\.palette\b/, 'styles.css skal style command palette');
  assert.match(STYLES_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^}]*palette/s, 'palette transition/animation skal respektere prefers-reduced-motion');
});

test('macOS Option+N (Dead/˜ via code KeyN), modifier-isolation og Tab-fokustrap i paletten', async () => {
  const h = createHarness(baseState());
  try {
    await h.flush();

    // Ctrl+Alt+K, Ctrl+Shift+K og Alt+Shift+N må ikke udløse palette eller hop
    h.pressKey({ key: 'k', ctrlKey: true, altKey: true });
    assert.equal(h.doc.querySelector('[role="dialog"]'), null);
    h.pressKey({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(h.doc.querySelector('[role="dialog"]'), null);
    h.pressKey({ key: 'n', altKey: true, shiftKey: true, code: 'KeyN' });
    assert.equal(h.win.location.hash, '');

    // Tab-fokustrap i åben palette cykler mellem input og luk-knap
    h.pressKey({ key: 'k', ctrlKey: true });
    const dialog = h.doc.querySelector('[role="dialog"]');
    const input = dialog.querySelector('input');
    const closeBtn = dialog.querySelector('.palette-close');
    assert.equal(h.doc.activeElement, input);
    h.pressKey({ key: 'Tab' }, input);
    assert.equal(h.doc.activeElement, closeBtn);
    h.pressKey({ key: 'Tab' }, closeBtn);
    assert.equal(h.doc.activeElement, input);

    // macOS Option+N sender ofte key='Dead' eller '˜' med code='KeyN'
    h.pressKey({ key: 'Dead', code: 'KeyN', altKey: true });
    await h.flush();
    assert.equal(dialog.hidden, true);
    assert.equal(h.win.location.hash, '#repo=beta&view=term%3Asess2222');
  } finally {
    h.cleanup();
  }
});

test('Command Palette og Alt+N fejler ikke når state.data mangler (locked) eller repos/agenter er tomme', async () => {
  const h = createHarness({ repos: [], agents: [], sessions: [] }, {
    fetch: async (url) => {
      if (url === '/api/state') return { status: 401, ok: false, json: async () => ({ error: 'locked' }) };
      return { status: 404, ok: false, json: async () => ({}) };
    },
  });
  try {
    await h.flush();
    h.pressKey({ key: 'n', altKey: true, code: 'KeyN' });
    assert.match(h.doc.getElementById('toast').textContent, /Ingen agenter venter/i);

    h.pressKey({ key: 'k', metaKey: true });
    const dialog = h.doc.querySelector('[role="dialog"]');
    assert.ok(dialog && !dialog.hidden);
    const opts = dialog.querySelectorAll('[role="option"]');
    assert.equal(opts.length, 4, 'Kun de 4 navigationspunkter vises når data mangler');
  } finally {
    h.cleanup();
  }
});
