'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGithub } = require('../server/github');

// Opretter en platformsuafhængig gh-shim (Windows gh.exe via csc.exe, Unix gh executable script)
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));
const mockFile = path.join(shimDir, 'mock-data.json');
const mockJs = path.join(shimDir, 'gh-mock.js');

fs.writeFileSync(mockJs, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mockPath = path.join(__dirname, 'mock-data.json');
let data = {};
try { data = JSON.parse(fs.readFileSync(mockPath, 'utf8')); } catch {}
if (data.exitCode) {
  if (data.stderr) process.stderr.write(data.stderr);
  process.exit(data.exitCode);
}
const args = process.argv.slice(2);
const cmd = args.slice(0, 2).join(' ');
if (cmd === 'pr view') {
  process.stdout.write(JSON.stringify(data.view || {}));
} else if (args[0] === 'api') {
  process.stdout.write(data.inline === null ? 'null' : JSON.stringify(data.inline || []));
} else if (cmd === 'pr list') {
  process.stdout.write(JSON.stringify(data.list || []));
} else if (cmd === 'issue view') {
  process.stdout.write(JSON.stringify(data.issue || {}));
} else if (cmd === 'issue list') {
  process.stdout.write(JSON.stringify(data.issues || []));
} else {
  process.stdout.write('{}');
}
`);

if (process.platform === 'win32') {
  const csPath = path.join(shimDir, 'gh.cs');
  const exePath = path.join(shimDir, 'gh.exe');
  fs.writeFileSync(csPath, `
using System;
using System.Diagnostics;
class Program {
    static int Main(string[] args) {
        var startInfo = new ProcessStartInfo {
            FileName = "node",
            Arguments = "\\"${mockJs.replace(/\\/g, '\\\\')}\\" " + string.Join(" ", args),
            UseShellExecute = false
        };
        var p = Process.Start(startInfo);
        p.WaitForExit();
        return p.ExitCode;
    }
}
`);
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (fs.existsSync(csc)) {
    execFileSync(csc, ['/nologo', `/out:${exePath}`, csPath]);
  }
  fs.writeFileSync(path.join(shimDir, 'gh.cmd'), `@echo off\r\nnode "%~dp0gh-mock.js" %*\r\n`);
} else {
  fs.writeFileSync(path.join(shimDir, 'gh'), `#!/bin/sh\nnode "$(dirname "$0")/gh-mock.js" "$@"\n`, { mode: 0o755 });
}

const origPath = process.env.PATH;
process.env.PATH = `${shimDir}${path.delimiter}${origPath}`;

function setMock(data) {
  fs.writeFileSync(mockFile, JSON.stringify(data));
}

test.after(() => {
  process.env.PATH = origPath;
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
});

test('github.detail: returnerer alle nye felter (body, baseBranch, state, draft, additions, deletions, changedFiles, checks, commits, diffHunk)', async () => {
  const gh = createGithub();
  const mockView = {
    number: 42,
    title: 'Tilføj review-composer',
    url: 'https://github.com/example/repo/pull/42',
    headRefName: 'feat/pr-review-composer',
    baseRefName: 'main',
    reviewDecision: 'CHANGES_REQUESTED',
    isDraft: false,
    state: 'OPEN',
    body: '## Beskrivelse af PR\\nHer er detaljerne.',
    additions: 120,
    deletions: 15,
    changedFiles: 4,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build-node', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-e2e', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'StatusContext', context: 'security/audit', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/deploy-preview', state: 'PENDING' },
    ],
    commits: [
      {
        oid: 'abcdef1234567890abcdef1234567890abcdef12',
        messageHeadline: 'feat: add composer',
        messageBody: 'Longer description',
        authors: [{ login: 'alice', name: 'Alice Dev' }],
        authoredDate: '2026-11-15T12:00:00Z',
      },
      {
        oid: '9876543210fedcba9876543210fedcba98765432',
        messageHeadline: 'fix: handle empty state',
        messageBody: '',
        author: { login: 'bob' },
        committedDate: '2026-11-15T13:00:00Z',
      },
    ],
    reviews: [
      { author: { login: 'rev1' }, state: 'CHANGES_REQUESTED', body: 'Ret denne linje', submittedAt: '2026-11-15T14:00:00Z' },
    ],
    comments: [
      { author: { login: 'bot' }, body: 'Velkommen til PR', createdAt: '2026-11-15T12:30:00Z' },
    ],
  };

  const mockInline = [
    {
      user: { login: 'rev1' },
      path: 'src/composer.js',
      line: 45,
      diff_hunk: '@@ -40,6 +40,7 @@\n const a = 1;\n+const b = 2;',
      body: 'Husk fejlhåndtering her',
      created_at: '2026-11-15T14:05:00Z',
    },
  ];

  setMock({ view: mockView, inline: mockInline });

  const detail = await gh.detail(shimDir, 42);

  assert.equal(detail.available, true);
  assert.equal(detail.number, 42);
  assert.equal(detail.title, 'Tilføj review-composer');
  assert.equal(detail.url, 'https://github.com/example/repo/pull/42');
  assert.equal(detail.branch, 'feat/pr-review-composer');
  assert.equal(detail.baseBranch, 'main');
  assert.equal(detail.decision, 'CHANGES_REQUESTED');
  assert.equal(detail.draft, false);
  assert.equal(detail.state, 'OPEN');
  assert.equal(detail.body, '## Beskrivelse af PR\\nHer er detaljerne.');
  assert.equal(detail.additions, 120);
  assert.equal(detail.deletions, 15);
  assert.equal(detail.changedFiles, 4);

  // Tjek checks: CheckRun + StatusContext
  assert.equal(Array.isArray(detail.checks), true);
  assert.equal(detail.checks.length, 4);
  assert.deepEqual(detail.checks[0], { name: 'build-node', status: 'COMPLETED', conclusion: 'SUCCESS' });
  assert.deepEqual(detail.checks[1], { name: 'test-e2e', status: 'IN_PROGRESS', conclusion: '' });
  assert.deepEqual(detail.checks[2], { name: 'security/audit', status: 'COMPLETED', conclusion: 'SUCCESS' });
  assert.deepEqual(detail.checks[3], { name: 'ci/deploy-preview', status: 'PENDING', conclusion: '' });

  // Tjek commits
  assert.equal(Array.isArray(detail.commits), true);
  assert.equal(detail.commits.length, 2);
  assert.deepEqual(detail.commits[0], {
    oid: 'abcdef1234567890abcdef1234567890abcdef12',
    messageHeadline: 'feat: add composer',
    messageBody: 'Longer description',
    author: 'alice',
    at: '2026-11-15T12:00:00Z',
  });
  assert.deepEqual(detail.commits[1], {
    oid: '9876543210fedcba9876543210fedcba98765432',
    messageHeadline: 'fix: handle empty state',
    messageBody: '',
    author: 'bob',
    at: '2026-11-15T13:00:00Z',
  });

  // Tjek inline kommentarer og diffHunk
  assert.equal(Array.isArray(detail.inline), true);
  assert.equal(detail.inline.length, 1);
  assert.equal(detail.inline[0].path, 'src/composer.js');
  assert.equal(detail.inline[0].line, 45);
  assert.equal(detail.inline[0].diffHunk, '@@ -40,6 +40,7 @@\n const a = 1;\n+const b = 2;');
  assert.equal(detail.inline[0].body, 'Husk fejlhåndtering her');
});

