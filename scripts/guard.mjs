/**
 * Guards on LLM-written text.
 *
 * The risk with generating project descriptions automatically is not that the
 * model writes badly — it's that it writes something *plausible and false*.
 * "Improved performance" becomes "improved performance by 40%", that lands on
 * a portfolio, and then it has to be defended in an interview.
 *
 * So nothing generated is trusted. Every candidate summary is checked against
 * the source text it was derived from, and anything that fails is thrown away
 * in favour of the repo's own GitHub description.
 *
 * Known limitation, stated plainly: this catches digits, not numbers spelled
 * as words. "Three developers" would pass where "3 developers" would not.
 * The prompt asks for digits, and the banned-claim list covers the common
 * unsupported superlatives, but this is a net, not a wall.
 */

/** Anything that reads as a measurement, version, or count. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Claims a README cannot substantiate and a recruiter will ask about. */
const BANNED = [
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bworld[- ]class\b/i,
  /\bindustry[- ]leading\b/i,
  /\bcutting[- ]edge\b/i,
  /\baward[- ]winning\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\bproduction[- ]ready\b/i,
  /\benterprise[- ]grade\b/i,
  /\bblazing(?:ly)?\s+fast\b/i,
  /\b(?:most|fastest|largest|best)\b/i,
  /\bmillions? of users\b/i,
  /\brevolution(?:ary|ise|ize)/i,
  /\bseamless(?:ly)?\b/i,
];

/** Model chatter that means the generation failed rather than succeeded. */
const META = [
  /^(?:sure|certainly|here(?:'s| is)|okay|of course)\b/i,
  /\bas an ai\b/i,
  /\bi (?:cannot|can't|am unable)\b/i,
  /\bbased on the (?:readme|provided)\b/i,
  /\bthe readme (?:does not|doesn't)\b/i,
];

/** Strip markdown, code fences, links and stray quoting down to plain prose. */
export function clean(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_#>]/g, '')
    .replace(/^\s*["'“”]|["'“”]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every distinct numeric token, normalised so 1,000 and 1000 compare equal. */
export function numbersIn(text) {
  return new Set((String(text).match(NUMBER) || []).map((n) => n.replace(/,/g, '')));
}

/**
 * @returns {{ok: boolean, text: string|null, reason: string|null}}
 */
export function validateSummary(candidate, source, opts = {}) {
  const min = opts.min ?? 20;
  const max = opts.max ?? 240;

  const text = clean(candidate);

  if (!text) return fail('empty after cleaning');
  if (text.length < min) return fail(`too short (${text.length} < ${min})`);
  if (text.length > max) return fail(`too long (${text.length} > ${max})`);
  if (/https?:\/\//i.test(text)) return fail('contains a URL');

  for (const re of META) {
    if (re.test(text)) return fail('reads as model chatter, not a description');
  }
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) return fail(`unsupported claim: "${m[0]}"`);
  }

  // The core check: no figure may appear that isn't in the source material.
  const allowed = numbersIn(source);
  for (const n of numbersIn(text)) {
    if (!allowed.has(n)) return fail(`invented figure: "${n}" is not in the source`);
  }

  return { ok: true, text, reason: null };

  function fail(reason) {
    return { ok: false, text: null, reason };
  }
}

/** Same rules, applied to a single line of the updates feed. */
export function validateUpdate(candidate, source, opts = {}) {
  return validateSummary(candidate, source, { min: 12, max: 180, ...opts });
}
