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

  class FakeText {
    constructor(text) { this.textContent = text; }
  }

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
    set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
    set innerHTML(_) { throw new Error('innerHTML is forbidden'); }
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
      if (k === 'selected' && this.parentNode && this.parentNode.tagName === 'SELECT') {
        this.parentNode.value = this.value;
      }
    }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    append(...nodes) {
      for (const n of nodes) {
        if (n == null || n === false) continue;
        if (typeof n === 'string' || typeof n === 'number') {
          this.children.push(new FakeText(String(n)));
        } else {
          if (n.parentNode) n.remove();
          n.parentNode = this;
          this.children.push(n);
          if (this.tagName === 'SELECT' && n.tagName === 'OPTION') {
            if (n.hasAttribute('selected') || this.children.length === 1) this.value = n.value;
          }
        }
      }
    }
    replaceChildren(...nodes) {
      for (const c of this.children) if (c instanceof FakeElement) c.parentNode = null;
      this.children = [];
      this._text = '';
      this.append(...nodes);
    }
    replaceWith(...nodes) {
      if (!this.parentNode) return;
      const p = this.parentNode;
      const idx = p.children.indexOf(this);
      if (idx === -1) return;
      this.parentNode = null;
      const ins = [];
      for (const n of nodes) {
        if (n == null || n === false) continue;
        if (typeof n === 'string' || typeof n === 'number') ins.push(new FakeText(String(n)));
        else { if (n.parentNode) n.remove(); n.parentNode = p; ins.push(n); }
      }
      p.children.splice(idx, 1, ...ins);
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
    contains(node) {
      let cur = node;
      while (cur) { if (cur === this) return true; cur = cur.parentNode; }
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
        for (const fn of (cur.listeners.get(ev.type) || []).slice()) fn.call(cur, ev);
        cur = ev.bubbles === false ? null : cur.parentNode;
      }
      return !ev.defaultPrevented;
    }
    focus() { this.ownerDocument.activeElement = this; }
    click() { this.dispatchEvent(makeEvent('click', { target: this, bubbles: true })); }
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

  function matchesSimple(el, sel) {
    const tokens = sel.match(/(?:#[\w-]+|\.[\w-]+|\[[^\]]+\]|[\w-]+)/g) || [];
    if (!tokens.length) return false;
    for (const tok of tokens) {
      if (tok.startsWith('#')) { if (el.id !== tok.slice(1)) return false; }
      else if (tok.startsWith('.')) { if (!el.classList.contains(tok.slice(1))) return false; }
      else if (tok.startsWith('[')) {
        const inner = tok.slice(1, -1);
        const eq = inner.indexOf('=');
        if (eq === -1) { if (!el.hasAttribute(inner)) return false; }
        else {
          const k = inner.slice(0, eq).trim();
          const v = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1');
          if (el.getAttribute(k) !== v) return false;
        }
      } else if (el.tagName !== tok.toUpperCase()) return false;
    }
    return true;
  }

  function makeEvent(type, props = {}) {
    return {
      type,
      bubbles: props.bubbles !== undefined ? props.bubbles : true,
      cancelable: true,
      defaultPrevented: false,
      cancelBubble: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.cancelBubble = true; },
      ...props,
    };
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
            const f = walk(c);
            if (f) return f;
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
    removeEventListener() {},
    dispatchEvent(ev) {
      for (const fn of (doc.listeners.get(ev.type) || []).slice()) fn.call(doc, ev);
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
    replaceState(_, __, url) { const i = String(url).indexOf('#'); locationObj.hash = i === -1 ? '' : String(url).slice(i); },
    pushState(_, __, url) { const i = String(url).indexOf('#'); locationObj.hash = i === -1 ? '' : String(url).slice(i); },
  };
  const win = {
    listeners, document: doc, location: locationObj, history: historyObj,
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    matchMedia: () => ({ matches: false }), focus() {}, addEventListener() {}, removeEventListener() {},
    renderMarkdown: (md) => { const p = doc.createElement('p'); p.textContent = md || ''; return p; },
    Terminal: class {
      constructor() { this.cols = 80; this.rows = 24; }
      loadAddon() {}
      open(host) { const ta = doc.createElement('textarea'); host.append(ta); }
      write() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} focus() {} dispose() {}
    },
    FitAddon: { FitAddon: class { fit() {} } },
  };
  doc.defaultView = win;

  let currentState = structuredClone(initialState);
  async function fakeFetch(url, opts = {}) {
    requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (overrides.fetch) {
      const res = await overrides.fetch(url, opts, currentState);
      if (res) return res;
    }
    const okJson = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data), text: async () => JSON.stringify(data) });
    if (url.startsWith('/api/state')) return okJson(currentState);
    if (url.startsWith('/api/worktrees')) {
      return okJson({
        currentBranch: 'main', detached: false,
        branches: [{ name: 'main', current: true, checkedOut: true }, { name: 'feat/old', current: false, checkedOut: false }],
        worktrees: [],
      });
    }
    if (url.includes('/summary')) return okJson({ available: true, commits: [], files: [], fileCount: 0, added: 0, removed: 0, uncommitted: false, startedAt: Date.now(), lastOutputAt: Date.now() });
    if (url === '/api/sessions' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const created = {
        id: 'a'.repeat(24),
        name: 'Claude Code',
        kind: body.kind,
        agentId: body.agentId,
        repo: body.repo,
        status: 'arbejder',
        startedAt: Date.now(),
        lastOutputAt: Date.now(),
        exitCode: null,
        worktree: body.worktree ? { branch: body.worktree.branch || 'ct/claude-abc123', baseBranch: 'main', mode: body.worktree.mode || 'new', cleaned: false } : null,
      };
      currentState.sessions.push(created);
      return okJson(created, 201);
    }
    if (url.endsWith('/worktree/cleanup') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const id = url.split('/')[3];
      const sess = currentState.sessions.find((s) => s.id === id);
      if (overrides.dirtyOnce && !body.force && !body.merge) {
        overrides.dirtyOnce = false;
        return okJson({ error: 'Worktree har ucommittede ændringer.', dirty: true }, 409);
      }
      if (sess && sess.worktree) sess.worktree.cleaned = true;
      return okJson({ ok: true, merged: !!body.merge, targetBranch: body.merge ? 'main' : null, branchDeleted: !!body.deleteBranch, branch: sess.worktree.branch });
    }
    return okJson({ error: 'Not found' }, 404);
  }

  const sandbox = {
    window: win, document: doc, location: locationObj, history: historyObj, localStorage: win.localStorage,
    fetch: fakeFetch,
    WebSocket: class { constructor() { this.readyState = 1; } send() {} close() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    URLSearchParams, requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: (fn, ms) => { const id = globalThis.setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { globalThis.clearTimeout(id); timers.delete(id); },
    setInterval: (fn, ms) => { const id = globalThis.setInterval(fn, ms); timers.add(id); return id; },
    clearInterval: (id) => { globalThis.clearInterval(id); timers.delete(id); },
    console, Date, Math, Number, String, Array, Object, Set, Map, Promise, JSON, encodeURIComponent, decodeURIComponent,
  };
  win.window = win;
  vm.runInNewContext(APP_JS, sandbox, { filename: 'public/app.js' });

  return {
    doc, location: locationObj, requests, makeEvent,
    flush: () => new Promise((r) => globalThis.setTimeout(r, 15)),
    cleanup: () => { for (const id of timers) { globalThis.clearTimeout(id); globalThis.clearInterval(id); } timers.clear(); },
  };
}

test('UI viser worktree-branch på både sessionskort og sessionsfane, og tillader opstart samt oprydning/merge', async () => {
  const now = Date.now();
  const sessId = '1'.repeat(24);
  const initialState = {
    root: '/tmp/projects', idleSeconds: 10, skipped: 0,
    agents: [{ id: 'claude', name: 'Claude Code' }],
    repos: [{ name: 'alpha', branch: 'main', oid: '1234567', detached: false, changed: 0, untracked: 0, ahead: 0, behind: 0, gitOk: true, brainFiles: 0, lastCommit: null }],
    sessions: [{
      id: sessId, repo: 'alpha', kind: 'agent', agentId: 'claude', name: 'Claude Code',
      startedAt: now - 60000, lastOutputAt: now - 1000, endedAt: now - 500, exitCode: 0, status: 'afsluttet',
      worktree: { branch: 'feat/parallel-ui', baseBranch: 'main', mode: 'new', cleaned: false },
    }],
    tokenSummary: { total: null, byRepo: {} },
  };

  const opts = { dirtyOnce: true };
  const h = createHarness(initialState, opts);
  try {
    await h.flush();

    // 1. Sessionskort på dashboard viser worktree-branch og oprydningsknapper
    const card = h.doc.querySelector('.deskcard');
    assert.ok(card, 'deskcard skal vises');
    assert.match(card.textContent, /feat\/parallel-ui/, 'sessionskortet skal vise worktree-branchen');

    // Klik på "Fjern worktree" mens dirtyOnce=true -> skal vise "Tving fjernelse"
    const cleanBtn = h.doc.querySelector(`[data-key="wtclean:${sessId}"]`);
    assert.ok(cleanBtn, 'Fjern worktree-knap skal vises på afsluttet worktree-kort');
    cleanBtn.click();
    await h.flush();
    const forceBtn = h.doc.querySelector(`[data-key="wtforce:${sessId}"]`);
    assert.ok(forceBtn, 'Tving fjernelse-knap skal vises efter dirty-afvisning');

    // Klik ind på repoet alpha -> sessionsfanen skal vise worktree-branch
    const openAlpha = h.doc.querySelector('[data-key="card:alpha"]');
    openAlpha.click();
    await h.flush();

    const sessTab = h.doc.querySelector(`[data-key="tab:term:${sessId}"]`);
    assert.ok(sessTab, 'sessionsfane skal findes');
    assert.match(sessTab.textContent, /feat\/parallel-ui/, 'sessionsfanen skal vise worktree-branchen');

    // 2. Åbn Worktree-panelet i repohead og start en ny agent i en worktree
    const wtToggle = h.doc.querySelector('[data-key="wt-toggle"]');
    assert.ok(wtToggle, 'Worktree-knap skal findes i repohead');
    wtToggle.click();
    await h.flush();

    const wtInput = h.doc.getElementById('wtbranch');
    assert.ok(wtInput, 'Worktree branch input skal vises');
    wtInput.value = 'feat/ui-new';
    wtInput.dispatchEvent(h.makeEvent('input', { target: wtInput }));

    const startWtBtn = h.doc.querySelector('[data-key="wtstart:claude"]');
    assert.ok(startWtBtn);
    startWtBtn.click();
    await h.flush();

    const createReq = h.requests.find((r) => r.url === '/api/sessions' && r.method === 'POST');
    assert.ok(createReq, 'POST /api/sessions skal sendes');
    assert.deepEqual(createReq.body.worktree, { mode: 'new', branch: 'feat/ui-new' });
    assert.match(h.doc.querySelector(`[data-key="tab:term:${'a'.repeat(24)}"]`).textContent, /feat\/ui-new/);

    // 3. Gå til den afsluttede session og klik "Merge & ryd op" i terminal-visningen
    h.doc.querySelector(`[data-key="tab:term:${sessId}"]`).click();
    await h.flush();

    const mergeBtn = h.doc.querySelector(`[data-key="termwtmerge:${sessId}"]`);
    assert.ok(mergeBtn, 'Merge & ryd op-knap skal vises i terminal-visningen');
    mergeBtn.click();
    await h.flush();

    const mergeReq = h.requests.find((r) => r.url === `/api/sessions/${sessId}/worktree/cleanup` && r.body.merge === true);
    assert.ok(mergeReq, 'cleanup med merge: true skal være kaldt');
    assert.equal(mergeReq.body.deleteBranch, true);
    assert.match(h.doc.querySelector(`[data-key="tab:term:${sessId}"]`).textContent, /ryddet/, 'fanen skal opdateres efter oprydning');

    assert.match(STYLES_CSS, /\.wtchip\b/);
    assert.doesNotMatch(APP_JS, /\.innerHTML\b/);
  } finally {
    h.cleanup();
  }
});

test('QA UI: XSS-sikker gengivelse af branchnavne uden innerHTML', async () => {
  const now = Date.now();
  const sessId = '2'.repeat(24);
  const evilBranch = 'feat/<img src=x onerror=alert(1)>';
  const initialState = {
    root: '/tmp/projects', idleSeconds: 10, skipped: 0,
    agents: [{ id: 'claude', name: 'Claude Code' }],
    repos: [{ name: 'alpha', branch: 'main', oid: '1234567', detached: false, changed: 0, untracked: 0, ahead: 0, behind: 0, gitOk: true, brainFiles: 0, lastCommit: null }],
    sessions: [{
      id: sessId, repo: 'alpha', kind: 'agent', agentId: 'claude', name: 'Claude Code',
      startedAt: now - 5000, lastOutputAt: now - 1000, endedAt: null, exitCode: null, status: 'arbejder',
      worktree: { branch: evilBranch, baseBranch: 'main', mode: 'new', cleaned: false },
    }],
    tokenSummary: { total: null, byRepo: {} },
  };
  const h = createHarness(initialState, {
    fetch: async (url) => {
      if (url.startsWith('/api/worktrees')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            currentBranch: 'main', detached: false,
            branches: [{ name: 'main', current: true, checkedOut: true }, { name: evilBranch, current: false, checkedOut: false }],
            worktrees: [],
          }),
          text: async () => '{}',
        };
      }
      return null;
    },
  });
  try {
    await h.flush();
    assert.equal(h.doc.querySelectorAll('img').length, 0);
    assert.equal(h.doc.querySelectorAll('script').length, 0);
    assert.ok(h.doc.querySelector('.deskcard').textContent.includes(evilBranch));
    h.doc.querySelector('[data-key="card:alpha"]').click();
    await h.flush();
    assert.ok(h.doc.querySelector(`[data-key="tab:term:${sessId}"]`).textContent.includes(evilBranch));
    h.doc.querySelector('[data-key="wt-toggle"]').click();
    await h.flush();
    assert.equal(h.doc.querySelectorAll('img').length, 0);
  } finally {
    h.cleanup();
  }
});

