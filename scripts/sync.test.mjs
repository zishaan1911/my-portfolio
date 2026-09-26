#!/usr/bin/env node
/**
 * End-to-end test of sync.mjs against a fake GitHub and a fake Groq.
 *
 * The guard is unit-tested separately; this checks it is actually wired in,
 * and that every way the previous bot failed in production stays fixed:
 *
 *   - empty answers from the reasoning model (the old token budget was 200)
 *   - rate limits that killed the updates feed for weeks
 *   - rejected generations cached as if they had succeeded
 *   - a commit on every run with nothing visibly changed
 *
 * Run: npm test
 */

import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, parseDuration } from './sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const NOW = Date.parse('2026-09-26T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');

/* ─── fixtures ──────────────────────────────────────────────────────── */

const CONFIG = {
  user: 'u',
  hide: ['u', 'u.github.io'],
  featured: ['Feat'],
  quiet: ['Quiet'],
  groups: [
    { id: 'systems', title: 'systems', blurb: 'Low level.' },
    { id: 'ml', title: 'machine learning', blurb: '' },
  ],
  assign: { RustDB: 'systems' },
  descriptions: {},
};

const repo = (name, extra = {}) => ({
  name, fork: false, private: false, html_url: `https://github.com/u/${name}`, description: null,
  language: 'Python', stargazers_count: 0, topics: [], archived: false, default_branch: 'main',
  pushed_at: daysAgo(2), created_at: daysAgo(300), homepage: null, ...extra,
});

const REPOS = [
  repo('RustDB', { description: 'Database engine in Rust.', language: 'Rust', stargazers_count: 12 }),
  repo('SmolGPT', { language: 'Python', stargazers_count: 30, created_at: daysAgo(20) }),
  repo('Bare', { pushed_at: daysAgo(40) }),
  repo('Feat', { description: 'Featured thing.', language: 'C++' }),
  repo('Quiet', { description: 'Auto-committed solutions.' }),
  repo('Forked', { fork: true }),
  repo('u.github.io', { language: 'HTML' }),
];

const READMES = {
  RustDB: '# RustDB\n\n![CI](https://x/badge.svg)\n\nRustDB is a transactional database engine written in Rust with a custom storage layer and write-ahead log. Built by a team of 3 developers and packaged with Docker so it runs anywhere. '.repeat(2),
  SmolGPT: '# SmolGPT\n\nSmolGPT is a decoder-only transformer with 51.1M parameters, trained from scratch on a single GPU using PyTorch and CUDA, with checkpointing and auto-resume. '.repeat(2),
  Bare: '# Bare',
  Feat: '# Feat\n\nHand-described elsewhere.',
};

const TREES = { Bare: ['main.py', 'requirements.txt', 'assets/logo.png', 'node_modules/x/index.js'] };
const FILES = { 'Bare/main.py': 'import pygame\n# snake: eat the apple, grow, do not hit the wall\n', 'Bare/requirements.txt': 'pygame\n' };

const COMMITS = {
  RustDB: [
    { message: 'feat: add B-tree page splitting', date: daysAgo(2) },
    { message: 'fix: replay the write-ahead log after a crash', date: daysAgo(2) },
    { message: 'Merge pull request #3 from u/x', date: daysAgo(2) },
    { message: 'Update README.md', date: daysAgo(2) },
  ],
  SmolGPT: [{ message: 'train: resume from the last checkpoint on disconnect', date: daysAgo(3) }],
  Quiet: [{ message: 'Solve Two Sum in C++', date: daysAgo(1) }, { message: 'Solve Three Sum in C++', date: daysAgo(1) }],
};

const RELEASES = { RustDB: [{ tag_name: 'v0.2.0', name: 'v0.2.0', published_at: daysAgo(4), draft: false, prerelease: false }] };

const CAL = (() => {
  const start = new Date(Date.parse('2025-09-21T00:00:00Z'));
  const weeks = [];
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
      days.push({ date, contributionCount: (w * 7 + d) % 4 === 0 ? 0 : ((w + d) % 9) + 1 });
    }
    weeks.push({ contributionDays: days });
  }
  return { totalContributions: 1388, weeks };
})();

/* ─── fake network ──────────────────────────────────────────────────── */

