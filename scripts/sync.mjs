#!/usr/bin/env node
/**
 * The sync bot. Pulls live data from GitHub (and a couple of public stat
 * sources), has Groq write what needs writing, checks every generated line
 * against its source, and splices the result into index.html.
 *
 *   content/projects.json   hand-edited: featured, hidden, groups, overrides
 *   data/repos.json         every public repo + its description and cache keys
 *   data/updates.json       the activity feed
 *   data/stats.json         heatmap, languages, rank, LeetCode counts
 *   index.html              regions between <!-- sync:x --> markers
 *   sitemap.xml             <lastmod>, when the page actually changed
 *
 * Design notes, most of them learned from the previous version of this bot:
 *
 * - The model is a reasoning model. Its hidden reasoning counts against
 *   max_completion_tokens, so a small budget returns an *empty* answer. The
 *   old bot asked for 200 tokens and got nothing back for most repos. Here the
 *   budget is generous and reasoning_effort is "low".
 *
 * - Groq's free tier allows 8K tokens a minute. The old bot fired a request
 *   per repo 700ms apart, blew the limit, and the updates feed failed every
 *   run for weeks. Here every call honours retry-after and the rate-limit
 *   headers, and there is a per-run call budget; leftovers happen next run.
 *
 * - Failures are never cached as if they were successes. A rejected or empty
 *   generation is retried on later runs (up to 3 times per README version).
 *
 * - Repos with a bare README are described from their file tree and
 *   manifests instead, rather than showing nothing.
 *
 * - Nothing is rendered that changes on its own (no "3 days ago"), and the
 *   site's own repo is not listed, so the bot's push can't trigger a change
 *   on the next run. The old bot committed on every run for that reason.
 *
 * - Every rejection, rate-limit wait and failure is written to the Actions
 *   job summary and as annotations, and a broken API key or retired model
 *   fails the job, so a broken bot is loud instead of quietly stale.
 *
 * Env:
 *   GITHUB_TOKEN   GitHub API (provided in Actions). Needed for the heatmap and
 *                  language stats; without it those are kept from the last run.
 *   GROQ_API_KEY   optional; without it nothing is generated and existing text is kept
 *   GROQ_MODEL     default openai/gpt-oss-20b
 *   SYNC_FORCE     "true" to ignore caches and regenerate everything
 *   SYNC_BUDGET    max Groq calls per run, default 24
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSummary, validateUpdate, clean } from './guard.mjs';
import {
  replaceBlock, renderHeatmap, renderLangs, renderUpdates, renderRepos, fmt,
} from './render.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Languages that describe markup, notebooks or build files rather than code I wrote. */
const NOT_CODE = new Set([
  'Jupyter Notebook', 'HTML', 'CSS', 'SCSS', 'Less', 'Makefile', 'CMake', 'Dockerfile',
  'Batchfile', 'PowerShell', 'Procfile', 'Roff', 'Shell',
]);

const hash = (s) => createHash('sha256').update(s || '').digest('hex').slice(0, 16);
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const daysSince = (iso, now) => (now - new Date(iso)) / 86400000;
const lcfirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const sentence = (s) => {
  const t = String(s || '').trim();
  if (!t) return t;
  const cap = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
};

/* ─────────────────────────── reporting ─────────────────────────────── */

class Report {
  constructor(log = console) {
    this.log = log;
    this.notes = [];
    this.warnings = [];
    this.rejections = [];
    this.errors = [];
  }
  note(msg) { this.notes.push(msg); this.log.log(`  ${msg}`); }
  warn(msg) { this.warnings.push(msg); this.log.log(`::warning::${msg}`); }
  error(msg) { this.errors.push(msg); this.log.log(`::error::${msg}`); }
  reject(what, reason, candidate) {
    this.rejections.push({ what, reason, candidate });
    this.log.log(`::warning title=Guard rejected ${what}::${reason}${candidate ? ` — "${String(candidate).slice(0, 140)}"` : ''}`);
  }
  markdown(extra = []) {
    const out = ['## Sync bot', ''];
    out.push(...extra, '');
    if (this.errors.length) out.push('### Errors', ...this.errors.map((e) => `- ${e}`), '');
    if (this.rejections.length) {
      out.push('### Rejected by the guard', '', '| what | why | candidate |', '|---|---|---|');
      for (const r of this.rejections) {
        out.push(`| ${r.what} | ${r.reason} | ${String(r.candidate ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`);
      }
      out.push('');
    }
    if (this.warnings.length) out.push('### Warnings', ...this.warnings.map((w) => `- ${w}`), '');
    if (this.notes.length) out.push('<details><summary>Log</summary>', '', ...this.notes.map((n) => `- ${n}`), '', '</details>');
    return out.join('\n');
  }
}

