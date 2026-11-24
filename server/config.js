'use strict';
// Indlæser og gemmer indstillinger. En eksisterende indstillingsfil overskrives aldrig –
// manglende felter får bare standardværdier i hukommelsen.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  root: '',
  port: 4317,
  brainPaths: ['docs', 'CLAUDE.md', 'AGENTS.md', '.claude'],
  agents: [
    { id: 'claude', name: 'Claude Code', command: 'claude' },
    { id: 'gemini', name: 'Gemini', command: 'agy' },
    { id: 'mistral', name: 'Mistral', command: 'vibe' },
    { id: 'codex', name: 'OpenAI Codex', command: 'codex' },
  ],
  idleSeconds: 8,
  maxSessions: 12,
  personalSkillsDir: '',
  personalSkillsDirs: [],
  tokensFile: '',
  claudeProjectsDir: '',
  agyBrainDir: '',
};

// "~" betyder din hjemmemappe – også når det står i indstillingsfilen.
function expand(p) {
  return path.resolve(p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
}

function cleanSkillDir(val) {
  if (typeof val !== 'string' || !val.trim()) return null;
  const s = val.trim();
  if (s === '~' || /^~[\\/]/.test(s)) return expand(s);
  return path.isAbsolute(s) ? path.resolve(s) : null;
}

function defaultPersonalSkillsDirs() {
  return [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.gemini', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];
}

function cleanLogDir(val, fallback) {
  if (val === false) return null;
  if (typeof val === 'string' && val) {
    const p = expand(val);
    if (path.isAbsolute(p)) return p;
  }
  return fallback;
}

function clean(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  cfg.root = typeof cfg.root === 'string' && cfg.root ? expand(cfg.root) : '';
  // Tom værdi = standardstederne for personlige skills (Claude Code, Gemini/Antigravity og delte .agents).
  const explicitSingle = cleanSkillDir(raw && raw.personalSkillsDir);
  cfg.personalSkillsDir = explicitSingle || path.join(os.homedir(), '.claude', 'skills');
  const rawDirs = raw && Array.isArray(raw.personalSkillsDirs)
    ? raw.personalSkillsDirs.map(cleanSkillDir).filter(Boolean)
    : [];
  const mergedDirs = rawDirs.length
    ? (explicitSingle ? [explicitSingle, ...rawDirs] : rawDirs)
    : (explicitSingle ? [explicitSingle] : defaultPersonalSkillsDirs());
  cfg.personalSkillsDirs = [...new Set(mergedDirs)];
  if (cfg.personalSkillsDirs.length && !explicitSingle && rawDirs.length) {
    cfg.personalSkillsDir = cfg.personalSkillsDirs[0];
  }
  cfg.tokensFile = raw && raw.tokensFile === false
    ? null
    : (typeof cfg.tokensFile === 'string' && cfg.tokensFile ? expand(cfg.tokensFile) : '');
  cfg.claudeProjectsDir = cleanLogDir(raw && raw.claudeProjectsDir, path.join(os.homedir(), '.claude', 'projects'));
  cfg.agyBrainDir = cleanLogDir(raw && raw.agyBrainDir, path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'));
  cfg.port = Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536 ? cfg.port : DEFAULTS.port;
  cfg.idleSeconds = Number.isFinite(cfg.idleSeconds) && cfg.idleSeconds >= 2 ? cfg.idleSeconds : DEFAULTS.idleSeconds;
  cfg.maxSessions = Number.isInteger(cfg.maxSessions) && cfg.maxSessions > 0 ? Math.min(cfg.maxSessions, 50) : DEFAULTS.maxSessions;
  cfg.brainPaths = Array.isArray(cfg.brainPaths)
    ? cfg.brainPaths.filter((p) => typeof p === 'string' && p && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'))
    : DEFAULTS.brainPaths;
  const seen = new Set();
  cfg.agents = (Array.isArray(cfg.agents) ? cfg.agents : DEFAULTS.agents).filter((a) => {
    const ok = a && typeof a.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(a.id)
      && typeof a.command === 'string' && a.command.trim() && !seen.has(a.id);
    if (ok) seen.add(a.id);
    return ok;
  }).map((a) => ({ id: a.id, name: typeof a.name === 'string' && a.name ? a.name.slice(0, 60) : a.id, command: a.command }));
  // Claude, Gemini, Mistral og OpenAI Codex er altid med – også i en ældre indstillingsfil med sin egen liste. Har filen en agent
  // med samme id, vinder filens. "builtinAgents": false slår det fra.
  if (!(raw && raw.builtinAgents === false)) {
    for (const a of DEFAULTS.agents) if (!seen.has(a.id)) { seen.add(a.id); cfg.agents.push({ ...a }); }
  }
  delete cfg.builtinAgents;
  return cfg;
}

function load(file) {
  let raw = null;
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Indstillingsfilen ${file} er ikke gyldig JSON: ${err.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Indstillingsfilen ${file} skal indeholde et JSON-objekt ({ ... }). Ret den, eller slet den for at starte forfra.`);
    }
  }
  return { config: clean(raw), existed, raw };
}

// Gemmer kun de felter vi bevidst ændrer, oven på det der allerede står i filen.
function save(file, raw, changes) {
  const next = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : DEFAULTS), ...changes };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

module.exports = { load, save, clean, expand, DEFAULTS };
