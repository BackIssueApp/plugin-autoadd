// The Auto-add pass: read the weekly release list for this week and the weeks
// ahead, see which series the rules catch, and add the new ones. Everything
// that touches the app (the release list, the library, the add itself) is
// handed in, so the pass runs against fakes in the tests.
import { collect, classify, BURST_MAX } from './match.js';

export const WEEKS_AHEAD = 8; // how far the release list reaches
export const WEEKS_BACK = 4;  // how long a series that was caught early is followed after it ships

// The weeks to look at, oldest first, kept for a while so the page and the
// preview do not ask the release list again on every keystroke. Weeks already
// gone by are marked `past`. `load({ week, year })` returns { week, year, releases }.
export function makeFeed({ load, currentWeek, shiftWeek, ahead = WEEKS_AHEAD, back = WEEKS_BACK, ttlMs = 30 * 60 * 1000, clock = Date.now }) {
  let cached = null; // { at, key, weeks, failed }
  let inflight = null;
  async function read() {
    const cur = currentWeek(new Date(clock()));
    const weeks = []; let failed = 0; let lastError = null;
    for (let d = -back; d <= ahead; d++) {
      const w = d === 0 ? cur : shiftWeek(cur.week, cur.year, d);
      try {
        const r = await load(w);
        weeks.push({ week: w.week, year: w.year, past: d < 0, releases: Array.isArray(r?.releases) ? r.releases : [] });
      } catch (e) { failed++; lastError = e; }
    }
    if (!weeks.some((w) => !w.past)) throw new Error(`the release list is unavailable (${lastError?.message || lastError || 'no answer'})`);
    return { at: clock(), key: cur.year + '-' + cur.week, weeks, failed };
  }
  return {
    async weeks({ fresh = false } = {}) {
      const cur = currentWeek(new Date(clock()));
      if (!fresh && cached && cached.key === cur.year + '-' + cur.week && clock() - cached.at < ttlMs) return cached;
      if (!inflight) inflight = read().then((r) => (cached = r)).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

// What the rules catch right now, each series with its state (see classify).
// `store` supplies what is already waiting and what was dealt with before.
// With `hold`, a rule found to catch more than `burstMax` series at once has
// them put on hold there and then, so that answering some of them does not
// let the rest through once fewer than that are left. `exceptRule` looks at
// one rule as if it had nothing on hold yet (a rule being changed).
export async function matchesFor(rules, { feed, tracked, store, fresh = false, hold = false, burstMax = BURST_MAX, exceptRule = null }) {
  const { weeks, failed } = await feed.weeks({ fresh });
  const caught = collect(rules, weeks, { pending: store.pendingKeys() });
  const held = store.heldKeys(exceptRule);
  const matches = classify(caught, { tracked: tracked(), handled: store.handled(), skippedKeys: store.skippedKeys(), approvedKeys: store.approvedKeys(), heldKeys: held, burstMax });
  if (hold) for (const m of matches) if (m.hold === 'burst' && !held.has(m.nameKey)) store.hold(m);
  return { matches, weeksRead: weeks.length, weeksFailed: failed };
}

// One pass. `add(match)` puts the series in the library and returns
// { seriesId, queued }; a series is only remembered as added once that
// succeeds, so a failed add is tried again on the next pass. A series the
// list has no catalog id for yet is remembered by name, and `onWaiting` is
// called the first time it is seen. A series whose rule asks first is held
// the same way once its id is known, and `onAsk` is called once for it; it is
// added when someone says yes. A rule that would add more than `burstMax`
// series in this pass adds none of them: they are held like the ones of a
// rule that asks first, and `onBurst({ ruleId, keyword, count })` is called
// once for the lot instead of `onAsk` for each.
export function makeScanner({ store, feed, tracked, add, onAdded = () => {}, onWaiting = () => {}, onAsk = () => {}, onBurst = () => {}, burstMax = BURST_MAX, log = () => {}, clock = () => new Date() }) {
  let running = null;
  async function pass({ fresh = true } = {}) {
    const rules = store.rules();
    const summary = { at: clock().toISOString(), rules: rules.filter((r) => r.enabled).length, added: [], failed: [], waiting: 0, asking: 0, held: 0, matched: 0 };
    if (!summary.rules) { store.setMeta('lastRun', summary); return summary; }
    const { matches, weeksRead, weeksFailed } = await matchesFor(rules, { feed, tracked, store, fresh, hold: true, burstMax });
    summary.matched = matches.length; summary.weeksRead = weeksRead; summary.weeksFailed = weeksFailed;
    const bursts = new Map(); // rule id → what it has newly on hold
    for (const m of matches) {
      if (m.state === 'waiting') {
        summary.waiting++;
        if (store.pend(m)) { try { onWaiting(m); } catch { /* telling people is best-effort */ } }
        continue;
      }
      if (!m.cvId) continue; // skipped while waiting: stays known by name
      if (m.state === 'ask') {
        summary.asking++;
        store.pend(m); // followed by name, like a waiting one, until someone answers
        if (store.markAsked(m.nameKey)) {
          if (m.hold === 'burst') {
            const b = bursts.get(m.ruleId) || { ruleId: m.ruleId, keyword: m.keyword, count: 0 };
            b.count++; bursts.set(m.ruleId, b);
          } else { try { onAsk(m); } catch { /* telling people is best-effort */ } }
        }
        continue;
      }
      // The list has its id now: what was known by name moves to the id. A
      // series that still has to be added stays known by name until the add
      // succeeds, so it is followed even once its issues have shipped.
      if (m.state !== 'new') {
        if (m.state === 'skipped' && !store.handled().has(m.cvId)) store.record('skipped', m, null);
        store.unpend(m.nameKey);
        continue;
      }
      try {
        const r = await add(m);
        store.record('added', m, r?.seriesId ?? null);
        store.unpend(m.nameKey);
        const done = { cvId: m.cvId, series: m.series, keyword: m.keyword, seriesId: r?.seriesId ?? null, queued: r?.queued || 0, shipdate: m.shipdate, number: m.number };
        summary.added.push(done);
        try { onAdded(done, m); } catch { /* telling people is best-effort */ }
      } catch (e) {
        summary.failed.push({ cvId: m.cvId, series: m.series, error: String(e?.message || e) });
        log('warn', `Could not add ${m.series}: ${e?.message || e}`);
        if (e?.rateLimited) break; // the catalog asked us to slow down: the rest wait for the next pass
      }
    }
    for (const b of bursts.values()) {
      summary.held += b.count;
      try { onBurst(b); } catch { /* telling people is best-effort */ }
    }
    store.prunePending(undefined, undefined, new Set(matches.map((m) => m.nameKey)));
    store.setMeta('lastRun', summary);
    return summary;
  }
  return {
    // One pass at a time; a second caller gets the pass already under way.
    run(opts) {
      if (!running) running = pass(opts).finally(() => { running = null; });
      return running;
    },
    busy: () => !!running,
  };
}
