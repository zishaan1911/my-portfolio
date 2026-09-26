/**
 * Guards on LLM-written text.
 *
 * The risk with generating project descriptions automatically is not that the
 * model writes badly — it's that it writes something *plausible and false*.
 * "Improved performance" becomes "improved performance by 40%", that lands on
 * a portfolio, and then it has to be defended in an interview.
 *
 * So nothing generated is trusted. Every candidate is checked against the
 * source text it was derived from, and anything that fails is thrown away.
 *
 * What is caught:
 *   - any figure (digits) that doesn't appear in the source
 *   - any number written as a word ("three", "doubled", "thousands") unless the
 *     same word, or its digits, appear in the source
 *   - hard hype ("state-of-the-art", superlatives) always
 *   - soft hype ("robust", "powerful") unless the source itself uses the word
 *   - first person, model chatter, links, and anything the wrong length
 *
 * It is still a net, not a wall: a claim with no number and no hype word
 * ("supports distributed transactions") is only as true as the prompt keeps
 * it. The workflow logs every rejection so the misses are visible.
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
  /\brevolution(?:ary|ise|ize)/i,
  /\bseamless(?:ly)?\b/i,
  /\bgame[- ]changing\b/i,
  /\bunparalleled\b/i,
];

/** Fine if the source says it; an embellishment if it doesn't. */
const SOFT = [
  'robust', 'powerful', 'sophisticated', 'innovative', 'comprehensive', 'groundbreaking',
  'advanced', 'novel', 'elegant', 'highly', 'extremely', 'incredibly', 'efficient',
  'scalable', 'next-generation', 'intelligent',
];

/** Numbers spelled out, and words that make quantitative claims. */
const WORD_NUMBERS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: null, hundreds: null, thousand: null, thousands: null, million: null,
  millions: null, billion: null, billions: null, dozen: 12, dozens: null,
  twice: null, double: null, doubled: null, triple: null, tripled: null,
  quadrupled: null, tenfold: null, halved: null,
};
const WORD_NUMBER_RE = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join('|')})\\b`, 'gi');

/** Model chatter that means the generation failed rather than succeeded. */
const META = [
  /^(?:sure|certainly|here(?:'s| is)|okay|of course)\b/i,
  /\bas an ai\b/i,
  /\bi (?:cannot|can't|am unable)\b/i,
  /\bbased on the (?:readme|provided|information|material)\b/i,
  /\bthe readme (?:does not|doesn't)\b/i,
  /\b(?:unfortunately|no information)\b/i,
  // Describes the repository instead of the project: true, and useless.
  /\b(?:repository|repo) (?:contains|for|with|that contains|is empty)\b/i,
  /\b(?:empty|placeholder) (?:readme|repository|repo)\b/i,
  /\b(?:only|just) (?:a|an|the) (?:license|licence|readme)\b/i,
];

/** A portfolio line is about the work, not the writer. */
const FIRST_PERSON = [
  /(?:^|[\s(])I(?:'m|'ve|'d)?(?=[\s,.;:!?)]|$)/,
  /\b(?:we|we're|we've|our|ours|my)\b/i,
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
  const src = String(source || '');

  const text = clean(candidate);

  if (!text) return fail('empty after cleaning');
  if (text.length < min) return fail(`too short (${text.length} < ${min})`);
  if (text.length > max) return fail(`too long (${text.length} > ${max})`);
  if (/https?:\/\/|www\./i.test(text)) return fail('contains a URL');

  for (const re of META) {
    if (re.test(text)) return fail('reads as model chatter, not a description');
  }
  for (const re of FIRST_PERSON) {
    const m = text.match(re);
    if (m) return fail(`first person: "${m[0].trim()}"`);
  }
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) return fail(`unsupported claim: "${m[0]}"`);
  }
  for (const word of SOFT) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(text) && !re.test(src)) return fail(`embellishment not in source: "${word}"`);
  }

  // The core check: no figure may appear that isn't in the source material.
  const allowed = numbersIn(src);
  for (const n of numbersIn(text)) {
    if (!allowed.has(n)) return fail(`invented figure: "${n}" is not in the source`);
  }

  // Same rule for numbers written as words, which the digit check can't see.
  for (const m of text.matchAll(WORD_NUMBER_RE)) {
    const word = m[1].toLowerCase();
    const digits = WORD_NUMBERS[word];
    const inSource = new RegExp(`\\b${word}\\b`, 'i').test(src) ||
      (digits !== null && allowed.has(String(digits)));
    if (!inSource) return fail(`invented quantity: "${m[1]}" is not in the source`);
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