function makeWorld({ groq }) {
  const log = { groqBodies: [], sleeps: [], ghCalls: 0 };
  const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const text = (body, status = 200) => new Response(body, { status });

  async function fetch(url, init = {}) {
    const u = new URL(url);

    if (u.host === 'api.groq.com') {
      const body = JSON.parse(init.body);
      log.groqBodies.push(body);
      return groq(body, { json, text });
    }
    if (u.host === 'user-badge.committers.top') return text('<svg aria-label="committers.top rank: Malaysia #48 (public commits)"></svg>');
    if (u.host === 'leetcode.com') {
      return json({ data: { matchedUser: { submitStatsGlobal: { acSubmissionNum: [
        { difficulty: 'All', count: 283 }, { difficulty: 'Easy', count: 72 },
        { difficulty: 'Medium', count: 161 }, { difficulty: 'Hard', count: 50 },
      ] } } } });
    }
    if (u.host !== 'api.github.com') throw new Error(`unexpected host ${u.host}`);
    log.ghCalls++;

    const p = u.pathname;
    if (p === '/graphql') {
      return json({ data: { user: {
        contributionsCollection: { contributionCalendar: CAL },
        repositories: { nodes: [
          { name: 'RustDB', languages: { edges: [{ size: 9000, node: { name: 'Rust' } }, { size: 500, node: { name: 'Shell' } }] } },
          { name: 'SmolGPT', languages: { edges: [{ size: 6000, node: { name: 'Python' } }, { size: 90000, node: { name: 'Jupyter Notebook' } }] } },
          { name: 'u.github.io', languages: { edges: [{ size: 99999, node: { name: 'JavaScript' } }] } },
        ] },
      } } });
    }
    if (p === '/users/u/repos') return json(u.searchParams.get('page') === '1' ? REPOS : []);
    let m;
    if ((m = p.match(/^\/repos\/u\/([^/]+)\/readme$/))) return READMES[m[1]] ? text(READMES[m[1]]) : text('', 404);
    if ((m = p.match(/^\/repos\/u\/([^/]+)\/git\/trees\//))) {
      return json({ tree: (TREES[m[1]] || []).map((path) => ({ path, type: 'blob' })) });
    }
    if ((m = p.match(/^\/repos\/u\/([^/]+)\/contents\/(.+)$/))) {
      const f = FILES[`${m[1]}/${decodeURIComponent(m[2])}`];
      return f ? text(f) : text('', 404);
    }
    if ((m = p.match(/^\/repos\/u\/([^/]+)\/commits$/))) {
      return json((COMMITS[m[1]] || []).map((c) => ({ author: { type: 'User' }, commit: { message: c.message, author: { date: c.date } } })));
    }
    if ((m = p.match(/^\/repos\/u\/([^/]+)\/releases$/))) return json(RELEASES[m[1]] || []);
    return text('', 404);
  }

  return { fetch, log, sleep: async (ms) => { log.sleeps.push(ms); } };
}

/** Groq that hallucinates for RustDB, rate-limits once, and goes blank for Bare. */
function scriptedGroq({ bareWorks = false } = {}) {
  let limited = false;
  return (body, { json }) => {
    const user = body.messages[1].content;
    const reply = (obj) => json({
      choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }],
      usage: { total_tokens: 900 },
    }, 200, { 'x-ratelimit-remaining-tokens': '7000', 'x-ratelimit-reset-tokens': '2s' });

    if (body.response_format.json_schema.name === 'update_line') {
      return reply({ text: 'Added B-tree page splitting and write-ahead log replay after a crash.' });
    }
    if (user.includes('Repository: RustDB')) {
      return reply({ summary: 'A transactional database engine in Rust that improved throughput by 40%.', group: 'systems' });
    }
    if (user.includes('Repository: SmolGPT')) {
      if (!limited) {
        limited = true;
        return json({ error: { message: 'Rate limit reached' } }, 429, { 'retry-after': '2' });
      }
      return reply({ summary: 'A decoder-only transformer with 51.1M parameters, trained from scratch on a single GPU with PyTorch.', group: 'ml' });
    }
    if (user.includes('Repository: Bare')) {
      if (!bareWorks) {
        // What the old bot kept getting: the reasoning ate the budget.
        return json({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { total_tokens: 1500 } });
      }
      return reply({ summary: 'A snake game written in Python with pygame.', group: 'other' });
    }
    return reply({ summary: 'Should not be asked about this repository at all.', group: 'other' });
  };
}

async function site() {
  const root = await mkdtemp(join(tmpdir(), 'sync-test-'));
  await mkdir(join(root, 'content'));
  await writeFile(join(root, 'content/projects.json'), JSON.stringify(CONFIG));
  await copyFile(resolve(HERE, '../index.html'), join(root, 'index.html'));
  await copyFile(resolve(HERE, '../sitemap.xml'), join(root, 'sitemap.xml'));
  return root;
}

const quiet = { log() {} };
const read = async (root, f) => readFile(join(root, f), 'utf8');

/* ─── run 1: a fresh site ───────────────────────────────────────────── */

const root = await site();
const env = { GROQ_API_KEY: 'k', GITHUB_TOKEN: 't' };
let world = makeWorld({ groq: scriptedGroq() });
const r1 = await run({ root, env, fetch: world.fetch, sleep: world.sleep, now: NOW, log: quiet });

