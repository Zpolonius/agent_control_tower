'use strict';
// Roller: indbyggede roller, tillæg pr. repo, teknologi-gæt, rapporter og sikkerhed omkring filerne.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoles, parseFindings, detectStacks } = require('../server/roles');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-roles-'));
const mk = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const builtin = path.join(tmp, 'roles');
mk(path.join(builtin, 'fejlfinder.md'), '---\nname: Fejlfinder\nicon: lup\nmode: report\ndescription: Finder fejl\n---\n# Opgave i {{repo}} ({{date}})\nTeknologi: {{stacks}}\nFokus: {{input}}\nSkriv til {{reportPath}}\n\n## Om teknologien\n{{stackNotes}}\n\n## Særligt for dette repo\n{{repoNotes}}\n\nSlut {{ukendt}}');
mk(path.join(builtin, 'udvikler.md'), '---\nname: Udvikler\nicon: skruenoegle\nmode: develop\ndescription: Retter\n---\nRet: {{input}}');
mk(path.join(builtin, 'Ugyldigt Navn.md'), '---\nname: x\n---\nx');
mk(path.join(builtin, 'stacks', 'flutter.md'), 'Kør flutter analyze.');
mk(path.join(builtin, 'stacks', 'kotlin.md'), 'Kør ./gradlew test.');
const roles = createRoles({ builtinDir: builtin });

function repo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('finder teknologier i roden og ét niveau ned', () => {
  const r = repo('stack');
  mk(path.join(r, 'pubspec.yaml'), 'name: x');
  mk(path.join(r, 'android', 'build.gradle.kts'), '');
  mk(path.join(r, 'web', 'package.json'), '{}');
  mk(path.join(r, 'node_modules', 'x', 'pubspec.yaml'), '');
  assert.deepEqual(detectStacks(r), ['flutter', 'kotlin', 'typescript']);
  assert.deepEqual(detectStacks(repo('tom')), []);
  assert.deepEqual(detectStacks(path.join(tmp, 'findes-ikke')), []);
});

test('lister indbyggede roller og springer ugyldige filnavne over', () => {
  const list = roles.list(repo('ren'));
  assert.deepEqual(list.map((r) => [r.id, r.name, r.icon, r.mode, r.hasRepoNotes, r.source]),
    [['fejlfinder', 'Fejlfinder', 'lup', 'report', false, 'builtin'], ['udvikler', 'Udvikler', 'skruenoegle', 'develop', false, 'builtin']]);
  const r = repo('orden');
  mk(path.join(r, '.control-tower', 'roles', 'aaa.md'), '---\nname: Egen\n---\nx');
  assert.deepEqual(roles.list(r).map((x) => x.id), ['fejlfinder', 'udvikler', 'aaa'], 'faste roller i fast rækkefølge, repoets egne til sidst');
});