test('github.detail: bevarer tomme APPROVED og CHANGES_REQUESTED reviews, men filtrerer tomme COMMENTED', async () => {
  const gh = createGithub();
  const mockView = {
    number: 10,
    title: 'Test reviews',
    reviews: [
      { author: { login: 'approver' }, state: 'APPROVED', body: '', submittedAt: '2026-11-15T10:00:00Z' },
      { author: { login: 'blocker' }, state: 'CHANGES_REQUESTED', body: '   ', submittedAt: '2026-11-15T11:00:00Z' },
      { author: { login: 'ghost1' }, state: 'COMMENTED', body: '', submittedAt: '2026-11-15T12:00:00Z' },
      { author: { login: 'ghost2' }, state: 'COMMENTED', body: '   ', submittedAt: '2026-11-15T12:30:00Z' },
      { author: { login: 'reviewer' }, state: 'COMMENTED', body: 'Fint arbejde!', submittedAt: '2026-11-15T13:00:00Z' },
    ],
  };

  setMock({ view: mockView, inline: [] });

  const detail = await gh.detail(shimDir, 10);
  assert.equal(detail.reviews.length, 3);
  assert.equal(detail.reviews[0].author, 'approver');
  assert.equal(detail.reviews[0].state, 'APPROVED');
  assert.equal(detail.reviews[1].author, 'blocker');
  assert.equal(detail.reviews[1].state, 'CHANGES_REQUESTED');
  assert.equal(detail.reviews[2].author, 'reviewer');
  assert.equal(detail.reviews[2].state, 'COMMENTED');
  assert.equal(detail.reviews[2].body, 'Fint arbejde!');
});

test('github.detail: håndterer manglende og null felter sikkert', async () => {
  const gh = createGithub();
  const mockView = {
    number: 99,
    title: 'Minimal PR',
    body: null,
    baseRefName: null,
    state: null,
    isDraft: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    statusCheckRollup: null,
    commits: null,
    reviews: null,
    comments: null,
  };

  setMock({ view: mockView, inline: null });

  const detail = await gh.detail(shimDir, 99);
  assert.equal(detail.available, true);
  assert.equal(detail.number, 99);
  assert.equal(detail.body, '');
  assert.equal(detail.baseBranch, '');
  assert.equal(detail.state, '');
  assert.equal(detail.draft, false);
  assert.equal(detail.additions, 0);
  assert.equal(detail.deletions, 0);
  assert.equal(detail.changedFiles, 0);
  assert.deepEqual(detail.checks, []);
  assert.deepEqual(detail.commits, []);
  assert.deepEqual(detail.reviews, []);
  assert.deepEqual(detail.comments, []);
  assert.deepEqual(detail.inline, []);
  assert.equal(detail.inlineMissing, true);
});

test('github.detail: begrænser commits til de seneste 50', async () => {
  const gh = createGithub();
  const commits = [];
  for (let i = 1; i <= 60; i += 1) {
    commits.push({
      oid: `commit-${i}`.padEnd(40, '0'),
      messageHeadline: `Commit #${i}`,
      messageBody: '',
      author: { login: `dev${i}` },
      authoredDate: '2026-11-15T10:00:00Z',
    });
  }

  setMock({
    view: {
      number: 101,
      title: 'Mange commits',
      commits,
    },
    inline: [],
  });

  const detail = await gh.detail(shimDir, 101);
  assert.equal(detail.commits.length, 50);
  assert.equal(detail.commits[0].messageHeadline, 'Commit #11');
  assert.equal(detail.commits[49].messageHeadline, 'Commit #60');
});

test('github.detail: fejlhåndtering når gh fejler', async () => {
  const gh = createGithub();
  setMock({
    exitCode: 1,
    stderr: 'Du er ikke logget ind i GitHub CLI. Kør "gh auth login"',
  });

  const detail = await gh.detail(shimDir, 7);
  assert.equal(detail.available, false);
  assert.match(detail.reason, /ikke logget ind/);
});
