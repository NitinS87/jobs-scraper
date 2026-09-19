const test = require('node:test');
const assert = require('node:assert');

const {
  SLOT_MS,
  DEFAULT_PER_RUN,
  slugify,
  allRoots,
  computeActiveVerticals,
} = require('../lib/verticals');

const PINNED = ['software-internet-ai'];
const ROOTS = allRoots();
const at = (slot, over = {}) => computeActiveVerticals({
  now: slot * SLOT_MS, roots: ROOTS, pinned: PINNED, perRun: DEFAULT_PER_RUN, ...over,
});

test('the taxonomy has the 19 roots the rotation is sized for', () => {
  assert.equal(ROOTS.length, 19, `expected 19 roots, got ${ROOTS.length}`);
  assert.ok(ROOTS.includes('software-internet-ai'), 'the pinned root must exist');
  assert.deepEqual(ROOTS, [...ROOTS].sort(), 'roots must be slug-sorted, not taxonomy-ordered');
});

test('slugify produces stable slugs for the real root names', () => {
  assert.equal(slugify('Software/Internet/AI'), 'software-internet-ai');
  assert.equal(slugify('Human Resource/Administrative/Legal'), 'human-resource-administrative-legal');
  assert.equal(slugify('Creative & Design'), 'creative-design');
});

test('the pinned root is active in every slot', () => {
  // Software/Internet/AI is 10,090 of the mapped corpus as of 2026-09-18; the
  // rotation must not cost it its 6-hourly freshness.
  for (let slot = 0; slot < 40; slot += 1) {
    assert.ok(at(slot).active.includes('software-internet-ai'), `slot ${slot} dropped the pinned root`);
  }
});

test('three consecutive slots cover every rotating root exactly once', () => {
  // 18 rotating roots and K=6 partition cleanly (18 % 6 === 0), so a full cycle
  // is 3 runs = 18 hours at the 6-hourly cron. K=4 or 5 would be coprime with
  // 18 and stretch the cycle to 54h/108h.
  const seen = [];
  for (let slot = 0; slot < 3; slot += 1) {
    seen.push(...at(slot).active.filter((r) => !PINNED.includes(r)));
  }
  const rotating = ROOTS.filter((r) => !PINNED.includes(r));
  assert.equal(seen.length, rotating.length, 'a full cycle must visit 18 roots');
  assert.equal(new Set(seen).size, rotating.length, 'no root may be visited twice in one cycle');
  assert.deepEqual([...seen].sort(), [...rotating].sort());
});

test('every run is the pinned root plus exactly perRun others', () => {
  for (let slot = 0; slot < 10; slot += 1) {
    assert.equal(at(slot).active.length, DEFAULT_PER_RUN + PINNED.length, `slot ${slot}`);
  }
});

test('two times inside the same slot produce an identical set', () => {
  // A retry or manual dispatch inside the same 6h window must top up the same
  // verticals, not scatter partial coverage across different ones.
  const early = computeActiveVerticals({ now: 100 * SLOT_MS + 1, roots: ROOTS, pinned: PINNED });
  const late = computeActiveVerticals({ now: 100 * SLOT_MS + SLOT_MS - 1, roots: ROOTS, pinned: PINNED });
  assert.deepEqual(early.active, late.active);
  assert.equal(early.slot, late.slot);
});

test('the window wraps around the end of the list', () => {
  const rotating = ROOTS.filter((r) => !PINNED.includes(r));
  // Find a slot whose window straddles the wrap point.
  let wrapped = null;
  for (let slot = 0; slot < 50; slot += 1) {
    const start = (slot * DEFAULT_PER_RUN) % rotating.length;
    if (start + DEFAULT_PER_RUN > rotating.length) { wrapped = slot; break; }
  }
  if (wrapped === null) return; // clean divisor: no straddling window exists
  const { active } = at(wrapped);
  assert.equal(new Set(active).size, active.length, 'a wrapped window must not duplicate');
});

test('VERTICALS_ONLY short-circuits rotation and keeps the pinned root', () => {
  const { active } = at(7, { only: ['healthcare', 'finance'] });
  assert.deepEqual(active.sort(), ['finance', 'healthcare', 'software-internet-ai'].sort());
});

test('unknown slugs in VERTICALS_ONLY are dropped, not thrown on', () => {
  // A typo in a repo Variable must not take the scheduled run down.
  const { active } = at(7, { only: ['healthcare', 'not-a-real-root'] });
  assert.deepEqual(active.sort(), ['healthcare', 'software-internet-ai'].sort());
});

test('VERTICALS_SKIP wins over pinning', () => {
  const { active } = at(3, { skip: ['software-internet-ai'] });
  assert.ok(!active.includes('software-internet-ai'), 'skip must override pin, matching SCRAPER_SKIP semantics');
});

test('perRun 0 yields the pinned root only, and a large perRun yields everything', () => {
  assert.deepEqual(at(5, { perRun: 0 }).active, PINNED);
  assert.equal(at(5, { perRun: 99 }).active.length, ROOTS.length);
});

test('all:true takes every root regardless of slot', () => {
  const { active } = at(11, { all: true });
  assert.equal(active.length, ROOTS.length);
});

test('the label names the slot and the active roots', () => {
  const { label } = at(2);
  assert.ok(label.includes('slot 2'), label);
  assert.ok(label.includes('software-internet-ai'), label);
});
