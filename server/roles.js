'use strict';
// Roller: færdige arbejdsbeskrivelser (fejlfinder, security, QA, UX, Issue/PO, udvikler, orkestrator, teknisk dokumentation), som gives til en agent.
// Rollerne ligger som markdown-filer i Control Towers egen mappe "roles". Et repo kan give en rolle et tillæg
// (eller lave sine egne roller) i .control-tower/roles/<id>.md. Teknologi-noter ligger i roles/stacks/<stack>.md.
// Control Tower læser kun filerne – rapporterne skriver agenten selv i repoets docs/reports.
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./skills');

const BUILTIN_DIR = path.join(__dirname, '..', 'roles');
const REPO_DIR = path.join('.control-tower', 'roles');
const REPORT_DIR = path.join('docs', 'reports');
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ICONS = new Set(['lup', 'skjold', 'kolbe', 'pensel', 'klippebord', 'skruenoegle', 'bog', 'dirigent', 'robot']);
const MAX_FILE = 64 * 1024;
const MAX_REPORT = 512 * 1024;
const MAX_INPUT = 20000;
const STACK_NAMES = { typescript: 'TypeScript/JavaScript', kotlin: 'Kotlin/Android', flutter: 'Flutter/Dart' };

function readSmall(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString('utf8').replace(/^﻿/, ''), size, truncated: size > max };
  } finally { fs.closeSync(fd); }
}

// Finder en fil inde i en mappe – og kun inde i den. Symlinks der peger ud, afvises.
function inside(base, ...parts) {
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { return null; }
  let real;
  try { real = fs.realpathSync(path.join(realBase, ...parts)); } catch { return null; }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
  return real;
}

function exists(dir, name) {
  try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
}