test('QA UI: #rolewtbranch i Roller-fanen har accessible label', async () => {
  const initialState = {
    root: '/tmp/projects', idleSeconds: 10, skipped: 0,
    agents: [{ id: 'claude', name: 'Claude Code' }],
    repos: [{ name: 'alpha', branch: 'main', oid: '1234567', detached: false, changed: 0, untracked: 0, ahead: 0, behind: 0, gitOk: true, brainFiles: 0, lastCommit: null }],
    sessions: [],
    tokenSummary: { total: null, byRepo: {} },
  };
  const h = createHarness(initialState, {
    fetch: async (url) => {
      if (url.startsWith('/api/roles')) {
        return {
          ok: true, status: 200,
          json: async () => ({ roles: [{ id: 'qa', name: 'QA', icon: 'kolbe', mode: 'report', description: 'Test' }], stacks: [], reports: [] }),
          text: async () => '{}',
        };
      }
      return null;
    },
  });
  try {
    await h.flush();
    h.doc.querySelector('[data-key="card:alpha"]').click();
    await h.flush();
    h.doc.querySelector('[data-key="tab:roles"]').click();
    await h.flush();
    const roleWtBranch = h.doc.getElementById('rolewtbranch');
    assert.ok(roleWtBranch, '#rolewtbranch skal findes');
    const hasLabel = !!h.doc.querySelector('label[for="rolewtbranch"]') || !!roleWtBranch.getAttribute('aria-label');
    assert.ok(hasLabel, '#rolewtbranch mangler <label for="rolewtbranch"> eller aria-label');
  } finally {
    h.cleanup();
  }
});

