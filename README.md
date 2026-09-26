# zishaan1911.github.io

My personal site: **https://zishaan1911.github.io**

Hand-written HTML and CSS in a terminal style. There's no framework or build step. A small
bot keeps the live parts current: the activity feed, the repo list, the contribution
heatmap and the ranking numbers.

```
index.html               the page; every word is in the HTML, so crawlers and no-JS visitors see it all
assets/css/site.css      one stylesheet, four themes (phosphor, amber, ice, paper)
assets/js/site.js        theme switcher, section nav, typing effect, the tiny shell
assets/fonts/            JetBrains Mono, self-hosted and subset (see below)
content/projects.json    what the bot should feature, hide, group and describe by hand
data/*.json              the bot's state: repos, activity feed, stats
scripts/sync.mjs         the bot
scripts/guard.mjs        what stops the bot from making things up
scripts/render.mjs       data → HTML, spliced into index.html between markers
scripts/og.html          source for the social preview image
```

## Editing

- **Hand-written sections** (hero, selected work, research, experience, stack, certs) are
  plain HTML in `index.html`. Edit them directly.
- **Generated regions** sit between `<!-- sync:NAME -->` and `<!-- /sync:NAME -->`
  markers. The bot overwrites whatever is between them, so don't edit inside them.
  `npm test` fails if a marker goes missing.
- **Which repos go where** is set in `content/projects.json`:
  - `featured`: shown as hand-written cards, so left out of the list below them.
  - `hide`: never shown.
  - `quiet`: listed, but kept out of the activity feed (e.g. auto-committed LeetCode solutions).
  - `groups` and `assign`: the "everything else" sections. A repo not listed in `assign`
    is placed by the model.
  - `descriptions`: a hand-written description always beats a generated one.

Pushing a change to `content/` or `scripts/` re-runs the bot straight away.

## The sync bot

`.github/workflows/sync.yml` runs `scripts/sync.mjs` twice a day. It:

1. lists every public repo and writes a one-line description for each one that needs it.
   For a repo whose README says almost nothing, it reads the file tree and manifests instead;
2. builds the activity feed from new repos, releases, and one line per repo per week of commits;
3. pulls the contribution calendar and language breakdown (GitHub GraphQL), the committers.top
   Malaysia rank, and LeetCode solved counts;
4. renders all of that into `index.html`, and commits only if the page actually changed.

Groq (`openai/gpt-oss-20b`) writes the prose. Nothing it writes is trusted.
`scripts/guard.mjs` checks every line against the exact text it was generated from and
rejects it if it:

- states a figure that isn't in the source, in digits *or* in words ("three", "doubled", "thousands")
- uses hype ("state-of-the-art", superlatives), or an embellishment like "robust" that the source never uses
- is in the first person, reads like model chatter, contains a link, or is the wrong length

A rejected line falls back to the repo's own GitHub description, or for the feed to
the most descriptive commit message quoted verbatim. Every rejection is listed, with
the reason and the rejected text, in the run's job summary.

### Setup

1. Add a repository secret `GROQ_API_KEY` (https://console.groq.com/keys). Without it
   everything else still syncs, and feed lines are quoted commit messages.
2. That's it: `GITHUB_TOKEN` is provided by Actions. To regenerate everything, run the
   workflow manually with **force** ticked.

### What was wrong with the previous version

- **Blank descriptions.** `gpt-oss-20b` is a reasoning model, and its hidden reasoning
  counts against `max_completion_tokens`. The old budget of 200 was used up before any
  answer came out, so 8 of 18 repos got an empty string. Now: `reasoning_effort: "low"`,
  `include_reasoning: false`, a 1,500-token budget and strict JSON output.
- **A feed stuck since 15 September.** Groq's free tier allows 8K tokens a minute. The
  old bot sent a request per repo 700ms apart, hit the limit, and the feed request failed
  every run. Now every call honours `retry-after` and the rate-limit headers, and a few
  calls are held back for the feed.
- **Failures cached as successes.** A rejected description was stored against the
  README's hash, so it was never retried. Now a failure is retried up to 3 times per
  README version.
- **A commit every run.** The site's own repo was in the list, so the bot's push
  changed the data it read on the next run: 37 commits in 18 days, many of them a
  two-line timestamp change. The site repo is now hidden, nothing relative
  ("3 days ago") is rendered into the HTML, and the timestamp only moves when
  something else did.
- **Silent failure.** Everything was a `console.warn` in a green run. Now rejections and
  waits go to the job summary, and a bad key or retired model fails the job, so GitHub
  emails me.

## Running locally

It's static, but the shell and fonts want HTTP rather than `file://`:

```bash
python -m http.server 8000
```

```bash
npm test
```

```bash
GITHUB_TOKEN=$(gh auth token) npm run sync
```

`npm test` runs the guard, the renderer, and the whole bot against a fake GitHub and a
fake Groq, including the rate-limit, empty-answer and dead-key cases. CI runs it before
every sync, and generates nothing if it fails.

## Search

`index.html` carries a canonical URL, Open Graph and Twitter tags, and JSON-LD for a
`ProfilePage`, a `Person` (with `sameAs` links to GitHub, LinkedIn, LeetCode and
Hugging Face) and both papers as `ScholarlyArticle`s. `sitemap.xml` is kept current by
the bot, and `robots.txt` points at it.

## Credits

- Font: [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), SIL Open Font
  License (`assets/fonts/OFL.txt`). It's self-hosted because the Google Fonts build
  leaves out box drawing and block characters, and the fallback font's different width
  breaks every diagram.
- Name banner: FIGlet's *ANSI Shadow* font.

Until September 2026 this repository was a fork of
[richardapps-web](https://github.com/Richard-Apps/richardapps-web) (GPLv3) by Richard-Apps.
The current site is a from-scratch rewrite and contains none of that code. The earlier
history is still in `git log`.
