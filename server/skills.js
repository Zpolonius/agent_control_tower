'use strict';
// Skills til Claude Code: små instruktionsfiler (SKILL.md) som agenten kan bruge.
// Projekt-skills ligger i repoets .claude-mappe, personlige i din hjemmemappe.
// Control Tower læser dem kun. Nye skills skrives af en agent, ikke af Control Tower.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024;
const MAX_SKILLS = 300;

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
  // base = mappen der ledes i. Filer der (via symlinks) ender uden for base, springes over.
  function collect(base, scope, patterns) {
    let realBase;
    try { realBase = fs.realpathSync(base); } catch { return []; }
    const out = [];
    const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    function add(abs, source, fallbackName) {
      if (out.length >= MAX_SKILLS) return;
      let real, st;
      try { real = fs.realpathSync(abs); st = fs.statSync(real); } catch { return; }
      if (!st.isFile() || !(real.startsWith(realBase + path.sep))) return;
      let parsed;
      try { parsed = parseFrontmatter(readCapped(real).text); } catch { return; }
      const flag = (v) => /^(true|yes|on|1)$/i.test(String(v || ''));
      out.push({
        id: path.relative(realBase, real).split(path.sep).join('/'),
        name: (parsed.meta.name || fallbackName).slice(0, 100),
        description: `${parsed.meta.description || ''}${parsed.meta.when_to_use ? ` ${parsed.meta.when_to_use}` : ''}`.trim().slice(0, 1600),
        scope, source, manualOnly: flag(parsed.meta['disable-model-invocation']), mtime: st.mtimeMs,
      });
    }
    for (const p of patterns) p({ realBase, dirs, add });
    return out.sort((a, b) => a.name.localeCompare(b.name, 'da'));
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

  const project = (repoDir) => collect(path.join(repoDir, '.claude'), 'project', [skillDirs('skills', 'skill', 0), commandFiles]);
  const personal = () => collect(config.personalSkillsDir, 'personal', [skillDirs('', 'skill', 0), skillDirs('synced', 'synced', 1)]);

  // Kun filer der står på listen kan læses – så kan der ikke hentes andet fra fx ~/.claude.
  function read(scope, repoDir, id) {
    const base = scope === 'personal' ? config.personalSkillsDir : path.join(repoDir, '.claude');
    const entry = (scope === 'personal' ? personal() : project(repoDir)).find((s) => s.id === id);
    if (!entry) return null;
    const { text, truncated } = readCapped(path.join(fs.realpathSync(base), ...entry.id.split('/')));
    return { ...entry, truncated, content: parseFrontmatter(text).body };
  }

  return { project, personal, read };
}

module.exports = { createSkills, parseFrontmatter };
