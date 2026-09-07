#!/usr/bin/env node
/**
 * Pulls live data from GitHub, optionally rewrites descriptions and an updates
 * feed with Groq, and writes two JSON files the site reads at runtime.
 *
 *   src/data/repos.json    every public repo
 *   src/data/updates.json  a short activity feed built from recent commits
 *
 * Design notes:
 *
 * - Nothing the model writes is trusted. Every candidate passes through
 *   scripts/guard.mjs and falls back to the repo's own GitHub description on
 *   failure. See that file for what is and isn't caught.
 *
 * - Summaries are cached against a hash of the README. Groq is only called
 *   when the source actually changed, which keeps the output stable, keeps
 *   commits meaningful, and keeps API usage near zero on a quiet week.
 *
 * - The script never fails the workflow on a network error. A missing GROQ_API_KEY
 *   simply means descriptions stay as GitHub's own.
 *
 * Env:
 *   GITHUB_TOKEN  raises the API rate limit (provided automatically in Actions)
 *   GROQ_API_KEY  optional; without it, no text is generated
 *   GROQ_MODEL    default openai/gpt-oss-20b
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSummary, validateUpdate, clean } from './guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../src/data');
const REPOS_OUT = resolve(DATA, 'repos.json');
const UPDATES_OUT = resolve(DATA, 'updates.json');

const USER = process.env.GITHUB_USER || 'zishaan1911';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

/* Groq retired llama-3.1-8b-instant and llama-3.3-70b-versatile on 2026-08-16.
   Most tutorials still name them; they return a 400. */
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Repos never worth showing, regardless of activity. */
const HIDE = new Set(['zishaan1911']); // profile README repo

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha256').update(s || '').digest('hex').slice(0, 16);

function signal(ms = 20000) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function gh(path, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    signal: signal(),
    headers: {
      'User-Agent': `${USER}-site-sync`,
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
  return raw ? res.text() : res.json();
}

/* ---------------- GitHub ---------------- */

async function fetchRepos() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/users/${USER}/repos?per_page=100&page=${page}&sort=pushed`);
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out
    .filter((r) => !r.fork && !r.private && !HIDE.has(r.name))
    .map((r) => ({
      name: r.name,
      url: r.html_url,
      homepage: r.homepage || null,
      description: r.description || null,
      language: r.language || null,
      stars: r.stargazers_count,
      forks: r.forks_count,
      topics: r.topics || [],
      archived: r.archived,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
    }));
}

async function fetchReadme(name) {
  try {
    const text = await gh(`/repos/${USER}/${name}/readme`, { raw: true });
    if (!text) return null;
    // Trim to the first chunk — enough to describe the project, small enough
    // to keep the prompt cheap and focused.
    return text.slice(0, 4000);
  } catch {
    return null;
  }
}

async function fetchRecentCommits(repos, days = 45, maxRepos = 10) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const active = repos.filter((r) => !r.archived).slice(0, maxRepos);
  const all = [];

  for (const repo of active) {
    try {
      const commits = await gh(`/repos/${USER}/${repo.name}/commits?since=${since}&per_page=30`);
      if (!Array.isArray(commits)) continue;
      for (const c of commits) {
        const msg = (c.commit?.message || '').split('\n')[0].trim();
        if (!msg) continue;
        if (/^merge\b/i.test(msg)) continue;
        if (/^(bump|chore\(deps\)|dependabot)/i.test(msg)) continue;
        if (/\[(bot|skip ci)\]/i.test(msg)) continue;
        if (c.author?.type === 'Bot') continue;
        if (msg.length < 8) continue;
        all.push({ repo: repo.name, date: c.commit?.author?.date, message: msg });
      }
    } catch {
      /* one unreadable repo shouldn't sink the run */
    }
  }
  return all.sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* ---------------- Groq ---------------- */

async function groq(system, user, { maxTokens = 400, temperature = 0.2 } = {}) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    signal: signal(30000),
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (res.status === 404 || res.status === 400) {
    const body = await res.text();
    throw new Error(
      `Groq rejected model "${GROQ_MODEL}" (${res.status}). ` +
      `Check https://console.groq.com/docs/models for current IDs. ${body.slice(0, 200)}`,
    );
  }
  if (res.status === 429) throw new Error('Groq rate limit hit');
  if (!res.ok) throw new Error(`Groq ${res.status}`);

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const DESC_SYSTEM = `You write one-sentence descriptions of software projects for a developer's portfolio.

Rules, all mandatory:
- Use ONLY facts stated in the README you are given. Invent nothing.
- Never state a number, percentage, version or measurement unless that exact figure appears in the README. Write digits, not words, for any figure.
- No marketing language. Banned: state-of-the-art, production-ready, blazingly fast, seamless, world-class, cutting-edge, revolutionary, superlatives of any kind.
- Third person. Do not write "I" or "we".
- One sentence, 20 to 200 characters. Plain text only: no markdown, no links, no quotes.
- Describe what it IS and what it DOES. Lead with the noun.
- Output the sentence and nothing else. No preamble.

Good: "A transactional database engine written in Rust with a custom storage layer and a command-line client."
Bad: "This is a blazingly fast, production-ready database that improves performance by 40%."`;

