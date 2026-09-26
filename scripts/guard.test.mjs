#!/usr/bin/env node
/**
 * Tests for the LLM output guard.
 *
 * These matter more than the usual unit test: this code is the only thing
 * standing between a language model and claims published under my name.
 *
 * Run: npm test
 */

import { validateSummary, validateUpdate, clean, numbersIn } from './guard.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const README = `
# RustDB
A transactional database engine written in Rust with a custom storage layer.
Built by a team of 3 developers. Supports order 4 B-tree indexes.
Tested with GoogleTest and deployed via Docker.
`;

/* ---- the failure mode this exists to prevent ---- */

const invented = validateSummary(
  'A transactional database engine in Rust that improved query throughput by 40%.',
  README,
);
check('rejects an invented percentage', !invented.ok, invented.reason);

const inventedCount = validateSummary(
  'A database engine in Rust built by a team of 12 engineers.',
  README,
);
check('rejects an inflated head count', !inventedCount.ok, inventedCount.reason);

/* ---- figures that ARE in the source must survive ---- */

const grounded = validateSummary(
  'A transactional database engine in Rust with a custom storage layer, built by a team of 3.',
  README,
);
check('accepts a figure present in the source', grounded.ok, grounded.reason || '');

const btree = validateSummary(
  'A database engine in Rust supporting order 4 B-tree indexes over a custom storage layer.',
  README,
);
check('accepts "order 4" from the source', btree.ok, btree.reason || '');

/* ---- hype ---- */

for (const [label, text] of [
  ['state-of-the-art', 'A state-of-the-art database engine written in Rust.'],
  ['production-ready', 'A production-ready transactional engine written in Rust.'],
  ['blazingly fast', 'A blazingly fast storage engine written in the Rust language.'],
  ['superlative', 'The fastest transactional database engine written in Rust today.'],
  ['seamlessly', 'A database engine that seamlessly handles transactions in Rust.'],
]) {
  const r = validateSummary(text, README);
  check(`rejects "${label}"`, !r.ok, r.reason);
}

/* ---- model chatter ---- */

for (const [label, text] of [
  ['preamble', "Sure! Here's a description: a database engine written in Rust."],
  ['refusal', 'I cannot generate a description without more information here.'],
  ['meta', 'Based on the README, this is a database engine written in Rust.'],
]) {
  const r = validateSummary(text, README);
  check(`rejects ${label}`, !r.ok, r.reason);
}

/* ---- shape ---- */

check('rejects empty', !validateSummary('', README).ok);
check('rejects too short', !validateSummary('A database.', README).ok);
check('rejects too long', !validateSummary('A database engine in Rust. '.repeat(20), README).ok);
check('rejects a URL', !validateSummary('A database engine, see https://example.com for docs.', README).ok);

/* ---- cleaning ---- */

const md = validateSummary(
  '**A transactional database engine** in `Rust` with a [custom storage layer](https://x.com).',
  README,
);
check('strips markdown and link targets', md.ok && !md.text.includes('*') && !md.text.includes('http'), md.reason || md.text);

check('clean() collapses whitespace', clean('a\n\n  b   c') === 'a b c');
check('clean() removes code fences', clean('```js\nlet x=1\n```\nHello there') === 'Hello there');
check('numbersIn() normalises separators', numbersIn('12,630 images').has('12630'));

const thousands = validateSummary(
  'A vision pipeline evaluated on 12,630 test images across 43 classes.',
  'Evaluated on 12630 test images over 43 GTSRB classes.',
);
check('matches 12,630 against 12630 in source', thousands.ok, thousands.reason || '');

/* ---- version-like tokens ---- */

const version = validateSummary(
  'A computer-vision pipeline written in C++17 using OpenCV.',
  'Vision pipeline in C++17 built on OpenCV.',
);
check('accepts version numbers present in source', version.ok, version.reason || '');

const badVersion = validateSummary(
  'A computer-vision pipeline written in C++20 using OpenCV.',
  'Vision pipeline in C++17 built on OpenCV.',
);
check('rejects a version not in source', !badVersion.ok, badVersion.reason);

/* ---- updates feed ---- */

const upd = validateUpdate('Added B-tree page splitting to the storage engine.', 'commit: add b-tree page splitting');
check('accepts a grounded update line', upd.ok, upd.reason || '');

const updBad = validateUpdate('Cut query latency by 60% in the storage engine.', 'commit: tune storage engine');
check('rejects an invented update figure', !updBad.ok, updBad.reason);

/* ---- numbers written as words (the old guard's known gap) ---- */

const spelled = validateSummary('A database engine in Rust built by a team of twelve engineers.', README);
check('rejects a spelled-out number not in the source', !spelled.ok, spelled.reason);

const spelledOk = validateSummary('A transactional database engine in Rust, built by a team of three.', README);
check('accepts a spelled-out number whose digits are in the source', spelledOk.ok, spelledOk.reason || '');

const doubled = validateSummary('A Rust database engine that doubled write throughput over its first version.', README);
check('rejects "doubled" when the source never says it', !doubled.ok, doubled.reason);

const manyTx = validateSummary('A Rust database engine serving thousands of transactions per second.', README);
check('rejects "thousands of" when the source never says it', !manyTx.ok, manyTx.reason);

/* ---- embellishment: fine only when the source says it ---- */

const robust = validateSummary('A robust transactional database engine written in Rust.', README);
check('rejects "robust" absent from the source', !robust.ok, robust.reason);

const robustOk = validateSummary(
  'A simulator that reports a robustness curve and a robust estimate of miss distance.',
  'The runner reports a robust estimate of miss distance and a robustness curve.',
);
check('accepts "robust" when the source uses it', robustOk.ok, robustOk.reason || '');

/* ---- voice ---- */

for (const [label, text] of [
  ['"I"', 'I built a transactional database engine in Rust with a custom storage layer.'],
  ['"our"', 'Our transactional database engine is written in Rust with a custom storage layer.'],
  ['"we"', 'A Rust database engine where we wrote a custom storage layer from scratch.'],
]) {
  const r = validateSummary(text, README);
  check(`rejects first person ${label}`, !r.ok, r.reason);
}

const io = validateSummary('A storage engine in Rust with a custom I/O layer and Docker builds.', `${README} Custom I/O layer.`);
check('does not mistake "I/O" for first person', io.ok, io.reason || '');

console.log(failures ? `\n${failures} failing check(s)` : '\nAll guard checks passed.');
process.exit(failures ? 1 : 0);