const repos1 = JSON.parse(await read(root, 'data/repos.json')).repos;
const byName = (list, n) => list.find((r) => r.name === n);

check('exits cleanly', r1.code === 0, `code ${r1.code}`);
check('forks and hidden repos are excluded',
  !byName(repos1, 'Forked') && !byName(repos1, 'u.github.io'), repos1.map((r) => r.name).join(','));

const body = world.log.groqBodies[0];
check('asks for low reasoning effort', body.reasoning_effort === 'low');
check('hides the reasoning from the answer', body.include_reasoning === false);
check('leaves room for the answer after reasoning', body.max_completion_tokens >= 1000, String(body.max_completion_tokens));
check('asks for strict JSON', body.response_format?.type === 'json_schema' && body.response_format.json_schema.strict === true);

const rust = byName(repos1, 'RustDB');
check('a hallucinated figure is rejected', rust.genStatus === 'rejected' && !/40%/.test(rust.summary || ''), rust.summary);
check('…and the GitHub description is used instead', rust.summary === 'Database engine in Rust.' && rust.summarySource === 'github');
check('the rejection is reported', r1.report.rejections.some((x) => x.what === 'RustDB' && /40/.test(x.reason)));
check('manual group assignment wins', rust.group === 'systems');

const smol = byName(repos1, 'SmolGPT');
check('a grounded summary is accepted', smol.summarySource === 'groq' && smol.summary.includes('51.1M'), smol.summary);
check('the model can choose the group', smol.group === 'ml');
check('a rate limit waits for retry-after, then succeeds', world.log.sleeps.includes(2000), world.log.sleeps.join(','));

const bare = byName(repos1, 'Bare');
check('an empty answer is an error, not a blank description', bare.genStatus === 'error' && bare.summary === null);

check('featured repos are not sent to the model',
  !world.log.groqBodies.some((b) => b.messages[1].content.includes('Repository: Feat')));

const page1 = await read(root, 'index.html');
check('rank is written into the page', page1.includes('#<!-- sync:rank -->48<!-- /sync:rank -->'));
check('contributions are written into the page', page1.includes('<!-- sync:contrib -->1,388<!-- /sync:contrib -->'));
check('LeetCode count is written into the page', page1.includes('<!-- sync:lc-solved -->283<!-- /sync:lc-solved -->'));
check('the heatmap is rendered', /<!-- sync:heatmap --><pre class="heatmap"/.test(page1));
check('featured repos are left out of the list', !/class="repo-name"[^>]*>Feat</.test(page1));
check('listed repos appear in their group', /systems<\/h3>.*RustDB/s.test(page1));
check('the repo count excludes forks and hidden repos', page1.includes('<!-- sync:repo-count -->5<!-- /sync:repo-count -->'));

const stats = JSON.parse(await read(root, 'data/stats.json'));
check('language stats skip notebooks, shell and the site itself',
  stats.languages.map((l) => l.name).join(',') === 'Rust,Python', stats.languages.map((l) => l.name).join(','));

const feed = JSON.parse(await read(root, 'data/updates.json')).updates;
check('releases are in the feed', feed.some((u) => u.kind === 'release' && u.text === 'Released v0.2.0.'));
check('new projects are in the feed', feed.some((u) => u.kind === 'new' && u.repo === 'SmolGPT' && u.text.startsWith('Started SmolGPT: a decoder-only')));
check('commit activity is summarised', feed.some((u) => u.kind === 'activity' && u.repo === 'RustDB' && /B-tree page splitting/.test(u.text)));
check('a lone commit is quoted instead of summarised',
  feed.some((u) => u.kind === 'activity' && u.repo === 'SmolGPT' && u.text === 'Resume from the last checkpoint on disconnect.'),
  JSON.stringify(feed.filter((u) => u.repo === 'SmolGPT')));
check('quiet repos stay out of the activity feed', !feed.some((u) => u.repo === 'Quiet'));
check('the feed is newest first', feed.every((u, i) => i === 0 || feed[i - 1].date >= u.date));
check('sitemap lastmod is updated', (await read(root, 'sitemap.xml')).includes('<lastmod>2026-09-26</lastmod>'));

/* ─── run 2: nothing changed upstream ───────────────────────────────── */

world = makeWorld({ groq: scriptedGroq({ bareWorks: true }) });
const r2 = await run({ root, env, fetch: world.fetch, sleep: world.sleep, now: NOW + 3600000, log: quiet });
const repos2 = JSON.parse(await read(root, 'data/repos.json')).repos;
const asked = world.log.groqBodies.map((b) => b.messages[1].content.match(/Repository: (\S+)/)?.[1]).filter(Boolean);