const UPDATE_SYSTEM = `You turn raw git commit messages into short update lines for a developer's portfolio changelog.

Rules, all mandatory:
- Use ONLY what the commit messages say. Invent nothing.
- Never state a number, percentage or measurement that does not appear in the commits.
- No marketing language and no superlatives.
- Past tense, third person, no "I" or "we".
- Each line 12 to 160 characters, plain text, one sentence.
- Group related commits into a single line. Skip trivial ones.
- Return ONLY a JSON array of objects: [{"repo":"name","text":"..."}]
- At most 6 objects. No prose outside the JSON.`;

async function describeRepos(repos, previous) {
  const prev = new Map((previous?.repos || []).map((r) => [r.name, r]));
  let generated = 0, reused = 0, rejected = 0;

  for (const repo of repos) {
    const cached = prev.get(repo.name);

    if (!GROQ_KEY) {
      repo.summary = cached?.summary || repo.description;
      repo.summarySource = cached?.summary ? cached.summarySource : 'github';
      repo.readmeHash = cached?.readmeHash || null;
      continue;
    }

    const readme = await fetchReadme(repo.name);
    const source = [readme, repo.description, repo.topics.join(' ')].filter(Boolean).join('\n');
    const h = hash(source);

    // Unchanged source and a summary already on file: nothing to do.
    if (cached?.readmeHash === h && cached?.summary) {
      repo.summary = cached.summary;
      repo.summarySource = cached.summarySource;
      repo.readmeHash = h;
      reused++;
      continue;
    }

    repo.readmeHash = h;

    if (!source || source.length < 40) {
      repo.summary = repo.description;
      repo.summarySource = 'github';
      continue;
    }

    try {
      const raw = await groq(DESC_SYSTEM, `Repository: ${repo.name}\n\nREADME:\n${source}`, { maxTokens: 200 });
      const verdict = validateSummary(raw, source);
      if (verdict.ok) {
        repo.summary = verdict.text;
        repo.summarySource = 'groq';
        generated++;
      } else {
        console.warn(`  guard rejected ${repo.name}: ${verdict.reason}`);
        repo.summary = cached?.summary || repo.description;
        repo.summarySource = cached?.summary ? cached.summarySource : 'github';
        rejected++;
      }
    } catch (err) {
      console.warn(`  groq failed for ${repo.name}: ${err.message}`);
      repo.summary = cached?.summary || repo.description;
      repo.summarySource = cached?.summary ? cached.summarySource : 'github';
    }

    await sleep(700); // stay well inside the free-tier rate limit
  }

  console.log(`  descriptions: ${generated} generated, ${reused} cached, ${rejected} rejected by guard`);
}

