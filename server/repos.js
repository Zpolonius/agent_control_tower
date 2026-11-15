'use strict';
// Finder git-repos direkte under rodmappen og læser deres status. Kun læsning – der ændres aldrig noget i et repo.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

function parseStatus(out) {
  const info = { branch: null, detached: false, oid: null, ahead: 0, behind: 0, upstream: false, changed: 0, untracked: 0 };
  if (out == null) return info;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.oid ')) info.oid = /^[0-9a-f]{7,}/.test(line.slice(13)) ? line.slice(13, 20) : null;
    else if (line.startsWith('# branch.head ')) {
      // "(detached)" er ikke en branch: repoet står på et bestemt commit uden branch.
      const head = line.slice(14).trim();
      if (head === '(detached)') info.detached = true; else info.branch = head;
    }
    else if (line.startsWith('# branch.upstream ')) info.upstream = true;
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { info.ahead = Number(m[1]); info.behind = Number(m[2]); }
    } else if (line.startsWith('? ')) info.untracked += 1;
    else if (/^[12u] /.test(line)) info.changed += 1;
  }
  return info;
}

async function describe(root, name, brain) {
  const dir = path.join(root, name);
  const [status, log] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '--branch']),
    git(dir, ['log', '-1', '--format=%ct%x09%s']),
  ]);
  const info = parseStatus(status);
  let lastCommit = null;
  if (log && log.trim()) {
    const [ts, ...rest] = log.trim().split('\t');
    lastCommit = { time: Number(ts) * 1000, subject: rest.join('\t').slice(0, 200) };
  }
  return { name, ...info, gitOk: status != null, lastCommit, brainFiles: brain.list(dir).length };
}

function createScanner(config, brain) {
  let cache = null;
  let pending = null;

  function listNames() {
    let entries;
    try {
      entries = fs.readdirSync(config.root, { withFileTypes: true });
    } catch {
      return { names: [], skipped: 0, error: 'Rodmappen kan ikke læses' };
    }
    const names = [];
    let skipped = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      // Mapper der er genveje (symlinks) tæller også med.
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(config.root, e.name)).isDirectory(); } catch { isDir = false; } }
      if (!isDir) continue;
      if (fs.existsSync(path.join(config.root, e.name, '.git'))) names.push(e.name);
      else skipped += 1;
    }
    names.sort((a, b) => a.localeCompare(b, 'da'));
    return { names, skipped, error: null };
  }

  async function scan(force) {
    if (!force && cache && Date.now() - cache.at < 4000) return cache.data;
    if (pending) return pending;
    pending = (async () => {
      const { names, skipped, error } = listNames();
      const repos = [];
      // Fem ad gangen, så mange repos ikke starter 100 git-processer på én gang.
      for (let i = 0; i < names.length; i += 5) {
        repos.push(...await Promise.all(names.slice(i, i + 5).map((n) => describe(config.root, n, brain))));
      }
      const data = { repos, skipped, error };
      cache = { at: Date.now(), data };
      return data;
    })().finally(() => { pending = null; });
    return pending;
  }

  // Et repo-navn fra browseren godtages kun, hvis det findes i den aktuelle liste – så kan ingen pege ud af rodmappen.
  function resolve(name) {
    if (typeof name !== 'string') return null;
    return listNames().names.includes(name) ? path.join(config.root, name) : null;
  }

  return { scan, resolve };
}

module.exports = { createScanner, parseStatus };