check('a successful description is not regenerated', !asked.includes('SmolGPT'), asked.join(','));
check('a failed description is retried', asked.includes('Bare') && byName(repos2, 'Bare').summary === 'A snake game written in Python with pygame.');
check('a thin README is described from its code', world.log.groqBodies.some((b) => /--- main\.py ---[\s\S]*pygame/.test(b.messages[1].content)));
check('ungrouped repos fall back to "other"', byName(repos2, 'Bare').group === 'other');
check('a rejected description is retried, with a count', byName(repos2, 'RustDB').genAttempts === 2);
check('an unchanged commit window is not re-summarised', !world.log.groqBodies.some((b) => b.response_format.json_schema.name === 'update_line'));

/* ─── a summary the guard would now reject is written again ─────────── */

{
  const doc = JSON.parse(await read(root, 'data/repos.json'));
  byName(doc.repos, 'SmolGPT').summary = 'Repository contains only a license file and an empty README.';
  await writeFile(join(root, 'data/repos.json'), JSON.stringify(doc));
  world = makeWorld({ groq: scriptedGroq({ bareWorks: true }) });
  await run({ root, env, fetch: world.fetch, sleep: world.sleep, now: NOW + 5400000, log: quiet });
  const redone = byName(JSON.parse(await read(root, 'data/repos.json')).repos, 'SmolGPT');
  check('an accepted summary that fails a newer guard is regenerated',
    redone.summary.startsWith('A decoder-only transformer') &&
      world.log.groqBodies.some((b) => b.messages[1].content.includes('Repository: SmolGPT')),
    redone.summary);
}

/* ─── run 3: truly nothing to do ────────────────────────────────────── */

// RustDB has hit its retry limit and everything else is cached, so this run
// must not touch the page or any data file.
world = makeWorld({ groq: scriptedGroq({ bareWorks: true }) });
await run({ root, env, fetch: world.fetch, sleep: world.sleep, now: NOW + 7200000, log: quiet });
const before = await read(root, 'index.html');
world = makeWorld({ groq: scriptedGroq({ bareWorks: true }) });
const r4 = await run({ root, env, fetch: world.fetch, sleep: world.sleep, now: NOW + 10800000, log: quiet });
check('an idle run changes nothing, so nothing is committed', r4.changed.length === 0 && before === await read(root, 'index.html'),
  r4.changed.join(','));
check('an idle run makes no model calls', world.log.groqBodies.length === 0, String(world.log.groqBodies.length));

/* ─── a dead key fails loudly, but still saves what it could ────────── */

const root2 = await site();
world = makeWorld({ groq: (b, { json }) => json({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, 401) });
const r5 = await run({ root: root2, env, fetch: world.fetch, sleep: world.sleep, now: NOW, log: quiet });
check('an invalid key exits non-zero', r5.code === 2, `code ${r5.code}`);
check('…after one call, not one per repo', world.log.groqBodies.length === 1, String(world.log.groqBodies.length));
check('…and still writes the page', (await read(root2, 'index.html')).includes('<!-- sync:rank -->48<!-- /sync:rank -->'));
check('…and says what to fix', r5.report.errors.some((e) => /GROQ_API_KEY/.test(e)));

/* ─── no key at all: still a useful sync ────────────────────────────── */

const root3 = await site();
world = makeWorld({ groq: () => { throw new Error('should not be called'); } });
const r6 = await run({ root: root3, env: { GITHUB_TOKEN: 't' }, fetch: world.fetch, sleep: world.sleep, now: NOW, log: quiet });
const feed3 = JSON.parse(await read(root3, 'data/updates.json')).updates;
check('without a key the sync still succeeds', r6.code === 0);
check('without a key the feed quotes commits', feed3.some((u) => u.repo === 'RustDB' && u.kind === 'activity'),
  JSON.stringify(feed3));

check('quoted lines are marked as quotes', feed3.every((u) => u.kind !== 'activity' || u.by === 'commit'));

// The key comes back: the quoted line for a busy week gets rewritten properly.
world = makeWorld({ groq: scriptedGroq({ bareWorks: true }) });
await run({ root: root3, env, fetch: world.fetch, sleep: world.sleep, now: NOW + 3600000, log: quiet });
const upgraded = JSON.parse(await read(root3, 'data/updates.json')).updates.find((u) => u.key.startsWith('activity:RustDB'));
check('a quoted commit is upgraded once the model is available',
  upgraded?.by === 'model' && /B-tree page splitting and write-ahead log replay/.test(upgraded.text), JSON.stringify(upgraded));

/* ─── helpers ───────────────────────────────────────────────────────── */

check('parseDuration', parseDuration('1m2.5s') === 62500 && parseDuration('250ms') === 250 && parseDuration('7.66s') === 7660);

await Promise.all([root, root2, root3].map((d) => rm(d, { recursive: true, force: true })));
console.log(failures ? `\n${failures} failing check(s)` : '\nAll sync checks passed.');
process.exit(failures ? 1 : 0);