async function buildUpdates(commits) {
  if (!GROQ_KEY || !commits.length) return [];

  const source = commits.slice(0, 60).map((c) => `[${c.repo}] ${c.message}`).join('\n');

  try {
    const raw = await groq(UPDATE_SYSTEM, `Commit messages, newest first:\n\n${source}`, { maxTokens: 700 });
    const match = clean(raw).match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn('  updates: model did not return JSON');
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      console.warn('  updates: unparseable JSON');
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const known = new Set(commits.map((c) => c.repo));
    const out = [];

    for (const item of parsed.slice(0, 6)) {
      const verdict = validateUpdate(item?.text, source);
      if (!verdict.ok) {
        console.warn(`  guard rejected update: ${verdict.reason}`);
        continue;
      }
      // A repo name the model made up is as bad as a made-up number.
      const repo = known.has(item?.repo) ? item.repo : null;
      const date = commits.find((c) => c.repo === repo)?.date || commits[0].date;
      out.push({ repo, text: verdict.text, date: date?.slice(0, 10) || null });
    }

    console.log(`  updates: ${out.length} of ${parsed.length} accepted`);
    return out;
  } catch (err) {
    console.warn(`  updates failed: ${err.message}`);
    return [];
  }
}

/* ---------------- Write ---------------- */

const readJson = async (p) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
};

/**
 * Serialise a repo with a fixed key order.
 *
 * Without this, a repo whose summary came from cache had its keys inserted in
 * a different order than one freshly generated, so JSON.stringify produced a
 * different string for identical data — and the change check fired on every
 * run, committing noise every six hours forever. Caught by sync.test.mjs.
 */
function canonical(r) {
  return {
    name: r.name,
    url: r.url,
    homepage: r.homepage ?? null,
    description: r.description ?? null,
    summary: r.summary ?? null,
    summarySource: r.summarySource ?? null,
    language: r.language ?? null,
    stars: r.stars,
    forks: r.forks,
    topics: r.topics ?? [],
    archived: r.archived,
    pushedAt: r.pushedAt,
    createdAt: r.createdAt,
    readmeHash: r.readmeHash ?? null,
  };
}

/** Compare ignoring the timestamp, so an unchanged run produces no commit. */
function changed(next, prev) {
  if (!prev) return true;
  const strip = (o) => JSON.stringify({ ...o, generatedAt: undefined });
  return strip(next) !== strip(prev);
}

async function main() {
  await mkdir(DATA, { recursive: true });

  const prevRepos = await readJson(REPOS_OUT);
  const prevUpdates = await readJson(UPDATES_OUT);

  console.log(`Syncing github.com/${USER}`);
  if (!GROQ_KEY) console.log('  GROQ_API_KEY not set — using GitHub descriptions as-is');

  let repos;
  try {
    repos = await fetchRepos();
    console.log(`  ${repos.length} public repos`);
  } catch (err) {
    console.error(`GitHub fetch failed: ${err.message}`);
    if (!prevRepos) process.exit(1); // nothing on file and nothing fetched
    console.error('Keeping the committed data.');
    return;
  }

  await describeRepos(repos, prevRepos);

  const commits = await fetchRecentCommits(repos);
  console.log(`  ${commits.length} recent commits`);
  const updates = await buildUpdates(commits);

  const reposDoc = {
    generatedAt: new Date().toISOString(),
    user: USER,
    count: repos.length,
    totalStars: repos.reduce((n, r) => n + r.stars, 0),
    repos: repos
      .sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt))
      .map(canonical),
  };

  const updatesDoc = {
    generatedAt: new Date().toISOString(),
    // Keep the previous feed if this run produced nothing usable.
    updates: updates.length ? updates : prevUpdates?.updates || [],
  };

  if (changed(reposDoc, prevRepos)) {
    await writeFile(REPOS_OUT, JSON.stringify(reposDoc, null, 2) + '\n');
    console.log('  wrote repos.json');
  } else {
    console.log('  repos.json unchanged');
  }

  if (changed(updatesDoc, prevUpdates)) {
    await writeFile(UPDATES_OUT, JSON.stringify(updatesDoc, null, 2) + '\n');
    console.log('  wrote updates.json');
  } else {
    console.log('  updates.json unchanged');
  }
}

main().catch((err) => {
  console.error('sync failed:', err.message);
  process.exit(1);
});
