// Auto-add plugin for BackIssue: keyword rules that add upcoming series to
// the library before anyone has heard of them. A rule is a phrase ("star
// trek"), optionally narrowed by publisher and by words to leave out. Twice a
// day the weekly release list is read for this week and the eight after it;
// a series whose name a rule catches, and that is not in the library yet, is
// added and monitored like any series added by hand. Its issues then
// download through the app's own lanes as they ship.
//
// A series is added once. Deleting it afterwards does not bring it back, and
// "Skip" on the page keeps a caught series out before it is added.
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { makeCvClient } from '../../src/cv.js';
import { addSeriesFromCv } from '../../src/cvmatch.js';
import * as coreDb from '../../src/db.js';
import * as releases from '../../src/releases.js';
import * as notifications from '../../src/notifications.js';
import * as logstore from '../../src/logstore.js';
import * as jobs from '../../src/jobs.js';
import { openStore } from './store.js';
import { cleanRule, alreadyOut } from './match.js';
import { makeFeed, makeScanner, matchesFor, WEEKS_AHEAD } from './scan.js';

const JOB_ID = 'autoadd-scan';
const JOB_LABEL = 'Add upcoming series that match a rule';

export default async function register(api) {
  api.registerClientAsset({ js: 'client/ui.js', css: 'client/autoadd.css' });

  // Rules add series and start downloads with nobody watching, so writing
  // them is an administrator's call unless a role is granted it.
  const ACCESS = api.registerPermission ? 'autoadd.manage' : 'admin';
  api.registerPermission?.({
    key: 'autoadd.manage',
    label: 'Manage auto-add rules',
    description: 'Write the rules that add upcoming series to the library automatically, and run them',
    tier: 'admin',
  });

  const store = openStore(config.dbPath);
  const log = (level, msg) => { try { (level === 'warn' ? logstore.logWarn : logstore.logInfo)?.(msg, 'autoadd'); } catch { /* logging is best-effort */ } };

  // The download sources that are switched on. Queueing with none of them
  // would only produce a wall of failed downloads.
  let orderedSources = null;
  try { ({ orderedSources } = await import('../../src/sources/index.js')); } catch { /* older core */ }
  const anySource = () => { try { return orderedSources ? orderedSources(config).length > 0 : true; } catch { return true; } };

  // Routes get their own connection to the app's database; the scheduled job
  // is handed the app's.
  let own = null;
  const ownDb = () => {
    if (!own) {
      own = new Database(config.dbPath);
      own.pragma('journal_mode = WAL');
      own.pragma('busy_timeout = 5000');
    }
    return own;
  };
  const trackedIn = (db) => () => {
    const m = new Map();
    for (const s of db.prepare('SELECT id, cv_id FROM series WHERE cv_id IS NOT NULL').all()) m.set(s.cv_id, s.id);
    return m;
  };

  const feed = makeFeed({
    load: (w) => releases.fetchWeeklyReleases(w),
    currentWeek: releases.currentWeek,
    shiftWeek: releases.shiftWeek,
  });

  // Put one caught series in the library: monitored for every issue, or from
  // the issue that is about to ship when the rule says so. Issues already out
  // are queued the way a manual add queues them (the "download on add"
  // setting decides); the ones the release list still has ahead are left to
  // the app's release-day lanes.
  const adder = (db, startDownloads) => async (m) => {
    const lib = coreDb.defaultLibrary?.(db)?.id ?? null;
    const client = makeCvClient(config, lib != null ? { libraryId: lib } : {});
    const r = await addSeriesFromCv(db, client, m.cvId, { monitor: 'all' });
    if (r.outcome === 'created' && m.scope === 'new' && m.number != null) {
      try { coreDb.setMonitor(db, r.seriesId, 'new', { from: m.number }); } catch { /* keeps "all" */ }
    }
    let queued = 0;
    if (r.outcome === 'created' && config.autoDownloadOnAdd !== false && anySource()) {
      try {
        const wanted = db.prepare(`
          SELECT ci.comicvine_id, ci.issue_number, ci.name FROM wanted_issues w
            JOIN cv_issues ci ON ci.comicvine_id = w.cv_issue_id
           WHERE w.series_id = ?
        `).all(r.seriesId);
        const out = alreadyOut(wanted, m.upcoming, new Date().toISOString().slice(0, 10));
        const ids = out.map((ci) => coreDb.ensureCvIssueRow(db, { seriesId: r.seriesId, cvIssueId: ci.comicvine_id, number: ci.issue_number, title: ci.name }));
        if (ids.length) { coreDb.queueIssues(db, ids); startDownloads?.(); }
        queued = ids.length;
      } catch (e) { log('warn', `${r.title || m.series} was added, but its released issues could not be queued: ${e?.message || e}`); }
    }
    return { seriesId: r.seriesId, queued };
  };

  // Tell people what arrived: one note per series for the first few, then one
  // that counts the rest.
  const NOTE_EACH = 5;
  const announcer = (db) => {
    let told = 0;
    return {
      each(done) {
        log('info', `Added ${done.series} (rule "${done.keyword}")${done.queued ? `, ${done.queued} released issue${done.queued === 1 ? '' : 's'} queued` : ''}`);
        if (++told > NOTE_EACH) return;
        notifications.notify?.(db, {
          type: 'autoadd.added', category: 'release', level: 'success',
          title: `Added ${done.series}`,
          body: `It matches your rule “${done.keyword}”.`,
          url: done.seriesId != null ? `/volume/${done.seriesId}` : null,
          seriesId: done.seriesId ?? null,
          params: { title: done.series, keyword: done.keyword },
        });
      },
      rest() {
        if (told <= NOTE_EACH) return;
        const count = told - NOTE_EACH;
        notifications.notify?.(db, {
          type: 'autoadd.more', category: 'release', level: 'success',
          title: `${count} more series added`,
          body: 'Auto-add has the full list.',
          params: { count },
        });
      },
    };
  };

  // One pass over the rules. `db` is the app's connection when the scheduler
  // calls, the plugin's own from a route.
  let scanner = null; // the pass under way, shared by every caller
  async function runPass(db, startDownloads) {
    if (scanner?.busy()) return scanner.run();
    const say = announcer(db);
    scanner = makeScanner({ store, feed, tracked: trackedIn(db), add: adder(db, startDownloads), onAdded: say.each, log });
    try {
      const summary = await scanner.run();
      try { say.rest(); } catch { /* best-effort */ }
      if (summary.added.length || summary.failed.length) log('info', `Auto-add: ${summary.added.length} added, ${summary.failed.length} failed, ${summary.waiting} waiting for a catalog entry`);
      return summary;
    } finally { scanner = null; }
  }
  const brief = (s) => ({ added: s.added.length, failed: s.failed.length, waiting: s.waiting });
  const asJob = (label, fn) => (jobs.runJob ? jobs.runJob(JOB_ID, label, async () => brief(await fn())) : fn().then(brief));

  // Twice a day unless the Jobs page says otherwise. The times sit a little
  // after the hour so the pass does not land on the app's own release check.
  config.autoaddScanCron ??= '40 7,19 * * *';
  config.autoaddScanEnabled ??= true;
  api.registerJob?.({
    id: JOB_ID,
    label: JOB_LABEL,
    scheduleKey: 'autoaddScanHours',
    run: (ctx) => asJob(JOB_LABEL, () => runPass(ctx?.db || ownDb(), ctx?.startDownloads)),
  });

  // ---- routes --------------------------------------------------------------
  const route = (method, path, handler) => api.registerRoute(method, path, async (req, res) => {
    try { await handler(req, res); }
    catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: ACCESS });
  const lists = () => ({ tracked: trackedIn(ownDb()), handled: () => store.handled() });

  // Rules, what they have done so far, and the last pass.
  route('get', '/api/autoadd/state', (req, res) => {
    const present = trackedIn(ownDb())();
    res.json({
      rules: store.rules(),
      history: store.history().map((h) => ({ ...h, inLibrary: present.has(h.cvId), seriesId: present.get(h.cvId) ?? null })),
      lastRun: store.getMeta('lastRun'),
      running: !!scanner?.busy(),
      weeksAhead: WEEKS_AHEAD,
    });
  });

  // What the saved rules catch in the weeks ahead.
  route('get', '/api/autoadd/matches', async (req, res) => {
    try { res.json(await matchesFor(store.rules(), { feed, ...lists() })); }
    catch (e) { res.json({ matches: [], error: String(e?.message || e) }); }
  });

  // What a rule would catch, before it is saved.
  route('post', '/api/autoadd/preview', async (req, res) => {
    const { rule, error } = cleanRule(req.body || {});
    if (error) return res.json({ matches: [], invalid: error });
    try { res.json(await matchesFor([{ ...rule, id: 0, enabled: true }], { feed, ...lists() })); }
    catch (e) { res.json({ matches: [], error: String(e?.message || e) }); }
  });

  route('post', '/api/autoadd/rules', (req, res) => {
    const { rule, error } = cleanRule(req.body || {});
    if (error) return res.status(400).json({ error });
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    if (store.rules().some((r) => same(r.keyword, rule.keyword) && same(r.publisher, rule.publisher) && same(r.exclude, rule.exclude))) {
      return res.status(409).json({ error: 'a rule like this one already exists', code: 'duplicate' });
    }
    res.json({ rule: store.createRule(rule, req.user?.username || null) });
  });

  // Change a rule: `enabled` alone flips the switch, anything else replaces
  // the rule's fields.
  route('post', '/api/autoadd/rules/:id', (req, res) => {
    const cur = store.rule(req.params.id);
    if (!cur) return res.status(404).json({ error: 'no such rule' });
    const body = req.body || {};
    let patch = {};
    if (body.keyword !== undefined) {
      const { rule, error } = cleanRule(body);
      if (error) return res.status(400).json({ error });
      patch = rule;
    }
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    res.json({ rule: store.updateRule(cur.id, patch) });
  });

  route('post', '/api/autoadd/rules/:id/delete', (req, res) => {
    res.json({ deleted: store.deleteRule(req.params.id) });
  });

  // "Not this one": keep a caught series out. Looked up in what the rules
  // catch right now, so only a series a rule really caught can be skipped.
  route('post', '/api/autoadd/skip', async (req, res) => {
    const cvId = Number(req.body?.cvId);
    const { matches } = await matchesFor(store.rules(), { feed, ...lists() });
    const m = matches.find((x) => x.cvId === cvId);
    if (!m) return res.status(404).json({ error: 'no rule catches that series right now', code: 'gone' });
    if (m.state !== 'new') return res.status(409).json({ error: 'that series is not waiting to be added', code: 'gone' });
    store.record('skipped', m, null);
    res.json({ skipped: true });
  });

  // Take a series off the record: a skipped one is caught again, and one that
  // was added and later deleted may be added again.
  route('post', '/api/autoadd/forget', (req, res) => {
    res.json({ forgotten: store.forget(req.body?.cvId) });
  });

  // Run the rules now. Answers when the pass is done; it shows on the Jobs
  // page like the scheduled one.
  route('post', '/api/autoadd/run', async (req, res) => {
    const start = () => { try { req.app?.locals?.startDownloads?.(); } catch { /* older core: the queue picks them up at its next kick */ } };
    let summary = null;
    await asJob(JOB_LABEL, async () => (summary = await runPass(ownDb(), start)));
    res.json(summary);
  });
}