test('QA UI: genåbning af worktree-bar nulstiller brugt/disabled branch og ny-branch kladde', async () => {
  const initialState = {
    root: '/tmp/projects', idleSeconds: 10, skipped: 0,
    agents: [{ id: 'claude', name: 'Claude Code' }],
    repos: [{ name: 'alpha', branch: 'main', oid: '1234567', detached: false, changed: 0, untracked: 0, ahead: 0, behind: 0, gitOk: true, brainFiles: 0, lastCommit: null }],
    sessions: [],
    tokenSummary: { total: null, byRepo: {} },
  };
  let wtCalls = 0;
  const h = createHarness(initialState, {
    fetch: async (url) => {
      if (url.startsWith('/api/worktrees')) {
        wtCalls += 1;
        return {
          ok: true, status: 200,
          json: async () => ({
            currentBranch: 'main', detached: false,
            branches: [
              { name: 'main', current: true, checkedOut: true },
              { name: 'feat/old', current: false, checkedOut: wtCalls > 1 },
              { name: 'feat/free', current: false, checkedOut: false },
            ],
            worktrees: [],
          }),
          text: async () => '{}',
        };
      }
      return null;
    },
  });
  try {
    await h.flush();
    h.doc.querySelector('[data-key="card:alpha"]').click();
    await h.flush();
    h.doc.querySelector('[data-key="wt-toggle"]').click();
    await h.flush();
    const modeSel = h.doc.getElementById('wtmode');
    modeSel.value = 'existing';
    modeSel.dispatchEvent(h.makeEvent('change', { target: modeSel }));
    await h.flush();
    h.doc.querySelector('[data-key="wtstart:claude"]').click();
    await h.flush();

    h.doc.querySelector('[data-key="wt-toggle"]').click();
    await h.flush();
    const existingSel = h.doc.getElementById('wtexisting');
    assert.equal(existingSel.value, 'feat/free', `forventede næste ledige branch feat/free, fik ${existingSel.value}`);

    // Også mode=new rydder branch-input efter opstart, og fokus på #wtbranch bevares når /api/worktrees svarer
    const modeSel2 = h.doc.getElementById('wtmode');
    modeSel2.value = 'new';
    modeSel2.dispatchEvent(h.makeEvent('change', { target: modeSel2 }));
    await h.flush();
    const wtInput = h.doc.getElementById('wtbranch');
    wtInput.value = 'feat/once';
    wtInput.dispatchEvent(h.makeEvent('input', { target: wtInput }));
    h.doc.querySelector('[data-key="wtstart:claude"]').click();
    await h.flush();

    h.doc.querySelector('[data-key="wt-toggle"]').click();
    await h.flush();
    assert.equal(h.doc.getElementById('wtbranch').value, '', 'branch-feltet skal være ryddet efter opstart');
    h.doc.querySelector('[data-key="wt-toggle"]').click(); // luk igen
    h.doc.querySelector('[data-key="wt-toggle"]').click(); // åbn og fokuser før /api/worktrees svarer
    h.doc.getElementById('wtbranch').focus();
    await h.flush();
    assert.equal(h.doc.activeElement.id, 'wtbranch', 'fokus på #wtbranch skal bevares efter /api/worktrees svarer');
  } finally {
    h.cleanup();
  }
});

