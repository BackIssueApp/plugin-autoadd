// Auto-add state: plugin-owned tables inside the app's database, so backups
// cover them. Rules are what the user wrote. autoadd_series is the record of
// every series a rule has dealt with (added, or skipped by hand), which is
// what keeps a series from being added a second time after it was removed.
// autoadd_pending holds the series a rule caught before the release list had
// a catalog id for them: they are known by name until the id arrives.
import Database from 'better-sqlite3';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

export function openStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS autoadd_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      publisher TEXT NOT NULL DEFAULT '',
      exclude TEXT NOT NULL DEFAULT '',
      skip_collected INTEGER NOT NULL DEFAULT 1,
      new_only INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'all',          -- all | new
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE TABLE IF NOT EXISTS autoadd_series (
      cv_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,                       -- added | skipped
      rule_id INTEGER,
      keyword TEXT,
      title TEXT, publisher TEXT, year TEXT,
      series_id INTEGER,
      issue_number TEXT, ship_date TEXT,
      at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE TABLE IF NOT EXISTS autoadd_pending (
      name_key TEXT PRIMARY KEY,                  -- normalized name | start year
      title TEXT, year TEXT, keyword TEXT, rule_id INTEGER,
      issue_number TEXT, ship_date TEXT,
      skipped INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE TABLE IF NOT EXISTS autoadd_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Columns added after the first build.
  const ruleCols = db.prepare("SELECT name FROM pragma_table_info('autoadd_rules')").all().map((r) => r.name);
  if (!ruleCols.includes('new_only')) db.exec('ALTER TABLE autoadd_rules ADD COLUMN new_only INTEGER NOT NULL DEFAULT 0');

  const shape = (r) => r && ({
    id: r.id, keyword: r.keyword, publisher: r.publisher || '', exclude: r.exclude || '',
    skipCollected: !!r.skip_collected, newOnly: !!r.new_only, scope: r.scope === 'new' ? 'new' : 'all',
    enabled: !!r.enabled, createdBy: r.created_by || null, createdAt: r.created_at,
  });

  return {
    close: () => db.close(),

    rules: () => db.prepare('SELECT * FROM autoadd_rules ORDER BY id').all().map(shape),
    rule: (id) => shape(db.prepare('SELECT * FROM autoadd_rules WHERE id = ?').get(Number(id))),

    createRule(rule, byName = null) {
      const r = db.prepare(`INSERT INTO autoadd_rules (keyword, publisher, exclude, skip_collected, new_only, scope, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(rule.keyword, rule.publisher || '', rule.exclude || '', rule.skipCollected ? 1 : 0, rule.newOnly ? 1 : 0, rule.scope, byName);
      return this.rule(r.lastInsertRowid);
    },

    // Replace a rule's fields; `enabled` alone flips the switch.
    updateRule(id, patch) {
      const cur = this.rule(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE autoadd_rules SET keyword=?, publisher=?, exclude=?, skip_collected=?, new_only=?, scope=?, enabled=? WHERE id=?')
        .run(next.keyword, next.publisher || '', next.exclude || '', next.skipCollected ? 1 : 0, next.newOnly ? 1 : 0, next.scope, next.enabled ? 1 : 0, cur.id);
      return this.rule(cur.id);
    },

    deleteRule: (id) => db.prepare('DELETE FROM autoadd_rules WHERE id = ?').run(Number(id)).changes > 0,

    // catalog id → { status, … } for every series a rule has dealt with.
    handled() {
      const m = new Map();
      for (const r of db.prepare('SELECT cv_id, status, series_id FROM autoadd_series').all()) m.set(r.cv_id, r);
      return m;
    },

    // Remember a series as added or skipped; the newest word on it wins.
    record(status, m, seriesId = null) {
      db.prepare(`INSERT INTO autoadd_series (cv_id, status, rule_id, keyword, title, publisher, year, series_id, issue_number, ship_date, at)
        VALUES (@cvId, @status, @ruleId, @keyword, @title, @publisher, @year, @seriesId, @number, @shipdate, ${NOW})
        ON CONFLICT(cv_id) DO UPDATE SET status=excluded.status, rule_id=excluded.rule_id, keyword=excluded.keyword,
          title=excluded.title, publisher=excluded.publisher, year=excluded.year, series_id=excluded.series_id,
          issue_number=excluded.issue_number, ship_date=excluded.ship_date, at=excluded.at`)
        .run({
          cvId: m.cvId, status, ruleId: m.ruleId ?? null, keyword: m.keyword ?? null, title: m.series ?? null,
          publisher: m.publisher ?? null, year: m.seriesYear ?? null, seriesId, number: m.number ?? null, shipdate: m.shipdate ?? null,
        });
    },

    forget: (cvId) => db.prepare('DELETE FROM autoadd_series WHERE cv_id = ?').run(Number(cvId)).changes > 0,

    history: (limit = 200) => db.prepare('SELECT * FROM autoadd_series ORDER BY at DESC, cv_id DESC LIMIT ?').all(limit).map((r) => ({
      cvId: r.cv_id, status: r.status, ruleId: r.rule_id, keyword: r.keyword, series: r.title, publisher: r.publisher,
      seriesYear: r.year, seriesId: r.series_id, number: r.issue_number, shipdate: r.ship_date, at: r.at,
    })),

    // ---- series caught before the list had a catalog id for them ----
    // Name keys of everything waiting (skipped or not): a series in here is
    // followed up even after its issues have left the weeks ahead.
    pendingKeys: () => new Set(db.prepare('SELECT name_key FROM autoadd_pending').all().map((r) => r.name_key)),
    skippedKeys: () => new Set(db.prepare('SELECT name_key FROM autoadd_pending WHERE skipped = 1').all().map((r) => r.name_key)),

    // Start waiting on a series. True the first time it is seen, which is
    // when people are told about it.
    pend(m) {
      return db.prepare(`INSERT OR IGNORE INTO autoadd_pending (name_key, title, year, keyword, rule_id, issue_number, ship_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(m.nameKey, m.series ?? null, m.seriesYear ?? null, m.keyword ?? null, m.ruleId ?? null, m.number ?? null, m.shipdate ?? null).changes > 0;
    },
    // "Not this one" for a series that is still waiting, and taking it back.
    skipPending(m, skipped = true) {
      this.pend(m);
      return db.prepare('UPDATE autoadd_pending SET skipped = ? WHERE name_key = ?').run(skipped ? 1 : 0, m.nameKey).changes > 0;
    },
    unskipPending: (nameKey) => db.prepare('UPDATE autoadd_pending SET skipped = 0 WHERE name_key = ? AND skipped = 1').run(String(nameKey)).changes > 0,
    unpend: (nameKey) => db.prepare('DELETE FROM autoadd_pending WHERE name_key = ?').run(String(nameKey)).changes > 0,
    // A series that never got its id is let go after a few months.
    prunePending(days = 120, now = Date.now()) {
      const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 19) + 'Z';
      return db.prepare('DELETE FROM autoadd_pending WHERE first_seen < ?').run(cutoff).changes;
    },

    getMeta(key) {
      const v = db.prepare('SELECT value FROM autoadd_meta WHERE key = ?').get(key)?.value;
      try { return v ? JSON.parse(v) : null; } catch { return null; }
    },
    setMeta: (key, value) => db.prepare('INSERT INTO autoadd_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value)),
  };
}
