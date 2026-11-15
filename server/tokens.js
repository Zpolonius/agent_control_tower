'use strict';
// Token-regnskab: kombinerer Control Towers eget sessionsregnskab med lokale agent-logfiler
// (Claude Code under ~/.claude/projects og Antigravity/agy under ~/.gemini/antigravity-cli/brain).
// Læser kun tal, modelnavn, tidsstempel og repo-tilknytning – indhold fra samtaler vises aldrig i browseren.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const isWin = process.platform === 'win32';
const CACHE_MS = 4000;
const MAX_CLAUDE_DEPTH = 3;
const MAX_LOG_FILES = 2000;

function nonNegInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function emptyCounts() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, turns: 0 };
}

function addCounts(dst, src) {
  if (!src) return dst;
  dst.input += nonNegInt(src.input);
  dst.cacheRead += nonNegInt(src.cacheRead);
  dst.cacheWrite += nonNegInt(src.cacheWrite);
  dst.output += nonNegInt(src.output);
  dst.turns += nonNegInt(src.turns);
  dst.total = dst.input + dst.cacheRead + dst.cacheWrite + dst.output;
  return dst;
}

function cloneCounts(src) {
  return addCounts(emptyCounts(), src);
}

function dayKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodMinDay(period) {
  const now = Date.now();
  if (period === 'today') return dayKey(now);
  if (period === '7d') return dayKey(now - 6 * 86400000);
  if (period === '30d') return dayKey(now - 29 * 86400000);
  return null;
}

function normPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return isWin ? s.toLowerCase() : s;
}

function encodeClaudePath(p) {
  return String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function safeModelName(m) {
  if (typeof m !== 'string') return '';
  return m.trim().slice(0, 80);
}

function logTypeForAgent(agent) {
  if (!agent) return 'other';
  const cmd = String(agent.command || '');
  const id = String(agent.id || '');
  if (/\bclaude\b/i.test(cmd) || /^claude$/i.test(id)) return 'claude';
  if (/\b(?:agy|antigravity)\b/i.test(cmd) || /^(?:agy|antigravity)$/i.test(id)) return 'agy';
  return 'other';
}

function buildRepoMatchers(root, repoNames) {
  if (!root || !Array.isArray(repoNames) || !repoNames.length) return [];
  return repoNames.map((name) => {
    const abs = path.join(root, name);
    const norm = normPath(abs);
    const enc = encodeClaudePath(abs);
    return {
      name,
      norm,
      encLower: enc.toLowerCase(),
      re: new RegExp(`${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\\\"'\\s,;:)])`, isWin ? 'gi' : 'g'),
    };
  }).sort((a, b) => b.norm.length - a.norm.length);
}

function matchRepoPath(p, matchers) {
  if (!p || !matchers.length) return null;
  const np = normPath(p);
  for (const m of matchers) {
    if (np === m.norm || np.startsWith(`${m.norm}/`)) return m.name;
  }
  return null;
}

function countRepoTextHits(text, matchers, hits) {
  if (!text || !matchers.length) return;
  const norm = String(text).replace(/\\\\/g, '/').replace(/\\/g, '/');
  for (const m of matchers) {
    m.re.lastIndex = 0;
    const found = norm.match(m.re);
    if (found) hits.set(m.name, (hits.get(m.name) || 0) + found.length);
  }
}

function topRepoHit(hits) {
  let best = null;
  let max = 0;
  for (const [name, count] of hits) {
    if (count > max) { best = name; max = count; }
  }
  return best;
}

async function readJsonl(filePath, onObject) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && typeof obj === 'object') onObject(obj);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function addDayModel(byDay, modelsByDay, day, model, delta) {
  if (!day) return;
  if (!byDay[day]) byDay[day] = emptyCounts();
  addCounts(byDay[day], delta);
  if (model) {
    if (!modelsByDay[day]) modelsByDay[day] = {};
    if (!modelsByDay[day][model]) modelsByDay[day][model] = emptyCounts();
    addCounts(modelsByDay[day][model], delta);
  }
}

function insideRoot(realRoot, target) {
  let real;
  try {
    real = fs.realpathSync(target);
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return { real, st };
  } catch {
    return null;
  }
}

