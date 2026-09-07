import { CONFIG } from '../config.js';

/**
 * Renders the two files written by scripts/sync.mjs:
 *
 *   src/data/repos.json    every public repo
 *   src/data/updates.json  a short activity feed
 *
 * Both are committed to the repository, so the page still works with no
 * network beyond the page load itself, and search engines see real content.
 * If either file is missing the static markup already in index.html stays
 * exactly as it is — this only ever replaces content it successfully loaded.
 */

/** Shown in full detail higher up the page, so skipped in the grouped list. */
const FEATURED = new Set([
  'OpenRover',
  'RustDB',
  'Traffic-Sign-Detection',
  'SmolGPT',
  'AI-Powered-GitOps-Deployment-Platform',
]);

/**
 * Everything else, grouped by what it actually is.
 *
 * A flat list of 19 repositories tells a visitor nothing. Grouped, the shape
 * of the work is obvious at a glance — and the quantitative finance cluster in
 * particular was invisible on the old site despite being a third of the output.
 *
 * Repos are matched by exact name. Anything unmatched falls into "Other", so
 * new repositories still appear without touching this file.
 */
const GROUPS = [
  {
    title: 'Quantitative finance',
    blurb: 'Pricing, risk and signal research.',
    repos: [
      'monte-carlo-engine',
      'Algorithmic-Options-Hedging-Model',
      'DL-SP500',
      'alpha-decay-detection-system',
      'Temporal-Graph-Neural-Network-TGNN-for-Causal-Asset-Relationships',
      'MnA-Jet-Signal',
      'pitwall',
    ],
  },
  {
    title: 'Systems and simulation',
    blurb: 'Lower-level work in C++ and Rust.',
    repos: ['cppnum', 'Blackhole-Simulator', 'BlackHole-Simulation', 'rps-bot'],
  },
  {
    title: 'Applications and coursework',
    blurb: 'Built for a client, a class or a hackathon.',
    repos: [
      'GASX',
      'GreenNova',
      'klinik',
      'taigu-battery-logging',
      'UCCD2303-Database-Technology-Assignment',
      'UCCC2513-Mini-Project',
    ],
  },
  {
    title: 'Practice',
    blurb: '',
    repos: ['LeetCode-Solutions', 'my-portfolio'],
  },
];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadJSON(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch (err) {
    console.warn(`[live] could not load ${path}:`, err.message);
    return null;
  }
}

function relativeDate(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? 's' : ''} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years > 1 ? 's' : ''} ago`;
}

function repoRow(r) {
  // Rendered inside a group, so this is deliberately compact.
  const tags = [];
  if (r.language) tags.push(`<p class="tag">${esc(r.language)}</p>`);
  if (r.stars > 0) tags.push(`<p class="tag">${r.stars} ★</p>`);
  if (r.archived) tags.push(`<p class="tag">Archived</p>`);
  else tags.push(`<p class="tag active">${esc(relativeDate(r.pushedAt))}</p>`);

  const desc = r.summary || r.description;

  return `
	<li>
		<p class="pr-title"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a></p>
		${desc ? `<p class="pr-desc">${esc(desc)}</p>` : ''}
		<div class="tag-list">${tags.join('')}</div>
	</li>`;
}

function groupBlock(title, blurb, repos) {
  return (
    `<li class="repo-group">` +
    `<p class="pr-title">${esc(title)}</p>` +
    (blurb ? `<p class="pr-desc">${esc(blurb)}</p>` : '') +
    `<ul class="repo-sublist">${repos.map(repoRow).join('')}</ul>` +
    `</li>`
  );
}

async function renderRepos() {
  const list = document.getElementById('repo-list');
  const meta = document.getElementById('repo-meta');
  if (!list) return;

  const data = await loadJSON('src/data/repos.json');
  if (!data?.repos?.length) {
    list.innerHTML = '<li><p class="pr-desc">Repository list unavailable. See github.com/zishaan1911.</p></li>';
    return;
  }

  const rest = data.repos.filter((r) => !FEATURED.has(r.name));
  const byName = new Map(rest.map((r) => [r.name, r]));

  if (meta) {
    meta.textContent =
      `${data.count} public repositories · ${data.totalStars} stars · ` +
      `synced ${relativeDate(data.generatedAt)}`;
  }

  const placed = new Set();
  let html = '';

  for (const group of GROUPS) {
    const members = group.repos.map((n) => byName.get(n)).filter(Boolean);
    if (!members.length) continue;
    members.forEach((r) => placed.add(r.name));
    html += groupBlock(group.title, group.blurb, members);
  }

  // Anything new on GitHub shows up here without this file needing an edit.
  const leftovers = rest.filter((r) => !placed.has(r.name));
  if (leftovers.length) html += groupBlock('Other', '', leftovers);

  list.innerHTML = html;
}

async function renderUpdates() {
  const list = document.getElementById('update-list');
  if (!list) return;

  const data = await loadJSON('src/data/updates.json');
  if (!data?.updates?.length) return; // keep the static fallback already in the HTML

  list.innerHTML = data.updates
    .map((u) => {
      const when = u.date
        ? new Date(u.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()
        : '';
      const repo = u.repo ? ` <span class="tag">${esc(u.repo)}</span>` : '';
      return `<p><em>★ ${esc(when)}:</em> ${esc(u.text)}${repo}</p>`;
    })
    .join('');
}

export function initLiveData() {
  if (CONFIG.liveData === false) return;
  renderRepos();
  renderUpdates();
}
