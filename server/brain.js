'use strict';
// "Hjernen": markdown-filer i repoets docs-mappe m.m. Vises kun – Control Tower skriver aldrig i dem.
const fs = require('node:fs');
const path = require('node:path');

const EXT = new Set(['.md', '.mdx', '.markdown', '.txt']);
const MAX_FILES = 400;
const MAX_DEPTH = 5;
const MAX_BYTES = 512 * 1024;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build']);

function createBrain(config) {
  function list(repoDir) {
    let realRepo;
    try { realRepo = fs.realpathSync(repoDir); } catch { return []; }
    const found = new Map();

    function inside(real) {
      return real === realRepo || real.startsWith(realRepo + path.sep);
    }
    function addFile(abs) {
      if (found.size >= MAX_FILES || !EXT.has(path.extname(abs).toLowerCase())) return;
      let real, st;
      try { real = fs.realpathSync(abs); st = fs.statSync(real); } catch { return; }
      // Symlinks der peger ud af repoet springes over.
      if (!st.isFile() || !inside(real) || found.has(real)) return;
      found.set(real, { path: path.relative(realRepo, real).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
    }
    function walk(dir, depth) {
      if (depth > MAX_DEPTH || found.size >= MAX_FILES) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'da'));
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, depth + 1); }
        else addFile(abs);
      }
    }

    for (const rel of config.brainPaths) {
      const abs = path.join(realRepo, rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, 0); else addFile(abs);
    }
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path, 'da'));
  }

  // Filen skal stå på listen ovenfor – så kan en sti som ../../hemmelig aldrig læses.
  function read(repoDir, relPath) {
    const entry = list(repoDir).find((f) => f.path === relPath);
    if (!entry) return null;
    const abs = path.join(fs.realpathSync(repoDir), ...entry.path.split('/'));
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(entry.size, MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { path: entry.path, mtime: entry.mtime, size: entry.size, truncated: entry.size > MAX_BYTES, content: buf.toString('utf8').replace(/^\uFEFF/, '') };
    } finally {
      fs.closeSync(fd);
    }
  }

  return { list, read };
}

module.exports = { createBrain };
