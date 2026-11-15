'use strict';
// Resumé af hvad der er sket i et repo, siden en agent startede. Bygger kun på git – der kaldes ingen model,
// og der skrives ikke noget i repoet. Resuméet viser ændringer i repoet i perioden, uanset hvem der lavede dem.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(cwd, args, input) {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-C', cwd, ...args],
      { timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => resolve(err ? null : stdout));
    if (input != null && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

const SHA = /^[0-9a-f]{7,64}$/;

// Læser "git status --porcelain=v2 -z". -z giver filnavne råt (mellemrum, æøå, anførselstegn) adskilt af nul-tegn.
function parseStatus(out) {
  const untracked = [];
  let dirty = false;
  const parts = (out || '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.startsWith('? ')) { untracked.push(p.slice(2)); dirty = true; }
    else if (/^[1u] /.test(p)) dirty = true;
    else if (p.startsWith('2 ')) { dirty = true; i += 1; } // omdøbning: næste felt er det gamle navn
  }
  return { untracked, dirty };
}

// Læser "git diff --numstat -z". En omdøbning står som: tal, tal, tomt navn, og derefter gammelt og nyt navn i hvert sit felt.
function parseNumstat(out) {
  const files = [];
  const parts = (out || '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!m) continue;
    const f = { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-', path: m[3], from: null };
    if (m[3] === '') { f.from = parts[i + 1] || ''; f.path = parts[i + 2] || ''; i += 2; }
    if (f.path) files.push(f);
  }
  return files;
}

const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--untracked-files=normal'];

// Tages lige før agenten starter: hvilket commit og hvilken branch repoet står på, og hvad der allerede var ændret.
async function baseline(cwd) {
  const [head, branch, status, dirty] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, STATUS_ARGS),
    git(cwd, ['diff', '--numstat', '-z', 'HEAD']),
  ]);
  const sha = head && SHA.test(head.trim()) ? head.trim() : null;
  return {
    ok: status != null, sha, branch: branch ? branch.trim() : null,
    untracked: parseStatus(status).untracked, dirty: parseNumstat(dirty).map((f) => f.path),
  };
}

async function summarize(cwd, base) {
  if (!base || !base.ok) return { available: false, reason: 'Git-status kunne ikke læses, da agenten startede.' };
  if (base.sha && !SHA.test(base.sha)) return { available: false, reason: 'Ugyldigt udgangspunkt.' };

  // Havde repoet ingen commits ved start, sammenlignes der med "det tomme træ" (et repo uden filer).
  let from = base.sha;
  if (!from) {
    const empty = await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], '');
    from = empty && SHA.test(empty.trim()) ? empty.trim() : null;
  }
  const [head, branch, status] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, STATUS_ARGS),
  ]);
  if (status == null) return { available: false, reason: 'Git-status kunne ikke læses.' };
  const hasHead = !!(head && SHA.test(head.trim()));

  // Er der skiftet branch, eller er historikken skrevet om, er "siden start" ikke længere en ren fortsættelse.
  let moved = false;
  if (base.sha) {
    const ancestor = await git(cwd, ['merge-base', '--is-ancestor', base.sha, 'HEAD']);
    moved = ancestor == null || (!!base.branch && !!branch && branch.trim() !== base.branch);
  }

  const [log, diff] = await Promise.all([
    hasHead ? git(cwd, ['log', '--max-count=30', '--format=%h%x09%s', ...(base.sha ? [`${base.sha}..HEAD`] : [])]) : Promise.resolve(''),
    from ? git(cwd, ['diff', '--numstat', '-z', from]) : Promise.resolve(''),
  ]);

  const untrackedBefore = new Set(base.untracked);
  const dirtyBefore = new Set(base.dirty);
  const commits = (log || '').split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t').slice(0, 200) }; });
  const show = (f) => (f.from ? `${f.from} → ${f.path}` : f.path).slice(0, 400);
  // "preexisting": filen var allerede ændret eller lå der allerede (uden at være i git), da agenten startede.
  const changed = parseNumstat(diff).map((f) => ({
    path: show(f), added: f.added, removed: f.removed, binary: f.binary, isNew: false,
    preexisting: dirtyBefore.has(f.path) || untrackedBefore.has(f.path) || (!!f.from && dirtyBefore.has(f.from)),
  }));
  const now = parseStatus(status);
  const fresh = now.untracked.filter((p) => !untrackedBefore.has(p))
    .map((p) => ({ path: p.slice(0, 400), added: 0, removed: 0, binary: false, isNew: true, preexisting: false }));
  const files = [...changed, ...fresh];
  return {
    available: true, commits, moved,
    files: files.slice(0, 200), fileCount: files.length,
    added: changed.reduce((n, f) => n + f.added, 0), removed: changed.reduce((n, f) => n + f.removed, 0),
    uncommitted: now.dirty,
  };
}

