/* zishaan1911.github.io
   Progressive enhancement only: every word on the page is in the HTML, so
   search engines and no-JS visitors get the full site. This file adds the
   theme switcher, the section nav, the typing effect and the tiny shell. */

(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const THEMES = ['phosphor', 'amber', 'ice', 'paper'];

  /* ─── theme ─────────────────────────────────────────────────────── */

  function setTheme(name, persist = true) {
    if (!THEMES.includes(name)) return false;
    root.dataset.theme = name;
    document.querySelectorAll('[data-set-theme]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.setTheme === name)));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (persist) {
      try { localStorage.setItem('theme', name); } catch { /* private mode */ }
    }
    return true;
  }

  setTheme(root.dataset.theme || 'phosphor', false);
  document.querySelectorAll('[data-set-theme]').forEach((b) =>
    b.addEventListener('click', () => setTheme(b.dataset.setTheme)));

  /* ─── nav: highlight the section in view, digits jump ───────────── */

  const navLinks = [...document.querySelectorAll('.tabs a')];
  const sections = navLinks
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);

  if ('IntersectionObserver' in window) {
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => visible.set(e.target.id, e.intersectionRatio));
      let best = null;
      for (const s of sections) {
        if ((visible.get(s.id) || 0) > 0 && best === null) best = s.id;
      }
      navLinks.forEach((a) =>
        a.setAttribute('aria-current', String(a.getAttribute('href') === `#${best}`)));
    }, { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.01] });
    sections.forEach((s) => io.observe(s));
  }

  function goTo(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    history.replaceState(null, '', `#${id}`);
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
    const i = Number(e.key);
    if (Number.isInteger(i) && navLinks[i]) {
      e.preventDefault();
      goTo(navLinks[i].getAttribute('href').slice(1));
    } else if (e.key === '/') {
      e.preventDefault();
      input?.focus();
    }
  });

  /* ─── typing effect on the tagline ─────────────────────────────── */

  const typed = document.querySelector('[data-type]');
  if (typed && !reduceMotion) {
    const full = typed.textContent;
    typed.textContent = '';
    let n = 0;
    const tick = () => {
      n += 1 + (Math.random() < 0.3 ? 1 : 0);
      typed.textContent = full.slice(0, n);
      if (n < full.length) setTimeout(tick, 16 + Math.random() * 28);
    };
    setTimeout(tick, 350);
  }

  /* ─── the heatmap is wider than a phone: start at the recent end ── */

  document.querySelectorAll('.heatmap').forEach((el) => { el.scrollLeft = el.scrollWidth; });

  /* ─── "synced 3 hours ago" from the bot's timestamp ────────────── */

  document.querySelectorAll('.foot time[datetime]').forEach((el) => {
    const then = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(+then)) return;
    const days = Math.floor((Date.now() - then) / 86400000);
    el.title = then.toUTCString();
    el.textContent = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  });

  /* ─── the shell ─────────────────────────────────────────────────── */

  const form = document.getElementById('shell-form');
  const input = document.getElementById('shell-in');
  const out = document.getElementById('shell-out');
  if (!form || !input || !out) return;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = (href, text) => `<a href="${esc(href)}">${esc(text || href)}</a>`;

  function print(html, cls) {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    p.innerHTML = html;
    out.append(p);
    out.scrollTop = out.scrollHeight;
  }

  // Read projects from the page itself, so the shell can never disagree with it.
  const projects = [...document.querySelectorAll('.card[data-project]')].map((el) => ({
    key: el.dataset.project,
    id: el.id,
    name: el.querySelector('h3')?.textContent.trim() || el.dataset.project,
    url: el.dataset.url || el.querySelector('.links a')?.href,
    lede: el.querySelector('.card-lede')?.textContent.trim() || '',
  }));
  const text = (sel) => document.querySelector(sel)?.textContent.trim() || '';

  const SECTIONS = {
    home: 'home', work: 'work', research: 'research', experience: 'experience',
    activity: 'log', log: 'log', repos: 'repos', contact: 'contact', about: 'contact',
    stack: 'stack', certs: 'certs',
  };

  const COMMANDS = {
    help: {
      desc: 'list commands',
      run() {
        const rows = Object.entries(COMMANDS)
          .filter(([, c]) => c.desc)
          .map(([k, c]) => `  ${k.padEnd(10)} ${c.desc}`);
        print(esc(rows.join('\n')));
      },
    },
    whoami: {
      desc: 'who is this',
      run() {
        print(esc('Zishaan Ahmed. Software & systems engineer, CS undergrad at UTAR, Malaysia.\n' +
          'Builds simulators, deployment systems, ML pipelines, and writes the odd paper.'));
      },
    },
    ls: {
      desc: 'list sections',
      run() {
        print(Object.keys(SECTIONS)
          .filter((k, i, a) => a.indexOf(k) === i && !['log', 'about'].includes(k))
          .map((k) => `<a href="#${SECTIONS[k]}" data-cd>${k}/</a>`).join('  '));
      },
    },
    cd: {
      desc: 'cd <section>: jump there',
      run([where = 'home']) {
        const id = SECTIONS[where.replace(/[/~.]/g, '') || 'home'];
        if (!id) return print(esc(`cd: no such directory: ${where}`), 'err');
        goTo(id);
      },
    },
    projects: {
      desc: 'selected work',
      run() {
        projects.filter((p) => !['paper', 'sat'].includes(p.key)).forEach((p) =>
          print(`<a href="#${esc(p.id)}" data-cd>${esc(p.name.padEnd(10))}</a> ${esc(p.lede.split('. ')[0].replace(/\.$/, ''))}.`));
        print(esc('open <name> to view the source'), 'echo');
      },
    },
    open: {
      desc: 'open <project>: view the source',
      run([name]) {
        const p = projects.find((x) => x.key === (name || '').toLowerCase() ||
          x.name.toLowerCase() === (name || '').toLowerCase());
        if (!p) return print(esc(`open: ${name || '(nothing)'}: try one of ${projects.map((x) => x.key).join(', ')}`), 'err');
        print(`opening ${link(p.url)}`);
        window.open(p.url, '_blank', 'noopener');
      },
    },
    research: {
      desc: 'papers',
      run() {
        print(`${esc('How Long is the Graph of xⁿ?')} ${link('https://doi.org/10.5281/zenodo.22970394', 'doi')}`);
        print(`${esc('A Hybrid Learning Framework for Automated SAT Solver Selection')} ${link('https://doi.org/10.5281/zenodo.22763759', 'doi')}`);
      },
    },
    stats: {
      desc: 'live numbers',
      run() {
        const tiles = [...document.querySelectorAll('.tile')].map((t) =>
          `${t.querySelector('.tile-num')?.textContent.trim().padEnd(9)} ${t.querySelector('.tile-label')?.textContent.trim()}`);
        print(esc(tiles.join('\n')));
      },
    },
    contact: {
      desc: 'how to reach me',
      run() {
        print(`email    ${link('mailto:iamzishaan@gmail.com', 'iamzishaan@gmail.com')}`);
        print(`linkedin ${link('https://www.linkedin.com/in/zishaan-ahmed', 'in/zishaan-ahmed')}`);
        print(`github   ${link('https://github.com/zishaan1911', 'zishaan1911')}`);
      },
    },
    email: { run() { COMMANDS.contact.run(); } },
    github: { run() { window.open('https://github.com/zishaan1911', '_blank', 'noopener'); print('opening github…'); } },
    linkedin: { run() { window.open('https://www.linkedin.com/in/zishaan-ahmed', '_blank', 'noopener'); print('opening linkedin…'); } },
    theme: {
      desc: 'theme <phosphor|amber|ice|paper>',
      run([name]) {
        if (!name) return print(esc(`current: ${root.dataset.theme}. available: ${THEMES.join(', ')}`));
        if (!setTheme(name)) print(esc(`theme: unknown theme "${name}"`), 'err');
      },
    },
    date: { desc: 'what time is it', run() { print(esc(new Date().toString())); } },
    echo: { run(args) { print(esc(args.join(' '))); } },
    history: { desc: 'what you typed', run() { print(esc(hist.map((h, i) => `${String(i + 1).padStart(3)}  ${h}`).join('\n'))); } },
    clear: { desc: 'clear the screen', run() { out.innerHTML = ''; } },
    sudo: { run() { print(esc('visitor is not in the sudoers file. This incident will be reported.'), 'err'); } },
    rm: { run() { print(esc('rm: nice try.'), 'err'); } },
    exit: { run() { print(esc("there's no exit. try `contact` instead.")); } },
    vim: { run() { print(esc('you are now trapped in vim. (just kidding. try `help`.)')); } },
    neofetch: { run() { goTo('home'); print(esc(text('.fetch dl').replace(/\s+\n/g, '\n'))); } },
  };

  const hist = [];
  let cursor = 0;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const line = input.value.trim();
    input.value = '';
    if (!line) return;
    hist.push(line);
    cursor = hist.length;
    print(`${esc('$ ')}${esc(line)}`, 'echo');
    const [cmd, ...args] = line.split(/\s+/);
    const c = COMMANDS[cmd.toLowerCase()];
    if (c) c.run(args);
    else print(esc(`${cmd}: command not found. try 'help'`), 'err');
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && hist.length) {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
      input.value = hist[cursor];
    } else if (e.key === 'ArrowDown' && hist.length) {
      e.preventDefault();
      cursor = Math.min(hist.length, cursor + 1);
      input.value = hist[cursor] || '';
    } else if (e.key === 'Tab') {
      const v = input.value.trim().toLowerCase();
      if (!v || v.includes(' ')) return;
      const match = Object.keys(COMMANDS).filter((k) => k.startsWith(v));
      if (match.length) {
        e.preventDefault();
        if (match.length === 1) input.value = `${match[0]} `;
        else print(esc(match.join('  ')), 'echo');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      out.innerHTML = '';
    }
  });

  out.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-cd]');
    if (!a) return;
    e.preventDefault();
    goTo(a.getAttribute('href').slice(1));
  });
})();
