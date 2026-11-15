'use strict';
// Lille markdown-viser. Den bygger sidens elementer ét for ét og indsætter aldrig rå HTML,
// så tekst i en fil (eller et review) kan ikke køre kode i browseren.
(function () {
  function el(tag, text) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    return n;
  }

  function inline(parent, text) {
    // Kursiv kræver tekst lige inden for stjernerne og ikke et bogstav lige uden for, så "src/*.js" og "2 * 3" forbliver almindelig tekst.
    const re = /(`[^`\n]+`)|(\*\*(?=\S)[^*\n]*\S\*\*)|((?<=^|[\s(\["'])\*(?=[^\s*])[^*\n]*[^\s*]\*(?=$|[\s.,;:!?)\]"']))|(\[[^\]\n]+\]\([^)\s]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const t = m[0];
      if (m[1]) parent.append(el('code', t.slice(1, -1)));
      else if (m[2]) parent.append(el('strong', t.slice(2, -2)));
      else if (m[3]) parent.append(el('em', t.slice(1, -1)));
      else {
        const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        // Kun almindelige weblinks bliver klikbare. Alt andet (fx javascript:) vises som ren tekst.
        if (/^https?:\/\//i.test(mm[2])) {
          const a = el('a', mm[1]);
          a.href = mm[2]; a.target = '_blank'; a.rel = 'noopener noreferrer';
          parent.append(a);
        } else parent.append(mm[1]);
      }
      last = m.index + t.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(src) {
    const root = el('div');
    root.className = 'md';
    const lines = String(src).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) { const p = el('p'); inline(p, para.join(' ')); root.append(p); para = []; }
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```|~~~)/);
      if (fence) {
        flush();
        const buf = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { buf.push(lines[i]); i += 1; }
        i += 1;
        const pre = el('pre'); pre.tabIndex = 0; pre.append(el('code', buf.join('\n')));
        root.append(pre);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); const n = el('h' + Math.min(h[1].length + 1, 6)); inline(n, h[2].replace(/\s+#+\s*$/, '')); root.append(n); i += 1; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(el('hr')); i += 1; continue; }
      if (/^\s*>/.test(line)) {
        flush();
        const q = el('blockquote');
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        const p = el('p'); inline(p, buf.join(' ')); q.append(p); root.append(q);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flush();
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const wrap = el('div'); wrap.className = 'tablewrap'; wrap.tabIndex = 0;
        const table = el('table');
        const head = el('tr');
        for (const c of cells(line)) { const th = el('th'); inline(th, c); head.append(th); }
        const thead = el('thead'); thead.append(head); table.append(thead);
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const tr = el('tr');
          for (const c of cells(lines[i])) { const td = el('td'); inline(td, c); tr.append(td); }
          tbody.append(tr); i += 1;
        }
        table.append(tbody); wrap.append(table); root.append(wrap);
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        const list = el(ordered ? 'ol' : 'ul');
        // En nummereret liste fortsætter fra det tal den starter med (fx efter en kodeblok mellem trin 1 og 2).
        if (ordered && parseInt(li[2], 10) !== 1) list.start = parseInt(li[2], 10);
        const sameKind = (l) => { const x = l.match(/^(\s*)([-*+]|\d+[.)])\s+/); return !!x && /\d/.test(x[2]) === ordered; };
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          // Tomme linjer mellem punkter afbryder ikke listen, hvis næste linje er et punkt af samme slags.
          if (!m && !lines[i].trim()) {
            let j = i;
            while (j < lines.length && !lines[j].trim()) j += 1;
            if (j < lines.length && sameKind(lines[j])) { i = j; continue; }
            break;
          }
          if (m && /\d/.test(m[2]) !== ordered && m[1].length < 2) break;
          if (!m) {
            if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) { list.lastChild.append(' '); inline(list.lastChild, lines[i].trim()); i += 1; continue; }
            break;
          }
          const item = el('li');
          if (m[1].length >= 2) item.className = 'nested';
          const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            item.className += ' task';
            const box = el('span', task[1] === ' ' ? '☐' : '☑');
            box.className = 'box'; box.setAttribute('aria-label', task[1] === ' ' ? 'Ikke færdig' : 'Færdig');
            item.append(box, ' ');
            inline(item, task[2]);
          } else inline(item, m[3]);
          list.append(item); i += 1;
        }
        root.append(list);
        continue;
      }
      if (!line.trim()) { flush(); i += 1; continue; }
      para.push(line.trim());
      i += 1;
    }
    flush();
    return root;
  }

  window.renderMarkdown = render;
})();