// Gætter hvilke teknologier repoet bruger ud fra filer i roden og ét niveau ned (fx en app/-mappe).
function detectStacks(repoDir) {
  const found = new Set();
  const dirs = [repoDir];
  try {
    for (const e of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') dirs.push(path.join(repoDir, e.name));
    }
  } catch { /* ulæselig mappe: ingen gæt */ }
  for (const d of dirs.slice(0, 40)) {
    if (exists(d, 'pubspec.yaml')) found.add('flutter');
    if (['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => exists(d, f))) found.add('kotlin');
    if (exists(d, 'package.json') || exists(d, 'tsconfig.json')) found.add('typescript');
  }
  return [...found].sort();
}

function parseRole(text, id, source) {
  const { meta, body } = parseFrontmatter(text);
  const icon = ICONS.has(meta.icon) ? meta.icon : 'robot';
  return {
    id, source,
    name: String(meta.name || id).slice(0, 40),
    icon,
    mode: meta.mode === 'develop' ? 'develop' : 'report',
    description: String(meta.description || '').slice(0, 300),
    body,
  };
}

function createRoles({ builtinDir = BUILTIN_DIR } = {}) {
  function mdFiles(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md') && ID.test(e.name.slice(0, -3)))
        .map((e) => e.name.slice(0, -3)).sort();
    } catch { return []; }
  }

  function builtin() {
    const out = new Map();
    for (const id of mdFiles(builtinDir)) {
      const file = inside(builtinDir, `${id}.md`);
      if (!file) continue;
      try { out.set(id, parseRole(readSmall(file, MAX_FILE).text, id, 'builtin')); } catch { /* ulæselig rolle springes over */ }
    }
    return out;
  }

  // Repoets egne filer: et tillæg til en indbygget rolle (samme id), eller en helt ny rolle (nyt id med frontmatter).
  function repoFiles(repoDir) {
    const out = new Map();
    const dir = inside(repoDir, REPO_DIR);
    if (!dir) return out;
    for (const id of mdFiles(dir)) {
      const file = inside(dir, `${id}.md`);
      if (!file) continue;
      try { out.set(id, readSmall(file, MAX_FILE).text); } catch { /* springes over */ }
    }
    return out;
  }

  function resolveAll(repoDir) {
    const roles = builtin();
    const extras = repoFiles(repoDir);
    const notes = new Map();
    for (const [id, text] of extras) {
      if (roles.has(id)) notes.set(id, parseFrontmatter(text).body.trim());
      else {
        const role = parseRole(text, id, 'repo');
        if (role.body.trim()) roles.set(id, role);
      }
    }
    return { roles, notes };
  }

  // Gennemgangs-rollerne først, så dem der arbejder videre med fundene, og til sidst repoets egne roller.
  const ORDER = ['fejlfinder', 'security', 'qa', 'ux', 'po', 'udvikler', 'orkestrator', 'dokumentation'];
  const rank = (r) => { const i = ORDER.indexOf(r.id); return i === -1 ? ORDER.length + (r.source === 'repo' ? 1 : 0) : i; };

  function list(repoDir) {
    const { roles, notes } = resolveAll(repoDir);
    return [...roles.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'da')).map((r) => ({
      id: r.id, name: r.name, icon: r.icon, mode: r.mode, description: r.description, source: r.source, hasRepoNotes: notes.has(r.id) && !!notes.get(r.id),
    }));
  }

  function stackNotes(stacks) {
    return stacks.map((s) => {
      const file = inside(builtinDir, 'stacks', `${s}.md`);
      if (!file) return '';
      try { return `### ${STACK_NAMES[s] || s}\n${readSmall(file, MAX_FILE).text.trim()}`; } catch { return ''; }
    }).filter(Boolean).join('\n\n');
  }

  // Bygger den tekst der gives til agenten. Tomme afsnit fjernes, så agenten ikke ser "{{...}}" eller tomme overskrifter.
  function build(repoDir, repoName, roleId, input, now = new Date()) {
    const { roles, notes } = resolveAll(repoDir);
    const role = roles.get(roleId);
    if (!role) return null;
    const date = now.toISOString().slice(0, 10);
    const stacks = detectStacks(repoDir);
    const values = {
      repo: repoName,
      date,
      stacks: stacks.length ? stacks.map((s) => STACK_NAMES[s] || s).join(', ') : 'ukendt',
      stackNotes: stackNotes(stacks),
      repoNotes: notes.get(roleId) || '',
      reportPath: `${REPORT_DIR.split(path.sep).join('/')}/${date}-${roleId}.md`,
      input: String(input || '').slice(0, MAX_INPUT).trim(),
    };
    let text = role.body;
    // En overskrift hvis eneste indhold er en tom pladsholder, fjernes sammen med pladsholderen.
    text = text.replace(/^(#{1,6} [^\n]*)\n+\{\{(\w+)\}\}[ \t]*(?=\n|$)/gm, (all, head, key) => (values[key] ? `${head}\n\n${values[key]}` : ''));
    text = text.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in values ? values[key] : all));
    return { role: { id: role.id, name: role.name, icon: role.icon, mode: role.mode }, text: text.replace(/\n{3,}/g, '\n\n').trim(), stacks, reportPath: values.reportPath };
  }

  // Rapporter som agenterne har skrevet. Kun .md-filer direkte i docs/reports.
  function reports(repoDir) {
    const dir = inside(repoDir, REPORT_DIR);
    if (!dir) return [];
    let names;
    try { names = fs.readdirSync(dir).filter((n) => /^[^/\\]{1,120}\.md$/.test(n)); } catch { return []; }
    const out = [];
    for (const name of names) {
      const file = inside(dir, name);
      if (!file) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const m = name.match(/^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/);
      out.push({ name, date: m ? m[1] : null, roleId: m ? m[2] : null, mtime: st.mtimeMs, size: st.size });
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
  }

  function readReport(repoDir, name) {
    if (typeof name !== 'string' || !reports(repoDir).some((r) => r.name === name)) return null;
    const file = inside(repoDir, REPORT_DIR, name);
    if (!file) return null;
    const { text, truncated } = readSmall(file, MAX_REPORT);
    return { name, truncated, content: text, findings: parseFindings(text) };
  }

  return { list, build, reports, readReport, detectStacks };
}

// Deler en rapport op i fund: "## F1 · høj · Titel" efterfulgt af tekst indtil næste fund eller overskrift af samme niveau.
function parseFindings(text) {
  const out = [];
  const re = /^##[ \t]+(F\d{1,3})[ \t]*[·\-–|:][ \t]*([^\n]*)$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ at: m.index, end: m.index + m[0].length, id: m[1], head: m[2] });
  for (let i = 0; i < marks.length; i += 1) {
    const stop = i + 1 < marks.length ? marks[i + 1].at : (() => {
      const next = text.slice(marks[i].end).search(/^#{1,2} /m);
      return next === -1 ? text.length : marks[i].end + next;
    })();
    const parts = marks[i].head.split(/[ \t]*[·|][ \t]*|[ \t]+[-–][ \t]+/);
    const severity = parts.length > 1 && /^(kritisk|høj|middel|lav|info)$/i.test(parts[0]) ? parts.shift().toLowerCase() : null;
    out.push({ id: marks[i].id, severity, title: parts.join(' · ').trim().slice(0, 200), body: text.slice(marks[i].end, stop).trim().slice(0, 20000) });
  }
  return out.slice(0, 100);
}

module.exports = { createRoles, parseFindings, detectStacks, MAX_INPUT };
