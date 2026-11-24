'use strict';
// Terminal-sessioner. Hver session er en rigtig terminal (pty), der kører på din maskine i et repo.
// Sessionerne lever på serveren, så de fortsætter selvom du lukker browserfanen.
const crypto = require('node:crypto');
const os = require('node:os');
const pty = require('node-pty');
const { Terminal: ScreenTerminal } = require('@xterm/headless');
const {
  createWaitChecker, findApprovalOnScreen, inspectQuota, isTaskDone, SCREEN_QUOTA,
  CHROME_RE, FOOTER_RE, INTERRUPT_RE, BARE_PROMPT_RE, TURN_DONE_RE,
} = require('./wait-check');

const SCROLLBACK = 300 * 1024;
const PASTE_MAX = 60000;
// Hvor længe en agent skal være stille efter opstart, før rollens beskrivelse indsættes – og hvor længe der højst ventes.
const BRIEF_QUIET_MS = 1500;
const BRIEF_MAX_WAIT_MS = 20000;
// Skriver agenten slet intet efter start, ventes der lidt længere end ellers, så et langsomt program kan nå at starte.
const BRIEF_SILENT_MS = 5000;
const isWin = process.platform === 'win32';
// Hvor mange linjer over den synlige skærm der også kigges på (fx et spørgsmål der lige er rullet lidt op).
const SCREEN_EXTRA = 40;
const SCREEN_LIMIT = 80;
// Taster der besvarer et spørgsmål: Enter, et tal, j/n/y, Esc alene eller Ctrl+C. Piletaster (Esc + [) er ikke et svar.
const ANSWER_RE = /^(?:[0-9yYnNjJ]|\x1b|\x03)$|[\r\n]/;

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