test('bygger rollens tekst: pladsholdere udfyldes, og tomme afsnit forsvinder', () => {
  const r = repo('byg');
  const b = roles.build(r, 'byg', 'fejlfinder', '', new Date('2026-11-15T10:00:00Z'));
  assert.match(b.text, /^# Opgave i byg \(2026-11-15\)/);
  assert.match(b.text, /Teknologi: ukendt/);
  assert.match(b.text, /Skriv til docs\/reports\/2026-11-15-fejlfinder\.md/);
  assert.doesNotMatch(b.text, /Om teknologien|Særligt for dette repo/, 'tomme afsnit fjernes');
  assert.match(b.text, /Slut \{\{ukendt\}\}/, 'ukendte pladsholdere røres ikke');
  assert.deepEqual(b.role, { id: 'fejlfinder', name: 'Fejlfinder', icon: 'lup', mode: 'report' });
  assert.equal(roles.build(r, 'byg', 'findes-ikke', ''), null);
  assert.equal(roles.build(r, 'byg', '../../etc/passwd', ''), null);
});

test('teknologi-noter og repoets tillæg kommer med, og repoet kan lave sin egen rolle', () => {
  const r = repo('tillaeg');
  mk(path.join(r, 'pubspec.yaml'), '');
  mk(path.join(r, '.control-tower', 'roles', 'fejlfinder.md'), 'Kig især på betalingsflowet.');
  mk(path.join(r, '.control-tower', 'roles', 'tekst.md'), '---\nname: Korrekturlæser\nicon: pensel\ndescription: Læser tekster\n---\nLæs alle tekster i {{repo}}.');
  mk(path.join(r, '.control-tower', 'roles', 'tom.md'), '---\nname: Tom\n---\n');
  const b = roles.build(r, 'tillaeg', 'fejlfinder', 'login');
  assert.match(b.text, /Teknologi: Flutter\/Dart/);
  assert.match(b.text, /## Om teknologien\n\n### Flutter\/Dart\nKør flutter analyze\./);
  assert.match(b.text, /## Særligt for dette repo\n\nKig især på betalingsflowet\./);
  assert.match(b.text, /Fokus: login/);
  const list = roles.list(r);
  assert.equal(list.find((x) => x.id === 'fejlfinder').hasRepoNotes, true);
  assert.deepEqual(list.find((x) => x.id === 'tekst'), { id: 'tekst', name: 'Korrekturlæser', icon: 'pensel', mode: 'report', description: 'Læser tekster', source: 'repo', hasRepoNotes: false });
  assert.ok(!list.some((x) => x.id === 'tom'), 'en tom rolle vises ikke');
  assert.equal(roles.build(r, 'tillaeg', 'tekst', '').text, 'Læs alle tekster i tillaeg.');
  assert.equal(roles.list(repo('andet')).some((x) => x.id === 'tekst'), false, 'repoets rolle gælder kun det repo');
});

test('repoets rollefiler kan ikke pege ud af repoet', () => {
  const r = repo('symlink');
  mk(path.join(tmp, 'hemmelig.md'), '---\nname: Hemmelig\n---\nHEMMELIGT');
  fs.mkdirSync(path.join(r, '.control-tower', 'roles'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'hemmelig.md'), path.join(r, '.control-tower', 'roles', 'snyd.md'));
  const r2 = repo('symlink-mappe');
  fs.mkdirSync(path.join(r2, '.control-tower'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'roles'), path.join(r2, '.control-tower', 'roles'));
  assert.ok(!roles.list(r).some((x) => x.id === 'snyd'));
  assert.equal(roles.build(r, 'symlink', 'snyd', ''), null);
  assert.ok(!roles.list(r2).some((x) => x.source === 'repo'), 'en mappe der peger ud, bruges ikke');
});

test('input til rollen begrænses i længde', () => {
  const b = roles.build(repo('lang'), 'lang', 'udvikler', 'x'.repeat(50000));
  assert.equal(b.text.length, 'Ret: '.length + 20000);
});

test('rapporter: kun .md direkte i docs/reports, nyeste først, og fund deles op', () => {
  const r = repo('rapport');
  const dir = path.join(r, 'docs', 'reports');
  mk(path.join(dir, '2026-11-14-security.md'), '# Security\n\nResumé.\n\n## F1 · høj · Nøgle i koden\n**Hvor:** a.ts:3\n**Bevis:** x\n\n## F2 · lav · Mindre ting\nTekst\n\n# Bilag\nikke et fund');
  mk(path.join(dir, 'noter.txt'), 'x');
  mk(path.join(dir, 'under', '2026-11-15-x.md'), 'x');
  mk(path.join(tmp, 'udenfor.md'), 'HEMMELIGT');
  fs.symlinkSync(path.join(tmp, 'udenfor.md'), path.join(dir, 'snyd.md'));
  mk(path.join(dir, 'fri tekst.md'), 'Ingen fund her.');
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(dir, '2026-11-14-security.md'), t, t);
  fs.utimesSync(path.join(dir, 'fri tekst.md'), t - 100, t - 100);
  const list = roles.reports(r);
  assert.deepEqual(list.map((x) => [x.name, x.roleId, x.date]), [['2026-11-14-security.md', 'security', '2026-11-14'], ['fri tekst.md', null, null]]);
  const rep = roles.readReport(r, '2026-11-14-security.md');
  assert.deepEqual(rep.findings.map((f) => [f.id, f.severity, f.title]), [['F1', 'høj', 'Nøgle i koden'], ['F2', 'lav', 'Mindre ting']]);
  assert.match(rep.findings[0].body, /^\*\*Hvor:\*\* a\.ts:3/);
  assert.doesNotMatch(rep.findings[1].body, /Bilag/, 'et fund stopper ved næste hovedafsnit');
  for (const bad of ['snyd.md', '../../udenfor.md', 'noter.txt', 'under/2026-11-15-x.md', '', null]) assert.equal(roles.readReport(r, bad), null, String(bad));
  assert.deepEqual(roles.reports(repo('ingen-rapporter')), []);
});

test('fund-overskrifter i forskellige skrivemåder genkendes', () => {
  const f = parseFindings('## F1 - kritisk - A\nx\n## F12 · B uden alvor\ny\n## Ikke et fund\nz\n### F3 · lav · for dyb\n');
  assert.deepEqual(f.map((x) => [x.id, x.severity, x.title]), [['F1', 'kritisk', 'A'], ['F12', null, 'B uden alvor']]);
  assert.equal(f[1].body, 'y');
});
