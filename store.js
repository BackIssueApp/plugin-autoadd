// Auto-add state: plugin-owned tables inside the app's database, so backups
// cover them. Rules are what the user wrote; autoadd_series is the record of
// every series a rule has dealt with (added, or skipped by hand), which is
// what keeps a series from being added a second time after it was removed.
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
    CREATE TABLE IF NOT EXISTS autoadd_meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const shape = (r) => r && ({
    id: r.id, keyword: r.keyword, publisher: r.publisher || '', exclude: r.exclude || '',
    skipCollected: !!r.skip_collected, scope: r.scope === 'new' ? 'new' : 'all',
    enabled: !!r.enabled, createdBy: r.created_by || null, createdAt: r.created_at,
  });

  return {
    close: () => db.close(),

    rules: () => db.prepare('SELECT * FROM autoadd_rules ORDER BY id').all().map(shape),
    rule: (id) => shape(db.prepare('SELECT * FROM autoadd_rules WHERE id = ?').get(Number(id))),

    createRule(rule, byName = null) {
      const r = db.prepare(`INSERT INTO autoadd_rules (keyword, publisher, exclude, skip_collected, scope, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(rule.keyword, rule.publisher || '', rule.exclude || '', rule.skipCollected ? 1 : 0, rule.scope, byName);
      return this.rule(r.lastInsertRowid);
    },

    // Replace a rule's fields; `enabled` alone flips the switch.
    updateRule(id, patch) {
      const cur = this.rule(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE autoadd_rules SET keyword=?, publisher=?, exclude=?, skip_collected=?, scope=?, enabled=? WHERE id=?')
        .run(next.keyword, next.publisher || '', next.exclude || '', next.skipCollected ? 1 : 0, next.scope, next.enabled ? 1 : 0, cur.id);
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

    getMeta(key) {
      const v = db.prepare('SELECT value FROM autoadd_meta WHERE key = ?').get(key)?.value;
      try { return v ? JSON.parse(v) : null; } catch { return null; }
    },
    setMeta: (key, value) => db.prepare('INSERT INTO autoadd_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value)),
  };
}
