// Auto-add: what a rule catches, what happens to each caught series, the
// record that keeps a series from being added twice, and a whole pass run
// against a fake release list and a fake library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, hasPhrase, cleanRule, ruleMatches, collect, classify, isCollected, alreadyOut } from '../match.js';
import { openStore } from '../store.js';
import { makeFeed, makeScanner, matchesFor } from '../scan.js';

const rel = (series, extra = {}) => ({ series, publisher: 'IDW Publishing', type: 'Single Issue', issue: '1', shipdate: '2026-12-02', comicid: null, seriesyear: '2026', ...extra });
const rule = (keyword, extra = {}) => ({ id: 1, enabled: true, ...cleanRule({ keyword, ...extra }).rule });

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoadd-test-'));
  const store = openStore(path.join(dir, 'cat.db'));
  return { store, rm: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('normalize folds case, accents and punctuation', () => {
  assert.equal(normalize('Star Trek: Zero-Point!'), 'star trek zero point');
  assert.equal(normalize('Astérix & Obélix'), 'asterix and obelix');
  assert.equal(normalize(null), '');
});

test('a phrase matches whole words only', () => {
  assert.equal(hasPhrase('star trek zero point', 'star trek'), true);
  assert.equal(hasPhrase('giant size x men', 'ant'), false);
  assert.equal(hasPhrase('startrek', 'star trek'), false);
  assert.equal(hasPhrase('anything', ''), false);
});

test('cleanRule: a keyword is required, defaults are single issues and every issue', () => {
  assert.ok(cleanRule({ keyword: ' ' }).error);
  assert.ok(cleanRule({ keyword: '!' }).error);
  assert.ok(cleanRule({ keyword: 'x'.repeat(81) }).error);
  const { rule: r } = cleanRule({ keyword: '  Star   Trek ', exclude: 'omnibus, , Adventures', scope: 'bogus' });
  assert.deepEqual(r, { keyword: 'Star Trek', publisher: '', exclude: 'omnibus, Adventures', skipCollected: true, scope: 'all' });
  assert.equal(cleanRule({ keyword: 'Batman', scope: 'new', skipCollected: false }).rule.scope, 'new');
  assert.equal(cleanRule({ keyword: 'Batman', skipCollected: false }).rule.skipCollected, false);
});

test('a rule catches by name, and is narrowed by publisher, left-out words and collections', () => {
  assert.equal(ruleMatches(rule('star trek'), rel('Star Trek: Zero Point')), true);
  assert.equal(ruleMatches(rule('Star Trek'), rel('Stargate')), false);
  assert.equal(ruleMatches(rule('star trek', { publisher: 'idw' }), rel('Star Trek')), true);
  assert.equal(ruleMatches(rule('star trek', { publisher: 'Marvel' }), rel('Star Trek')), false);
  assert.equal(ruleMatches(rule('star trek', { exclude: 'red shirts' }), rel('Star Trek: Red Shirts')), false);
  assert.equal(ruleMatches(rule('star trek'), rel('Star Trek Omnibus', { type: 'Trade Paperback' })), false);
  assert.equal(ruleMatches(rule('star trek', { skipCollected: false }), rel('Star Trek Omnibus', { type: 'Trade Paperback' })), true);
  assert.equal(isCollected('Hardcover'), true);
  assert.equal(isCollected('Limited Series'), false);
});

test('collect gives one row per series with its first issue, and classify says what happens to it', () => {
  const weeks = [
    { week: '48', year: '2026', releases: [
      rel('Star Trek: Zero Point', { comicid: 177482, issue: '2', shipdate: '2026-12-02' }),
      rel('Star Trek', { comicid: 177149, issue: '3', shipdate: '2026-12-16' }),
      rel('Batman', { comicid: 5 }),
    ] },
    { week: '01', year: '2027', releases: [
      rel('Star Trek: Zero Point', { comicid: 177482, issue: '3', shipdate: '2027-01-06' }),
      rel('Star Trek: Lower Decks', { comicid: null, issue: '1', shipdate: '2027-01-06', seriesyear: '2027' }),
      rel('Star Trek: Year Five', { comicid: 900, issue: '1', shipdate: '2027-01-06' }),
      rel('Star Trek: Defiant', { comicid: 901, issue: '9', shipdate: '2027-01-06' }),
      rel('Star Trek: Old One', { comicid: 902, issue: '1', shipdate: '2027-01-06' }),
    ] },
  ];
  const off = { ...rule('batman'), id: 2, enabled: false };
  const got = collect([rule('star trek'), off], weeks);
  assert.deepEqual(got.map((m) => m.series), ['Star Trek: Zero Point', 'Star Trek', 'Star Trek: Defiant', 'Star Trek: Lower Decks', 'Star Trek: Old One', 'Star Trek: Year Five']);
  const zp = got[0];
  assert.equal(zp.number, '2'); assert.equal(zp.shipdate, '2026-12-02'); assert.equal(zp.issues, 2); assert.equal(zp.keyword, 'star trek');
  assert.deepEqual(zp.upcoming, [{ number: '2', shipdate: '2026-12-02' }, { number: '3', shipdate: '2027-01-06' }]);

  const states = Object.fromEntries(classify(got, {
    tracked: new Map([[177149, 12]]),
    handled: new Map([[900, { status: 'skipped' }], [902, { status: 'added' }], [177149, { status: 'added' }]]),
  }).map((m) => [m.series, m.state]));
  assert.deepEqual(states, {
    'Star Trek: Zero Point': 'new',
    'Star Trek': 'library',
    'Star Trek: Defiant': 'new',
    'Star Trek: Lower Decks': 'waiting',
    'Star Trek: Old One': 'removed',
    'Star Trek: Year Five': 'skipped',
  });
});

test('alreadyOut keeps the issues numbered below the first one still to ship', () => {
  const issues = ['1', '2', '3', 'Annual'].map((issue_number) => ({ issue_number }));
  const nums = (list) => list.map((i) => i.issue_number);
  const upcoming = [{ number: '2', shipdate: '2026-11-18' }, { number: '3', shipdate: '2026-12-16' }];
  assert.deepEqual(nums(alreadyOut(issues, upcoming, '2026-11-18')), ['1', '2', 'Annual'], 'shipping today is out');
  assert.deepEqual(nums(alreadyOut(issues, upcoming, '2026-11-17')), ['1', 'Annual']);
  assert.deepEqual(nums(alreadyOut(issues, upcoming, '2026-12-31')), ['1', '2', '3', 'Annual'], 'nothing left ahead');
  assert.deepEqual(nums(alreadyOut(issues, [{ number: '1', shipdate: null }], '2026-11-18')), ['Annual'], 'no ship date means not out yet');
  assert.deepEqual(nums(alreadyOut(issues, [], '2026-11-18')), ['1', '2', '3', 'Annual']);
});

test('store: rules round-trip, and the record of handled series', () => {
  const { store, rm } = tmpStore();
  try {
    const a = store.createRule(cleanRule({ keyword: 'Star Trek', publisher: 'IDW' }).rule, 'admin');
    assert.equal(a.keyword, 'Star Trek'); assert.equal(a.enabled, true); assert.equal(a.createdBy, 'admin');
    assert.equal(store.updateRule(a.id, { enabled: false }).enabled, false);
    assert.equal(store.updateRule(a.id, { scope: 'new' }).scope, 'new');
    assert.equal(store.updateRule(999, { enabled: true }), null);

    store.record('added', { cvId: 177482, series: 'Star Trek: Zero Point', keyword: 'Star Trek', ruleId: a.id, number: '2', shipdate: '2026-12-02' }, 31);
    store.record('skipped', { cvId: 900, series: 'Star Trek: Year Five' });
    assert.equal(store.handled().get(177482).status, 'added');
    assert.equal(store.handled().get(900).status, 'skipped');
    assert.equal(store.history().length, 2);
    assert.equal(store.forget(900), true);
    assert.equal(store.handled().has(900), false);

    store.setMeta('lastRun', { added: [1] });
    assert.deepEqual(store.getMeta('lastRun'), { added: [1] });
    assert.equal(store.deleteRule(a.id), true);
    assert.deepEqual(store.rules(), []);
    assert.equal(store.handled().get(177482).status, 'added', 'deleting a rule keeps its record');
  } finally { rm(); }
});

// A release list for two weeks and a clock fixed on the first of them.
function fakeFeed(byWeek, { ahead = 1 } = {}) {
  const calls = [];
  const feed = makeFeed({
    ahead,
    currentWeek: () => ({ week: '48', year: '2026' }),
    shiftWeek: (w, y, d) => ({ week: String(Number(w) + d), year: y }),
    load: async (w) => {
      calls.push(w.week);
      if (byWeek[w.week] === 'down') throw new Error('HTTP 502');
      return { ...w, releases: byWeek[w.week] || [] };
    },
  });
  return { feed, calls };
}

test('the feed reads this week and the weeks ahead once, then serves from memory', async () => {
  const { feed, calls } = fakeFeed({ 48: [rel('A')], 49: 'down' });
  const first = await feed.weeks();
  assert.equal(first.weeks.length, 1); assert.equal(first.failed, 1);
  await feed.weeks();
  assert.deepEqual(calls, ['48', '49']);
  await feed.weeks({ fresh: true });
  assert.equal(calls.length, 4);
  await assert.rejects(fakeFeed({ 48: 'down', 49: 'down' }).feed.weeks(), /release list is unavailable/);
});

test('a pass adds what is new once, leaves the rest, and tries a failed add again', async () => {
  const { store, rm } = tmpStore();
  try {
    store.createRule(cleanRule({ keyword: 'star trek' }).rule);
    const { feed } = fakeFeed({
      48: [rel('Star Trek: Zero Point', { comicid: 177482, issue: '2' }), rel('Star Trek', { comicid: 177149 }), rel('Batman', { comicid: 5 })],
      49: [rel('Star Trek: Lower Decks', { comicid: null }), rel('Star Trek: Broken', { comicid: 666 })],
    });
    const library = new Map([[177149, 12]]); // Star Trek is already in the library
    const added = []; const told = [];
    let brokenFor = 1;
    const scanner = makeScanner({
      store, feed,
      tracked: () => new Map(library),
      add: async (m) => {
        if (m.cvId === 666 && brokenFor-- > 0) throw new Error('catalog said no');
        const seriesId = 100 + added.length;
        library.set(m.cvId, seriesId); added.push(m.series);
        return { seriesId, queued: 1 };
      },
      onAdded: (d) => told.push(d.series),
    });

    const one = await scanner.run();
    assert.deepEqual(added, ['Star Trek: Zero Point']);
    assert.deepEqual(told, ['Star Trek: Zero Point']);
    assert.equal(one.waiting, 1);
    assert.equal(one.failed.length, 1);
    assert.equal(one.added[0].seriesId, 100);
    assert.equal(store.getMeta('lastRun').added.length, 1);
    assert.equal(store.handled().has(666), false, 'a failed add is not remembered');

    const two = await scanner.run();
    assert.deepEqual(added, ['Star Trek: Zero Point', 'Star Trek: Broken'], 'the failed one is tried again, nothing is added twice');
    assert.equal(two.added.length, 1);

    // Deleted from the library afterwards: it does not come back.
    library.delete(177482);
    const three = await scanner.run();
    assert.equal(three.added.length, 0);
    const { matches } = await matchesFor(store.rules(), { feed, tracked: () => new Map(library), handled: () => store.handled() });
    assert.equal(matches.find((m) => m.cvId === 177482).state, 'removed');

    // Unless it is taken off the record.
    store.forget(177482);
    assert.equal((await scanner.run()).added.length, 1);
  } finally { rm(); }
});

test('a pass with no rule switched on reads nothing', async () => {
  const { store, rm } = tmpStore();
  try {
    const r = store.createRule(cleanRule({ keyword: 'star trek' }).rule);
    store.updateRule(r.id, { enabled: false });
    const { feed, calls } = fakeFeed({ 48: [rel('Star Trek', { comicid: 1 })] });
    const out = await makeScanner({ store, feed, tracked: () => new Map(), add: async () => { throw new Error('must not add'); } }).run();
    assert.equal(out.added.length, 0);
    assert.deepEqual(calls, []);
  } finally { rm(); }
});

test('a skipped series is never added', async () => {
  const { store, rm } = tmpStore();
  try {
    store.createRule(cleanRule({ keyword: 'star trek' }).rule);
    store.record('skipped', { cvId: 177482, series: 'Star Trek: Zero Point' });
    const { feed } = fakeFeed({ 48: [rel('Star Trek: Zero Point', { comicid: 177482 })] });
    const out = await makeScanner({ store, feed, tracked: () => new Map(), add: async () => { throw new Error('must not add'); } }).run();
    assert.equal(out.added.length, 0); assert.equal(out.failed.length, 0);
  } finally { rm(); }
});
