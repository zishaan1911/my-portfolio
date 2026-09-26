/**
 * Turns the synced data into HTML and splices it into index.html.
 *
 * Everything here is a pure function of its input, and nothing renders a
 * relative time ("3 days ago") or the current date except the one `synced`
 * stamp, so re-running the sync on unchanged data produces a byte-identical
 * page and no commit.
 *
 * Generated regions in index.html are delimited like this, and a marker may
 * appear more than once (every copy is replaced):
 *
 *   <!-- sync:NAME -->…<!-- /sync:NAME -->
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 1388 -> "1,388", independent of the machine's locale. */
export const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "2026-09-14..." -> "Sep 2026" */
export const monthYear = (iso) => {
  const [y, m] = String(iso || '').split('-');
  return y && m ? `${MONTHS[Number(m) - 1]} ${y}` : '';
};

export function replaceBlock(html, name, content) {
  const re = new RegExp(`(<!-- sync:${name} -->)[\\s\\S]*?(<!-- /sync:${name} -->)`, 'g');
  if (!re.test(html)) throw new Error(`index.html has no <!-- sync:${name} --> marker`);
  return html.replace(re, (_, open, close) => `${open}${content}${close}`);
}

/* ─── contribution heatmap ─────────────────────────────────────────── */

// Two characters per week: a monospace cell is 0.6em wide and 1.32em tall,
// so a pair comes out close to square.
const SHADES = ['··', '░░', '▒▒', '▓▓', '██'];
const CELL = 2;

/**
 * @param {{start: string, counts: number[]}} cal  counts[i] is the day start+i;
 *        start is always a Sunday, as GitHub's calendar is.
 */
export function renderHeatmap(cal) {
  if (!cal?.counts?.length || !cal.start) return '';
  const { counts } = cal;
  const start = new Date(`${cal.start}T00:00:00Z`);
  const weeks = Math.ceil(counts.length / 7);

  // Quartiles of the non-zero days, the same idea GitHub uses for its greens.
  const nz = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (c) => (c <= 0 ? 0 : c <= cuts[0] ? 1 : c <= cuts[1] ? 2 : c <= cuts[2] ? 3 : 4);

  // Month labels over the first week that starts in a new month.
  const top = Array(weeks * CELL).fill(' ');
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const d = new Date(start.getTime() + w * 7 * 86400000);
    const m = d.getUTCMonth();
    if (m !== lastMonth) {
      const label = MONTHS[m];
      const at = w * CELL;
      if (at + label.length <= top.length && top.slice(at, at + label.length + 1).every((c) => c === ' ')) {
        for (let i = 0; i < label.length; i++) top[at + i] = label[i];
      }
      lastMonth = m;
    }
  }

  const DAYS = ['    ', 'Mon ', '    ', 'Wed ', '    ', 'Fri ', '    '];
  const rows = [`    ${top.join('').trimEnd()}`];
  for (let d = 0; d < 7; d++) {
    let row = DAYS[d];
    let run = null;
    let buf = '';
    const flush = () => {
      if (buf) row += `<span class="l${run}">${buf}</span>`;
      buf = '';
    };
    for (let w = 0; w < weeks; w++) {
      const i = w * 7 + d;
      if (i >= counts.length) break;
      const l = level(counts[i]);
      if (l !== run) { flush(); run = l; }
      buf += SHADES[l];
    }
    flush();
    rows.push(row);
  }
  rows.push('');
  rows.push(`    less ${SHADES.map((s, i) => `<span class="l${i}">${s}</span>`).join(' ')} more`);

  const active = counts.filter((c) => c > 0).length;
  const label = `Contribution heatmap: ${fmt(sum(counts))} contributions over ${weeks} weeks, active on ${active} days.`;
  return (
    `<pre class="heatmap" role="img" aria-label="${esc(label)}">${rows.join('\n')}</pre>` +
    `<p class="heat-total"><b>${fmt(cal.total ?? sum(counts))}</b> contributions in the last year · ` +
    `active <b>${active}</b> days · longest streak <b>${longestStreak(counts)}</b> days</p>`
  );
}

const sum = (a) => a.reduce((n, x) => n + x, 0);

export function longestStreak(counts) {
  let best = 0;
  let cur = 0;
  for (const c of counts) {
    cur = c > 0 ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

/* ─── languages ────────────────────────────────────────────────────── */

export function renderLangs(langs, width = 28) {
  if (!langs?.length) return '';
  const total = sum(langs.map((l) => l.bytes)) || 1;
  const rows = langs.map((l) => {
    const pct = (100 * l.bytes) / total;
    const filled = Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * width));
    return (
      `<li><span>${esc(l.name)}</span>` +
      `<span class="bar" aria-hidden="true">${'█'.repeat(filled)}<i>${'░'.repeat(width - filled)}</i></span>` +
      `<span class="pct">${pct.toFixed(1)}%</span></li>`
    );
  });
  return `<ul class="langs">${rows.join('')}</ul>`;
}

/* ─── activity feed ────────────────────────────────────────────────── */

const KIND = { release: 'release', new: 'new' };

export function renderUpdates(updates, repoUrl) {
  if (!updates?.length) return '<p class="updates-empty">Nothing in the last few weeks. Check back soon.</p>';
  const items = updates.map((u) => {
    const kind = KIND[u.kind] ? `<span class="kind">${KIND[u.kind]}</span>` : '';
    const repo = u.repo
      ? `<a class="repo" href="${esc(repoUrl(u.repo))}">${esc(u.repo)}</a>`
      : '<span class="repo"></span>';
    return `<li><time datetime="${esc(u.date)}">${esc(u.date)}</time>${repo}<span>${kind}${esc(u.text)}</span></li>`;
  });
  return `<ol class="updates">${items.join('')}</ol>`;
}

/* ─── everything-else repo list ────────────────────────────────────── */

export function renderRepos(repos, groups) {
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  const other = [];
  for (const r of repos) (byGroup.get(r.group) || other).push(r);

  const blocks = [];
  for (const g of groups) {
    const members = byGroup.get(g.id);
    if (members.length) blocks.push(groupBlock(g.title, g.blurb, members));
  }
  if (other.length) blocks.push(groupBlock('other', '', other));
  return `<div class="groups">${blocks.join('')}</div>`;
}

function groupBlock(title, blurb, repos) {
  const rows = repos.map((r) => {
    const meta = [
      r.language,
      r.stars > 0 ? `★ ${r.stars}` : null,
      r.archived ? 'archived' : monthYear(r.pushedAt),
    ].filter(Boolean).join(' · ');
    const desc = r.summary || r.description;
    return (
      `<div class="repo-row"><a class="repo-name" href="${esc(r.url)}">${esc(r.name)}</a>` +
      `<span class="repo-meta">${esc(meta)}</span>` +
      (desc ? `<p class="repo-desc">${esc(desc)}</p>` : '') +
      `</div>`
    );
  });
  return (
    `<div class="box group"><h3 class="box-title">${esc(title)}</h3>` +
    (blurb ? `<p class="group-blurb">${esc(blurb)}</p>` : '') +
    rows.join('') +
    `</div>`
  );
}
