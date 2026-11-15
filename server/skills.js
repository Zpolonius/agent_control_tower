'use strict';
// Skills til Claude Code og Gemini/Antigravity: små instruktionsfiler (SKILL.md) som agenten kan bruge.
// Projekt-skills ligger i repoets .claude-, .gemini- eller .agents-mappe; personlige i dine valgte skill-mapper.
// Control Tower læser dem kun. Nye skills skrives af en agent, ikke af Control Tower.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024;
const MAX_SKILLS = 300;

function labelForPersonalDir(dir) {
  if (/[/\\]\.claude([/\\]skills)?$/i.test(dir)) return 'Claude (~/.claude/skills)';
  if (/[/\\]\.gemini([/\\]skills)?$/i.test(dir)) return 'Gemini (~/.gemini/skills)';
  if (/[/\\]\.agents([/\\]skills)?$/i.test(dir)) return 'Delt (~/.agents/skills)';
  const base = path.basename(dir);
  if (/^skills$/i.test(base)) {
    const parent = path.basename(path.dirname(dir));
    return parent ? `${parent}/skills` : base;
  }
  return base || dir;
}

function parseFrontmatter(text) {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of (m[1] || '').split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      meta[key] = /^[>|][+-]?$/.test(v) ? '' : v.replace(/^'(.*)'$/, (_, x) => x.replace(/''/g, "'")).replace(/^"(.*)"$/, '$1');
    } else if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key] ? `${meta[key]} ` : ''}${line.trim()}`;
  }
  return { meta, body: text.slice(m[0].length) };
}

function readCapped(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, MAX_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), truncated: size > MAX_BYTES };
  } finally { fs.closeSync(fd); }
}

function createSkills(config) {
  function personalDirs() {
    if (Array.isArray(config.personalSkillsDirs) && config.personalSkillsDirs.length) return config.personalSkillsDirs;
    return config.personalSkillsDir ? [config.personalSkillsDir] : [];
  }

  // base = mappen der ledes i. Filer der (via symlinks) ender uden for base, springes over.
  function collectOne(base, scope, patterns, { idPrefix = '', dir = base, dirLabel = null, seen = new Set(), out = [] } = {}) {
    let realBase;
    try { realBase = fs.realpathSync(base); } catch { return out; }
    const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
    function add(abs, source, fallbackName) {
      if (out.length >= MAX_SKILLS) return;
      let real, st;
      try { real = fs.realpathSync(abs); st = fs.statSync(real); } catch { return; }
      if (!st.isFile() || !(real.startsWith(realBase + path.sep)) || seen.has(real)) return;
      let parsed;
      try { parsed = parseFrontmatter(readCapped(real).text); } catch { return; }
      seen.add(real);
      const flag = (v) => /^(true|yes|on|1)$/i.test(String(v || ''));
      const rel = path.relative(realBase, real).split(path.sep).join('/');
      out.push({
        realFile: real,
        entry: {
          id: `${idPrefix}${rel}`,
          name: (parsed.meta.name || fallbackName).slice(0, 100),
          description: `${parsed.meta.description || ''}${parsed.meta.when_to_use ? ` ${parsed.meta.when_to_use}` : ''}`.trim().slice(0, 1600),
          scope, source, manualOnly: flag(parsed.meta['disable-model-invocation']), mtime: st.mtimeMs,
          dir, dirLabel,
        },
      });
    }
    for (const p of patterns) p({ realBase, dirs, add });
    return out;
  }

  const skillDirs = (sub, source, depth) => ({ realBase, dirs, add }) => {
    const walk = (dir, left) => {
      for (const e of dirs(dir)) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        if (sub === '' && dir === realBase && e.name === 'synced') continue; // håndteres for sig
        const skillFile = path.join(dir, e.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) add(skillFile, source, e.name);
        else if (left > 0) walk(path.join(dir, e.name), left - 1);
      }
    };
    walk(sub ? path.join(realBase, sub) : realBase, depth);
  };
  const commandFiles = ({ realBase, dirs, add }) => {
    const root = path.join(realBase, 'commands');
    for (const e of dirs(root)) {
      if (e.isFile() && e.name.endsWith('.md')) add(path.join(root, e.name), 'command', e.name.slice(0, -3));
      else if (e.isDirectory()) {
        for (const f of dirs(path.join(root, e.name))) {
          if (f.isFile() && f.name.endsWith('.md')) add(path.join(root, e.name, f.name), 'command', `${e.name}:${f.name.slice(0, -3)}`);
        }
      }
    }
  };

  function collectProject(repoDir) {
    const seen = new Set();
    const out = [];
    const targets = [
      { sub: '.claude', idPrefix: '', dirLabel: null, patterns: [skillDirs('skills', 'skill', 0), commandFiles] },
      { sub: '.gemini', idPrefix: '.gemini/', dirLabel: 'Gemini (.gemini)', patterns: [skillDirs('skills', 'skill', 0), commandFiles] },
      { sub: '.agents', idPrefix: '.agents/', dirLabel: 'Delt (.agents)', patterns: [skillDirs('skills', 'skill', 0)] },
    ];
    for (const t of targets) {
      collectOne(path.join(repoDir, t.sub), 'project', t.patterns, { idPrefix: t.idPrefix, dir: t.sub, dirLabel: t.dirLabel, seen, out });
    }
    return out.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'da'));
  }

  function collectPersonal() {
    const dirsList = personalDirs();
    const seen = new Set();
    const out = [];
    dirsList.forEach((base, idx) => {
      collectOne(base, 'personal', [skillDirs('', 'skill', 0), skillDirs('synced', 'synced', 1)], {
        idPrefix: idx === 0 ? '' : `${idx}:`,
        dir: base,
        dirLabel: labelForPersonalDir(base),
        seen,
        out,
      });
    });
    return out.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'da'));
  }

  const project = (repoDir) => collectProject(repoDir).map((x) => x.entry);
  const personal = () => collectPersonal().map((x) => x.entry);

  // Kun filer der står på listen kan læses – så kan der ikke hentes andet fra fx ~/.claude eller ~/.gemini.
  function read(scope, repoDir, id) {
    const found = (scope === 'personal' ? collectPersonal() : collectProject(repoDir)).find((x) => x.entry.id === id);
    if (!found) return null;
    const { text, truncated } = readCapped(found.realFile);
    return { ...found.entry, truncated, content: parseFrontmatter(text).body };
  }

  return { project, personal, read, labelForPersonalDir };
}

module.exports = { createSkills, parseFrontmatter, labelForPersonalDir };