function createSessions(config, { waitChecker = createWaitChecker(), onSessionEvent, onStateChange } = {}) {
  const sessions = new Map();

  const isIdleAgent = (s) => s.exitCode == null && s.kind === 'agent' && Date.now() - s.lastOutputAt >= config.idleSeconds * 1000;
  const currentWait = (s) => (isIdleAgent(s) ? waitChecker.checkSync(s) : null);

  function emitStateChange(reason, sessionId) {
    if (!onStateChange) return;
    try { onStateChange({ reason, sessionId }); } catch { /* ignore listener errors */ }
  }

  // Det der står på agentens skærm lige nu – gengivet af en usynlig terminal, så slettede og overskrevne linjer er væk.
  function screenText(s) {
    const buf = s.screen.buffer.active;
    const end = buf.length;
    const out = [];
    for (let i = Math.max(0, end - (s.rows + SCREEN_EXTRA)); i < end; i += 1) {
      const line = buf.getLine(i);
      if (!line) continue;
      const t = line.translateToString(true);
      // En lang linje der er brudt over flere rækker, samles igen.
      if (line.isWrapped && out.length) out[out.length - 1] += t; else out.push(t);
    }
    return out.join('\n');
  }

  // Et spørgsmål om godkendelse står åbent, fra det dukker op på skærmen, til du svarer.
  // Baggrundsarbejde, der skriver videre imens (tests, subagenter), kan ikke lukke det – kun dit svar, eller at det forsvinder.
  function updateApprovalState(s) {
    if (s.exitCode != null || s.kind !== 'agent' || s.pendingPaste) {
      s.approvalSince = null;
      s.approvalOpen = false;
      if (s.exitCode != null) s.prompt = null;
      return false;
    }
    const found = findApprovalOnScreen(s.screenText(), { mine: mine(s), limit: SCREEN_LIMIT });
    if (!found) {
      s.prompt = null;
      s.approvalSince = null;
      s.approvalOpen = false;
      return false;
    }
    const now = Date.now();
    // Nyt spørgsmål: anden tekst, eller samme tekst én gang mere på skærmen (fx aider, der spørger igen).
    if (!s.prompt || s.prompt.line !== found.line || found.count > s.prompt.count) { s.prompt = { line: found.line, count: found.count, at: now, key: found.key || null }; s.lastPromptAt = now; }
    else { s.prompt.count = found.count; s.prompt.key = found.key || null; }
    s.approvalOpen = s.lastAnswerAt < s.prompt.at;
    if (!s.approvalOpen) { s.approvalSince = null; return false; }
    if (!s.approvalSince) s.approvalSince = s.prompt.at;
    return true;
  }

  function needsApproval(s) {
    if (!updateApprovalState(s)) return false;
    if (isIdleAgent(s)) return true;
    const settleMs = Math.min(1500, Math.max(200, config.idleSeconds * 500));
    return Date.now() - s.approvalSince >= settleMs;
  }

  // Kvote-stop tælles kun, når agenten er stille, og beskeden står nederst på skærmen.
  // Dine tastetryk lukker den ikke – først når agenten selv skriver noget nyt efter dit Enter.
  function activeQuota(s) {
    if (s.exitCode != null || s.kind !== 'agent' || !isIdleAgent(s)) return null;
    return inspectQuota(s.screenText(), SCREEN_QUOTA);
  }

  // Det du selv er ved at skrive, og de sidste ting du har sendt – så dine egne ord i feltet ikke læses som agentens spørgsmål.
  const mine = (s) => [s.draft, ...s.sent];

  // Har du svaret på det seneste spørgsmål, tæller det ikke længere – heller ikke hvis agenten lader det stå på skærmen.
  const answeredPromptVisible = (s) => s.lastPromptAt > 0 && s.lastAnswerAt >= s.lastPromptAt;

  function status(s) {
    if (s.exitCode != null) return s.exitCode === 0 || s.killed ? 'afsluttet' : 'fejlet';
    if (s.kind === 'shell') return 'aaben';
    if (needsApproval(s)) return 'venter';
    if (activeQuota(s)) return 'kvote';
    if (!isIdleAgent(s)) return 'arbejder';
    // En indsat tekst venter på dit Enter – det er dig der skal handle, uanset hvad teksten indeholder.
    if (s.pendingPaste) return 'venter';
    // Venter agenten på sine subagenter, er den ikke færdig – selvom dens egen tur er slut.
    const wait = currentWait(s);
    if (wait && wait.waitingFor === 'subagenter') return 'afventer';
    // En færdig tur vinder over en proces, der kører videre i baggrunden (fx en dev-server agenten har startet).
    if (isTaskDone(s.screenText(), { hadInput: s.hadUserInput, ignorePrompts: answeredPromptVisible(s), limit: SCREEN_LIMIT, strict: true, mine: mine(s) })) return 'faerdig';
    if (wait) return 'afventer';
    return 'venter';
  }

  function view(s) {
    const st = status(s);
    const approval = st === 'venter' && s.approvalSince != null;
    const quota = st === 'kvote' ? inspectQuota(s.screenText(), SCREEN_QUOTA) : null;
    const wait = st === 'afventer' ? currentWait(s) : null;
    return {
      id: s.id, repo: s.repo, kind: s.kind, agentId: s.agentId, name: s.name,
      startedAt: s.startedAt, lastOutputAt: s.lastOutputAt, endedAt: s.endedAt,
      exitCode: s.exitCode, status: st,
      needsApproval: approval,
      approvalKey: approval && s.prompt ? s.prompt.key || null : null,
      waitingFor: quota ? quota.waitingFor : (wait ? wait.waitingFor : null),
      waitingDetail: quota ? quota.detail : (wait ? wait.detail : null),
      lastLine: s.kind === 'agent' ? lastLine(s.screenText(), s.exitCode != null && s.exitCode !== 0 && !s.killed) : '',
      // stopped: du (eller en anden fane) har selv stoppet den. fresh: du har endnu ikke skrevet noget til den.
      stopped: !!s.killed, fresh: !s.hadUserInput, approvalSince: approval ? s.approvalSince : null,
      pendingPaste: s.pendingPaste,
      role: s.role, briefPending: !!s.pendingBrief,
      worktree: s.worktree ? { branch: s.worktree.branch, baseBranch: s.worktree.baseBranch || null, mode: s.worktree.mode, cleaned: !!s.worktree.cleaned } : null,
    };
  }

  function stateSnapshot(s) {
    const st = status(s);
    const approval = st === 'venter' && s.approvalSince != null;
    const quota = st === 'kvote' ? inspectQuota(s.screenText(), SCREEN_QUOTA) : null;
    const wait = st === 'afventer' ? currentWait(s) : null;
    const waitingFor = quota ? quota.waitingFor : (wait ? wait.waitingFor : null);
    const waitingDetail = quota ? quota.detail : (wait ? wait.detail : null);
    const approvalKey = approval && s.prompt ? s.prompt.key || null : null;
    return {
      st,
      approval,
      sig: JSON.stringify([st, s.exitCode, !!s.killed, approval, approvalKey, waitingFor, waitingDetail, s.pendingPaste, !!s.pendingBrief, s.worktree ? !!s.worktree.cleaned : null]),
    };
  }

  function checkStateChange(s, explicitReason) {
    if (!sessions.has(s.id)) return false;
    const prev = s.lastSnap;
    const next = stateSnapshot(s);
    if (prev && prev.sig === next.sig) return false;
    s.lastSnap = next;
    let reason = explicitReason;
    if (!reason) {
      if (next.st === 'kvote' && (!prev || prev.st !== 'kvote')) reason = 'quota';
      else if (prev && next.approval !== prev.approval) reason = 'approval';
      else reason = 'status';
    }
    emitStateChange(reason, s.id);
    return true;
  }

  function scheduleSettle(s) {
    clearTimeout(s.settleTimer);
    s.settleTimer = null;
    if (s.exitCode != null || s.kind !== 'agent' || !s.approvalOpen || s.approvalSince == null) return;
    const settleMs = Math.min(1500, Math.max(200, config.idleSeconds * 500));
    const waitMs = settleMs - (Date.now() - s.approvalSince);
    if (waitMs <= 0) return;
    s.settleTimer = setTimeout(() => {
      s.settleTimer = null;
      if (s.exitCode != null || !sessions.has(s.id)) return;
      checkStateChange(s);
    }, waitMs + 15);
    s.settleTimer.unref();
  }

  function scheduleIdle(s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (s.exitCode != null || s.kind !== 'agent') return;
    const idleMs = Math.max(0, config.idleSeconds * 1000);
    const remaining = idleMs - (Date.now() - s.lastOutputAt);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.exitCode != null || !sessions.has(s.id)) return;
      const left = idleMs - (Date.now() - s.lastOutputAt);
      if (left > 0) { scheduleIdle(s); return; }
      s.lastKnownIdle = true;
      checkStateChange(s);
      if (isIdleAgent(s)) {
        waitChecker.checkAll([s])
          .then(() => { if (s.exitCode == null && sessions.has(s.id)) checkStateChange(s); })
          .catch(() => {});
      }
    }, Math.max(10, remaining + 20));
    s.idleTimer.unref();
  }

  async function refreshWaits() {
    for (const s of sessions.values()) updateApprovalState(s);
    const idle = [...sessions.values()].filter(isIdleAgent);
    if (idle.length) await waitChecker.checkAll(idle);
  }

  // Flere sessioner af samme slags i samme repo får et nummer, så de kan kendes fra hinanden.
  function numbered(name, repo, agentId, roleId) {
    const n = [...sessions.values()].filter((x) => x.repo === repo && x.agentId === agentId && (x.role ? x.role.id : null) === (roleId || null)).length;
    return n ? `${name} ${n + 1}` : name;
  }

  // role/brief: startes agenten i en rolle, indsættes rollens arbejdsbeskrivelse, så snart agenten er klar.
  function create({ repo, repoDir, cwd, kind, agent, baseline, role, brief, initialPaste, worktree }) {
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
      id: crypto.randomBytes(12).toString('hex'), repo, repoDir: repoDir || cwd, kind, cwd, baseline: baseline || null,
      worktree: worktree || null,
      agentId: kind === 'agent' ? agent.id : null,
      name: numbered(kind === 'agent' ? (role ? `${role.name} · ${agent.name}` : agent.name) : 'Terminal', repo, kind === 'agent' ? agent.id : null, role ? role.id : null),
      role: kind === 'agent' && role ? { id: role.id, name: role.name, icon: role.icon, mode: role.mode } : null,
      pendingBrief: kind === 'agent' && brief ? brief : null, briefTimer: null,
      startedAt: now, lastOutputAt: now, lastInputAt: 0, lastResizeAt: 0, cols: 100, rows: 30, endedAt: null,
      exitCode: null, killed: false, bracketed: false, pendingPaste: false, hadUserInput: false, waitState: null,
      queuedPaste, initialPasteTimer: null,
      approvalSince: null, approvalOpen: false, prompt: null, lastPromptAt: 0, lastAnswerAt: 0, draft: '', sent: [], approvalTimer: null,
      idleTimer: null, settleTimer: null, lastKnownIdle: false, lastSnap: null,
      buffer: '', clients: new Set(), proc,
      screen: new ScreenTerminal({ cols: 100, rows: 30, scrollback: 500, allowProposedApi: true, logLevel: 'off' }),
    };
    s.screenText = () => screenText(s);
    sessions.set(s.id, s);
    s.lastSnap = stateSnapshot(s);
    emitStateChange('create', s.id);
    scheduleIdle(s);
    proc.onData((data) => {
      // Tegn du selv taster bliver gentaget af terminalen, og et program tegner skærmen om når vinduet ændrer størrelse.
      // Ingen af delene tæller som at agenten arbejder.
      const t = Date.now();
      if (t - s.lastInputAt > 400 && t - s.lastResizeAt > 600) {
        s.lastOutputAt = t;
        s.waitState = null;
        if (s.kind === 'agent') {
          scheduleIdle(s);
          if (s.lastKnownIdle) {
            s.lastKnownIdle = false;
            checkStateChange(s);
          }
        }
      }
      s.buffer += data;
      s.screen.write(data);
      // Rollens beskrivelse indsættes først, når agenten har været stille et øjeblik – så er den færdig med at starte op.
      if (s.pendingBrief) { clearTimeout(s.briefTimer); s.briefTimer = setTimeout(() => deliverBrief(s), BRIEF_QUIET_MS); }
      // Husk om programmet har slået "indsæt-tilstand" til (bruges af paste nedenfor).
      // Der kigges kun i det nye stykke (plus lidt fra før, hvis koden er delt over to stykker) – ikke hele historikken hver gang.
      const chunk = (s.modeTail || '') + data;
      s.modeTail = data.slice(-8);
      const on = chunk.lastIndexOf('\x1b[?2004h');
      const off = chunk.lastIndexOf('\x1b[?2004l');
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
          if (s.exitCode != null || !sessions.has(s.id)) return;
          checkStateChange(s);
          if (s.approvalOpen && !needsApproval(s)) scheduleSettle(s);
        }, 350);
        s.approvalTimer.unref();
      }
      for (const c of s.clients) c.onData(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(s.killTimer1); clearTimeout(s.killTimer2); clearTimeout(s.approvalTimer); clearTimeout(s.briefTimer); clearTimeout(s.briefFallback); clearTimeout(s.initialPasteTimer);
      clearTimeout(s.idleTimer); clearTimeout(s.settleTimer);
      s.pendingBrief = null;
      s.approvalTimer = null; s.initialPasteTimer = null; s.queuedPaste = null;
      s.idleTimer = null; s.settleTimer = null;
      // Blev processen slået ned af et signal (nedbrud, kill -9), og var det ikke os selv, er det en fejl – ikke "afsluttet".
      s.exitCode = signal && !s.killed ? 128 + signal : (exitCode ?? 0);
      s.endedAt = Date.now();
      if (s.kind === 'agent' && onSessionEvent) onSessionEvent('exit', view(s));
      checkStateChange(s, 'exit');
      for (const c of s.clients) c.onExit(s.exitCode);
    });
    // Siger agenten slet ingenting efter start, indsættes beskrivelsen alligevel efter et stykke tid.
    if (s.pendingBrief) {
      s.briefFallback = setTimeout(() => deliverBrief(s), BRIEF_MAX_WAIT_MS);
      s.briefTimer = setTimeout(() => deliverBrief(s), BRIEF_SILENT_MS);
    }
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
        let resetIdle = false;
        if (/[\r\n]/.test(data)) {
          s.hadUserInput = true;
          // Du har sendt noget: agenten går i gang nu, også selvom dens første svar kommer samtidig med ekkoet.
          s.lastOutputAt = Date.now();
          s.waitState = null;
          resetIdle = true;
        }
        // Det du er ved at skrive, huskes, så "> ja" i feltet ikke forveksles med et spørgsmål fra agenten.
        if (/[\r\n]/.test(data)) {
          const sent = (s.draft + data.split(/[\r\n]/)[0].replace(/[\x00-\x1f]/g, '')).trim();
          if (sent) s.sent = [sent, ...s.sent].slice(0, 5);
        }
        if (/[\r\n\x03\x15]/.test(data)) s.draft = '';
        else if (data === '\x7f' || data === '\b') s.draft = s.draft.slice(0, -1);
        else if (!/\x1b/.test(data)) s.draft = (s.draft + data.replace(/[\x00-\x1f]/g, '')).slice(-500);
        // Enter, Ctrl+C eller Ctrl+U betyder, at en indsat tekst er sendt eller slettet.
        if (/[\r\n\x03\x15]/.test(data)) s.pendingPaste = false;
        // Et svar lukker et åbent spørgsmål med det samme. Piletaster i menuen gør ikke.
        if (s.kind === 'agent' && ANSWER_RE.test(data)) {
          s.lastAnswerAt = Date.now();
          // Har du lige svaret på et spørgsmål, går agenten i gang nu – også selvom svaret var et tal uden Enter.
          if (s.approvalOpen) { s.lastOutputAt = Date.now(); s.waitState = null; resetIdle = true; }
          s.approvalSince = null;
          s.approvalOpen = false;
          clearTimeout(s.settleTimer); s.settleTimer = null;
        }
        if (resetIdle && s.kind === 'agent') {
          s.lastKnownIdle = false;
          scheduleIdle(s);
        }
        s.proc.write(data);
        checkStateChange(s);
      },
      resize(cols, rows) {
        if (s.exitCode != null || (cols === s.cols && rows === s.rows)) return;
        s.cols = cols; s.rows = rows; s.lastResizeAt = Date.now();
        try { s.screen.resize(cols, rows); } catch { /* lukket imens */ }
        try { s.proc.resize(cols, rows); } catch { /* lukket imens */ }
      },
      detach() { s.clients.delete(client); },
    };
  }

  // Rollens beskrivelse indsættes uden Enter, ligesom alt andet: du ser den igennem og sender den selv.
  function deliverBrief(s) {
    clearTimeout(s.briefTimer); clearTimeout(s.briefFallback);
    if (!s.pendingBrief || s.exitCode != null) { s.pendingBrief = null; return; }
    const text = s.pendingBrief;
    s.pendingBrief = null;
    paste(s.id, text, true);
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
    checkStateChange(s, 'paste');
    return 'ok';
  }

  // Sender et hurtig-svar (fx ja/nej/enter/1/2/esc/ctrl-k) direkte til en kørende agent fra overblikket.
  const KEYS = { enter: '\r', yes: 'y\r', no: 'n\r', '1': '1\r', '2': '2\r', esc: '\x1b', 'ctrl-k': '\x0b' };
  function approve(id, key) {
    const s = get(id);
    if (!s || s.exitCode != null) return 'gone';
    if (s.kind !== 'agent') return 'not-agent';
    if (!Object.prototype.hasOwnProperty.call(KEYS, key)) return 'invalid';
    s.lastInputAt = Date.now();
    s.hadUserInput = true;
    s.pendingPaste = false;
    // Hurtig-svar fra overblikket er et svar på spørgsmålet, ligesom når du taster det selv.
    s.lastAnswerAt = Date.now();
    s.lastOutputAt = Date.now();
    s.waitState = null;
    s.approvalSince = null;
    s.approvalOpen = false;
    s.draft = '';
    s.lastKnownIdle = false;
    clearTimeout(s.settleTimer); s.settleTimer = null;
    scheduleIdle(s);
    s.proc.write(KEYS[key]);
    checkStateChange(s, 'approve');
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
    clearTimeout(s.settleTimer);
    s.initialPasteTimer = null;
    s.settleTimer = null;
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
    if (s.exitCode == null) {
      kill(s);
      checkStateChange(s, 'remove');
    } else {
      clearTimeout(s.idleTimer); clearTimeout(s.settleTimer);
      s.idleTimer = null; s.settleTimer = null;
      sessions.delete(id);
      try { s.screen.dispose(); } catch { /* allerede lukket */ }
      emitStateChange('remove', id);
    }
    return true;
  }

  function markWorktreeCleaned(id) {
    const s = get(id);
    if (!s || !s.worktree) return false;
    s.worktree.cleaned = true;
    checkStateChange(s, 'worktree');
    return true;
  }

  function closeAll() { for (const s of sessions.values()) kill(s); }
  // Bruges når Control Tower selv lukker: der må ikke ligge processer tilbage bagefter.
  function forceAll() { for (const s of sessions.values()) { s.killed = true; signal(s, 'SIGKILL'); } }
  const running = () => [...sessions.values()].filter((s) => s.exitCode == null).length;

  return { create, get, attach, paste, approve, remove, markWorktreeCleaned, closeAll, forceAll, running, refreshWaits, list: () => [...sessions.values()].map(view), hostname: os.hostname() };
}

module.exports = { createSessions, lastLine, PASTE_MAX, BRIEF_QUIET_MS };
