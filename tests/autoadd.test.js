// Auto-add: what a rule catches, what happens to each caught series, the
// record that keeps a series from being added twice, following a series that
// was caught before the list had an id for it, and a whole pass run against a
// fake release list and a fake library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, hasPhrase, cleanRule, ruleMatches, collect, classify, isCollected, alreadyOut, pickExisting, nameKeyOf } from '../match.js';
import { openStore } from '../store.js';
import { makeFeed, makeScanner, matchesFor } from '../scan.js';

const rel = (series, extra = {}) => ({ series, publisher: 'IDW Publishing', type: 'Single Issue', issue: '1', shipdate: '2026-12-02', comicid: null, seriesyear: '2026', ...extra });
const rule = (keyword, extra = {}) => ({ id: 1, enabled: true, ...cleanRule({ keyword, ...extra }).rule });
const week = (releases, past = false) => ({ week: 'w', year: 'y', past, releases });

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

test('cleanRule: a keyword is required, defaults are single issues, every issue, any series', () => {
  assert.ok(cleanRule({ keyword: ' ' }).error);
  assert.ok(cleanRule({ keyword: '!' }).error);
  assert.ok(cleanRule({ keyword: 'x'.repeat(81) }).error);
  const { rule: r } = cleanRule({ keyword: '  Star   Trek ', exclude: 'omnibus, , Adventures', scope: 'bogus' });
  assert.deepEqual(r, { keyword: 'Star Trek', publisher: '', exclude: 'omnibus, Adventures', skipCollected: true, newOnly: false, scope: 'all' });
  assert.equal(cleanRule({ keyword: 'Batman', scope: 'new', skipCollected: false }).rule.scope, 'new');
  assert.equal(cleanRule({ keyword: 'Batman', skipCollected: false }).rule.skipCollected, false);
  assert.equal(cleanRule({ keyword: 'Batman', newOnly: 1 }).rule.newOnly, true);
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

test('collect gives one row per series with its next issue, and classify says what happens to it', () => {
  const weeks = [
    week([
      rel('Star Trek: Zero Point', { comicid: 177482, issue: '2', shipdate: '2026-12-02' }),
      rel('Star Trek', { comicid: 177149, issue: '3', shipdate: '2026-12-16' }),
      rel('Batman', { comicid: 5 }),
    ]),
    week([
      rel('Star Trek: Zero Point', { comicid: 177482, issue: '3', shipdate: '2027-01-06' }),
      rel('Star Trek: Lower Decks', { comicid: null, issue: '1', shipdate: '2027-01-06', seriesyear: '2027' }),
      rel('Star Trek: Year Five', { comicid: 900, issue: '1', shipdate: '2027-01-06' }),
      rel('Star Trek: Defiant', { comicid: 901, issue: '9', shipdate: '2027-01-06' }),
      rel('Star Trek: Old One', { comicid: 902, issue: '1', shipdate: '2027-01-06' }),
      rel('Star Trek: Not For Me', { comicid: null, issue: '1', shipdate: '2027-01-06', seriesyear: '2027' }),
    ]),
  ];
  const off = { ...rule('batman'), id: 2, enabled: false };
  const got = collect([rule('star trek'), off], weeks);
  assert.deepEqual(got.map((m) => m.series), ['Star Trek: Zero Point', 'Star Trek', 'Star Trek: Defiant', 'Star Trek: Lower Decks', 'Star Trek: Not For Me', 'Star Trek: Old One', 'Star Trek: Year Five']);
  const zp = got[0];
  assert.equal(zp.number, '2'); assert.equal(zp.shipdate, '2026-12-02'); assert.equal(zp.issues, 2); assert.equal(zp.keyword, 'star trek');
  assert.deepEqual(zp.upcoming, [{ number: '2', shipdate: '2026-12-02' }, { number: '3', shipdate: '2027-01-06' }]);
  assert.equal(zp.key, 'id:177482'); assert.equal(zp.nameKey, 'star trek zero point|2026');
  assert.equal(got[3].key, 'name:star trek lower decks|2027');

  const states = Object.fromEntries(classify(got, {
    tracked: new Map([[177149, 12]]),
    handled: new Map([[900, { status: 'skipped' }], [902, { status: 'added' }], [177149, { status: 'added' }]]),
    skippedKeys: new Set([nameKeyOf('Star Trek: Not For Me', '2027')]),
  }).map((m) => [m.series, m.state]));
  assert.deepEqual(states, {
    'Star Trek: Zero Point': 'new',
    'Star Trek': 'library',
    'Star Trek: Defiant': 'new',
    'Star Trek: Lower Decks': 'waiting',
    'Star Trek: Not For Me': 'skipped',
    'Star Trek: Old One': 'removed',
    'Star Trek: Year Five': 'skipped',
  });
});

test('a "new series only" rule catches a series whose first issue is on the list or just shipped', () => {
  const weeks = [
    week([rel('Batman: Fresh Start', { comicid: 30, issue: '1', shipdate: '2026-11-04' }), rel('Batman: Long Gone', { comicid: 40, issue: '1', shipdate: '2026-11-04' })], true),
    week([
      rel('Batman', { comicid: 10, issue: '16', publisher: 'DC Comics' }),
      rel('Batman: Year Zero', { comicid: 20, issue: '1' }),
      rel('Batman: Fresh Start', { comicid: 30, issue: '2' }),
      rel('Batman Annual', { comicid: null, issue: '1', seriesyear: '2027' }),
    ]),
  ];
  const fresh = rule('batman', { newOnly: true });
  assert.deepEqual(collect([fresh], weeks).map((m) => m.series).sort(), ['Batman Annual', 'Batman: Fresh Start', 'Batman: Year Zero'],
    'issue 16 is left out, a first issue in a past week counts, a series only in past weeks is not caught');
  const fs2 = collect([fresh], weeks).find((m) => m.cvId === 30);
  assert.equal(fs2.number, '2', 'the issue shown is the next one to ship, not the one that already did');

  // The next rule down may still own what a "new only" rule passed over.
  const any = { ...rule('batman', { publisher: 'DC' }), id: 2 };
  const both = collect([fresh, any], weeks);
  assert.equal(both.find((m) => m.cvId === 10).ruleId, 2);
  assert.equal(both.find((m) => m.cvId === 20).ruleId, 1);
});

test('a series caught earlier is followed into past weeks, a stranger there is not', () => {
  const weeks = [
    week([rel('Star Trek: One Shot', { comicid: 77, issue: '1', shipdate: '2026-11-04' }), rel('Star Trek: Stranger', { comicid: 78, issue: '1', shipdate: '2026-11-04' })], true),
    week([rel('Batman', { comicid: 5 })]),
  ];
  assert.deepEqual(collect([rule('star trek')], weeks), []);
  const got = collect([rule('star trek', { newOnly: true })], weeks, { pending: new Set([nameKeyOf('Star Trek: One Shot', '2026')]) });
  assert.deepEqual(got.map((m) => m.series), ['Star Trek: One Shot']);
  assert.equal(got[0].number, '1'); assert.equal(got[0].shipdate, '2026-11-04');
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

test('pickExisting applies the rule to catalog series and leaves out what is in the library', () => {
  const volumes = [
    { id: 1, name: 'Star Trek', publisher: { name: 'Western Publishing' }, start_year: '1967', count_of_issues: 61 },
    { id: 2, name: 'Star Trek', publisher: 'Marvel', start_year: '1980', count_of_issues: 18 },
    { id: 3, name: 'Star Trek Omnibus', publisher: 'IDW Publishing', start_year: 2009, count_of_issues: 2 },
    { id: 4, name: 'Stargate', publisher: 'Avatar', start_year: '2003', count_of_issues: 3 },
    { id: 5, name: 'Star Trek: Voyager', publisher: 'Marvel', start_year: '1996', count_of_issues: 15 },
    { id: 2, name: 'Star Trek', publisher: 'Marvel', start_year: '1980', count_of_issues: 18 },
    { id: 6, name: 'Star Trek: Deep Space Nine', publisher: null, start_year: null, count_of_issues: null },
  ];
  const got = pickExisting(rule('star trek'), volumes, new Set([5]));
  assert.deepEqual(got.map((v) => v.cvId), [2, 1, 6], 'newest first, no omnibus, no duplicate, nothing from the library');
  assert.deepEqual(got[1], { cvId: 1, series: 'Star Trek', publisher: 'Western Publishing', seriesYear: '1967', issues: 61 });
  assert.deepEqual(pickExisting(rule('star trek', { publisher: 'marvel', skipCollected: false }), volumes).map((v) => v.cvId), [5, 2]);
  assert.deepEqual(pickExisting(rule('star trek', { skipCollected: false, exclude: 'voyager' }), volumes).map((v) => v.cvId), [3, 2, 1, 6]);
});

test('store: rules round-trip, the record of handled series, and series waiting by name', () => {
  const { store, rm } = tmpStore();
  try {
    const a = store.createRule(cleanRule({ keyword: 'Star Trek', publisher: 'IDW', newOnly: true }).rule, 'admin');
    assert.equal(a.keyword, 'Star Trek'); assert.equal(a.enabled, true); assert.equal(a.createdBy, 'admin'); assert.equal(a.newOnly, true);
    assert.equal(store.updateRule(a.id, { enabled: false }).enabled, false);
    assert.equal(store.updateRule(a.id, { scope: 'new', newOnly: false }).scope, 'new');
    assert.equal(store.rule(a.id).newOnly, false);
    assert.equal(store.updateRule(999, { enabled: true }), null);

    store.record('added', { cvId: 177482, series: 'Star Trek: Zero Point', keyword: 'Star Trek', ruleId: a.id, number: '2', shipdate: '2026-12-02' }, 31);
    store.record('skipped', { cvId: 900, series: 'Star Trek: Year Five' });
    assert.equal(store.handled().get(177482).status, 'added');
    assert.equal(store.handled().get(900).status, 'skipped');
    assert.equal(store.history().length, 2);
    assert.equal(store.forget(900), true);
    assert.equal(store.handled().has(900), false);

    const m = { nameKey: 'star trek lower decks|2027', series: 'Star Trek: Lower Decks', seriesYear: '2027', keyword: 'Star Trek', number: '1', shipdate: '2027-01-06' };
    assert.equal(store.pend(m), true, 'first sighting');
    assert.equal(store.pend(m), false, 'seen before');
    assert.deepEqual([...store.pendingKeys()], [m.nameKey]);
    assert.equal(store.skippedKeys().size, 0);
    store.skipPending(m, true);
    assert.deepEqual([...store.skippedKeys()], [m.nameKey]);
    assert.equal(store.unskipPending(m.nameKey), true);
    assert.equal(store.skippedKeys().size, 0);
    assert.equal(store.pendingKeys().size, 1, 'still waiting, so it is not announced a second time');
    assert.equal(store.prunePending(), 0);
    assert.equal(store.prunePending(120, Date.now() + 121 * 86400000), 1, 'old enough to let go');
    assert.equal(store.unpend(m.nameKey), false);

    store.setMeta('lastRun', { added: [1] });
    assert.deepEqual(store.getMeta('lastRun'), { added: [1] });
    assert.equal(store.deleteRule(a.id), true);
    assert.deepEqual(store.rules(), []);
    assert.equal(store.handled().get(177482).status, 'added', 'deleting a rule keeps its record');
  } finally { rm(); }
});

// A release list whose weeks are numbers, and a clock fixed on week 48.
// `byWeek` may be changed between passes to play the list moving on.
function fakeFeed(byWeek, { ahead = 1, back = 0 } = {}) {
  const calls = [];
  const feed = makeFeed({
    ahead, back, ttlMs: 0,
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

test('the feed reads the weeks behind, this week and the weeks ahead, and marks the ones gone by', async () => {
  const { feed, calls } = fakeFeed({ 47: [rel('Old')], 48: [rel('A')], 49: 'down' }, { back: 1 });
  const first = await feed.weeks();
  assert.deepEqual(calls, ['47', '48', '49']);
  assert.deepEqual(first.weeks.map((w) => [w.week, w.past]), [['47', true], ['48', false]]);
  assert.equal(first.failed, 1);
  await assert.rejects(fakeFeed({ 47: [rel('Old')], 48: 'down', 49: 'down' }, { back: 1 }).feed.weeks(), /release list is unavailable/);

  // Served from memory while fresh.
  const kept = makeFeed({ ahead: 0, back: 0, currentWeek: () => ({ week: '48', year: '2026' }), shiftWeek: () => ({}), load: async (w) => { calls.push('kept'); return { ...w, releases: [] }; } });
  await kept.weeks(); await kept.weeks();
  assert.equal(calls.filter((c) => c === 'kept').length, 1);
  await kept.weeks({ fresh: true });
  assert.equal(calls.filter((c) => c === 'kept').length, 2);
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
    const added = []; const told = []; const coming = [];
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
      onWaiting: (m) => coming.push(m.series),
    });

    const one = await scanner.run();
    assert.deepEqual(added, ['Star Trek: Zero Point']);
    assert.deepEqual(told, ['Star Trek: Zero Point']);
    assert.deepEqual(coming, ['Star Trek: Lower Decks'], 'the series still waiting is announced');
    assert.equal(one.waiting, 1);
    assert.equal(one.failed.length, 1);
    assert.equal(one.added[0].seriesId, 100);
    assert.equal(store.getMeta('lastRun').added.length, 1);
    assert.equal(store.handled().has(666), false, 'a failed add is not remembered');

    const two = await scanner.run();
    assert.deepEqual(added, ['Star Trek: Zero Point', 'Star Trek: Broken'], 'the failed one is tried again, nothing is added twice');
    assert.equal(two.added.length, 1);
    assert.deepEqual(coming, ['Star Trek: Lower Decks'], 'and it is announced once only');

    // Deleted from the library afterwards: it does not come back.
    library.delete(177482);
    const three = await scanner.run();
    assert.equal(three.added.length, 0);
    const { matches } = await matchesFor(store.rules(), { feed, tracked: () => new Map(library), store });
    assert.equal(matches.find((m) => m.cvId === 177482).state, 'removed');

    // Unless it is taken off the record.
    store.forget(177482);
    assert.equal((await scanner.run()).added.length, 1);
  } finally { rm(); }
});

test('a series caught while waiting is added when its id arrives, even after it has shipped', async () => {
  const { store, rm } = tmpStore();
  try {
    store.createRule(cleanRule({ keyword: 'star trek', newOnly: true }).rule);
    const byWeek = { 48: [rel('Star Trek: One Shot', { comicid: null, issue: '1', shipdate: '2026-11-25' })] };
    const { feed } = fakeFeed(byWeek, { ahead: 1, back: 1 });
    const library = new Map(); const added = []; const coming = [];
    const scanner = makeScanner({
      store, feed, tracked: () => new Map(library),
      add: async (m) => { library.set(m.cvId, 7); added.push([m.series, m.upcoming.length]); return { seriesId: 7 }; },
      onWaiting: (m) => coming.push(m.series),
    });
    assert.equal((await scanner.run()).waiting, 1);
    assert.deepEqual(coming, ['Star Trek: One Shot']);
    assert.equal(store.pendingKeys().size, 1);

    // A week on: it has shipped, sits in a week gone by, and now has its id.
    delete byWeek[48];
    byWeek[47] = [rel('Star Trek: One Shot', { comicid: 555, issue: '1', shipdate: '2026-11-25' }), rel('Star Trek: Stranger', { comicid: 556, issue: '1', shipdate: '2026-11-25' })];
    const later = await scanner.run();
    assert.deepEqual(added, [['Star Trek: One Shot', 1]], 'the one that was waiting is added, a stranger in a past week is not');
    assert.equal(later.added[0].cvId, 555);
    assert.equal(store.pendingKeys().size, 0, 'no longer waiting');
    assert.equal(store.handled().get(555).status, 'added');
  } finally { rm(); }
});

test('a series skipped while waiting stays out once its id arrives', async () => {
  const { store, rm } = tmpStore();
  try {
    store.createRule(cleanRule({ keyword: 'star trek' }).rule);
    const byWeek = { 48: [rel('Star Trek: Not For Me', { comicid: null })] };
    const { feed } = fakeFeed(byWeek);
    const scanner = makeScanner({ store, feed, tracked: () => new Map(), add: async () => { throw new Error('must not add'); } });
    await scanner.run();
    const { matches } = await matchesFor(store.rules(), { feed, tracked: () => new Map(), store });
    assert.equal(matches[0].state, 'waiting');
    store.skipPending(matches[0], true);

    byWeek[48] = [rel('Star Trek: Not For Me', { comicid: 321 })];
    const out = await scanner.run();
    assert.equal(out.added.length, 0); assert.equal(out.failed.length, 0);
    assert.equal(store.handled().get(321).status, 'skipped', 'the skip moves from the name to the id');
    assert.equal(store.pendingKeys().size, 0);
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