function createTokens(config, { getRepoNames } = {}) {
  const fileCache = new Map();
  let scanCache = null;
  let pendingScan = null;
  let ledger = { version: 1, sessions: {} };
  let ledgerLoaded = false;
  let ledgerDirty = false;
  let ledgerWritable = true;

  function loadLedger() {
    if (ledgerLoaded) return;
    ledgerLoaded = true;
    if (!config.tokensFile) return;
    if (!fs.existsSync(config.tokensFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(config.tokensFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        ledger = { version: 1, sessions: parsed.sessions };
      }
    } catch (err) {
      ledgerWritable = false;
      console.error(`Advarsel: kunne ikke læse token-regnskabet ${config.tokensFile}: ${err.message}`);
    }
  }

  function flushLedger() {
    loadLedger();
    if (!ledgerDirty || !config.tokensFile || !ledgerWritable) return;
    try {
      const dir = path.dirname(config.tokensFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmpFile = `${config.tokensFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmpFile, config.tokensFile);
      ledgerDirty = false;
    } catch {
      /* Bevar regnskabet i hukommelsen hvis disken fejler midlertidigt */
    }
  }

  function configuredAgents() {
    return Array.isArray(config.agents) ? config.agents : [];
  }

  function resolveAgentMeta(agentId, fallbackType) {
    const cfgAgent = configuredAgents().find((a) => a.id === agentId);
    if (cfgAgent) return { id: cfgAgent.id, name: cfgAgent.name, logType: logTypeForAgent(cfgAgent) };
    if (fallbackType) {
      const byType = configuredAgents().find((a) => logTypeForAgent(a) === fallbackType);
      if (byType) return { id: byType.id, name: byType.name, logType: fallbackType };
      if (fallbackType === 'claude') return { id: 'claude', name: 'Claude Code', logType: 'claude' };
      if (fallbackType === 'agy') return { id: 'agy', name: 'Antigravity (agy)', logType: 'agy' };
    }
    return { id: agentId || 'ukendt', name: agentId || 'Ukendt agent', logType: fallbackType || 'other' };
  }

  function recordSession(event, sessionView) {
    if (!sessionView || sessionView.kind !== 'agent') return;
    loadLedger();
    const existing = ledger.sessions[sessionView.id];
    const meta = resolveAgentMeta(sessionView.agentId);
    const next = existing ? { ...existing } : {
      id: sessionView.id,
      repo: sessionView.repo,
      agentId: sessionView.agentId,
      agentName: meta.name,
      sessionName: sessionView.name,
      logType: meta.logType,
      startedAt: sessionView.startedAt,
      endedAt: null,
      status: sessionView.status,
      logId: null,
      counts: emptyCounts(),
      contextTokens: 0,
      byDay: {},
      modelsByDay: {},
    };
    next.repo = sessionView.repo;
    next.agentId = sessionView.agentId || next.agentId;
    next.agentName = meta.name;
    next.sessionName = sessionView.name || next.sessionName;
    next.status = sessionView.status;
    if (sessionView.endedAt != null) next.endedAt = sessionView.endedAt;
    ledger.sessions[sessionView.id] = next;
    ledgerDirty = true;
    if (event === 'exit') flushLedger();
  }

  function syncActiveSessions(activeSessions) {
    if (!Array.isArray(activeSessions)) return;
    loadLedger();
    for (const s of activeSessions) {
      if (s.kind !== 'agent') continue;
      const cur = ledger.sessions[s.id];
      if (!cur || cur.status !== s.status || cur.endedAt !== s.endedAt) {
        recordSession('sync', s);
      }
    }
  }

  async function parseAgyTranscript(real, st, convId, matchers) {
    const counts = emptyCounts();
    const byDay = {};
    const modelsByDay = {};
    const hits = new Map();
    let firstAt = null;
    let lastAt = null;
    let contextTokens = 0;
    let contextTs = -Infinity;

    await readJsonl(real, (obj) => {
      const ts = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
      if (Number.isFinite(ts)) {
        if (firstAt == null || ts < firstAt) firstAt = ts;
        if (lastAt == null || ts > lastAt) lastAt = ts;
      }
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (tc && tc.args) countRepoTextHits(JSON.stringify(tc.args), matchers, hits);
        }
      }
      if (hits.size === 0 && typeof obj.content === 'string') {
        countRepoTextHits(obj.content, matchers, hits);
      }
      const inp = nonNegInt(obj.input_tokens);
      const cr = nonNegInt(obj.cache_read_tokens);
      const cw = nonNegInt(obj.cache_write_tokens);
      const out = nonNegInt(obj.output_tokens);
      if (inp + cr + cw + out === 0) return;

      const ctx = inp + cr + cw;
      const turnTs = Number.isFinite(ts) ? ts : st.mtimeMs;
      if (ctx > 0 && turnTs >= contextTs) {
        contextTs = turnTs;
        contextTokens = ctx;
      }

      const delta = { input: inp, cacheRead: cr, cacheWrite: cw, output: out, turns: 1 };
      addCounts(counts, delta);
      const day = dayKey(turnTs);
      const model = safeModelName(obj.model) || 'gemini';
      addDayModel(byDay, modelsByDay, day, model, delta);
    });

    return {
      id: `agy:${convId}`,
      logType: 'agy',
      firstAt: firstAt ?? Math.round(st.birthtimeMs || st.mtimeMs),
      lastAt: lastAt ?? Math.round(st.mtimeMs),
      mtimeMs: Math.round(st.mtimeMs),
      detectedRepo: topRepoHit(hits),
      counts,
      contextTokens,
      byDay,
      modelsByDay,
    };
  }

  async function parseClaudeTranscript(real, st, relPath, parentFolder, matchers) {
    const turnsByKey = new Map();
    const hits = new Map();
    let firstAt = null;
    let lastAt = null;
    let lineIdx = 0;

    await readJsonl(real, (obj) => {
      lineIdx += 1;
      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      if (Number.isFinite(ts)) {
        if (firstAt == null || ts < firstAt) firstAt = ts;
        if (lastAt == null || ts > lastAt) lastAt = ts;
      }
      if (typeof obj.cwd === 'string') {
        const matched = matchRepoPath(obj.cwd, matchers);
        if (matched) hits.set(matched, (hits.get(matched) || 0) + 1);
      }
      const msg = obj.message;
      const usage = msg && typeof msg === 'object' ? msg.usage : null;
      if (!usage || typeof usage !== 'object') return;

      const inp = nonNegInt(usage.input_tokens);
      const cr = nonNegInt(usage.cache_read_input_tokens);
      const cw = nonNegInt(usage.cache_creation_input_tokens);
      const out = nonNegInt(usage.output_tokens);
      if (inp + cr + cw + out === 0) return;

      const key = (typeof msg.id === 'string' && msg.id) || (typeof obj.requestId === 'string' && obj.requestId) || `line:${lineIdx}`;
      const prev = turnsByKey.get(key);
      const sum = inp + cr + cw + out;
      if (!prev || sum >= prev.sum) {
        turnsByKey.set(key, {
          sum,
          idx: lineIdx,
          ts: Number.isFinite(ts) ? ts : st.mtimeMs,
          model: safeModelName(msg.model) || 'claude',
          delta: { input: inp, cacheRead: cr, cacheWrite: cw, output: out, turns: 1 },
        });
      }
    });

    const counts = emptyCounts();
    const byDay = {};
    const modelsByDay = {};
    let contextTokens = 0;
    let latestTurnTs = -Infinity;
    let latestTurnIdx = -1;
    for (const turn of turnsByKey.values()) {
      addCounts(counts, turn.delta);
      addDayModel(byDay, modelsByDay, dayKey(turn.ts), turn.model, turn.delta);
      const ctx = turn.delta.input + turn.delta.cacheRead + turn.delta.cacheWrite;
      if (ctx > 0 && (turn.ts > latestTurnTs || (turn.ts === latestTurnTs && turn.idx >= latestTurnIdx))) {
        latestTurnTs = turn.ts;
        latestTurnIdx = turn.idx;
        contextTokens = ctx;
      }
    }

    let detectedRepo = topRepoHit(hits);
    if (!detectedRepo && parentFolder) {
      const folderLower = parentFolder.toLowerCase();
      const folderMatch = matchers.find((m) => m.encLower === folderLower);
      if (folderMatch) detectedRepo = folderMatch.name;
    }

    return {
      id: `claude:${relPath}`,
      logType: 'claude',
      firstAt: firstAt ?? Math.round(st.birthtimeMs || st.mtimeMs),
      lastAt: lastAt ?? Math.round(st.mtimeMs),
      mtimeMs: Math.round(st.mtimeMs),
      detectedRepo,
      counts,
      contextTokens,
      byDay,
      modelsByDay,
    };
  }

  async function scanAgyLogs(matchers, repoSig) {
    if (!config.agyBrainDir) return { available: false, logs: [] };
    let realRoot;
    try { realRoot = fs.realpathSync(config.agyBrainDir); } catch { return { available: false, logs: [] }; }
    let entries;
    try { entries = fs.readdirSync(realRoot, { withFileTypes: true }); } catch { return { available: false, logs: [] }; }

    const logs = [];
    for (const e of entries) {
      if (logs.length >= MAX_LOG_FILES) break;
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const candidate = path.join(realRoot, e.name, '.system_generated', 'logs', 'transcript.jsonl');
      const info = insideRoot(realRoot, candidate);
      if (!info) continue;
      const cached = fileCache.get(info.real);
      if (cached && cached.mtimeMs === info.st.mtimeMs && cached.size === info.st.size && cached.repoSig === repoSig) {
        logs.push(cached.parsed);
        continue;
      }
      const parsed = await parseAgyTranscript(info.real, info.st, e.name, matchers);
      fileCache.set(info.real, { mtimeMs: info.st.mtimeMs, size: info.st.size, repoSig, parsed });
      logs.push(parsed);
    }
    return { available: true, logs };
  }

  function mergeClaudeSessionGroup(parentRel, entries) {
    if (entries.length === 1 && !entries[0].isSubagent) return entries[0].parsed;
    const parent = entries.find((x) => !x.isSubagent)?.parsed || null;
    const counts = emptyCounts();
    const byDay = {};
    const modelsByDay = {};
    let firstAt = parent ? parent.firstAt : null;
    let lastAt = 0;
    let mtimeMs = 0;
    let detectedRepo = parent ? parent.detectedRepo : null;

    for (const { parsed } of entries) {
      addCounts(counts, parsed.counts);
      if (!parent && (firstAt == null || parsed.firstAt < firstAt)) firstAt = parsed.firstAt;
      if (parsed.lastAt > lastAt) lastAt = parsed.lastAt;
      if ((parsed.mtimeMs || 0) > mtimeMs) mtimeMs = parsed.mtimeMs || 0;
      if (!detectedRepo && parsed.detectedRepo) detectedRepo = parsed.detectedRepo;
      for (const [day, mMap] of Object.entries(parsed.modelsByDay || {})) {
        for (const [model, delta] of Object.entries(mMap)) {
          addDayModel(byDay, modelsByDay, day, model, delta);
        }
      }
      for (const [day, dc] of Object.entries(parsed.byDay || {})) {
        if (!parsed.modelsByDay || !parsed.modelsByDay[day]) {
          if (!byDay[day]) byDay[day] = emptyCounts();
          addCounts(byDay[day], dc);
        }
      }
    }

    return {
      id: `claude:${parentRel}`,
      logType: 'claude',
      firstAt: firstAt ?? 0,
      lastAt: lastAt || mtimeMs,
      mtimeMs,
      detectedRepo,
      counts,
      contextTokens: parent ? (parent.contextTokens || 0) : Math.max(0, ...entries.map((e) => e.parsed.contextTokens || 0)),
      byDay,
      modelsByDay,
    };
  }

  async function scanClaudeLogs(matchers, repoSig) {
    if (!config.claudeProjectsDir) return { available: false, logs: [] };
    let realRoot;
    try { realRoot = fs.realpathSync(config.claudeProjectsDir); } catch { return { available: false, logs: [] }; }

    const files = [];
    const maxWalk = MAX_LOG_FILES * 4;
    function walk(dir, depth, projectFolder) {
      if (depth > MAX_CLAUDE_DEPTH || files.length >= maxWalk) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length >= maxWalk) break;
        const abs = path.join(dir, e.name);
        if (e.isDirectory() || e.isSymbolicLink()) {
          let realDir;
          try {
            realDir = fs.realpathSync(abs);
            if (!fs.statSync(realDir).isDirectory()) continue;
            if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) continue;
          } catch { continue; }
          walk(realDir, depth + 1, depth === 0 ? e.name : projectFolder);
        } else if (e.name.endsWith('.jsonl')) {
          const info = insideRoot(realRoot, abs);
          if (info) files.push({ ...info, rel: path.relative(realRoot, info.real).split(path.sep).join('/'), projectFolder });
        }
      }
    }
    walk(realRoot, 0, '');

    if (files.length > MAX_LOG_FILES) {
      files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      files.length = MAX_LOG_FILES;
    }

    // Læg subagenter (<session>/subagents/agent-*.jsonl) sammen med hovedsessionen så kort og total passer.
    const groups = new Map();
    for (const f of files) {
      let parsed;
      const cached = fileCache.get(f.real);
      if (cached && cached.mtimeMs === f.st.mtimeMs && cached.size === f.st.size && cached.repoSig === repoSig) {
        parsed = cached.parsed;
      } else {
        parsed = await parseClaudeTranscript(f.real, f.st, f.rel, f.projectFolder, matchers);
        fileCache.set(f.real, { mtimeMs: f.st.mtimeMs, size: f.st.size, repoSig, parsed });
      }
      const isSubagent = /\/subagents\/[^/]+\.jsonl$/i.test(f.rel);
      const parentRel = isSubagent ? f.rel.replace(/\/subagents\/[^/]+\.jsonl$/i, '.jsonl') : f.rel;
      if (!groups.has(parentRel)) groups.set(parentRel, []);
      groups.get(parentRel).push({ isSubagent, parsed });
    }
    const logs = [];
    for (const [parentRel, group] of groups) {
      logs.push(mergeClaudeSessionGroup(parentRel, group));
    }
    return { available: true, logs };
  }

  function linkAndMergeLogs(logs) {
    loadLedger();
    const byLogId = new Map(logs.map((l) => [l.id, l]));
    const claimed = new Set();
    for (const entry of Object.values(ledger.sessions)) {
      if (entry.logId) claimed.add(entry.logId);
    }

    // Knyt nyere Control Tower-sessioner til tilhørende logfiler uden at tage logfiler fra andre sessioner.
    const unlinked = Object.values(ledger.sessions)
      .filter((e) => !e.logId && (e.logType === 'agy' || e.logType === 'claude'))
      .sort((a, b) => a.startedAt - b.startedAt);

    function linkPass(allowResumed) {
      const pairs = [];
      for (const entry of unlinked) {
        if (entry.logId) continue;
        const endBound = (entry.endedAt || Date.now()) + 15000;
        const startBound = entry.startedAt - 15000;
        for (const l of logs) {
          if (l.logType !== entry.logType || claimed.has(l.id)) continue;
          if (l.detectedRepo && l.detectedRepo !== entry.repo) continue;
          let dist;
          if (!allowResumed) {
            if (l.firstAt < startBound || l.firstAt > endBound) continue;
            dist = Math.abs(l.firstAt - entry.startedAt);
          } else {
            const activeEnd = Math.max(l.lastAt, l.mtimeMs || 0);
            if (l.firstAt > endBound || activeEnd < entry.startedAt - 5000) continue;
            dist = Math.abs(activeEnd - (entry.endedAt || Date.now()));
          }
          pairs.push({ entry, log: l, dist });
        }
      }
      pairs.sort((a, b) => a.dist - b.dist || a.entry.startedAt - b.entry.startedAt);
      for (const { entry, log } of pairs) {
        if (entry.logId || claimed.has(log.id)) continue;
        entry.logId = log.id;
        claimed.add(log.id);
        ledgerDirty = true;
      }
    }
    linkPass(false);
    linkPass(true);

    // Opdater regnskabet med friske tal fra tilknyttede logfiler.
    for (const entry of Object.values(ledger.sessions)) {
      if (!entry.logId) continue;
      const log = byLogId.get(entry.logId);
      if (!log) continue;
      const nextContextTokens = log.contextTokens || 0;
      if (!entry.counts || entry.counts.total !== log.counts.total || entry.counts.turns !== log.counts.turns || entry.lastAt !== log.lastAt || entry.contextTokens !== nextContextTokens) {
        entry.counts = cloneCounts(log.counts);
        entry.contextTokens = nextContextTokens;
        entry.byDay = log.byDay;
        entry.modelsByDay = log.modelsByDay;
        entry.lastAt = log.lastAt;
        ledgerDirty = true;
      }
    }
    flushLedger();
    return claimed;
  }

  async function scan(force, activeSessions = []) {
    syncActiveSessions(activeSessions);
    if (!force && scanCache && Date.now() - scanCache.at < CACHE_MS) {
      linkAndMergeLogs(scanCache.logs);
      return scanCache;
    }
    if (pendingScan) return pendingScan;

    pendingScan = (async () => {
      const repoNames = getRepoNames ? await getRepoNames() : [];
      const repoSig = `${config.root || ''}|${repoNames.join(',')}`;
      const matchers = buildRepoMatchers(config.root, repoNames);
      const [agy, claude] = await Promise.all([
        scanAgyLogs(matchers, repoSig),
        scanClaudeLogs(matchers, repoSig),
      ]);
      const logs = [...agy.logs, ...claude.logs];
      linkAndMergeLogs(logs);
      scanCache = {
        at: Date.now(),
        repoNames,
        sources: { ledgerFile: Boolean(config.tokensFile), claudeLogs: claude.available, agyLogs: agy.available },
        logs,
      };
      return scanCache;
    })().finally(() => { pendingScan = null; });

    return pendingScan;
  }

  function sliceByPeriod(entry, minDay) {
    if (!minDay) {
      const models = {};
      for (const mMap of Object.values(entry.modelsByDay || {})) {
        for (const [m, c] of Object.entries(mMap)) {
          if (!models[m]) models[m] = emptyCounts();
          addCounts(models[m], c);
        }
      }
      return { counts: cloneCounts(entry.counts), byDay: entry.byDay || {}, models };
    }
    const counts = emptyCounts();
    const byDay = {};
    const models = {};
    for (const [day, c] of Object.entries(entry.byDay || {})) {
      if (day < minDay) continue;
      byDay[day] = cloneCounts(c);
      addCounts(counts, c);
    }
    for (const [day, mMap] of Object.entries(entry.modelsByDay || {})) {
      if (day < minDay) continue;
      for (const [m, c] of Object.entries(mMap)) {
        if (!models[m]) models[m] = emptyCounts();
        addCounts(models[m], c);
      }
    }
    return { counts, byDay, models };
  }

  function collectRecords(scanned, activeSessions) {
    loadLedger();
    const activeIds = new Map((activeSessions || []).map((s) => [s.id, s]));
    const claimed = new Set();
    const records = [];

    for (const entry of Object.values(ledger.sessions)) {
      if (entry.logId) claimed.add(entry.logId);
      const live = activeIds.get(entry.id);
      const meta = resolveAgentMeta(entry.agentId, entry.logType);
      records.push({
        id: entry.id,
        source: 'control-tower',
        repo: entry.repo,
        agentId: meta.id,
        agentName: meta.name,
        status: live ? live.status : 'afsluttet',
        startedAt: entry.startedAt,
        lastAt: entry.lastAt || entry.endedAt || entry.startedAt,
        counts: entry.counts || emptyCounts(),
        contextTokens: entry.contextTokens || 0,
        byDay: entry.byDay || {},
        modelsByDay: entry.modelsByDay || {},
        matched: Boolean(entry.logId),
      });
    }

    for (const l of scanned.logs) {
      if (claimed.has(l.id)) continue;
      if (l.counts.total === 0 && l.counts.turns === 0) continue;
      const meta = resolveAgentMeta(null, l.logType);
      records.push({
        id: l.id,
        source: 'external',
        repo: l.detectedRepo || null,
        agentId: meta.id,
        agentName: meta.name,
        status: 'ekstern',
        startedAt: l.firstAt,
        lastAt: l.lastAt,
        counts: l.counts,
        contextTokens: l.contextTokens || 0,
        byDay: l.byDay,
        modelsByDay: l.modelsByDay,
        matched: true,
      });
    }
    return records;
  }

  function aggregate(records, scanned, period) {
    const minDay = periodMinDay(period);
    const repoSet = new Set(scanned.repoNames || []);
    const totals = { ...emptyCounts(), sessions: 0 };
    const agentMap = new Map();
    const repoMap = new Map();
    const modelMap = new Map();
    const dayMap = new Map();
    const sessionRows = [];

    for (const a of configuredAgents()) {
      agentMap.set(a.id, { agentId: a.id, name: a.name, sessions: 0, ...emptyCounts() });
    }

    for (const rec of records) {
      const sliced = sliceByPeriod(rec, minDay);
      const c = sliced.counts;
      const include = !minDay ? (c.total > 0 || rec.source === 'control-tower') : (c.total > 0 || c.turns > 0);
      if (!include) continue;

      if (c.total > 0 || c.turns > 0) totals.sessions += 1;
      addCounts(totals, c);

      if (!agentMap.has(rec.agentId)) {
        agentMap.set(rec.agentId, { agentId: rec.agentId, name: rec.agentName, sessions: 0, ...emptyCounts() });
      }
      const ag = agentMap.get(rec.agentId);
      if (c.total > 0 || rec.source === 'control-tower') ag.sessions += 1;
      addCounts(ag, c);

      if (c.total > 0 || c.turns > 0) {
        const rKey = rec.repo || '__unassigned__';
        if (!repoMap.has(rKey)) {
          repoMap.set(rKey, {
            repo: rec.repo,
            inRoot: Boolean(rec.repo && repoSet.has(rec.repo)),
            sessions: 0,
            byAgent: {},
            ...emptyCounts(),
          });
        }
        const rp = repoMap.get(rKey);
        rp.sessions += 1;
        addCounts(rp, c);
        if (!rp.byAgent[rec.agentId]) rp.byAgent[rec.agentId] = { name: rec.agentName, ...emptyCounts() };
        addCounts(rp.byAgent[rec.agentId], c);

        for (const [model, mc] of Object.entries(sliced.models)) {
          const mk = `${rec.agentId}:${model}`;
          if (!modelMap.has(mk)) modelMap.set(mk, { model, agentId: rec.agentId, agentName: rec.agentName, ...emptyCounts() });
          addCounts(modelMap.get(mk), mc);
        }

        for (const [day, dc] of Object.entries(sliced.byDay)) {
          if (!dayMap.has(day)) dayMap.set(day, { date: day, ...emptyCounts() });
          addCounts(dayMap.get(day), dc);
        }
      }

      sessionRows.push({
        id: rec.id,
        source: rec.source,
        repo: rec.repo,
        agentId: rec.agentId,
        agentName: rec.agentName,
        status: rec.status,
        startedAt: rec.startedAt,
        lastAt: rec.lastAt,
        models: Object.keys(sliced.models),
        ...c,
        contextTokens: rec.contextTokens || 0,
      });
    }

    const byAgent = [...agentMap.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'da'));
    const byRepo = [...repoMap.values()].sort((a, b) => b.total - a.total || String(a.repo || '').localeCompare(String(b.repo || ''), 'da'));
    const byModel = [...modelMap.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
    const byDay = [...dayMap.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
    sessionRows.sort((a, b) => (b.lastAt || b.startedAt) - (a.lastAt || a.startedAt));

    return {
      period: period || 'all',
      updatedAt: scanned.at,
      totals,
      byAgent,
      byRepo,
      byModel,
      byDay,
      sessions: sessionRows.slice(0, 50),
      sources: scanned.sources,
    };
  }

  async function summaryForState(activeSessions = []) {
    const scanned = await scan(false, activeSessions);
    const records = collectRecords(scanned, activeSessions);
    const agg = aggregate(records, scanned, 'all');
    const sessionTokens = {};
    for (const rec of records) {
      if (rec.source !== 'control-tower') continue;
      sessionTokens[rec.id] = { ...cloneCounts(rec.counts), contextTokens: rec.contextTokens || 0, matched: rec.matched };
    }
    const byRepo = {};
    for (const r of agg.byRepo) {
      if (r.repo) byRepo[r.repo] = { ...cloneCounts(r), byAgent: r.byAgent };
    }
    return {
      sessionTokens,
      tokenSummary: {
        total: agg.totals,
        byAgent: agg.byAgent,
        byRepo,
      },
    };
  }

  async function report({ period = 'all', fresh = false, activeSessions = [] } = {}) {
    const valid = period === 'today' || period === '7d' || period === '30d' || period === 'all' ? period : 'all';
    const scanned = await scan(fresh, activeSessions);
    const records = collectRecords(scanned, activeSessions);
    return aggregate(records, scanned, valid);
  }

  return { recordSession, summaryForState, report, flush: flushLedger };
}

module.exports = { createTokens, encodeClaudePath, logTypeForAgent };
