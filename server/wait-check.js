'use strict';
// Finder ud af, om en stille agent venter på noget andet end brugeren (fx subagenter, tests, emulator eller build).
// Kombinerer levende underprocesser i styresystemet med de seneste linjer i terminalbufferen.
const { execFile } = require('node:child_process');
const path = require('node:path');

const isWin = process.platform === 'win32';
const CACHE_MS = 2000;
const QUERY_TIMEOUT_MS = 1800;

const SHELLS = new Set([
  'powershell.exe', 'powershell', 'pwsh.exe', 'pwsh',
  'cmd.exe', 'cmd', 'bash.exe', 'bash', 'sh.exe', 'sh', 'zsh', 'fish', 'dash',
]);
const AGENTS = new Set(['claude', 'agy', 'codex', 'gemini', 'opencode', 'aider']);
const IGNORED_HELPERS = new Set([
  'conhost.exe', 'conhost', 'openconsole.exe', 'openconsole',
  'winpty-agent.exe', 'winpty-agent', 'sleep', 'timeout.exe', 'timeout',
]);

const PERSISTENT_CMD_RE = /\b(mcp[-_]?server|@modelcontextprotocol|--mcp\b|tsserver|eslint_d|pyright|rust-analyzer|clangd|language[-_]?server|crashpad)\b/i;
const SHELL_EXEC_RE = /(?:^|\s)(?:-c|-command|-encodedcommand|\/c|\/k)\b/i;
const ACTIVE_SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✶✻✽✢]\s*\S/;
const SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✶✻✽✢●]\s*\S/;
const INTERRUPT_RE = /\b(esc to interrupt|ctrl\+c to interrupt|ctrl\+b to run in background)\b/i;
const CHROME_RE = /^[─━═╭╮╰╯│┃|+`~\-=_.\s]+$/;
const FOOTER_RE = /^(?:\?\s*for shortcuts\b|shift\+tab\b|for shortcuts\b|logout$)/i;
const USER_WAIT_RE = /\b((?:waiting|awaiting)\s+(?:for\s+)?(?:user|you|your|input|reply|response|confirmation|approval|permission|decision)|venter på (?:dig|dit svar|svar fra dig|godkendelse|tilladelse|input))\b/i;
const USER_PROMPT_RE = /(?:^|\b)(?:do you want to|would you like to|should i (?:run|execute|proceed|continue)|run this command|kør denne kommando|allow once|always allow|allow always|allow for this (?:session|conversation|project|workspace)|allow execution|allow this (?:command|action|tool|request|edit|change|operation)|yes,?\s*allow|approve (?:this|command|action|tool|request|execution)|confirm (?:this|command|action|execution)|(?:approval|confirmation|permission) required|press enter|enter to (?:confirm|approve|allow|run|submit|select|continue)|tryk på enter|select an option|choose an option|esc to (?:cancel|reject|deny|decline)|(?:run|execute) command\?|proceed\?|continue\?|apply (?:this )?(?:edit|change|patch)\?)(?!\w)/i;
const YES_NO_RE = /(?:\[(?:y\/n(?:\/[a-z]+)*|yes\/no)\]|\((?:y\/n(?:\/[a-z]+)*|yes\/no)\)|(?:^|\s)y\/n\s*[?:]?\s*$)/i;
const CHOICE_RE = /^(?:(?:[❯>›▸►●•*]\s*)?(?:1[.)]|\[1\])\s*(?:yes|allow|always\s+allow|approve|run|accept|confirm|ja)\b|(?:[❯>›▸►●•*]|\[[x*]\]|\([●*x]\))\s*(?:yes(?:\s*,\s*allow\b.*)?|allow(?:\s+(?:once|always|this(?:\s+\w+)?|for\b.*))?|always\s+allow(?:\b.*)?|approve(?:\s+(?:once|this))?|run(?:\s+(?:once|command|this(?:\s+command)?))?|accept|confirm|ja)\s*(?:\([^)]*\))?\s*$|\[(?:yes|allow(?:\s+once)?|run|approve)\]\s*(?:\||\/|\s)\s*\[(?:no|deny|reject|cancel)\]|(?:[❯>›▸►●•*]\s*)?(?:allow(?:\s+once)?|yes|run)\s*[·|\/]\s*(?:always\s+allow\s*[·|\/]\s*)?(?:deny|reject|cancel|no)\s*$)/i;
const BARE_PROMPT_RE = /^[>❯$#]\s*$/;
const COMPLETION_RE = /(?:\b\d+\s+(?:passed|failed|skipped)\b|\ball tests passed\b|\btest suite (?:passed|failed|finished)\b|\bexited with code\b|\bdone in \d|\bbuild succeeded\b|\bcompiled successfully\b)/i;

// Prioriteret rækkefølge: det mest specifikke vises først.
const PROC_RULES = [
  { waitingFor: 'e2e-tests', re: /\b(playwright|cypress|puppeteer|selenium|chromedriver|geckodriver|webdriver|appium|maestro|detox|patrol|e2e[-_]?tests?|integration_test)\b/i },
  { waitingFor: 'tests', re: /\b(vitest|jest|mocha|ava|pytest|unittest|rspec|phpunit|flutter_tester|flutter\s+test|dart\s+test|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|bun\s+test|cargo\s+test|go\s+test|dotnet\s+test|ctest|mvn\s+test|gradle\s+test|node\s+--test)\b/i },
  { waitingFor: 'emulator', re: /\b(emulator(?:\.exe)?|qemu-system[^\s]*|adb(?:\.exe)?|simctl|scrcpy|genymotion|avdmanager|android-emulator)\b/i },
  { waitingFor: 'CI', re: /\b(gh\s+run\s+watch|gh\s+pr\s+checks)\b/i },
  { waitingFor: 'Docker', re: /\b(docker(?:-compose)?|podman|kubectl)\b/i },
  { waitingFor: 'installation', re: /\b(npm\s+(?:install|ci)|pnpm\s+install|yarn\s+install|pip\s+install|uv\s+(?:pip|sync)|cargo\s+fetch|flutter\s+pub\s+get|pod\s+install|brew\s+install)\b/i },
  { waitingFor: 'build', re: /\b(gradle[w]?|xcodebuild|cargo\s+build|rustc|tsc\b|vite\s+build|webpack|esbuild|rollup|next\s+build|flutter\s+(?:build|run)|mvn\b|msbuild|dotnet\s+build|cmake|ninja)\b/i },
  { waitingFor: 'server', re: /\b(vite\b|next\s+dev|webpack-dev-server|nodemon|uvicorn|gunicorn)\b/i },
  { waitingFor: 'git', re: /\bgit\s+(?:fetch|pull|push|clone|rebase)\b/i },
];

const BUFFER_RULES = [
  { waitingFor: 'subagenter', re: /\b(sub-?agents?|subagenter|background agents?|swarm|teammates?|spawning agent|waiting for \d+ agents?|running \d+ agents?|\d+ agents? running|agent tools? running)\b/i },
  { waitingFor: 'subagenter', re: /\b(?:Task|Agent)\([^)]*\).{0,40}(?:running|waiting|pending|…|\.\.\.)/i },
  { waitingFor: 'e2e-tests', re: /\b(playwright|cypress|puppeteer|selenium|webdriver|appium|maestro|detox|patrol|e2e[- ]tests?|end-to-end)\b/i },
  { waitingFor: 'tests', re: /\b(running tests?|kører tests?|test suite|waiting for tests?|vitest|jest|mocha|pytest|flutter test|dart test|npm test|pnpm test|cargo test|go test|node --test)\b/i },
  { waitingFor: 'emulator', re: /\b(waiting for emulator|starting emulator|booting emulator|android emulator|ios simulator|adb wait-for-device|waiting for (?:android )?device|simctl boot|venter på emulator)\b/i },
  { waitingFor: 'CI', re: /\b(waiting for ci|waiting for checks|gh run watch|github actions)\b/i },
  { waitingFor: 'Docker', re: /\b(docker build|docker compose|docker-compose|waiting for container|starting container)\b/i },
  { waitingFor: 'installation', re: /\b(installing dependencies|npm install|npm ci|pnpm install|yarn install|flutter pub get|pip install|pod install)\b/i },
  { waitingFor: 'build', re: /\b(?:compiling\b|building(?:\s+(?:app|project|bundle|apk|ipa|image|release|debug)\b|\s*(?:…|\.\.\.))|bundling\b|gradle\b|xcodebuild\b|webpack\b|vite build\b|flutter (?:build|run)\b)/i },
  { waitingFor: 'server', re: /\b(waiting for server|starting dev server)\b/i },
];

function normName(name) {
  return path.basename(String(name || '')).toLowerCase();
}

function baseAgentName(name) {
  return normName(name).replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

// Fjerner stier og evt. flag-værdier med tokens/nøgler, så kun et kort kommando-resumé vises i browseren.
function sanitizeDetail(raw) {
  const clean = String(raw || '')
    .replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✶✻✽✢●\s]+/, '')
    .replace(/\b[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASS|PWD|AUTH)[A-Z0-9_]*=\S+/gi, '[skjult]')
    .replace(/(?:--?(?:token|password|secret|api[-_]?key)[=\s]+)\S+/gi, '[skjult]')
    .trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

function formatProcDetail(proc) {
  const exe = normName(proc.name).replace(/\.exe$/i, '');
  const cmd = String(proc.cmd || '').trim();
  if (!cmd) return exe;
  // Forkort evt. fuld sti i starten til filnavnet, så detaljen er let at læse.
  const parts = cmd.split(/\s+/);
  const head = path.basename(parts[0].replace(/^["']|["']$/g, '')).replace(/\.exe$/i, '');
  const rest = parts.slice(1, 5).map((p) => {
    const stripped = p.replace(/^["']|["']$/g, '');
    return /[\\/]/.test(stripped) ? path.basename(stripped) : stripped;
  });
  return sanitizeDetail([head, ...rest].filter(Boolean).join(' '));
}

// Henter alle kørende processer i ét OS-kald, så flere sessioner kan tjekkes uden ekstra overhead.
function queryProcesses() {
  return new Promise((resolve) => {
    if (isWin) {
      const ps = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve(null);
          try {
            const parsed = JSON.parse(stdout.trim());
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            resolve(arr.filter((p) => p && Number.isInteger(p.ProcessId)).map((p) => ({
              pid: p.ProcessId,
              ppid: p.ParentProcessId,
              name: p.Name || '',
              cmd: p.CommandLine || '',
            })));
          } catch { resolve(null); }
        });
      return;
    }
    execFile('ps', ['-eo', 'pid=,ppid=,comm=,args='],
      { timeout: QUERY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const list = [];
        for (const line of stdout.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
          if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] || '' });
        }
        resolve(list);
      });
  });
}

function isAgentProcess(proc) {
  const base = baseAgentName(proc.name);
  if (AGENTS.has(base)) return true;
  if ((base === 'node' || base === 'bun' || base === 'deno') && proc.cmd) {
    return /(?:^|[\\/\s"'])(?:@anthropic-ai[\\/])?(claude(?:-code)?|agy|antigravity|codex|gemini(?:-cli)?|opencode|aider)(?:[\\/\s"'.]|$)/i.test(proc.cmd);
  }
  return false;
}

function collectDescendants(rootPid, processes) {
  if (!rootPid || !Array.isArray(processes)) return [];
  const byParent = new Map();
  for (const p of processes) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [{ pid: rootPid, depth: 0 }];
  while (queue.length) {
    const cur = queue.shift();
    const kids = byParent.get(cur.pid) || [];
    for (const k of kids) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push({ ...k, depth: cur.depth + 1, hasChildren: (byParent.get(k.pid) || []).length > 0 });
      queue.push({ pid: k.pid, depth: cur.depth + 1 });
    }
  }
  return { list: out, byParent };
}

// Finder hvilke pid'er der udgør selve hovedagenten (inkl. evt. .cmd/.sh-wrapper), så kun det den *starter* tæller.
function findPrimaryAgentPids(rootPid, byParent) {
  const chain = new Set([rootPid]);
  let cur = rootPid;
  for (let hop = 0; hop < 4; hop += 1) {
    const kids = (byParent.get(cur) || []).filter((k) => !IGNORED_HELPERS.has(normName(k.name)));
    if (!kids.length) break;
    const agentKid = kids.find(isAgentProcess);
    if (agentKid) { chain.add(agentKid.pid); break; }
    // En enkelt wrapper-skal (fx cmd.exe /c claude.cmd eller sh -c ...) følges ét led ned.
    const shellKids = kids.filter((k) => SHELLS.has(normName(k.name)));
    if (kids.length === 1 && shellKids.length === 1) {
      chain.add(kids[0].pid);
      cur = kids[0].pid;
      continue;
    }
    if (hop === 0 && kids.length === 1) chain.add(kids[0].pid);
    break;
  }
  return chain;
}

function inspectProcessTree(rootPid, processes) {
  if (!rootPid || !Array.isArray(processes)) return null;
  const { list, byParent } = collectDescendants(rootPid, processes);
  if (!list || !list.length) return null;

  const primaryPids = findPrimaryAgentPids(rootPid, byParent);
  const candidates = list.filter((p) => {
    if (primaryPids.has(p.pid)) return false;
    const n = normName(p.name);
    if (IGNORED_HELPERS.has(n)) return false;
    if (p.cmd && PERSISTENT_CMD_RE.test(p.cmd)) return false;
    // En tom, interaktiv skal uden -c/-Command og uden børn venter bare på næste værktøjskald.
    if (SHELLS.has(n) && !SHELL_EXEC_RE.test(p.cmd || '') && !p.hasChildren) return false;
    return true;
  });
  if (!candidates.length) return null;

  // 1) Tjek for subagenter (en ny agent-proces eller eksplicit subagent-worker under hovedagenten).
  const sub = candidates.find((p) => isAgentProcess(p) || /\bsub-?agent\b/i.test(p.cmd || ''));
  if (sub) return { waitingFor: 'subagenter', detail: formatProcDetail(sub), source: 'process' };

  // 2) Tjek mod kendte kategorier i prioriteret rækkefølge.
  for (const rule of PROC_RULES) {
    const match = candidates.find((p) => rule.re.test(`${normName(p.name)} ${p.cmd || ''}`));
    if (match) return { waitingFor: rule.waitingFor, detail: formatProcDetail(match), source: 'process' };
  }

  // 3) En anden ikke-skal-proces (eller skal med eksplicit kommando) under hovedagenten er en aktiv kommando.
  const active = candidates.find((p) => p.depth >= 2 && (!SHELLS.has(normName(p.name)) || SHELL_EXEC_RE.test(p.cmd || '')));
  if (active) return { waitingFor: 'kommando', detail: formatProcDetail(active), source: 'process' };

  return null;
}

function cleanLines(buffer) {
  if (!buffer || typeof buffer !== 'string') return [];
  let tail = buffer.slice(-12000);
  if (buffer.length > 12000) {
    const cut = tail.search(/[\r\n]/);
    if (cut >= 0 && cut < 512) tail = tail.slice(cut);
  }
  const text = tail
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[mhl]/g, '')
    .replace(/\x1b\[[0-9]*C/g, ' ')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  return text
    .split(/[\r\n]+/)
    .map((l) => l.replace(/^[│┃]+\s*|\s*[│┃]+$/g, '').trim())
    .filter((l) => l && !CHROME_RE.test(l) && !FOOTER_RE.test(l));
}

function isUserWaitLine(line) {
  return USER_PROMPT_RE.test(line) || YES_NO_RE.test(line) || CHOICE_RE.test(line) || USER_WAIT_RE.test(line);
}

function inspectBuffer(buffer) {
  const lines = cleanLines(buffer).slice(-14);
  if (!lines.length) return null;

  const recentBottom = lines.slice(-6);
  const hasInterrupt = lines.slice(-10).some((l) => INTERRUPT_RE.test(l));
  const hasSpinner = recentBottom.some((l) => SPINNER_RE.test(l));

  // Eksplicitte godkendelses-/bruger-prompts i bunden vinder altid.
  if (recentBottom.some(isUserWaitLine)) {
    return null;
  }

  // Uden aktiv spinner eller interrupt-linje betyder en tom prompt eller et spørgsmål nederst, at agenten venter på dig.
  if (!hasInterrupt && !hasSpinner) {
    const lastTwo = lines.slice(-2);
    const looksLikeQuestion = (l) => /\?\s*$/.test(l) && !/https?:\/\/\S*\?/.test(l);
    if (lastTwo.some((l) => BARE_PROMPT_RE.test(l) || looksLikeQuestion(l))) return null;
  }

  // Læs nedefra og op; stop hvis vi rammer en afslutningslinje (så gamle testkørsler højere oppe ikke tæller).
  const activeTail = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (COMPLETION_RE.test(l)) break;
    activeTail.push(l);
  }
  if (!activeTail.length) return null;

  // Flerlinje-kommandoer kan skubbe godkendelsesspørgsmålet længere op end de sidste 6 linjer.
  const promptIdx = activeTail.findIndex(isUserWaitLine);
  if (promptIdx >= 0 && !activeTail.slice(0, promptIdx).some((l) => ACTIVE_SPINNER_RE.test(l))) {
    return null;
  }

  for (const rule of BUFFER_RULES) {
    const match = activeTail.find((l) => rule.re.test(l));
    if (match) return { waitingFor: rule.waitingFor, detail: sanitizeDetail(match), source: 'buffer' };
  }

  // Eksplicit "Waiting for X" / "Venter på X" i bunden af terminalen.
  for (const l of activeTail.slice(0, 5)) {
    const m = l.match(/\b(?:waiting for|venter på)\s+([a-z0-9æøå][a-z0-9æøå _-]{1,28})/i);
    if (m && !USER_WAIT_RE.test(l)) {
      return { waitingFor: m[1].trim().replace(/[.…]+$/, ''), detail: sanitizeDetail(l), source: 'buffer' };
    }
  }

  if (hasInterrupt || hasSpinner) {
    const line = activeTail.find((l) => SPINNER_RE.test(l)) || activeTail.find((l) => !BARE_PROMPT_RE.test(l) && !INTERRUPT_RE.test(l)) || '';
    return { waitingFor: 'baggrundsopgave', detail: sanitizeDetail(line), source: 'buffer' };
  }

  return null;
}

function createWaitChecker({ query = queryProcesses } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function snapshot() {
    const now = Date.now();
    if (cachedAt > 0 && now - cachedAt < CACHE_MS) return cached;
    if (!inflight) {
      inflight = Promise.resolve(query())
        .catch(() => null)
        .then((res) => {
          cached = res;
          cachedAt = Date.now();
          inflight = null;
          return res;
        });
    }
    return inflight;
  }

  async function checkAll(idleSessions) {
    if (!idleSessions.length) return;
    const procs = await snapshot();
    for (const s of idleSessions) {
      const pid = s.proc && s.proc.pid;
      const fromProc = procs && pid ? inspectProcessTree(pid, procs) : null;
      s.waitState = fromProc || inspectBuffer(s.buffer);
    }
  }

  function checkSync(s) {
    return s.waitState || inspectBuffer(s.buffer);
  }

  return { checkAll, checkSync };
}

module.exports = {
  createWaitChecker,
  inspectProcessTree,
  inspectBuffer,
  sanitizeDetail,
};
