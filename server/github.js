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
const commitAuthor = (c) => {
  if (Array.isArray(c.authors) && c.authors.length) {
    const a = c.authors[0];
    if (a && typeof a.login === 'string') return a.login;
    if (a && typeof a.name === 'string') return a.name;
  }
  if (c.author) {
    if (typeof c.author === 'string') return c.author;
    if (typeof c.author.login === 'string') return c.author.login;
    if (typeof c.author.name === 'string') return c.author.name;
  }
  return 'ukendt';
};
const commitAt = (c) => str(c && (c.authoredDate || c.committedDate || c.at), 40);
const mapCheck = (c) => {
  if (!c || typeof c !== 'object') return null;
  const name = str(c.name || c.context, 200);
  if (!name) return null;
  const status = str(c.status || (c.state === 'PENDING' ? 'PENDING' : (c.state ? 'COMPLETED' : '')), 40);
  const conclusion = str(c.conclusion || (c.state && c.state !== 'PENDING' ? c.state : ''), 40);
  return { name, status, conclusion };
};

function createGithub(deps) {
  const runner = typeof deps === 'function' ? deps : (deps && typeof deps.gh === 'function' ? deps.gh : gh);
  const cache = new Map();

  async function list(repo, cwd, force) {
    const hit = cache.get(repo);
    if (!force && hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await runner(cwd, ['pr', 'list', '--limit', '30', '--json', 'number,title,headRefName,reviewDecision,isDraft,updatedAt,url,author']);
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
    const [view, inline, rest] = await Promise.all([
      runner(cwd, ['pr', 'view', n, '--json', 'number,title,url,headRefName,baseRefName,reviewDecision,isDraft,state,body,additions,deletions,changedFiles,statusCheckRollup,commits,reviews,comments']),
      runner(cwd, ['api', `repos/{owner}/{repo}/pulls/${n}/comments`, '--paginate']),
      runner(cwd, ['api', `repos/{owner}/{repo}/pulls/${n}/reviews`, '--paginate']),
    ]);
    const pr = view.ok ? parse(view.out) : null;
    if (!pr) return { available: false, reason: view.reason || 'Uventet svar fra GitHub' };
    const inl = inline.ok ? parse(inline.out) : null;
    // gh pr view giver reviews med GraphQL-id, mens kodekommentarer peger på REST-id'et – oversæt, så de kan samles.
    const restReviews = rest.ok ? parse(rest.out) : null;
    const reviewIds = new Map((Array.isArray(restReviews) ? restReviews : [])
      .filter((r) => r && typeof r.node_id === 'string' && Number.isInteger(r.id)).map((r) => [r.node_id, r.id]));
    const inlineReviewIds = new Set((Array.isArray(inl) ? inl : []).map((c) => c && c.pull_request_review_id).filter(Number.isInteger));
    return {
      available: true,
      number: Number(pr.number), title: str(pr.title, 300), url: str(pr.url, 500),
      branch: str(pr.headRefName, 200), baseBranch: str(pr.baseRefName || pr.baseBranch, 200),
      decision: str(pr.reviewDecision, 40), state: str(pr.state, 40), draft: !!(pr.isDraft ?? pr.draft),
      body: str(pr.body, 50000),
      additions: Number.isInteger(pr.additions) ? pr.additions : (Number(pr.additions) || 0),
      deletions: Number.isInteger(pr.deletions) ? pr.deletions : (Number(pr.deletions) || 0),
      changedFiles: Number.isInteger(pr.changedFiles) ? pr.changedFiles : (Number(pr.changedFiles) || 0),
      checks: (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []).map(mapCheck).filter(Boolean),
      commits: (Array.isArray(pr.commits) ? pr.commits.slice(-50) : []).map((c) => ({
        oid: str(c.oid || c.sha, 100),
        messageHeadline: str(c.messageHeadline || c.message || '', 500),
        messageBody: str(c.messageBody, 10000),
        author: commitAuthor(c),
        at: commitAt(c),
      })),
      reviews: (pr.reviews || []).map((r) => ({ id: reviewIds.get(r.id) ?? null, author: login(r.author), state: str(r.state, 40), body: str(r.body, 20000), at: str(r.submittedAt, 40) }))
        .filter((r) => (r.body && r.body.trim()) || r.state !== 'COMMENTED' || inlineReviewIds.has(r.id)),
      comments: (pr.comments || []).map((c) => ({ author: login(c.author), body: str(c.body, 20000), at: str(c.createdAt, 40) })),
      inline: Array.isArray(inl) ? inl.map((c) => ({ author: login(c.user), path: str(c.path, 500),
        reviewId: Number.isInteger(c.pull_request_review_id) ? c.pull_request_review_id : null,
        line: Number.isInteger(c.line) ? c.line : (Number.isInteger(c.original_line) ? c.original_line : null),
        diffHunk: str(c.diff_hunk ?? c.diffHunk, 10000),
        body: str(c.body, 20000), at: str(c.created_at, 40) })) : [],
      inlineMissing: !Array.isArray(inl),
    };
  }

  const labels = (l) => (Array.isArray(l) ? l.slice(0, 12).map((x) => str(x && x.name, 60)).filter(Boolean) : []);

  async function issues(repo, cwd, force) {
    const key = `issues:${repo}`;
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await runner(cwd, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,labels,assignees,updatedAt,url,author,comments']);
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
    const r = await runner(cwd, ['issue', 'view', String(number), '--json', 'number,title,body,labels,url,author,comments,updatedAt']);
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
