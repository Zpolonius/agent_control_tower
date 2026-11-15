'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encodeIco, writeIco, writeIconset } = require('../scripts/make-icons');

test('make-icons: genererer gyldig .ico og .iconset PNG-filer', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-icons-'));
  try {
    const icoBuf = encodeIco();
    assert.equal(icoBuf.readUInt16LE(0), 0);
    assert.equal(icoBuf.readUInt16LE(2), 1);
    assert.equal(icoBuf.readUInt16LE(4), 4);

    const icoPath = path.join(tmp, 'control-tower.ico');
    writeIco(icoPath);
    assert.equal(fs.readFileSync(icoPath).length, icoBuf.length);

    const iconsetDir = path.join(tmp, 'ControlTower.iconset');
    writeIconset(iconsetDir);
    const files = fs.readdirSync(iconsetDir);
    assert.equal(files.length, 10);
    for (const f of files) {
      const data = fs.readFileSync(path.join(iconsetDir, f));
      assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${f} skal være gyldig PNG`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function spawnTrayServer(confPath) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), '--tray', '--no-open'], {
    env: { ...process.env, CONTROL_TOWER_CONFIG: confPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForUrl(proc) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Timeout før URL kom:\n${out}`)), 6000);
    const onData = (chunk) => {
      out += chunk.toString('utf8');
      const m = out.match(/Åbn:\s*(http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Afsluttede uventet (${code}):\n${out}`));
    });
  });
}

function waitExit(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Serveren lukkede ikke inden for fristen'));
    }, 5000);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('server --tray: udskriver link og lukker pænt ved STOP eller lukket stdin', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tray-'));
  try {
    const root = path.join(tmp, 'repos');
    fs.mkdirSync(root, { recursive: true });
    const confPath = path.join(tmp, 'config.json');
    fs.writeFileSync(confPath, JSON.stringify({
      root,
      port: 14319,
      tokensFile: false,
      claudeProjectsDir: false,
      agyBrainDir: false,
    }));

    const p1 = spawnTrayServer(confPath);
    const url1 = await waitForUrl(p1);
    assert.match(url1, /^http:\/\/127\.0\.0\.1:14319\/#token=[a-f0-9]{64}$/);
    p1.stdin.write('STOP\n');
    assert.equal(await waitExit(p1), 0);

    const p2 = spawnTrayServer(confPath);
    const url2 = await waitForUrl(p2);
    assert.match(url2, /^http:\/\/127\.0\.0\.1:14319\/#token=[a-f0-9]{64}$/);
    p2.stdin.end();
    assert.equal(await waitExit(p2), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
