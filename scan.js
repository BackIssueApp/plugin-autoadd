// The Auto-add pass: read the weekly release list for this week and the weeks
// ahead, see which series the rules catch, and add the new ones. Everything
// that touches the app (the release list, the library, the add itself) is
// handed in, so the pass runs against fakes in the tests.
import { collect, classify } from './match.js';

export const WEEKS_AHEAD = 8; // how far the release list reaches

// The weeks to look at, oldest first, kept for a while so the page and the
// preview do not ask the release list again on every keystroke.
// `load({ week, year })` returns { week, year, releases }.
export function makeFeed({ load, currentWeek, shiftWeek, ahead = WEEKS_AHEAD, ttlMs = 30 * 60 * 1000, clock = Date.now }) {
  let cached = null; // { at, key, weeks, failed }
  let inflight = null;
  async function read() {
    const cur = currentWeek(new Date(clock()));
    const weeks = []; let failed = 0; let lastError = null;
    for (let d = 0; d <= ahead; d++) {
      const w = d === 0 ? cur : shiftWeek(cur.week, cur.year, d);
      try {
        const r = await load(w);
        weeks.push({ week: w.week, year: w.year, releases: Array.isArray(r?.releases) ? r.releases : [] });
      } catch (e) { failed++; lastError = e; }
    }
    if (!weeks.length) throw new Error(`the release list is unavailable (${lastError?.message || lastError || 'no answer'})`);
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
export async function matchesFor(rules, { feed, tracked, handled, fresh = false }) {
  const { weeks, failed } = await feed.weeks({ fresh });
  return { matches: classify(collect(rules, weeks), { tracked: tracked(), handled: handled() }), weeksRead: weeks.length, weeksFailed: failed };
}

// One pass. `add(match)` puts the series in the library and returns
// { seriesId, queued }; a series is only remembered as added once that
// succeeds, so a failed add is tried again on the next pass.
export function makeScanner({ store, feed, tracked, add, onAdded = () => {}, log = () => {}, clock = () => new Date() }) {
  let running = null;
  async function pass({ fresh = true } = {}) {
    const rules = store.rules();
    const summary = { at: clock().toISOString(), rules: rules.filter((r) => r.enabled).length, added: [], failed: [], waiting: 0, matched: 0 };
    if (!summary.rules) { store.setMeta('lastRun', summary); return summary; }
    const { matches, weeksRead, weeksFailed } = await matchesFor(rules, { feed, tracked, handled: () => store.handled(), fresh });
    summary.matched = matches.length; summary.weeksRead = weeksRead; summary.weeksFailed = weeksFailed;
    for (const m of matches) {
      if (m.state === 'waiting') { summary.waiting++; continue; }
      if (m.state !== 'new') continue;
      try {
        const r = await add(m);
        store.record('added', m, r?.seriesId ?? null);
        const done = { cvId: m.cvId, series: m.series, keyword: m.keyword, seriesId: r?.seriesId ?? null, queued: r?.queued || 0, shipdate: m.shipdate, number: m.number };
        summary.added.push(done);
        try { onAdded(done, m); } catch { /* telling people is best-effort */ }
      } catch (e) {
        summary.failed.push({ cvId: m.cvId, series: m.series, error: String(e?.message || e) });
        log('warn', `Could not add ${m.series}: ${e?.message || e}`);
        if (e?.rateLimited) break; // the catalog asked us to slow down: the rest wait for the next pass
      }
    }
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
