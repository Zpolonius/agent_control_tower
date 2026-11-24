'use strict';
// Hjernen: kun repoets egne docs – ikke agenternes arbejdskopier eller rapporter, der har deres egen fane.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrain } = require('../server/brain');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-brain-'));
const mk = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('springer worktrees, andre checkouts og rapporter over', () => {
  const repo = path.join(tmp, 'repo');
  mk(path.join(repo, 'CLAUDE.md'));
  mk(path.join(repo, 'docs', 'arkitektur.md'));
  mk(path.join(repo, 'docs', 'reports', '2026-11-17-udvikler.md'));
  mk(path.join(repo, '.claude', 'skills', 'run', 'SKILL.md'));
  mk(path.join(repo, '.claude', 'worktrees', 'fix-1', 'CLAUDE.md'));
  mk(path.join(repo, '.claude', 'worktrees', 'fix-1', 'docs', 'arkitektur.md'));
  // En anden checkout et andet sted (en git worktree har en .git-fil, ikke en mappe).
  mk(path.join(repo, 'docs', 'vendor-checkout', '.git'), 'gitdir: /et/andet/sted');
  mk(path.join(repo, 'docs', 'vendor-checkout', 'README.md'));

  const brain = createBrain({ brainPaths: ['docs', 'CLAUDE.md', 'AGENTS.md', '.claude'] });
  assert.deepEqual(brain.list(repo).map((f) => f.path),
    ['.claude/skills/run/SKILL.md', 'CLAUDE.md', 'docs/arkitektur.md']);
  assert.equal(brain.read(repo, '.claude/worktrees/fix-1/CLAUDE.md'), null, 'skjulte filer kan heller ikke læses');
});
