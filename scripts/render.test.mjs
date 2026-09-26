#!/usr/bin/env node
/**
 * Tests for scripts/render.mjs, and a check that index.html still carries
 * every marker the bot writes into. Deleting one by accident while editing
 * the page would otherwise only show up as a failed sync in production.
 *
 * Run: npm test
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  replaceBlock, renderHeatmap, renderLangs, renderUpdates, renderRepos, fmt, monthYear, longestStreak, esc,
} from './render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

/* ---- markers ---- */

const page = await readFile(resolve(HERE, '../index.html'), 'utf8');
for (const name of ['rank', 'contrib', 'lc-solved', 'lc-hard', 'heatmap', 'langs', 'updates', 'repos', 'repo-count', 'stars', 'synced']) {
  let ok = true;
  try { replaceBlock(page, name, 'x'); } catch { ok = false; }
  check(`index.html has the ${name} marker`, ok);
}

const twice = '<!-- sync:a -->1<!-- /sync:a --> and <!-- sync:a -->2<!-- /sync:a -->';
check('replaceBlock replaces every copy of a marker',
  replaceBlock(twice, 'a', '9') === '<!-- sync:a -->9<!-- /sync:a --> and <!-- sync:a -->9<!-- /sync:a -->');
check('replaceBlock inserts "$&" literally, not as a regex back-reference',
  replaceBlock('<!-- sync:a --><!-- /sync:a -->', 'a', 'cost $& $1').includes('cost $& $1'));
let threw = false;
try { replaceBlock('<p>no markers</p>', 'a', 'x'); } catch { threw = true; }
check('replaceBlock throws when a marker is missing', threw);

/* ---- formatting ---- */

check('fmt adds thousands separators', fmt(1388) === '1,388' && fmt(1234567) === '1,234,567' && fmt(48) === '48');
check('monthYear', monthYear('2026-09-14T08:00:00Z') === 'Sep 2026' && monthYear(null) === '');
check('esc escapes markup', esc('<a href="x">&</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
check('longestStreak', longestStreak([0, 1, 2, 0, 3, 4, 5, 0]) === 3 && longestStreak([]) === 0);

/* ---- heatmap ---- */

const counts = Array.from({ length: 7 * 53 }, (_, i) => (i % 5 === 0 ? 0 : (i % 17) + 1));
const heat = renderHeatmap({ total: 999, start: '2025-09-21', counts });
check('heatmap renders a labelled image', heat.includes('role="img"') && heat.includes('aria-label="Contribution heatmap'));
check('heatmap shows the total', heat.includes('<b>999</b> contributions'));
check('heatmap uses all five shades', ['l0', 'l1', 'l2', 'l3', 'l4'].every((c) => heat.includes(`class="${c}"`)));
check('heatmap labels every month', /Sep Oct     Nov/.test(heat) && /Mar/.test(heat));
check('heatmap is deterministic', heat === renderHeatmap({ total: 999, start: '2025-09-21', counts }));
check('empty heatmap renders nothing', renderHeatmap(null) === '' && renderHeatmap({ counts: [] }) === '');
const rows = heat.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1].split('\n');
const width = rows[2].replace(/<[^>]+>/g, '').length;
check('heatmap rows are two characters per week', width === 4 + 53 * 2, `width ${width}`);

/* ---- languages ---- */

const langs = renderLangs([{ name: 'C++', bytes: 600 }, { name: 'Go', bytes: 300 }, { name: 'Rust', bytes: 100 }]);
check('language bars show percentages', langs.includes('60.0%') && langs.includes('30.0%') && langs.includes('10.0%'));
check('language bars are 28 cells wide', (langs.match(/<li>.*?<\/li>/)[0].match(/[█░]/g) || []).length === 28);

/* ---- updates ---- */

const upd = renderUpdates([
  { kind: 'release', repo: 'Helmsman', date: '2026-09-07', text: 'Released v1.0.0.' },
  { kind: 'activity', repo: 'X', date: '2026-09-06', text: 'Added <script>alert(1)</script>.' },
], (n) => `https://github.com/u/${n}`);
check('updates link the repo', upd.includes('href="https://github.com/u/Helmsman"'));
check('updates label releases', upd.includes('<span class="kind">release</span>'));
check('updates escape text', !upd.includes('<script>') && upd.includes('&lt;script&gt;'));
check('empty updates say so', renderUpdates([], () => '').includes('Nothing in the last few weeks'));

/* ---- repo list ---- */

const groups = [{ id: 'quant', title: 'quant', blurb: 'Money.' }, { id: 'ml', title: 'ml', blurb: '' }];
const list = renderRepos([
  { name: 'A', url: 'u/A', group: 'quant', language: 'Python', stars: 3, pushedAt: '2026-09-01T00:00:00Z', summary: 'Prices things.' },
  { name: 'B', url: 'u/B', group: null, language: 'Go', stars: 0, pushedAt: '2026-08-01T00:00:00Z', description: 'Fallback.' },
  { name: 'C', url: 'u/C', group: 'quant', archived: true, stars: 0, pushedAt: '2025-01-01T00:00:00Z' },
], groups);
check('repos are grouped', list.indexOf('>quant<') < list.indexOf('>A<') && list.includes('Money.'));
check('empty groups are left out', !list.includes('>ml<'));
check('ungrouped repos land in "other"', list.includes('>other<') && list.indexOf('>other<') < list.indexOf('>B<'));
check('repo meta has language, stars and month', list.includes('Python · ★ 3 · Sep 2026'));
check('description falls back to GitHub\'s', list.includes('Fallback.'));
check('archived repos say so', list.includes('archived'));

console.log(failures ? `\n${failures} failing check(s)` : '\nAll render checks passed.');
process.exit(failures ? 1 : 0);
