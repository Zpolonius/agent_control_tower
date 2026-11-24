'use strict';
// Git worktree-håndtering for isolerede parallelle agenter i samme repo.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-C', cwd, ...args],
      {
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : 0,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

const isWin = process.platform === 'win32';
const normCmp = (p) => (isWin ? String(p).toLowerCase() : String(p));
const samePath = (a, b) => normCmp(a) === normCmp(b);
const isPathInside = (child, parent) => normCmp(child).startsWith(normCmp(parent) + path.sep);

function canonicalPath(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const dir = path.dirname(abs);
    if (dir === abs) return abs;
    return path.join(canonicalPath(dir), path.basename(abs));
  }
}

function makeError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

function isValidBranchFormat(name) {
  if (typeof name !== 'string' || !BRANCH_RE.test(name)) return false;
  if (name === 'HEAD' || name === '@') return false;
  if (name.includes('..') || name.includes('//') || name.includes('/.') || name.includes('@{')) return false;
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return false;
  const segs = name.split('/');
  return segs.every((seg) => seg && seg !== '.' && seg !== '..' && !seg.startsWith('.') && !seg.endsWith('.lock'));
}

async function validateBranchName(repoDir, name) {
  if (!isValidBranchFormat(name)) return false;
  const res = await git(repoDir, ['check-ref-format', '--branch', name]);
  return res.ok;
}

function parseWorktreeList(out, worktreeBase) {
  const realBase = worktreeBase ? canonicalPath(worktreeBase) : null;
  const blocks = (out || '').trim().split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.map((block, index) => {
    const entry = {
      path: null,
      realPath: null,
      head: null,
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
      main: index === 0,
      managed: false,
    };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        entry.path = line.slice(9).trim();
        entry.realPath = canonicalPath(entry.path);
      } else if (line.startsWith('HEAD ')) {
        entry.head = line.slice(5).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice(7).trim();
        entry.branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
      } else if (line === 'detached') {
        entry.detached = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        entry.locked = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        entry.prunable = true;
      }
    }
    if (realBase && entry.realPath) {
      entry.managed = !entry.main && isPathInside(entry.realPath, realBase);
    }
    return entry;
  }).filter((w) => w.path);
}