/* ─────────────────────────── GitHub ────────────────────────────────── */

function github({ fetch, token, user }) {
  const headers = (raw) => ({
    'User-Agent': `${user}-site-sync`,
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function rest(path, { raw = false } = {}) {
    const res = await fetch(`https://api.github.com${path}`, { headers: headers(raw), signal: AbortSignal.timeout(20000) });
    if (res.status === 404 || res.status === 409) return null; // 409: empty repository
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
    return raw ? res.text() : res.json();
  }

  async function graphql(query, variables) {
    if (!token) throw new Error('no token');
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers(false), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors[0].message}`);
    return body.data;
  }

  return { rest, graphql };
}

async function fetchRepos(gh, user, hidden) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh.rest(`/users/${user}/repos?per_page=100&page=${page}&sort=pushed`);
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out
    .filter((r) => !r.fork && !r.private && !hidden.has(r.name))
    .map((r) => ({
      name: r.name,
      url: r.html_url,
      homepage: r.homepage || null,
      description: r.description || null,
      language: r.language || null,
      stars: r.stargazers_count,
      topics: r.topics || [],
      archived: r.archived,
      branch: r.default_branch || 'main',
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
    }));
}

/** Strip a README down to prose: no badges, no HTML, no images, no link targets. */
export function readmeText(md) {
  return String(md || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SKIP_PATH = /(^|\/)(\.git|node_modules|dist|build|out|vendor|__pycache__|\.venv|venv|third_party|\.idea|\.vscode)(\/|$)|\.(png|jpe?g|gif|svg|ico|webp|pdf|mp4|mov|zip|gz|tar|bin|onnx|pt|pth|ckpt|h5|pkl|npy|npz|parquet|csv|lock|woff2?|ttf|otf|exe|dll|so|dylib)$/i;
const KEY_FILES = [
  /^package\.json$/, /^pyproject\.toml$/, /^requirements\.txt$/, /^Cargo\.toml$/, /^go\.mod$/,
  /^CMakeLists\.txt$/, /^setup\.py$/, /^(src\/)?main\.\w+$/, /^(src\/)?app\.\w+$/, /^index\.html$/,
];

/**
 * What the model is allowed to know about a repo. The guard checks the
 * model's answer against exactly this text, so anything not in here can't
 * end up on the page.
 */
async function repoContext(gh, user, repo) {
  const readme = readmeText(await gh.rest(`/repos/${user}/${repo.name}/readme`, { raw: true }).catch(() => null));
  const parts = [
    `Repository: ${repo.name}`,
    repo.description && `GitHub description: ${repo.description}`,
    repo.topics.length && `Topics: ${repo.topics.join(', ')}`,
    repo.language && `Primary language: ${repo.language}`,
    readme && `README:\n${readme.slice(0, 3500)}`,
  ];

  // A README of a title and nothing else says nothing; look at the code.
  if (readme.length < 400) {
    const tree = await gh.rest(`/repos/${user}/${repo.name}/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`).catch(() => null);
    const files = (tree?.tree || [])
      .filter((t) => t.type === 'blob' && !SKIP_PATH.test(t.path))
      .map((t) => t.path)
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (files.length) parts.push(`Files:\n${files.slice(0, 60).join('\n')}`);
    const picks = KEY_FILES.flatMap((re) => files.filter((f) => re.test(f))).slice(0, 3);
    for (const f of picks) {
      const body = await gh.rest(`/repos/${user}/${repo.name}/contents/${f.split('/').map(encodeURIComponent).join('/')}`, { raw: true }).catch(() => null);
      if (body) parts.push(`--- ${f} ---\n${body.slice(0, 1500)}`);
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

/* ─────────────────────────── Groq ──────────────────────────────────── */

export class Groq {
  constructor({ key, model, budget, fetch, sleep, report }) {
    Object.assign(this, { key, model, budget, fetch, sleep, report });
    this.calls = 0;
    this.tokens = 0;
    this.waited = 0;
    this.fatal = null;
  }

  get available() { return Boolean(this.key) && !this.fatal && this.calls < this.budget; }

  /** One structured call. Returns the parsed object, or throws. */
  async json(name, system, user, schema, { maxTokens = 1500 } = {}) {
    if (!this.available) throw new Error('llm unavailable');
    this.calls++;

    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this.fetch(GROQ_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_completion_tokens: maxTokens,
          reasoning_effort: 'low',
          include_reasoning: false,
          response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (res.status === 429) {
        const wait = retryAfter(res.headers);
        this.waited += wait;
        this.report.note(`rate limited, waiting ${(wait / 1000).toFixed(1)}s`);
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        await this.sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let err = {};
        try { err = JSON.parse(body).error || {}; } catch { /* not json */ }
        // The model produced something that didn't match the schema: that's a
        // bad answer, not a broken setup.
        if (err.code === 'json_validate_failed') throw new Error('model output did not match the schema');
        if (res.status === 401 || res.status === 403 || res.status === 404 ||
            /model|decommission|api key|invalid_api_key/i.test(`${err.code} ${err.message}`)) {
          this.fatal = `Groq ${res.status}: ${err.message || body.slice(0, 200)} (model "${this.model}"). ` +
            'Check the GROQ_API_KEY secret and https://console.groq.com/docs/models.';
          this.report.error(this.fatal);
        }
        throw new Error(`Groq ${res.status}: ${err.message || body.slice(0, 160)}`);
      }

      const data = await res.json();
      this.tokens += data.usage?.total_tokens || 0;
      await this.pace(res.headers);

      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      if (!content.trim()) throw new Error(`empty answer (finish_reason: ${choice?.finish_reason || 'unknown'})`);
      try {
        return JSON.parse(content);
      } catch {
        throw new Error('answer was not valid JSON');
      }
    }
    throw new Error('gave up after repeated rate limits');
  }

  /** Stay under the tokens-per-minute limit instead of hitting it. */
  async pace(headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining-tokens'));
    if (Number.isFinite(remaining) && remaining < 3000) {
      const wait = Math.min(65000, parseDuration(headers.get('x-ratelimit-reset-tokens')) + 250);
      this.waited += wait;
      await this.sleep(wait);
    }
  }
}

/** "7.66s", "1m2.5s", "250ms" -> milliseconds. */
export function parseDuration(s) {
  if (!s) return 0;
  let ms = 0;
  for (const [, n, unit] of String(s).matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  }
  return ms;
}

function retryAfter(headers) {
  const s = Number(headers.get('retry-after'));
  const fromHeader = Number.isFinite(s) && s > 0 ? s * 1000 : parseDuration(headers.get('x-ratelimit-reset-tokens'));
  return Math.min(65000, Math.max(1000, fromHeader || 10000));
}

/* ─────────────────────────── descriptions ──────────────────────────── */

const DESC_SYSTEM = `You write the one-line description shown under a repository on a software engineer's portfolio, and choose which group it belongs in.

Rules, all mandatory:
- Use ONLY facts in the material you are given. If the README is thin, describe what the files and code show it is, and nothing more.
- Never state a number, version, percentage or measurement unless that exact figure appears in the material. Write figures as digits, never as words.
- No marketing language and no superlatives: not "state-of-the-art", "production-ready", "robust", "powerful", "seamless", "cutting-edge", "best", "fastest".
- Third person, present tense. Never "I", "we", "our" or "my".
- Lead with what it is ("A real-time …", "An event-driven backtester that …"), then what is technically interesting about it. Name the core technique or stack when the material states it.
- One sentence, 60 to 200 characters, plain text: no markdown, no links, no quotes. Do not start with the repository name.
- Describe the project, never the repository ("a repository for…", "contains only a README"). If the material is too thin to say what the project does, return an empty string as the summary.
- group: the single best id from the allowed list.`;

function descSchema(groupIds) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      group: { type: 'string', enum: [...groupIds, 'other'] },
    },
    required: ['summary', 'group'],
    additionalProperties: false,
  };
}

async function describeRepos({ repos, prev, config, gh, llm, report, force }) {
  const prevBy = new Map((prev?.repos || []).map((r) => [r.name, r]));
  const featured = new Set(config.featured || []);
  const groupIds = (config.groups || []).map((g) => g.id);
  const stats = { generated: 0, cached: 0, rejected: 0, failed: 0, skipped: 0 };

  for (const repo of repos) {
    const old = prevBy.get(repo.name);
    const override = config.descriptions?.[repo.name];
    const assigned = config.assign?.[repo.name];

    // Carry everything over by default; only overwrite what this run improves.
    Object.assign(repo, {
      summary: old?.summary ?? null,
      summarySource: old?.summarySource ?? null,
      group: assigned ?? old?.group ?? null,
      contextHash: old?.contextHash ?? null,
      genStatus: old?.genStatus ?? 'pending',
      genAttempts: old?.genAttempts ?? 0,
    });
    if (repo.summarySource === 'groq' && repo.summary) repo.summary = sentence(repo.summary);

    if (override) {
      Object.assign(repo, { summary: override, summarySource: 'manual', genStatus: 'ok' });
    } else if (repo.summarySource === 'groq' && !validateSummary(repo.summary, repo.summary).ok) {
      // The guard has learned something since this was accepted: write it again.
      Object.assign(repo, { summary: repo.description, summarySource: 'github', genStatus: 'pending', genAttempts: 0, contextHash: null });
    } else if (repo.summarySource === 'manual') {
      // The override was removed from content/projects.json: start over.
      Object.assign(repo, { summary: repo.description, summarySource: 'github', genStatus: 'pending', genAttempts: 0 });
    }

    // Featured repos have hand-written copy on the page; don't spend budget on them.
    if (featured.has(repo.name)) {
      if (!repo.summary) Object.assign(repo, { summary: repo.description, summarySource: 'github' });
      stats.skipped++;
      continue;
    }
    if (override && repo.group) continue;

    const untouched = old && old.pushedAt === repo.pushedAt && repo.contextHash !== null && !force;
    if (untouched && repo.genStatus === 'ok' && repo.group) { stats.cached++; continue; }
    if (untouched && !llm.available) { stats.skipped++; continue; } // nothing new to read, nobody to write it

    let context;
    try {
      context = await repoContext(gh, config.user, repo);
    } catch (err) {
      report.warn(`could not read ${repo.name}: ${err.message}`);
      continue;
    }
    const h = hash(context);

    if (!force && old?.contextHash === h) {
      if (repo.genStatus === 'ok') { stats.cached++; continue; }
      if (repo.genAttempts >= 3) { stats.skipped++; continue; } // same README failed 3 times; wait for it to change
    }
    if (h !== repo.contextHash) repo.genAttempts = 0;
    repo.contextHash = h;

    if (context.length < 60) {
      if (!repo.summary) Object.assign(repo, { summary: repo.description, summarySource: 'github' });
      continue;
    }
    // Leave a few calls for the activity feed, which sits higher on the page.
    if (!llm.available || llm.calls >= llm.budget - 6) {
      if (!repo.summary && repo.description) Object.assign(repo, { summary: repo.description, summarySource: 'github' });
      continue;
    }

    try {
      const out = await llm.json('repo_summary', DESC_SYSTEM,
        `Allowed group ids: ${[...groupIds, 'other'].join(', ')}\n\n${context}`, descSchema(groupIds));
      const verdict = validateSummary(out.summary, context);
      if (!assigned) repo.group = groupIds.includes(out.group) ? out.group : 'other';
      if (override) continue;
      if (verdict.ok) {
        Object.assign(repo, { summary: sentence(verdict.text), summarySource: 'groq', genStatus: 'ok', genAttempts: 0 });
        stats.generated++;
      } else {
        report.reject(repo.name, verdict.reason, out.summary);
        Object.assign(repo, { genStatus: 'rejected', genAttempts: repo.genAttempts + 1 });
        if (!repo.summary && repo.description) Object.assign(repo, { summary: repo.description, summarySource: 'github' });
        stats.rejected++;
      }
    } catch (err) {
      report.warn(`description for ${repo.name} failed: ${err.message}`);
      Object.assign(repo, { genStatus: 'error', genAttempts: repo.genAttempts + 1 });
      if (!repo.summary && repo.description) Object.assign(repo, { summary: repo.description, summarySource: 'github' });
      stats.failed++;
    }
  }

  report.note(`descriptions: ${stats.generated} generated, ${stats.cached} cached, ` +
    `${stats.rejected} rejected, ${stats.failed} failed, ${stats.skipped} skipped`);
  return stats;
}

/* ─────────────────────────── activity feed ─────────────────────────── */

const UPDATE_SYSTEM = `You write one line for the activity feed on a software engineer's portfolio, summarising recent commits to one repository.

Rules, all mandatory:
- Use ONLY what the commit messages and the repository description say. Invent nothing.
- Describe the outcome: what now exists or works that didn't before. Prefer one concrete noun phrase ("a headless Monte Carlo evaluation CLI") over a list of modules. Mention at most 3 things.
- Never state a number unless that exact figure appears in the commits. No marketing language, no superlatives.
- Past tense, third person, no "I" or "we". Do not start with the repository name.
- One sentence, 40 to 160 characters, plain text.`;

const UPDATE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const TRIVIAL = [
  /^merge\b/i, /^(bump|chore\(deps\)|dependabot)/i, /\[(bot|skip ci)\]/i, /^chore: sync\b/i,
  /^(update|create|delete|rename|add) [\w./-]+$/i, /^add files via upload$/i, /^initial commit$/i, /^wip$/i,
];

async function recentCommits(gh, user, repo, sinceIso) {
  const commits = await gh.rest(`/repos/${user}/${repo.name}/commits?since=${sinceIso}&per_page=50`).catch(() => null);
  if (!Array.isArray(commits)) return [];
  return commits
    .filter((c) => c.author?.type !== 'Bot')
    .map((c) => ({ date: c.commit?.author?.date, message: (c.commit?.message || '').split('\n')[0].trim() }))
    .filter((c) => c.message.length >= 8 && !TRIVIAL.some((re) => re.test(c.message)));
}

function isoWeek(iso) {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function buildUpdates({ repos, prev, config, gh, llm, report, now, force }) {
  const entries = new Map((prev?.updates || []).map((u) => [u.key, u]));
  const known = new Map(repos.map((r) => [r.name, r]));

  // Newly started projects.
  for (const r of repos) {
    if (daysSince(r.createdAt, now) > 45) continue;
    const what = r.summary || r.description;
    entries.set(`new:${r.name}`, {
      key: `new:${r.name}`, kind: 'new', repo: r.name, date: day(r.createdAt),
      text: what ? `Started ${r.name}: ${lcfirst(sentence(what))}` : `Started ${r.name}.`,
    });
  }

  const recent = repos.filter((r) => daysSince(r.pushedAt, now) <= 21);

  // Releases.
  for (const r of recent) {
    const releases = await gh.rest(`/repos/${config.user}/${r.name}/releases?per_page=5`).catch(() => null);
    for (const rel of releases || []) {
      if (rel.draft || !rel.published_at || daysSince(rel.published_at, now) > 120) continue;
      const key = `release:${r.name}:${rel.tag_name}`;
      const title = rel.name && rel.name !== rel.tag_name && rel.name.length <= 60 ? ` (${clean(rel.name)})` : '';
      entries.set(key, {
        key, kind: 'release', repo: r.name, date: day(rel.published_at),
        text: `Released ${rel.tag_name}${title}${rel.prerelease ? ' as a pre-release' : ''}.`,
      });
    }
  }

  // Commit activity, one line per repo per ISO week. "quiet" repos (e.g. one
  // that gets an automatic commit per solved LeetCode problem) are left out.
  const quiet = new Set(config.quiet || []);
  for (const [key, u] of entries) if (u.kind === 'activity' && quiet.has(u.repo)) entries.delete(key);
  const since = new Date(now - 14 * 86400000).toISOString();
  let generated = 0;
  for (const r of recent) {
    if (quiet.has(r.name)) continue;
    const commits = await recentCommits(gh, config.user, r, since);
    if (!commits.length) continue;
    const latest = commits[0].date;
    const key = `activity:${r.name}:${isoWeek(latest)}`;
    const inWeek = commits.filter((c) => isoWeek(c.date) === isoWeek(latest));
    const source = `Repository description: ${r.summary || r.description || '(none)'}\n\nCommit messages, newest first:\n` +
      inWeek.map((c) => `- ${c.message}`).join('\n');
    const sourceHash = hash(source);
    const existing = entries.get(key);
    // Unchanged commits: keep the line, unless it was only a quoted commit
    // and the model is now available to write a proper one.
    const upgradable = existing?.by === 'commit' && llm.available && inWeek.length >= 2;
    if (existing?.sourceHash === sourceHash && !force && !upgradable) continue;

    let text = null;
    let by = 'model';
    if (llm.available && inWeek.length >= 2) {
      try {
        const out = await llm.json('update_line', UPDATE_SYSTEM, source, UPDATE_SCHEMA, { maxTokens: 1000 });
        const verdict = validateUpdate(out.text, source);
        if (verdict.ok) { text = sentence(verdict.text); generated++; }
        else report.reject(`update for ${r.name}`, verdict.reason, out.text);
      } catch (err) {
        report.warn(`update for ${r.name} failed: ${err.message}`);
      }
    }
    // No model, or it failed: quote the most descriptive commit verbatim. It's
    // less polished but it is exactly what happened.
    if (!text && existing?.by !== 'model') {
      const best = [...inWeek].sort((a, b) => b.message.length - a.message.length)[0];
      text = sentence(best.message.replace(/^(\w+)(\(.+?\))?!?:\s*/, ''));
      by = 'commit';
    }
    if (text) entries.set(key, { key, kind: 'activity', repo: r.name, date: day(latest), text, by, sourceHash });
  }

  const kindOrder = (u) => (u.kind === 'release' ? 0 : u.kind === 'new' ? 1 : 2);
  const updates = [...entries.values()]
    .filter((u) => !u.repo || known.has(u.repo))
    .filter((u) => daysSince(u.date, now) <= 120)
    .sort((a, b) => b.date.localeCompare(a.date) || kindOrder(a) - kindOrder(b) || a.key.localeCompare(b.key))
    .slice(0, 8);

  report.note(`updates: ${updates.length} in feed, ${generated} newly written`);
  return updates;
}

/* ─────────────────────────── stats ─────────────────────────────────── */

const STATS_QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
    repositories(ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, first: 100) {
      nodes { name languages(first: 20, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } } }
    }
  }
}`;

async function fetchStats({ prev, gh, fetch, config, hidden, report }) {
  const stats = { ...(prev || {}) };

  try {
    const data = await gh.graphql(STATS_QUERY, { login: config.user });
    const cal = data.user.contributionsCollection.contributionCalendar;
    const days = cal.weeks.flatMap((w) => w.contributionDays);
    stats.contributions = {
      total: cal.totalContributions,
      start: days[0]?.date,
      counts: days.map((d) => d.contributionCount),
    };

    const bytes = new Map();
    for (const repo of data.user.repositories.nodes) {
      if (hidden.has(repo.name)) continue;
      for (const e of repo.languages.edges) {
        if (NOT_CODE.has(e.node.name)) continue;
        bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size);
      }
    }
    const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7).map(([name, b]) => ({ name, bytes: b }));
    const rest = sorted.slice(7).reduce((n, [, b]) => n + b, 0);
    if (rest > 0) top.push({ name: 'other', bytes: rest });
    stats.languages = top;
  } catch (err) {
    report.warn(`heatmap and languages kept from last run: ${err.message}`);
  }

  try {
    const res = await fetch(`https://user-badge.committers.top/malaysia/${config.user}.svg`, { signal: AbortSignal.timeout(15000) });
    const svg = res.ok ? await res.text() : '';
    const m = svg.match(/Malaysia #(\d+)/);
    if (m) stats.rank = { country: 'Malaysia', rank: Number(m[1]) };
    else report.warn('committers.top rank not found; kept the last one');
  } catch (err) {
    report.warn(`committers.top unreachable: ${err.message}`);
  }

  try {
    const res = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        query: 'query($u:String!){matchedUser(username:$u){submitStatsGlobal{acSubmissionNum{difficulty count}}}}',
        variables: { u: config.leetcode || 'iamzishaan' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = res.ok ? await res.json() : null;
    const nums = body?.data?.matchedUser?.submitStatsGlobal?.acSubmissionNum;
    if (nums?.length) {
      const get = (d) => nums.find((x) => x.difficulty === d)?.count ?? 0;
      stats.leetcode = { solved: get('All'), easy: get('Easy'), medium: get('Medium'), hard: get('Hard') };
    } else {
      report.warn('LeetCode stats unavailable; kept the last ones');
    }
  } catch (err) {
    report.warn(`LeetCode unreachable: ${err.message}`);
  }

  return stats;
}

/* ─────────────────────────── write ─────────────────────────────────── */

const readJson = async (p) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
};

/** Fixed key order, so identical data always serialises identically. */
function canonicalRepo(r) {
  return {
    name: r.name, url: r.url, homepage: r.homepage ?? null, description: r.description ?? null,
    summary: r.summary ?? null, summarySource: r.summarySource ?? null, group: r.group ?? null,
    language: r.language ?? null, stars: r.stars ?? 0, topics: r.topics ?? [], archived: Boolean(r.archived),
    pushedAt: r.pushedAt, createdAt: r.createdAt, contextHash: r.contextHash ?? null,
    genStatus: r.genStatus ?? null, genAttempts: r.genAttempts ?? 0,
  };
}

async function writeIfChanged(path, text) {
  let before = null;
  try { before = await readFile(path, 'utf8'); } catch { /* new file */ }
  if (before === text) return false;
  await writeFile(path, text);
  return true;
}

export function renderPage(html, { repos, updates, stats, config }) {
  const featured = new Set(config.featured || []);
  const listed = repos.filter((r) => !featured.has(r.name));
  const set = (name, value) => { if (value !== undefined && value !== null && value !== '') html = replaceBlock(html, name, value); };

  set('rank', stats?.rank?.rank != null ? String(stats.rank.rank) : null);
  set('contrib', stats?.contributions?.total != null ? fmt(stats.contributions.total) : null);
  set('lc-solved', stats?.leetcode?.solved ? fmt(stats.leetcode.solved) : null);
  set('lc-hard', stats?.leetcode?.hard ? fmt(stats.leetcode.hard) : null);
  set('heatmap', stats?.contributions ? renderHeatmap(stats.contributions) : null);
  set('langs', stats?.languages?.length ? renderLangs(stats.languages) : null);
  set('repo-count', String(repos.length));
  set('stars', String(repos.reduce((n, r) => n + (r.stars || 0), 0)));
  set('updates', renderUpdates(updates, (name) => repos.find((r) => r.name === name)?.url || `https://github.com/${config.user}/${name}`));
  set('repos', renderRepos(listed, config.groups || []));
  return html;
}

/* ─────────────────────────── main ──────────────────────────────────── */

export async function run({
  root = DEFAULT_ROOT,
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now(),
  log = console,
} = {}) {
  const p = (...parts) => resolve(root, ...parts);
  const report = new Report(log);
  const config = JSON.parse(await readFile(p('content/projects.json'), 'utf8'));
  const hidden = new Set(config.hide || []);
  const force = env.SYNC_FORCE === 'true';

  const gh = github({ fetch, token: env.GITHUB_TOKEN || env.GH_TOKEN, user: config.user });
  const llm = new Groq({
    key: env.GROQ_API_KEY,
    model: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    budget: Number(env.SYNC_BUDGET) || 24,
    fetch, sleep, report,
  });

  await mkdir(p('data'), { recursive: true });
  const prevRepos = await readJson(p('data/repos.json'));
  const prevUpdates = await readJson(p('data/updates.json'));
  const prevStats = await readJson(p('data/stats.json'));

  log.log(`Syncing github.com/${config.user}${force ? ' (forced)' : ''}`);
  if (!env.GROQ_API_KEY) report.note('GROQ_API_KEY not set: nothing will be generated, existing text is kept');

  let repos;
  try {
    repos = await fetchRepos(gh, config.user, hidden);
    report.note(`${repos.length} public repos`);
  } catch (err) {
    report.error(`GitHub fetch failed: ${err.message}`);
    if (!prevRepos) return { code: 1, report };
    repos = prevRepos.repos;
  }
  repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));

  await describeRepos({ repos, prev: prevRepos, config, gh, llm, report, force });
  const updates = await buildUpdates({ repos, prev: prevUpdates, config, gh, llm, report, now, force });
  const stats = await fetchStats({ prev: prevStats, gh, fetch, config, hidden, report });

  const reposDoc = { user: config.user, repos: repos.map(canonicalRepo) };
  const updatesDoc = {
    updates: updates.map(({ key, kind, repo, date, text, by, sourceHash }) =>
      ({ key, kind, repo, date, text, by: by ?? null, sourceHash: sourceHash ?? null })),
  };
  const changed = [];
  if (await writeIfChanged(p('data/repos.json'), `${JSON.stringify(reposDoc, null, 2)}\n`)) changed.push('repos');
  if (await writeIfChanged(p('data/updates.json'), `${JSON.stringify(updatesDoc, null, 2)}\n`)) changed.push('activity');
  if (await writeIfChanged(p('data/stats.json'), `${JSON.stringify(stats)}\n`)) changed.push('stats');

  // Render with the old timestamp first; only restamp if the page really changed.
  const before = await readFile(p('index.html'), 'utf8');
  let html = renderPage(before, { repos, updates, stats, config });
  if (html !== before) {
    const stamp = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    html = replaceBlock(html, 'synced', `<time datetime="${stamp}">${stamp.slice(0, 10)}</time>`);
    await writeFile(p('index.html'), html);
    changed.push('page');
    try {
      const sitemap = await readFile(p('sitemap.xml'), 'utf8');
      await writeFile(p('sitemap.xml'), sitemap.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${stamp.slice(0, 10)}</lastmod>`));
    } catch { /* no sitemap */ }
  }

  const summaryLines = [
    `- repos: **${repos.length}** public, ${repos.filter((r) => r.summarySource === 'groq').length} with generated descriptions`,
    `- activity feed: **${updates.length}** entries`,
    `- Groq: ${llm.calls} call(s), ${fmt(llm.tokens)} tokens, ${(llm.waited / 1000).toFixed(0)}s waiting on rate limits${env.GROQ_API_KEY ? '' : ' (no key set)'}`,
    `- changed: ${changed.length ? changed.join(', ') : 'nothing'}`,
  ];
  log.log(summaryLines.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${report.markdown(summaryLines)}\n`);
  if (env.GITHUB_OUTPUT) {
    const parts = [...new Set(changed.filter((c) => c !== 'page'))];
    const message = `chore(sync): ${parts.length ? parts.join(', ') : 'page'}`;
    await appendFile(env.GITHUB_OUTPUT, `changed=${changed.length > 0}\nmessage=${message}\n`);
  }

  // A broken key or a retired model is the one failure worth an email.
  return { code: llm.fatal ? 2 : 0, report, changed, repos, updates, stats, llm };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then(({ code }) => { process.exitCode = code; }).catch((err) => {
    console.error(`sync failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
