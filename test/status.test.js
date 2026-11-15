'use strict';
// Status ud fra det der faktisk står på agentens skærm. Bruger en simuleret agent (test/fixtures/fake-agent.js),
// der tegner som Claude Code og Codex: rammer, spinnere der overskrives, menuer der slettes, baggrundsarbejde.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSessions } = require('../server/sessions');

process.env.SHELL = '/bin/bash';
// Ligger uden for test-mappen, så testkøreren ikke selv prøver at køre den som en test.
const FAKE = path.join(__dirname, '..', 'test-fixtures', 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Proces-opslag slås fra, så testen kun afhænger af skærmen (og ikke af hvad der ellers kører på maskinen).
const ss = createSessions({ idleSeconds: 2, maxSessions: 20 }, { waitChecker: require('../server/wait-check').createWaitChecker({ query: async () => null }) });

function start(flavor = 'claude') {
  const v = ss.create({ repo: 'x', cwd: __dirname, kind: 'agent', agent: { id: flavor, name: flavor, command: `${process.execPath} ${FAKE} ${flavor}` } });
  const link = ss.attach(v.id, { onData() {}, onExit() {} });
  const st = () => ss.list().find((x) => x.id === v.id);
  return { id: v.id, link, st, type: (t) => link.write(t) };
}
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return false;
}
// Følger status i et tidsrum og returnerer alle de forskellige værdier, der blev set.
async function watch(a, ms) {
  const seen = new Set();
  const end = Date.now() + ms;
  while (Date.now() < end) { const x = a.st(); seen.add(`${x.status}${x.needsApproval ? '+godkendelse' : ''}`); await sleep(100); }
  return [...seen];
}
const ready = (a) => until(() => a.st().status === 'venter', 10000);

test.after(() => ss.forceAll());

// Testene kører samtidig – hver har sin egen agent – så hele filen tager under et minut.
test.describe('status ud fra skærmen', { concurrency: true }, () => {
  // Hvert spørgsmål om godkendelse vises, mens baggrundsarbejde skriver videre på fire forskellige måder.
  for (const [scenario, how] of [
    ['apprlines', 'testlinjer der tilføjes under spørgsmålet'],
    ['apprspin', 'en spinner for subagenter der tegnes om under spørgsmålet'],
    ['apprdiff', 'en spinner over spørgsmålet, tegnet om med markørflytning'],
    ['apprsub', 'fremskridt fra en subagent'],
  ]) {
    test(`godkendelse holder, mens ${how} – og turen ender som færdig efter svaret`, async () => {
      const a = start();
      assert.ok(await ready(a));
      a.type(`${scenario}\r`);
      assert.ok(await until(() => a.st().needsApproval, 8000), 'spørgsmålet bliver opdaget');
      const during = await watch(a, 6000);
      assert.deepEqual(during, ['venter+godkendelse'], `status skal blive stående (så: ${during.join(', ')})`);
      a.type('1');
      assert.ok(await until(() => a.st().status === 'faerdig', 20000), `slutter som færdig (er: ${a.st().status})`);
    });
  }

  test('piletaster i menuen lukker ikke spørgsmålet', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('approve\r');
    assert.ok(await until(() => a.st().needsApproval, 10000));
    a.type('\x1b[B');
    await sleep(200);
    a.type('\x1b[A');
    const during = await watch(a, 2500);
    assert.deepEqual(during, ['venter+godkendelse']);
    a.type('1');
    assert.ok(await until(() => a.st().status === 'faerdig', 15000));
  });

  test('en dev-server der kører videre efter turen, giver færdig – ikke afventer', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('devsrv\r');
    assert.ok(await until(() => a.st().status === 'faerdig', 15000), `er: ${a.st().status} ${a.st().waitingFor || ''}`);
    const after = await watch(a, 3000);
    assert.deepEqual(after, ['faerdig']);
  });

  test('en ny opgave under en tidligere færdig tur er ikke færdig: venter på emulatoren, og bliver så færdig', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('question\r');
    assert.ok(await until(() => a.st().status === 'faerdig' || a.st().status === 'venter', 10000));
    a.type('bg\r');
    assert.ok(await until(() => a.st().status === 'afventer', 8000), `er: ${a.st().status}`);
    assert.equal(a.st().waitingFor, 'emulator');
    assert.ok(await until(() => a.st().status === 'faerdig', 20000), `er: ${a.st().status}`);
  });

  test('du sender "approve" som besked – det står i feltet bagefter, men er ikke en godkendelse', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('approve\r');
    const early = await watch(a, 2200);
    assert.ok(!early.includes('venter+godkendelse'), `så: ${early.join(', ')}`);
    assert.ok(await until(() => a.st().needsApproval, 8000), 'agentens rigtige spørgsmål bliver stadig opdaget');
    a.type('1');
    assert.ok(await until(() => a.st().status === 'faerdig', 15000));
  });

  test('"ja" i dit eget felt og agentens ord som "Create new file" eller "rate limit exceeded" er ikke en godkendelse', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('fpdone\r');
    assert.ok(await until(() => a.st().status === 'faerdig', 10000));
    for (const c of 'ja') { a.type(c); await sleep(150); }
    const seen = await watch(a, 3000);
    assert.ok(!seen.some((x) => /godkendelse|kvote/.test(x)), `så: ${seen.join(', ')}`);
  });

  test('kvote holder, selvom du taster, og slipper når agenten går i gang igen', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('quota\r');
    assert.ok(await until(() => a.st().status === 'kvote', 12000));
    for (let i = 0; i < 4; i += 1) { a.type(' '); await sleep(300); }
    const during = await watch(a, 2000);
    assert.deepEqual(during, ['kvote']);
    a.type('\x15go\r');
    assert.ok(await until(() => a.st().status === 'faerdig', 15000));
  });

  test('lige efter Enter står agenten som arbejder – ikke kortvarigt som afventer', async () => {
    const a = start();
    assert.ok(await ready(a));
    a.type('question\r');
    const first = await watch(a, 1200);
    assert.deepEqual(first, ['arbejder']);
  });

  test('en indsat tekst holder agenten på "venter på dig", også når teksten nævner build og tests', async () => {
    const a = start();
    assert.ok(await ready(a));
    assert.equal(ss.paste(a.id, 'Kør ./gradlew build og npm test, og svar: Do you want to proceed?'), 'ok');
    await sleep(2500);
    const seen = await watch(a, 1500);
    assert.deepEqual(seen, ['venter']);
  });

  test('Codex-agtig agent ender som færdig, når en slettet spinner ikke længere står på skærmen', async () => {
    const a = start('codex');
    assert.ok(await until(() => ['venter', 'faerdig'].includes(a.st().status), 10000));
    a.type('hello\r');
    await sleep(500);
    assert.ok(await until(() => a.st().status !== 'arbejder', 10000));
    const seen = await watch(a, 2500);
    assert.ok(!seen.some((x) => x.startsWith('afventer')), `så: ${seen.join(', ')}`);
  });

  test('stoppet af dig selv er markeret, så ingen fane giver besked om "færdig"', async () => {
    const a = start();
    assert.ok(await ready(a));
    assert.equal(a.st().fresh, true, 'ny agent uden input');
    ss.remove(a.id);
    assert.ok(await until(() => a.st() && a.st().status === 'afsluttet', 8000));
    assert.equal(a.st().stopped, true);
  });
});