async function listWorktrees(repoDir, worktreeBase) {
  const res = await git(repoDir, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  return parseWorktreeList(res.stdout, worktreeBase);
}

async function list(repoDir, worktreeBase) {
  const [refsRes, headRes, worktrees] = await Promise.all([
    git(repoDir, ['for-each-ref', '--format=%(refname:short)%09%(HEAD)', 'refs/heads']),
    git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    listWorktrees(repoDir, worktreeBase),
  ]);
  const checkedOut = new Set(worktrees.filter((w) => w.branch).map((w) => w.branch));
  const rawHead = headRes.ok ? headRes.stdout.trim() : null;
  const detached = rawHead === 'HEAD';
  const currentBranch = !detached && rawHead ? rawHead : null;
  const branches = [];
  if (refsRes.ok) {
    for (const line of refsRes.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [name, mark] = line.split('\t');
      if (!name) continue;
      branches.push({
        name,
        current: mark === '*',
        checkedOut: checkedOut.has(name),
      });
    }
  }
  return {
    currentBranch,
    detached,
    branches,
    worktrees: worktrees.map((w) => ({
      id: w.main ? 'main' : path.basename(w.path),
      branch: w.branch,
      head: w.head ? w.head.slice(0, 7) : null,
      detached: w.detached,
      main: w.main,
      managed: w.managed,
      locked: w.locked,
      prunable: w.prunable,
    })),
  };
}

function branchSlug(name) {
  return String(name || 'wt')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'wt';
}

async function generateBranchName(repoDir, agentId) {
  const prefix = `ct/${branchSlug(agentId || 'agent').slice(0, 16)}`;
  for (let i = 0; i < 8; i += 1) {
    const candidate = `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
    const exists = await git(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (!exists.ok) return candidate;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

async function create({ repoDir, repo, worktreeBase, opts, agentId }) {
  if (!worktreeBase) throw makeError(500, 'Worktree-rodmappe mangler.');
  if (opts !== true && (!opts || typeof opts !== 'object' || Array.isArray(opts))) {
    throw makeError(400, 'Ugyldige worktree-indstillinger.');
  }

  const mode = opts === true || opts.mode == null ? 'new' : opts.mode;
  if (mode !== 'new' && mode !== 'existing') {
    throw makeError(400, 'Ugyldig worktree-tilstand.');
  }

  const headCheck = await git(repoDir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!headCheck.ok) {
    throw makeError(400, 'Repoet har ingen commits endnu – opret et commit før du bruger worktree.');
  }

  let branch;
  let baseBranchName = null;
  let startPoint = 'HEAD';

  if (mode === 'new') {
    const rawBranch = opts === true ? null : opts.branch;
    const rawBase = opts === true ? null : opts.baseBranch;
    if (rawBranch != null && typeof rawBranch !== 'string') {
      throw makeError(400, 'Ugyldigt branchnavn.');
    }
    if (rawBase != null && rawBase !== '') {
      if (typeof rawBase !== 'string' || !(await validateBranchName(repoDir, rawBase))) {
        throw makeError(400, 'Ugyldigt basis-branchnavn.');
      }
      const baseOk = await git(repoDir, ['rev-parse', '--verify', '-q', `${rawBase}^{commit}`]);
      if (!baseOk.ok) {
        throw makeError(400, `Basis-branchen "${rawBase}" findes ikke.`);
      }
      startPoint = rawBase;
      baseBranchName = rawBase;
    } else {
      const cur = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      baseBranchName = cur.ok && cur.stdout.trim() && cur.stdout.trim() !== 'HEAD' ? cur.stdout.trim() : null;
    }

    if (rawBranch == null || rawBranch === '') {
      branch = await generateBranchName(repoDir, agentId);
    } else {
      if (!(await validateBranchName(repoDir, rawBranch))) {
        throw makeError(400, 'Ugyldigt branchnavn. Brug kun bogstaver, tal, "-", "_", "." og "/".');
      }
      const exists = await git(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${rawBranch}`]);
      if (exists.ok) {
        throw makeError(409, `Branchen "${rawBranch}" findes allerede.`);
      }
      branch = rawBranch;
    }
  } else {
    const rawBranch = opts.branch;
    if (typeof rawBranch !== 'string' || !rawBranch) {
      throw makeError(400, 'Vælg en eksisterende branch.');
    }
    if (!(await validateBranchName(repoDir, rawBranch))) {
      throw makeError(400, 'Ugyldigt branchnavn.');
    }
    const exists = await git(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${rawBranch}`]);
    if (!exists.ok) {
      throw makeError(400, `Branchen "${rawBranch}" findes ikke i repoet.`);
    }
    const worktrees = await listWorktrees(repoDir, worktreeBase);
    if (worktrees.some((w) => w.branch === rawBranch)) {
      throw makeError(409, `Branchen "${rawBranch}" er allerede tjekket ud i en anden worktree.`);
    }
    branch = rawBranch;
    const cur = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    baseBranchName = cur.ok && cur.stdout.trim() && cur.stdout.trim() !== 'HEAD' ? cur.stdout.trim() : null;
  }

  const safeRepo = path.basename(String(repo || 'repo'));
  const realBase = canonicalPath(worktreeBase);
  const realRepo = canonicalPath(repoDir);
  const dirName = `${branchSlug(branch)}-${crypto.randomBytes(4).toString('hex')}`;
  const target = path.join(realBase, safeRepo, dirName);

  if (!isPathInside(target, realBase) || samePath(target, realRepo)) {
    throw makeError(400, 'Ugyldig worktree-sti.');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = mode === 'new'
    ? ['worktree', 'add', '-b', branch, '--', target, startPoint]
    : ['worktree', 'add', '--', target, branch];
  const addRes = await git(repoDir, args);
  if (!addRes.ok) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    if (mode === 'new') {
      const exists = await git(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (exists.ok || /already exists/i.test(addRes.stderr)) {
        throw makeError(409, `Branchen "${branch}" findes allerede.`);
      }
    } else {
      const worktrees = await listWorktrees(repoDir, worktreeBase);
      if (worktrees.some((w) => w.branch === branch) || /already (?:checked out|used by worktree)/i.test(addRes.stderr)) {
        throw makeError(409, `Branchen "${branch}" er allerede tjekket ud i en anden worktree.`);
      }
    }
    throw makeError(500, 'Kunne ikke oprette git worktree.');
  }

  return {
    path: canonicalPath(target),
    branch,
    baseBranch: baseBranchName,
    mode,
    createdBranch: mode === 'new',
    cleaned: false,
  };
}

async function cleanup({ repoDir, worktreeBase, worktree, merge = false, deleteBranch = false, targetBranch = null, force = false }) {
  if (!worktree || typeof worktree.path !== 'string' || typeof worktree.branch !== 'string') {
    return { ok: false, status: 400, error: 'Ugyldige worktree-oplysninger.' };
  }
  if (!worktreeBase) {
    return { ok: false, status: 500, error: 'Worktree-rodmappe mangler.' };
  }
  const repoExists = fs.existsSync(repoDir);
  if (repoExists) {
    if (!(await validateBranchName(repoDir, worktree.branch))) {
      return { ok: false, status: 400, error: 'Ugyldigt branchnavn.' };
    }
  } else if (!isValidBranchFormat(worktree.branch)) {
    return { ok: false, status: 400, error: 'Ugyldigt branchnavn.' };
  }
  if (targetBranch != null && targetBranch !== '') {
    if (typeof targetBranch !== 'string' || !repoExists || !(await validateBranchName(repoDir, targetBranch))) {
      return { ok: false, status: 400, error: 'Ugyldigt mål-branchnavn.' };
    }
  }

  const realBase = canonicalPath(worktreeBase);
  const realRepo = canonicalPath(repoDir);
  const realWt = canonicalPath(worktree.path);
  if (!isPathInside(realWt, realBase) || samePath(realWt, realRepo) || samePath(realWt, realBase)) {
    return { ok: false, status: 400, error: 'Ugyldig worktree-sti.' };
  }

  let exists = false;
  try {
    const lst = fs.lstatSync(worktree.path);
    if (lst.isSymbolicLink()) return { ok: false, status: 400, error: 'Ugyldig worktree-sti.' };
    const actualReal = fs.realpathSync.native(worktree.path);
    if (!isPathInside(actualReal, realBase) || samePath(actualReal, realRepo)) {
      return { ok: false, status: 400, error: 'Ugyldig worktree-sti.' };
    }
    exists = true;
  } catch {
    exists = false;
  }

  if (!repoExists) {
    if (merge) {
      return { ok: false, status: 409, error: 'Hovedrepoet findes ikke længere.' };
    }
    if (exists) {
      if (!force) {
        return { ok: false, status: 409, dirty: true, error: 'Hovedrepoet findes ikke længere. Bekræft for at fjerne worktree-mappen.' };
      }
      fs.rmSync(realWt, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(realWt)); } catch { /* ikke tom eller allerede fjernet */ }
    }
    return {
      ok: true,
      merged: false,
      targetBranch: null,
      branchDeleted: false,
      branch: worktree.branch,
    };
  }

  const worktrees = await listWorktrees(repoDir, worktreeBase);
  const entry = worktrees.find((w) => samePath(w.realPath, realWt));
  if (entry && entry.main) {
    return { ok: false, status: 400, error: 'Kan ikke fjerne hovedrepoet.' };
  }
  if (!entry && exists) {
    return { ok: false, status: 400, error: 'Stien er ikke en registreret worktree.' };
  }

  let mergeTarget = null;
  if (merge) {
    if (!exists) {
      return { ok: false, status: 409, error: 'Worktree-mappen findes ikke længere.' };
    }
    const wtSt = await git(realWt, ['status', '--porcelain=v2', '-z']);
    if (!wtSt.ok || wtSt.stdout.length > 0) {
      return { ok: false, status: 409, dirty: true, error: 'Worktree har ucommittede ændringer – commit eller kassér dem før merge.' };
    }
    const headRes = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const current = headRes.ok ? headRes.stdout.trim() : '';
    if (!current || current === 'HEAD') {
      return { ok: false, status: 409, error: 'Hovedrepoet står ikke på en branch.' };
    }
    if (targetBranch && current !== targetBranch) {
      return { ok: false, status: 409, error: `Hovedrepoet står på "${current}", ikke "${targetBranch}".` };
    }
    mergeTarget = targetBranch || current;
    if (mergeTarget === worktree.branch) {
      return { ok: false, status: 409, error: 'Kan ikke merge branchen ind i sig selv.' };
    }
    const mainSt = await git(repoDir, ['status', '--porcelain=v2', '-z']);
    if (!mainSt.ok || mainSt.stdout.length > 0) {
      return { ok: false, status: 409, error: 'Hovedrepoet har ucommittede ændringer – commit eller stash dem før merge.' };
    }
    const mergeRes = await git(repoDir, ['merge', '--no-edit', '--', worktree.branch]);
    if (!mergeRes.ok) {
      await git(repoDir, ['merge', '--abort']);
      return { ok: false, status: 409, error: `Merge-konflikt ved merge af "${worktree.branch}" ind i "${mergeTarget}". Merge blev afbrudt.` };
    }
  }

  if (exists) {
    if (!merge && !force) {
      const wtSt = await git(realWt, ['status', '--porcelain=v2', '-z']);
      if (wtSt.ok && wtSt.stdout.length > 0) {
        return { ok: false, status: 409, dirty: true, error: 'Worktree har ucommittede ændringer. Bekræft for at fjerne den alligevel.' };
      }
    }
    if (entry && entry.locked) {
      await git(repoDir, ['worktree', 'unlock', '--', realWt]);
    }
    const rmArgs = ['worktree', 'remove', ...(force ? ['--force'] : []), '--', realWt];
    let rmRes = await git(repoDir, rmArgs);
    if (!rmRes.ok && force) {
      await git(repoDir, ['worktree', 'unlock', '--', realWt]);
      rmRes = await git(repoDir, ['worktree', 'remove', '--force', '--force', '--', realWt]);
    }
    if (!rmRes.ok) {
      return { ok: false, status: 409, error: 'Worktree kunne ikke fjernes.' };
    }
  }

  await git(repoDir, ['worktree', 'prune']);
  try {
    fs.rmdirSync(path.dirname(realWt));
  } catch { /* ikke tom eller allerede fjernet */ }

  let branchDeleted = false;
  if (deleteBranch) {
    const curRes = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const cur = curRes.ok ? curRes.stdout.trim() : '';
    if (cur !== worktree.branch) {
      const bRes = await git(repoDir, ['branch', merge ? '-d' : '-D', '--', worktree.branch]);
      branchDeleted = bRes.ok;
    }
  }

  return {
    ok: true,
    merged: !!merge,
    targetBranch: mergeTarget,
    branchDeleted,
    branch: worktree.branch,
  };
}

module.exports = {
  list,
  create,
  cleanup,
  validateBranchName,
  isValidBranchFormat,
  canonicalPath,
  parseWorktreeList,
};