test('QA UI: Mission Control opdaterer worktree-chip med data-wtprefix bevaret ved oprydning', async () => {
  const now = Date.now();
  const sessId = '4'.repeat(24);
  const stateObj = {
    root: '/tmp/projects', idleSeconds: 10, skipped: 0,
    agents: [{ id: 'claude', name: 'Claude Code' }],
    repos: [{ name: 'alpha', branch: 'main', oid: '1234567', detached: false, changed: 0, untracked: 0, ahead: 0, behind: 0, gitOk: true, brainFiles: 0, lastCommit: null }],
    sessions: [{
      id: sessId, repo: 'alpha', kind: 'agent', agentId: 'claude', name: 'Claude Code',
      startedAt: now - 5000, lastOutputAt: now - 1000, endedAt: now - 100, exitCode: 0, status: 'afsluttet',
      worktree: { branch: 'feat/mc-sync', baseBranch: 'main', mode: 'new', cleaned: false },
    }],
    tokenSummary: { total: null, byRepo: {} },
  };
  const h = createHarness(stateObj, {
    fetch: async (url, _opts, cur) => {
      if (url.startsWith('/api/state')) {
        return { ok: true, status: 200, json: async () => structuredClone(stateObj), text: async () => '{}' };
      }
      return null;
    },
  });
  try {
    await h.flush();
    h.doc.getElementById('missionnav').click();
    await h.flush();
    const chipBefore = h.doc.querySelector(`[data-wtchip="${sessId}"]`);
    assert.ok(chipBefore);
    assert.match(chipBefore.textContent, /^⑂ feat\/mc-sync$/);

    stateObj.sessions[0].worktree.cleaned = true;
    h.doc.getElementById('refresh').click();
    await h.flush();
    const chipAfter = h.doc.querySelector(`[data-wtchip="${sessId}"]`);
    assert.match(chipAfter.textContent, /^⑂ feat\/mc-sync \(ryddet\)$/);
  } finally {
    h.cleanup();
  }
});
