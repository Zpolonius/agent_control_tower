'use strict';
// Henter pull requests og reviews via GitHubs eget værktøj "gh", som du allerede er logget ind med.
// Control Tower gemmer derfor ingen GitHub-nøgler selv. Kun læsning.
const { execFile } = require('node:child_process');

function gh(cwd, args) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: stdout });
      let reason = 'GitHub svarede ikke. Tjek din internetforbindelse, og tryk "Hent igen".';
      const text = String(stderr || '');
      if (err.code === 'ENOENT') reason = 'GitHub CLI (gh) er ikke installeret på denne maskine. Installér den fra cli.github.com, og kør derefter "gh auth login" i en terminal.';
      else if (/auth login|not logged in|authentication/i.test(text)) reason = 'Du er ikke logget ind i GitHub CLI. Kør "gh auth login" i en terminal, og tryk derefter "Hent igen".';
      else if (/no git remotes|not a git repository|none of the git remotes/i.test(text)) reason = 'Dette repo er ikke koblet til GitHub.';
      resolve({ ok: false, reason });
    });
  });
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const login = (a) => (a && typeof a.login === 'string' ? a.login : 'ukendt');
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function createGithub() {
  const cache = new Map();

  async function list(repo, cwd, force) {
    const hit = cache.get(repo);
    if (!force && hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await gh(cwd, ['pr', 'list', '--limit', '30', '--json', 'number,title,headRefName,reviewDecision,isDraft,updatedAt,url,author']);
    const rows = r.ok ? parse(r.out) : null;
    const data = !r.ok ? { available: false, reason: r.reason, prs: [] }
      : !Array.isArray(rows) ? { available: false, reason: 'Uventet svar fra GitHub', prs: [] }
      : { available: true, reason: null, prs: rows.map((p) => ({
        number: Number(p.number), title: str(p.title, 300), branch: str(p.headRefName, 200),
        decision: str(p.reviewDecision, 40), draft: !!p.isDraft, updatedAt: str(p.updatedAt, 40),
        url: str(p.url, 500), author: login(p.author) })) };
    cache.set(repo, { at: Date.now(), data });
    return data;
  }

  async function detail(cwd, number) {
    const n = String(number);
    const [view, inline] = await Promise.all([
      gh(cwd, ['pr', 'view', n, '--json', 'number,title,url,headRefName,reviewDecision,reviews,comments']),
      gh(cwd, ['api', `repos/{owner}/{repo}/pulls/${n}/comments`, '--paginate']),
    ]);
    const pr = view.ok ? parse(view.out) : null;
    if (!pr) return { available: false, reason: view.reason || 'Uventet svar fra GitHub' };
    const inl = inline.ok ? parse(inline.out) : null;
    return {
      available: true,
      number: Number(pr.number), title: str(pr.title, 300), url: str(pr.url, 500),
      branch: str(pr.headRefName, 200), decision: str(pr.reviewDecision, 40),
      reviews: (pr.reviews || []).map((r) => ({ author: login(r.author), state: str(r.state, 40), body: str(r.body, 20000), at: str(r.submittedAt, 40) }))
        .filter((r) => r.body || r.state !== 'COMMENTED'),
      comments: (pr.comments || []).map((c) => ({ author: login(c.author), body: str(c.body, 20000), at: str(c.createdAt, 40) })),
      inline: Array.isArray(inl) ? inl.map((c) => ({ author: login(c.user), path: str(c.path, 500),
        line: Number.isInteger(c.line) ? c.line : (Number.isInteger(c.original_line) ? c.original_line : null),
        body: str(c.body, 20000), at: str(c.created_at, 40) })) : [],
      inlineMissing: !Array.isArray(inl),
    };
  }

  const labels = (l) => (Array.isArray(l) ? l.slice(0, 12).map((x) => str(x && x.name, 60)).filter(Boolean) : []);

  async function issues(repo, cwd, force) {
    const key = `issues:${repo}`;
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await gh(cwd, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,labels,assignees,updatedAt,url,author,comments']);
    const rows = r.ok ? parse(r.out) : null;
    const data = !r.ok ? { available: false, reason: r.reason, issues: [] }
      : !Array.isArray(rows) ? { available: false, reason: 'Uventet svar fra GitHub', issues: [] }
      : { available: true, reason: null, issues: rows.map((i) => ({
        number: Number(i.number), title: str(i.title, 300), labels: labels(i.labels),
        assignees: Array.isArray(i.assignees) ? i.assignees.slice(0, 5).map(login) : [],
        comments: Array.isArray(i.comments) ? i.comments.length : 0,
        updatedAt: str(i.updatedAt, 40), url: str(i.url, 500), author: login(i.author) })) };
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  async function issue(cwd, number) {
    const r = await gh(cwd, ['issue', 'view', String(number), '--json', 'number,title,body,labels,url,author,comments,updatedAt']);
    const i = r.ok ? parse(r.out) : null;
    if (!i) return { available: false, reason: r.reason || 'Uventet svar fra GitHub' };
    return {
      available: true, number: Number(i.number), title: str(i.title, 300), body: str(i.body, 30000), labels: labels(i.labels),
      url: str(i.url, 500), author: login(i.author), updatedAt: str(i.updatedAt, 40),
      comments: (i.comments || []).slice(-30).map((c) => ({ author: login(c.author), body: str(c.body, 10000), at: str(c.createdAt, 40) })),
    };
  }

  return { list, detail, issues, issue };
}

module.exports = { createGithub };
