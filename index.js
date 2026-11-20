// Auto-add plugin for BackIssue: keyword rules that add upcoming series to
// the library before anyone has heard of them. A rule is a phrase ("star
// trek"), optionally narrowed by publisher and by words to leave out, or a
// publisher on its own. Twice a day the weekly release list is read for this
// week and the eight after it.
// A series whose name a rule catches, and that is not in the library yet, is
// announced the moment it is caught and added as soon as the catalog has a
// record for it, then monitored like any series added by hand. Its issues
// download through the app's own lanes as they ship.
//
// A series is added once. Deleting it afterwards does not bring it back, and
// "Skip" on the page keeps a caught series out before it is added. A rule can
// ask first, so each series it catches waits for a yes on the page, and it can
// name the library its series go to. A rule that would add more than a
// handful of series in one check adds none of them: they wait for a yes too.
// A rule can also be pointed at the catalog's existing series, to add the
// back catalogue by hand.
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
import { cleanRule, alreadyOut, pickExisting, BURST_MAX } from './match.js';
import { makeFeed, makeScanner, matchesFor, WEEKS_AHEAD } from './scan.js';

const JOB_ID = 'autoadd-scan';
const JOB_LABEL = 'Add upcoming series that match a rule';
const EXISTING_MAX = 1000;  // how many catalog series one rule's back catalogue may list
const EXISTING_BATCH = 10;  // how many of them one request may add

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
  // The library a rule names, when it is still there and holds comics (the
  // release list is a comics list). Anything else means the default library.
  const comicLibrary = (db, id) => {
    if (id == null) return null;
    try { const lib = coreDb.getLibrary?.(db, Number(id)); return lib && lib.type === 'comic' ? lib : null; }
    catch { return null; }
  };
  // The catalog, asked through the destination library's sources like a manual add.
  const catalog = (db, libraryId = null) => {
    const lib = comicLibrary(db, libraryId)?.id ?? coreDb.defaultLibrary?.(db)?.id ?? null;
    return makeCvClient(config, lib != null ? { libraryId: lib } : {});
  };

  const feed = makeFeed({
    load: (w) => releases.fetchWeeklyReleases(w),
    currentWeek: releases.currentWeek,
    shiftWeek: releases.shiftWeek,
  });

  // Put one series in the library (the one its rule names, or the default):
  // monitored for every issue, or from the issue that is about to ship when
  // the rule says so. Issues already out are
  // queued the way a manual add queues them (the "download on add" setting
  // decides); the ones the release list still has ahead are left to the app's
  // release-day lanes.
  const adder = (db, startDownloads) => async (m) => {
    const r = await addSeriesFromCv(db, catalog(db, m.libraryId), m.cvId, { monitor: 'all' });
    const home = r.outcome === 'created' ? comicLibrary(db, m.libraryId) : null;
    if (home) { try { coreDb.assignSeriesLibrary?.(db, r.seriesId, home.id); } catch { /* the library went away: it stays in the default one */ } }
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
    return { seriesId: r.seriesId, queued, outcome: r.outcome };
  };

  // Tell people what a pass did: a note per series for the first few of each
  // kind, then one that counts the rest of what was added.
  const NOTE_EACH = 5;
  const announcer = (db) => {
    let added = 0; let waiting = 0; let asking = 0;
    const tell = (event) => { try { notifications.notify?.(db, event); } catch { /* best-effort */ } };
    return {
      // Caught, but the catalog has no record of it yet.
      waiting(m) {
        log('info', `Caught ${m.series} (rule "${m.keyword}"): waiting for its catalog record`);
        if (!m.shipdate || ++waiting > NOTE_EACH) return;
        tell({
          type: m.needsOk ? 'autoadd.waitingAsk' : 'autoadd.waiting', category: 'release', level: 'info',
          title: `Coming up: ${m.series}`,
          body: `It ships ${m.shipdate} and matches your rule “${m.keyword}”. ` + (m.needsOk
            ? 'Say on the Auto-add page whether to add it.'
            : 'It is added as soon as its details are available.'),
          params: { title: m.series, keyword: m.keyword, date: m.shipdate },
        });
      },
      // Its rule asks first, and the catalog has its record: it can be added
      // the moment someone says yes.
      ask(m) {
        log('info', `Caught ${m.series} (rule "${m.keyword}"): waiting for a yes or no`);
        if (++asking > NOTE_EACH) return;
        tell({
          type: 'autoadd.ask', category: 'release', level: 'info',
          title: `Needs your OK: ${m.series}`,
          body: `It matches your rule “${m.keyword}”. Add or skip it on the Auto-add page.`,
          params: { title: m.series, keyword: m.keyword },
        });
      },
      // A rule caught more series at once than it adds on its own: one note
      // for the lot, not one per series.
      burst(b) {
        log('info', `Rule "${b.keyword}" caught ${b.count} series at once: all of them wait for a yes or no`);
        tell({
          type: 'autoadd.burst', category: 'release', level: 'info',
          title: `“${b.keyword}” caught ${b.count} series at once`,
          body: 'That is more than Auto-add adds on its own. Add or skip them on the Auto-add page.',
          params: { keyword: b.keyword, count: b.count },
        });
      },
      added(done) {
        log('info', `Added ${done.series} (rule "${done.keyword}")${done.queued ? `, ${done.queued} released issue${done.queued === 1 ? '' : 's'} queued` : ''}`);
        if (++added > NOTE_EACH) return;
        tell({
          type: 'autoadd.added', category: 'release', level: 'success',
          title: `Added ${done.series}`,
          body: `It matches your rule “${done.keyword}”.`,
          url: done.seriesId != null ? `/volume/${done.seriesId}` : null,
          seriesId: done.seriesId ?? null,
          params: { title: done.series, keyword: done.keyword },
        });
      },
      rest() {
        if (asking > NOTE_EACH) {
          const count = asking - NOTE_EACH;
          tell({
            type: 'autoadd.askMore', category: 'release', level: 'info',
            title: `${count} more series need your OK`,
            body: 'Auto-add has the full list.',
            params: { count },
          });
        }
        if (added <= NOTE_EACH) return;
        const count = added - NOTE_EACH;
        tell({
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
    scanner = makeScanner({ store, feed, tracked: trackedIn(db), add: adder(db, startDownloads), onAdded: say.added, onWaiting: say.waiting, onAsk: say.ask, onBurst: say.burst, log });
    try {
      const summary = await scanner.run();
      say.rest();
      if (summary.added.length || summary.failed.length) log('info', `Auto-add: ${summary.added.length} added, ${summary.failed.length} failed, ${summary.waiting} waiting for a catalog record, ${summary.asking} waiting for a yes or no`);
      else if (summary.held) log('info', `Auto-add: ${summary.held} series put on hold for a yes or no`);
      return summary;
    } finally { scanner = null; }
  }
  const brief = (s) => ({ added: s.added.length, failed: s.failed.length, waiting: s.waiting, asking: s.asking || 0 });
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

  // The catalog's existing series whose name a rule catches and that are not
  // in the library. A name filter on the catalog's series list when the
  // source has one (it pages, so a long-running title is listed in full);
  // its plain search otherwise.
  async function existingFor(rule, db) {
    const client = catalog(db, rule.libraryId);
    let volumes = null;
    if (typeof client.list === 'function') {
      try {
        const name = rule.keyword.replace(/[:|,]+/g, ' ').replace(/\s+/g, ' ').trim();
        volumes = [];
        for (let offset = 0; offset < EXISTING_MAX; offset += 100) {
          const page = await client.list('volumes', { filter: `name:${name}`, fieldList: 'id,name,publisher,start_year,count_of_issues', limit: 100, offset });
          const got = page?.results || [];
          volumes.push(...got);
          if (got.length < 100 || volumes.length >= Number(page?.total ?? Infinity)) break;
        }
      } catch (e) { if (e?.rateLimited) throw e; volumes = null; }
    }
    if (!volumes) volumes = await client.search(rule.keyword);
    return pickExisting(rule, volumes, new Set(trackedIn(db)().keys()));
  }

  // ---- routes --------------------------------------------------------------
  const route = (method, path, handler) => api.registerRoute(method, path, async (req, res) => {
    try { await handler(req, res); }
    catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access: ACCESS });
  // What the given rules catch. The saved rules as a whole are looked at with
  // `hold`, so a rule that catches too much has it put on hold on first sight.
  const caught = (rules, opts = {}) => matchesFor(rules, { feed, tracked: trackedIn(ownDb()), store, ...opts });
  const caughtNow = () => caught(store.rules(), { hold: true });
  const kick = (req) => () => { try { req.app?.locals?.startDownloads?.(); } catch { /* older core: the queue picks them up at its next kick */ } };

  // Rules, what they have done so far, and the last pass.
  route('get', '/api/autoadd/state', (req, res) => {
    const present = trackedIn(ownDb())();
    res.json({
      rules: store.rules(),
      history: store.history().map((h) => ({ ...h, inLibrary: present.has(h.cvId), seriesId: present.get(h.cvId) ?? null })),
      lastRun: store.getMeta('lastRun'),
      running: !!scanner?.busy(),
      weeksAhead: WEEKS_AHEAD,
      burstMax: BURST_MAX,
    });
  });

  // What the saved rules catch in the weeks ahead.
  route('get', '/api/autoadd/matches', async (req, res) => {
    try { res.json(await caughtNow()); }
    catch (e) { res.json({ matches: [], error: String(e?.message || e) }); }
  });

  // What a rule would catch, before it is saved. A rule being changed says
  // which one it is (`id`), so what it has on hold now does not colour the
  // look at what it would do once saved.
  route('post', '/api/autoadd/preview', async (req, res) => {
    const { rule, error } = cleanRule(req.body || {});
    if (error) return res.json({ matches: [], invalid: error });
    try { res.json(await caught([{ ...rule, id: 0, enabled: true }], { exceptRule: Number(req.body?.id) || null })); }
    catch (e) { res.json({ matches: [], error: String(e?.message || e) }); }
  });

  // What the form sent, checked: a second rule that would catch exactly the
  // same series is refused, and so is a library that is gone or holds
  // something other than comics. Returns { rule } or { status, error, code }.
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  function checkedRule(body, exceptId = null) {
    const { rule, error } = cleanRule(body || {});
    if (error) return { status: 400, error };
    if (store.rules().some((r) => r.id !== exceptId && same(r.keyword, rule.keyword) && same(r.publisher, rule.publisher) && same(r.exclude, rule.exclude))) {
      return { status: 409, error: 'a rule like this one already exists', code: 'duplicate' };
    }
    if (rule.libraryId != null && !comicLibrary(ownDb(), rule.libraryId)) {
      return { status: 400, error: 'that library is gone, or does not hold comics', code: 'library' };
    }
    return { rule };
  }

  route('post', '/api/autoadd/rules', (req, res) => {
    const c = checkedRule(req.body);
    if (!c.rule) return res.status(c.status).json({ error: c.error, code: c.code });
    res.json({ rule: store.createRule(c.rule, req.user?.username || null) });
  });

  // Change a rule: `enabled` alone flips the switch, anything else replaces
  // the rule's fields.
  route('post', '/api/autoadd/rules/:id', (req, res) => {
    const cur = store.rule(req.params.id);
    if (!cur) return res.status(404).json({ error: 'no such rule' });
    const body = req.body || {};
    let patch = {};
    if (body.keyword !== undefined || body.publisher !== undefined) {
      const c = checkedRule(body, cur.id);
      if (!c.rule) return res.status(c.status).json({ error: c.error, code: c.code });
      patch = c.rule;
      store.releaseHolds(cur.id); // a changed rule is judged afresh
    }
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    res.json({ rule: store.updateRule(cur.id, patch) });
  });

  route('post', '/api/autoadd/rules/:id/delete', (req, res) => {
    const deleted = store.deleteRule(req.params.id);
    if (deleted) store.releaseHolds(req.params.id);
    res.json({ deleted });
  });

  // The back catalogue: existing series this rule's name test catches. A
  // rule with no name to look for has none: a publisher's whole catalogue is
  // not something to list.
  const NO_NAME = { error: 'a rule without a series name has no existing series to list', code: 'noKeyword' };
  route('get', '/api/autoadd/rules/:id/existing', async (req, res) => {
    const rule = store.rule(req.params.id);
    if (!rule) return res.status(404).json({ error: 'no such rule' });
    if (!rule.keyword) return res.status(400).json(NO_NAME);
    try { res.json({ series: await existingFor(rule, ownDb()) }); }
    catch (e) { res.json({ series: [], error: e?.rateLimited ? 'the catalog is busy right now, try again shortly' : String(e?.message || e) }); }
  });

  // Add some of them. A few per request, so the page can show progress and a
  // long list never holds one request open for minutes.
  route('post', '/api/autoadd/rules/:id/existing', async (req, res) => {
    const rule = store.rule(req.params.id);
    if (!rule) return res.status(404).json({ error: 'no such rule' });
    if (!rule.keyword) return res.status(400).json(NO_NAME);
    const ids = [...new Set((Array.isArray(req.body?.cvIds) ? req.body.cvIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length || ids.length > EXISTING_BATCH) return res.status(400).json({ error: `between 1 and ${EXISTING_BATCH} series can be added at a time` });
    const db = ownDb();
    const add = adder(db, kick(req));
    // A series that also has issues ahead on the list only gets the ones
    // already out queued, like any other add.
    let ahead = new Map();
    try { ahead = new Map((await caught([{ ...rule, enabled: true }])).matches.filter((m) => m.cvId).map((m) => [m.cvId, m])); } catch { /* the list is down: queue what the catalog has */ }
    const added = []; const failed = [];
    for (const cvId of ids) {
      const m = { cvId, ruleId: rule.id, keyword: rule.keyword, scope: 'all', libraryId: rule.libraryId, upcoming: ahead.get(cvId)?.upcoming || [], series: ahead.get(cvId)?.series || null };
      try {
        const r = await add(m);
        const row = db.prepare('SELECT title, publisher, year FROM series WHERE id = ?').get(r.seriesId) || {};
        store.record('added', { ...m, series: row.title || m.series, publisher: row.publisher || null, seriesYear: row.year || null }, r.seriesId);
        added.push({ cvId, seriesId: r.seriesId, queued: r.queued });
        log('info', `Added ${row.title || 'series ' + cvId} from the back catalogue (rule "${rule.keyword}")${r.queued ? `, ${r.queued} issue${r.queued === 1 ? '' : 's'} queued` : ''}`);
      } catch (e) {
        failed.push({ cvId, error: String(e?.message || e) });
        log('warn', `Could not add series ${cvId} from the back catalogue: ${e?.message || e}`);
        if (e?.rateLimited) break;
      }
    }
    res.json({ added, failed });
  });

  // "Not this one": keep a caught series out, whether it is about to be added
  // (known by its catalog id) or still waiting (known by name). Looked up in
  // what the rules catch right now, so only a caught series can be skipped.
  route('post', '/api/autoadd/skip', async (req, res) => {
    const key = String(req.body?.key || '');
    const { matches } = await caughtNow();
    const m = matches.find((x) => x.key === key);
    if (!m) return res.status(404).json({ error: 'no rule catches that series right now', code: 'gone' });
    if (m.state === 'new' || m.state === 'ask') store.record('skipped', m, null);
    else if (m.state === 'waiting') store.skipPending(m, true);
    else return res.status(409).json({ error: 'that series is not waiting to be added', code: 'gone' });
    res.json({ skipped: true });
  });

  // "Yes, this one", for a series that is on hold: its rule asks first, or
  // caught too many at once. One the catalog
  // already has a record for is added on the spot; one still waiting for its
  // record is added when that arrives.
  route('post', '/api/autoadd/approve', async (req, res) => {
    const key = String(req.body?.key || '');
    const { matches } = await caughtNow();
    const m = matches.find((x) => x.key === key);
    if (!m) return res.status(404).json({ error: 'no rule catches that series right now', code: 'gone' });
    if (m.state === 'waiting' && m.needsOk) { store.approvePending(m); return res.json({ approved: true }); }
    if (m.state !== 'ask') return res.status(409).json({ error: 'that series is not waiting for an answer', code: 'gone' });
    try {
      const r = await adder(ownDb(), kick(req))(m);
      store.record('added', m, r.seriesId);
      store.unpend(m.nameKey);
      log('info', `Added ${m.series} (rule "${m.keyword}", approved on the page)${r.queued ? `, ${r.queued} released issue${r.queued === 1 ? '' : 's'} queued` : ''}`);
      res.json({ added: { cvId: m.cvId, seriesId: r.seriesId, queued: r.queued } });
    } catch (e) {
      log('warn', `Could not add ${m.series}: ${e?.message || e}`);
      res.status(e?.rateLimited ? 429 : 500).json({ error: e?.rateLimited ? 'the catalog is busy right now, try again shortly' : String(e?.message || e) });
    }
  });

  // Take a series off the record: a skipped one is caught again, and one that
  // was added and later deleted may be added again.
  route('post', '/api/autoadd/forget', (req, res) => {
    const cvId = Number(req.body?.cvId) || null;
    const nameKey = req.body?.nameKey ? String(req.body.nameKey) : null;
    let forgotten = false;
    if (cvId) forgotten = store.forget(cvId) || forgotten;
    if (nameKey) forgotten = store.unskipPending(nameKey) || forgotten;
    res.json({ forgotten });
  });

  // Run the rules now. Answers when the pass is done; it shows on the Jobs
  // page like the scheduled one.
  route('post', '/api/autoadd/run', async (req, res) => {
    let summary = null;
    await asJob(JOB_LABEL, async () => (summary = await runPass(ownDb(), kick(req))));
    res.json(summary);
  });
}