async function diff(cwd, base, { file, commit } = {}) {
  let out = null;
  if (commit != null && commit !== '') {
    if (typeof commit !== 'string' || !SHA.test(commit.trim())) {
      return { available: false, reason: 'Kunne ikke læse commit-diff.' };
    }
    out = await git(cwd, ['show', '--format=commit %h%n%s%n', '--patch', '--stat=100', commit.trim()]);
    if (out == null) return { available: false, reason: 'Kunne ikke læse commit-diff.' };
  } else if (file != null && file !== '') {
    if (typeof file !== 'string' || file.length === 0 || file.length > 400 || file.startsWith('-') || file.includes('\0')) {
      return { available: false, reason: 'Ugyldigt filnavn.' };
    }
    const targetFile = file.includes(' → ') ? file.split(' → ').pop() : file;
    if (!targetFile || targetFile.startsWith('-')) {
      return { available: false, reason: 'Ugyldigt filnavn.' };
    }
    const rootResolved = path.resolve(cwd);
    const absTarget = path.resolve(cwd, targetFile);
    if (!absTarget.startsWith(rootResolved + path.sep)) {
      return { available: false, reason: 'Ugyldig filsti.' };
    }
    let from = base && base.sha && SHA.test(base.sha) ? base.sha : null;
    if (!from) {
      const empty = await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], '');
      from = empty && SHA.test(empty.trim()) ? empty.trim() : null;
    }
    if (!from) return { available: false, reason: 'Kunne ikke bestemme udgangspunkt for diff.' };
    out = await git(cwd, ['diff', from, '--', targetFile]);
    if (!out || !out.trim()) {
      try {
        const realRoot = fs.realpathSync(rootResolved);
        const realTarget = fs.realpathSync(absTarget);
        const st = fs.statSync(realTarget);
        if (st.isFile() && realTarget.startsWith(realRoot + path.sep)) {
          const rawBuf = fs.readFileSync(realTarget);
          const slice = rawBuf.subarray(0, 65536);
          if (slice.includes(0)) {
            out = `--- /dev/null\n+++ b/${targetFile}\nBinær fil (${st.size} bytes)\n`;
          } else {
            const text = slice.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
            const lines = text ? text.split('\n') : [];
            const body = lines.map((l) => `+${l}`).join('\n') + (lines.length ? '\n' : '');
            out = `--- /dev/null\n+++ b/${targetFile}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
          }
        }
      } catch {
        /* Filen findes ikke eller kan ikke læses direkte */
      }
    }
    if (out == null) return { available: false, reason: 'Kunne ikke læse fil-diff.' };
  } else {
    return { available: false, reason: 'Mangler fil eller commit.' };
  }

  const MAX = 80000;
  const truncated = out.length > MAX;
  return { available: true, diff: out.slice(0, MAX), truncated };
}

module.exports = { baseline, summarize, diff, parseStatus, parseNumstat };
