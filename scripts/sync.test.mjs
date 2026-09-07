#!/usr/bin/env node
/**
 * End-to-end test of sync.mjs against mocked GitHub and Groq responses.
 *
 * The guard is unit-tested separately; this checks it is actually *wired in* —
 * that a hallucinated figure coming back from Groq really does get discarded
 * and replaced by the GitHub description, rather than sailing into repos.json.
 *
 * Run: npm run test:sync
 */

import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

/* A harness that installs a fake fetch, then imports sync.mjs so main() runs
   against it. Groq is told to return a hallucinated 40% for one repo and a
   clean sentence for the other. */
const HARNESS = `
import { writeFile } from 'node:fs/promises';

const REPOS = [
  { name: 'RustDB', fork: false, private: false, html_url: 'https://github.com/u/RustDB',
    description: 'Database engine in Rust.', language: 'Rust', stargazers_count: 12,
    forks_count: 2, topics: ['rust'], archived: false,
    pushed_at: '2026-09-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z', homepage: null },
  { name: 'SmolGPT', fork: false, private: false, html_url: 'https://github.com/u/SmolGPT',
    description: 'Small transformer.', language: 'Python', stargazers_count: 30,
    forks_count: 4, topics: ['ml'], archived: false,
    pushed_at: '2026-08-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z', homepage: null },
  { name: 'Forked', fork: true, private: false, html_url: 'x', description: null,
    language: null, stargazers_count: 0, forks_count: 0, topics: [], archived: false,
    pushed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', homepage: null },
];

const READMES = {
  RustDB: 'RustDB is a transactional database engine written in Rust with a custom storage layer. Built by a team of 3 developers using Docker.',
  SmolGPT: 'SmolGPT is a decoder-only transformer with 51.1M parameters trained from scratch on a single GPU using PyTorch and CUDA.',
};

// One hallucination, one clean answer.
const GROQ_REPLIES = {
  RustDB: 'A transactional database engine in Rust that improved throughput by 40%.',
  SmolGPT: 'A decoder-only transformer with 51.1M parameters trained from scratch on a single GPU.',
};

const calls = { groq: 0 };

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (body, isText) => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => (isText ? body : JSON.stringify(body)),
  });

  if (u.includes('/repos?')) {
    return u.includes('page=1') ? ok(REPOS) : ok([]);
  }
  if (u.includes('/readme')) {
    const name = u.split('/repos/')[1].split('/')[1];
    return ok(READMES[name] || '', true);
  }
  if (u.includes('/commits')) {
    const name = u.split('/repos/')[1].split('/')[1];
    return ok([
      { commit: { message: 'add b-tree page splitting\\n\\ndetails', author: { date: '2026-09-01T00:00:00Z' } }, author: { type: 'User' } },
      { commit: { message: 'Merge pull request #4', author: { date: '2026-09-01T00:00:00Z' } }, author: { type: 'User' } },
      { commit: { message: 'bump deps', author: { date: '2026-09-01T00:00:00Z' } }, author: { type: 'User' } },
    ]);
  }
  if (u.includes('api.groq.com')) {
    calls.groq++;
    const body = JSON.parse(init.body);
    const prompt = body.messages[1].content;

    if (body.messages[0].content.includes('changelog')) {
      return ok({ choices: [{ message: { content: '[{"repo":"RustDB","text":"Added B-tree page splitting to the storage engine."},{"repo":"RustDB","text":"Cut latency by 90% across the board."}]' } }] });
    }
    const name = Object.keys(GROQ_REPLIES).find((n) => prompt.includes('Repository: ' + n));
    return ok({ choices: [{ message: { content: GROQ_REPLIES[name] || '' } }] });
  }
  throw new Error('unexpected fetch: ' + u);
};

await import(process.env.SYNC_PATH);
await new Promise((r) => setTimeout(r, 300));
await writeFile(process.env.CALLS_PATH, JSON.stringify(calls));
`;

const dir = await mkdtemp(join(tmpdir(), 'sync-test-'));
await mkdir(join(dir, 'src', 'data'), { recursive: true });
await mkdir(join(dir, 'scripts'), { recursive: true });

// Copy the real scripts so relative paths resolve inside the temp tree.
for (const f of ['sync.mjs', 'guard.mjs']) {
  await run('cp', [resolve(HERE, f), join(dir, 'scripts', f)]);
}
const harnessPath = join(dir, 'scripts', 'harness.mjs');
await run('bash', ['-c', `cat > ${harnessPath} << 'HEOF'\n${HARNESS}\nHEOF`]);

const callsPath = join(dir, 'calls.json');
const { stdout, stderr } = await run('node', [harnessPath], {
  env: {
    ...process.env,
    SYNC_PATH: join(dir, 'scripts', 'sync.mjs'),
    CALLS_PATH: callsPath,
    GROQ_API_KEY: 'test-key',
    GITHUB_USER: 'u',
    GITHUB_TOKEN: '',
  },
});

const log = stdout + stderr;
const repos = JSON.parse(await readFile(join(dir, 'src', 'data', 'repos.json'), 'utf8'));
const updates = JSON.parse(await readFile(join(dir, 'src', 'data', 'updates.json'), 'utf8'));

const byName = Object.fromEntries(repos.repos.map((r) => [r.name, r]));

check('forks are excluded', !byName.Forked && repos.repos.length === 2, `${repos.repos.length} repos`);

check(
  'hallucinated 40% is rejected',
  !/40%/.test(byName.RustDB.summary),
  `summary: "${byName.RustDB.summary}"`,
);
check(
  'rejected repo falls back to the GitHub description',
  byName.RustDB.summary === 'Database engine in Rust.' && byName.RustDB.summarySource === 'github',
  `source: ${byName.RustDB.summarySource}`,
);
check('guard rejection is logged', /guard rejected RustDB/.test(log));

check(
  'grounded summary is kept and marked as generated',
  /51\.1M/.test(byName.SmolGPT.summary) && byName.SmolGPT.summarySource === 'groq',
  `"${byName.SmolGPT.summary}"`,
);

check('stars are totalled', repos.totalStars === 42, String(repos.totalStars));
check('repos are sorted by most recently pushed', repos.repos[0].name === 'RustDB');

check('grounded update line kept', updates.updates.some((u) => /B-tree page splitting/.test(u.text)));
check(
  'invented "90%" update line rejected',
  !updates.updates.some((u) => /90%/.test(u.text)),
  JSON.stringify(updates.updates.map((u) => u.text)),
);
check('merge and bump commits filtered out', !/Merge pull request|bump deps/.test(JSON.stringify(updates)));

/* Second run: nothing changed, so no Groq calls and no rewrites. */
const first = JSON.parse(await readFile(callsPath, 'utf8'));
const second = await run('node', [harnessPath], {
  env: {
    ...process.env,
    SYNC_PATH: join(dir, 'scripts', 'sync.mjs'),
    CALLS_PATH: callsPath,
    GROQ_API_KEY: 'test-key',
    GITHUB_USER: 'u',
    GITHUB_TOKEN: '',
  },
});
const secondLog = second.stdout + second.stderr;

check('README cache prevents repeat description calls', /2 cached/.test(secondLog), secondLog.match(/descriptions:.*/)?.[0] || '');
check('unchanged data produces no rewrite', /repos.json unchanged/.test(secondLog));

await rm(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} failing check(s)` : '\nAll sync checks passed.');
process.exit(failures ? 1 : 0);
