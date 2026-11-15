'use strict';
// Terminal-sessioner. Hver session er en rigtig terminal (pty), der kører på din maskine i et repo.
// Sessionerne lever på serveren, så de fortsætter selvom du lukker browserfanen.
const crypto = require('node:crypto');
const os = require('node:os');
const pty = require('node-pty');
const {
  createWaitChecker, hasApprovalPrompt, inspectQuota, isTaskDone,
  CHROME_RE, FOOTER_RE, INTERRUPT_RE, BARE_PROMPT_RE, TURN_DONE_RE,
} = require('./wait-check');

const SCROLLBACK = 300 * 1024;
const PASTE_MAX = 60000;
const isWin = process.platform === 'win32';

function shellCommand(agentCommand) {
  if (isWin) {
    const exe = 'powershell.exe';
    if (!agentCommand) return [exe, ['-NoLogo']];
    // En sti i anførselstegn skal kaldes med & i PowerShell, og agentens egen afslutningskode gives videre.
    const call = /^\s*["']/.test(agentCommand) ? `& ${agentCommand}` : agentCommand;
    return [exe, ['-NoLogo', '-Command', `${call}; exit $LASTEXITCODE`]];
  }
  const exe = process.env.SHELL || '/bin/bash';
  // Login + interaktiv shell, så PATH (nvm, homebrew osv.) er den samme som i din normale terminal.
  return agentCommand ? [exe, ['-l', '-i', '-c', agentCommand]] : [exe, ['-l']];
}

const isNoiseLine = (l) => !l || CHROME_RE.test(l) || FOOTER_RE.test(l) || INTERRUPT_RE.test(l) || BARE_PROMPT_RE.test(l) || TURN_DONE_RE.test(l);

// Finder den seneste læsbare linje fra agenten, uden farvekoder og styretegn, til taleboblen i overblikket.
// Det er et skøn: programmer der tegner hele skærmen om (som Claude Code) kan give en bundlinje i stedet for en besked.
function lastLine(buffer, errorsFirst) {
  let tail = buffer.slice(-6000);
  // Er der klippet midt i teksten, kan starten være en halv farvekode – spring frem til næste linje.
  if (buffer.length > 6000) tail = tail.slice(Math.max(0, tail.search(/[\r\n]/)));
  const text = tail
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[mhl]/g, '')
    .replace(/\x1b\[\d*C/g, ' ')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.replace(/^[│┃|]+\s*|\s*[│┃|]+$/g, '').trim())
    .filter((l) => !isNoiseLine(l))
    .map((l) => l.replace(/^[\s●⏺•>❯›$#│┃|]+/, '').replace(/\s*[│┃|]+$/, '').trim())
    .filter((l) => !isNoiseLine(l) && l !== 'logout' && (l.match(/\p{L}/gu) || []).length >= 3); // 'logout' er skallens egen afskedshilsen
  const short = (l) => (l.length > 140 ? `${l.slice(0, 139)}…` : l);
  // Stoppede agenten med en fejl, er selve fejlbeskeden mere nyttig end den allersidste linje.
  if (errorsFirst) {
    const err = [...lines].reverse().find((l) => /\b(error|fejl|unable|failed|cannot|can't|not found|denied|fatal)\b/i.test(l));
    if (err) return short(err);
  }
  return lines.length ? short(lines[lines.length - 1]) : '';
}

function createSessions(config, { waitChecker = createWaitChecker(), onSessionEvent } = {}) {
  const sessions = new Map();

  const isIdleAgent = (s) => s.exitCode == null && s.kind === 'agent' && Date.now() - s.lastOutputAt >= config.idleSeconds * 1000;
  const currentWait = (s) => (isIdleAgent(s) ? waitChecker.checkSync(s) : null);

  function updateApprovalState(s) {
    if (s.exitCode != null || s.kind !== 'agent') {
      s.approvalSince = null;
      return false;
    }
    const now = Date.now();
    if (now < s.approvalCooldownUntil || !hasApprovalPrompt(s.buffer)) {
      s.approvalSince = null;
      return false;
    }
    if (!s.approvalSince) s.approvalSince = now;
    return true;
  }

  function needsApproval(s) {
    if (!updateApprovalState(s)) return false;
    if (isIdleAgent(s)) return true;
    const settleMs = Math.min(1500, Math.max(200, config.idleSeconds * 500));
    return Date.now() - s.approvalSince >= settleMs;
  }

  function updateQuotaState(s) {
    if (s.exitCode != null || s.kind !== 'agent') {
      s.quotaSince = null;
      return null;
    }
    const now = Date.now();
    const q = now >= s.approvalCooldownUntil ? inspectQuota(s.buffer) : null;
    if (!q) {
      s.quotaSince = null;
      return null;
    }
    if (!s.quotaSince) s.quotaSince = now;
    return q;
  }

  function activeQuota(s) {
    const q = updateQuotaState(s);
    if (!q) return null;
    if (isIdleAgent(s)) return q;
    const settleMs = Math.min(1500, Math.max(200, config.idleSeconds * 500));
    return Date.now() - s.quotaSince >= settleMs ? q : null;
  }

  function status(s) {
    if (s.exitCode != null) return s.exitCode === 0 || s.killed ? 'afsluttet' : 'fejlet';
    if (s.kind === 'shell') return 'aaben';
    if (needsApproval(s)) return 'venter';
    if (activeQuota(s)) return 'kvote';
    if (!isIdleAgent(s)) return 'arbejder';
    if (currentWait(s)) return 'afventer';
    return isTaskDone(s.buffer, { hadInput: s.hadUserInput }) ? 'faerdig' : 'venter';
  }

  function view(s) {
    const st = status(s);
    const approval = st === 'venter' && s.approvalSince != null;
    const quota = st === 'kvote' ? inspectQuota(s.buffer) : null;
    const wait = st === 'afventer' ? currentWait(s) : null;
    return {
      id: s.id, repo: s.repo, kind: s.kind, agentId: s.agentId, name: s.name,
      startedAt: s.startedAt, lastOutputAt: s.lastOutputAt, endedAt: s.endedAt,
      exitCode: s.exitCode, status: st,
      needsApproval: approval,
      waitingFor: quota ? quota.waitingFor : (wait ? wait.waitingFor : null),
      waitingDetail: quota ? quota.detail : (wait ? wait.detail : null),
      lastLine: s.kind === 'agent' ? lastLine(s.buffer, s.exitCode != null && s.exitCode !== 0 && !s.killed) : '',
      pendingPaste: s.pendingPaste,
    };
  }

  async function refreshWaits() {
    for (const s of sessions.values()) {
      updateApprovalState(s);
      updateQuotaState(s);
    }
    const idle = [...sessions.values()].filter(isIdleAgent);
    if (idle.length) await waitChecker.checkAll(idle);
  }

  // Flere sessioner af samme slags i samme repo får et nummer, så de kan kendes fra hinanden.
  function numbered(name, repo, agentId) {
    const n = [...sessions.values()].filter((x) => x.repo === repo && x.agentId === agentId).length;
    return n ? `${name} ${n + 1}` : name;
  }

  function create({ repo, cwd, kind, agent, baseline, initialPaste }) {
    const running = [...sessions.values()].filter((s) => s.exitCode == null).length;
    if (running >= config.maxSessions) {
      const err = new Error(`Der kører allerede ${running} sessioner (maks. ${config.maxSessions}). Stop eller fjern en session først.`);
      err.code = 'LIMIT';
      throw err;
    }
    const [exe, args] = shellCommand(kind === 'agent' ? agent.command : null);
    const proc = pty.spawn(exe, args, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const now = Date.now();
    const queuedPaste = kind === 'agent' && typeof initialPaste === 'string' && initialPaste.trim().length > 0 ? initialPaste : null;
    const s = {
      id: crypto.randomBytes(12).toString('hex'), repo, kind, cwd, baseline: baseline || null,
      agentId: kind === 'agent' ? agent.id : null,
      name: numbered(kind === 'agent' ? agent.name : 'Terminal', repo, kind === 'agent' ? agent.id : null),
      startedAt: now, lastOutputAt: now, lastInputAt: 0, lastResizeAt: 0, cols: 100, rows: 30, endedAt: null,
      exitCode: null, killed: false, bracketed: false, pendingPaste: false, hadUserInput: false, waitState: null,
      queuedPaste, initialPasteTimer: null,
      approvalSince: null, quotaSince: null, approvalCooldownUntil: 0, approvalTimer: null, buffer: '', clients: new Set(), proc,
    };
    sessions.set(s.id, s);
    proc.onData((data) => {
      // Tegn du selv taster bliver gentaget af terminalen, og et program tegner skærmen om når vinduet ændrer størrelse.
      // Ingen af delene tæller som at agenten arbejder.
      const t = Date.now();
      if (t - s.lastInputAt > 400 && t - s.lastResizeAt > 600) {
        s.lastOutputAt = t;
        s.waitState = null;
      }
      s.buffer += data;
      // Husk om programmet har slået "indsæt-tilstand" til (bruges af paste nedenfor).
      const on = s.buffer.lastIndexOf('\x1b[?2004h');
      const off = s.buffer.lastIndexOf('\x1b[?2004l');
      if (on !== -1 || off !== -1) s.bracketed = on > off;
      if (s.buffer.length > SCROLLBACK) {
        // Klip ved et linjeskift, så historikken ikke starter midt i en farvekode eller et tegn.
        const cut = s.buffer.slice(-SCROLLBACK);
        const nl = cut.indexOf('\n');
        s.buffer = nl !== -1 && nl < 8192 ? cut.slice(nl + 1) : cut;
      }
      if (s.queuedPaste) {
        clearTimeout(s.initialPasteTimer);
        if (s.bracketed) {
          const q = s.queuedPaste;
          s.queuedPaste = null;
          s.initialPasteTimer = null;
          paste(s.id, q);
        } else {
          s.initialPasteTimer = setTimeout(() => {
            s.initialPasteTimer = null;
            if (!s.queuedPaste) return;
            const q = s.queuedPaste;
            s.queuedPaste = null;
            paste(s.id, q);
          }, 900);
          s.initialPasteTimer.unref();
        }
      }
      if (s.kind === 'agent' && !s.approvalTimer) {
        s.approvalTimer = setTimeout(() => {
          s.approvalTimer = null;
          updateApprovalState(s);
          updateQuotaState(s);
        }, 350);
        s.approvalTimer.unref();
      }
      for (const c of s.clients) c.onData(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(s.killTimer1); clearTimeout(s.killTimer2); clearTimeout(s.approvalTimer); clearTimeout(s.initialPasteTimer);
      s.approvalTimer = null; s.initialPasteTimer = null; s.queuedPaste = null;
      // Blev processen slået ned af et signal (nedbrud, kill -9), og var det ikke os selv, er det en fejl – ikke "afsluttet".
      s.exitCode = signal && !s.killed ? 128 + signal : (exitCode ?? 0);
      s.endedAt = Date.now();
      if (s.kind === 'agent' && onSessionEvent) onSessionEvent('exit', view(s));
      for (const c of s.clients) c.onExit(s.exitCode);
    });
    const v = view(s);
    if (s.kind === 'agent' && onSessionEvent) onSessionEvent('start', v);
    return v;
  }

  function get(id) { return typeof id === 'string' ? sessions.get(id) : undefined; }

  function attach(id, client) {
    const s = get(id);
    if (!s) return null;
    s.clients.add(client);
    // Første gang nogen åbner terminalen, er indholdet nyt, og programmets spørgsmål til terminalen skal besvares.
    // Alle senere åbninger (genindlæsning, ekstra fane) er gammel historik, som ikke må besvares igen.
    const replay = !!s.everAttached;
    s.everAttached = true;
    return {
      scrollback: s.buffer, replay, exitCode: s.exitCode,
      write(data) {
        if (s.exitCode != null) return;
        s.lastInputAt = Date.now();
        if (/[\r\n]/.test(data)) s.hadUserInput = true;
        // Enter, Ctrl+C eller Ctrl+U betyder, at en indsat tekst er sendt eller slettet.
        if (/[\r\n\x03\x15]/.test(data)) s.pendingPaste = false;
        if (s.kind === 'agent' && /[\r\n\x03\x1b yYnN1-9]/.test(data)) {
          s.approvalSince = null;
          s.quotaSince = null;
          s.approvalCooldownUntil = Date.now() + 600;
        }
        s.proc.write(data);
      },
      resize(cols, rows) {
        if (s.exitCode != null || (cols === s.cols && rows === s.rows)) return;
        s.cols = cols; s.rows = rows; s.lastResizeAt = Date.now();
        try { s.proc.resize(cols, rows); } catch { /* lukket imens */ }
      },
      detach() { s.clients.delete(client); },
    };
  }

  // Indsætter tekst i en kørende AGENT (aldrig en almindelig terminal, hvor linjeskift ville køre teksten som kommandoer).
  // Der trykkes ikke Enter – du læser selv teksten igennem og sender den.
  function paste(id, text, force) {
    const s = get(id);
    if (!s || s.exitCode != null) return 'gone';
    if (s.kind !== 'agent') return 'not-agent';
    // Styretegn fjernes, så teksten ikke kan snyde terminalen (fx afslutte indsæt-tilstanden og trykke Enter selv).
    const safe = String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    if (!safe.trim()) return 'empty';
    // Hellere en klar fejl end at klippe slutningen af uden at sige det.
    if (safe.length > PASTE_MAX) return 'too-long';
    // Ligger der allerede en usendt tekst hos agenten, ville den nye blive klistret bagpå.
    if (s.pendingPaste && !force) return 'pending';
    s.pendingPaste = true;
    const bracketed = s.bracketed;
    s.lastInputAt = Date.now();
    // Uden indsæt-tilstand ville et linjeskift betyde "send", så dér laves teksten om til én linje.
    s.proc.write(bracketed ? `\x1b[200~${safe.replace(/\n/g, '\r')}\x1b[201~` : safe.replace(/\s*\n\s*/g, ' '));
    return 'ok';
  }

  // Sender et hurtig-svar (fx ja/nej/enter/1/2/esc) direkte til en kørende agent fra overblikket.
  const KEYS = { enter: '\r', yes: 'y\r', no: 'n\r', '1': '1\r', '2': '2\r', esc: '\x1b' };
  function approve(id, key) {
    const s = get(id);
    if (!s || s.exitCode != null) return 'gone';
    if (s.kind !== 'agent') return 'not-agent';
    if (!Object.prototype.hasOwnProperty.call(KEYS, key)) return 'invalid';
    s.lastInputAt = Date.now();
    s.hadUserInput = true;
    s.pendingPaste = false;
    s.approvalSince = null;
    s.quotaSince = null;
    s.approvalCooldownUntil = Date.now() + 600;
    s.proc.write(KEYS[key]);
    return 'ok';
  }

  // Sender et signal til hele processens gruppe (agenten og det den selv har startet).
  function signal(s, sig) {
    if (s.exitCode != null) return;
    try {
      if (isWin) s.proc.kill(); else process.kill(-s.proc.pid, sig);
    } catch {
      try { s.proc.kill(sig); } catch { /* allerede stoppet */ }
    }
  }

  // Først pænt (som når et terminalvindue lukkes), så bestemt, og til sidst tvunget – nogle programmer ignorerer det første.
  function kill(s) {
    if (s.exitCode != null) return;
    clearTimeout(s.initialPasteTimer);
    s.initialPasteTimer = null;
    s.queuedPaste = null;
    s.killed = true;
    signal(s, 'SIGHUP');
    s.killTimer1 = setTimeout(() => signal(s, 'SIGTERM'), 1500);
    s.killTimer2 = setTimeout(() => signal(s, 'SIGKILL'), 3500);
    s.killTimer1.unref(); s.killTimer2.unref();
  }

  // Stopper en kørende session, eller fjerner en afsluttet fra listen.
  function remove(id) {
    const s = get(id);
    if (!s) return false;
    if (s.exitCode == null) kill(s); else sessions.delete(id);
    return true;
  }

  function closeAll() { for (const s of sessions.values()) kill(s); }
  // Bruges når Control Tower selv lukker: der må ikke ligge processer tilbage bagefter.
  function forceAll() { for (const s of sessions.values()) { s.killed = true; signal(s, 'SIGKILL'); } }
  const running = () => [...sessions.values()].filter((s) => s.exitCode == null).length;

  return { create, get, attach, paste, approve, remove, closeAll, forceAll, running, refreshWaits, list: () => [...sessions.values()].map(view), hostname: os.hostname() };
}

module.exports = { createSessions, lastLine, PASTE_MAX };
