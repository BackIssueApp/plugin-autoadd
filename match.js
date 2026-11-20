// Rule matching for Auto-add: which entries of the weekly release list a rule
// catches, and what should happen to each caught series. Pure functions, no
// core imports and no I/O, so the whole decision is testable on its own.

// A release "type" that is a collected edition rather than a single issue.
// Same words the Releases page uses to hide collections.
const COLLECTED = /trade|hard ?cover|omnibus|collect|graphic novel|tpb|paperback|compendium/i;
export const isCollected = (type) => !!type && COLLECTED.test(String(type));

export const SCOPES = ['all', 'new'];
const MAX_TEXT = 80;
const MAX_EXCLUDES = 10;
// The most series one rule adds on its own in a single check. A rule that
// would add more than this at once is probably wider than its author meant
// ("Marvel" with nothing else catches some forty series), so none of them
// are added: they all wait for a yes or no instead.
export const BURST_MAX = 10;

// Lowercase, accents folded, punctuation to spaces: "Star Trek: Zero Point"
// and "star trek zero-point" read the same.
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Whole words only, so "ant" does not catch "Giant". Scripts written without
// spaces between words cannot be held to that, so they match anywhere.
export function hasPhrase(haystack, needle) {
  if (!needle) return false;
  if (/[^\x00-\x7f]/.test(needle)) return haystack.includes(needle);
  return (' ' + haystack + ' ').includes(' ' + needle + ' ');
}

const excludesOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((x) => String(x).trim()).filter(Boolean);

// Validate what the rule form sent. Returns { rule } or { error }. A rule
// needs a name to look for, or failing that a publisher: with no name it
// catches every series that publisher puts on the list.
export function cleanRule(input = {}) {
  const keyword = String(input.keyword ?? '').replace(/\s+/g, ' ').trim();
  const publisher = String(input.publisher ?? '').replace(/\s+/g, ' ').trim();
  if (keyword && normalize(keyword).length < 2) return { error: 'the name to look for needs at least two characters' };
  if (!keyword && normalize(publisher).length < 2) return { error: 'a name to look for, or a publisher, of at least two characters is required' };
  if (keyword.length > MAX_TEXT) return { error: 'the keyword is too long' };
  if (publisher.length > MAX_TEXT) return { error: 'the publisher is too long' };
  const library = Number(input.libraryId);
  const exclude = excludesOf(input.exclude).filter((x) => normalize(x));
  if (exclude.length > MAX_EXCLUDES || exclude.some((x) => x.length > MAX_TEXT)) return { error: 'too many words to leave out' };
  return {
    rule: {
      keyword,
      publisher,
      exclude: exclude.join(', '),
      skipCollected: input.skipCollected === undefined ? true : !!input.skipCollected,
      newOnly: !!input.newOnly,
      ask: !!input.ask,
      scope: SCOPES.includes(input.scope) ? input.scope : 'all',
      libraryId: Number.isInteger(library) && library > 0 ? library : null,
    },
  };
}

// What a rule is called where there is only room for a word or two: the name
// it looks for, or its publisher when it has no name.
export const ruleLabel = (rule) => rule?.keyword || rule?.publisher || '';

// Does this rule catch that release-list entry? (Whether the series is new
// is a question about the series, not one entry: see collect.)
export function ruleMatches(rule, rel) {
  const name = normalize(rel?.series);
  if (!name) return false;
  const keyword = normalize(rule.keyword);
  if (keyword ? !hasPhrase(name, keyword) : !normalize(rule.publisher)) return false;
  if (excludesOf(rule.exclude).some((x) => hasPhrase(name, normalize(x)))) return false;
  if (rule.publisher && !normalize(rel.publisher).includes(normalize(rule.publisher))) return false;
  if (rule.skipCollected && isCollected(rel.type)) return false;
  return true;
}

const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);
const isFirstIssue = (number) => { const n = parseFloat(number); return Number.isFinite(n) && n <= 1; };

// What a series is called on the list, whether or not the list has a catalog
// id for it yet. This is how a series caught early is recognised again later.
export const nameKeyOf = (series, year) => normalize(series) + '|' + (year ?? '');

// Every series the rules catch across the given weeks, one row per series,
// carrying the next issue of it to ship. Weeks arrive oldest first; a week
// marked `past` has already gone by and is only read to follow up on a
// series that was caught earlier and is still waiting (`pending`, a set of
// name keys): a series seen only in past weeks is otherwise not caught.
//
// The first rule that catches a series owns it. A "new series only" rule
// catches a series when its first issue is among the weeks read, or when it
// was already waiting. A series the list has no catalog id for yet is kept,
// keyed by name and start year, so the page can say it is waiting.
export function collect(rules, weeks, { pending = new Set() } = {}) {
  const active = (rules || []).filter((r) => r.enabled !== false && r.enabled !== 0);
  const rows = new Map();
  for (const w of weeks || []) {
    for (const rel of w?.releases || []) {
      const catching = active.filter((r) => ruleMatches(r, rel));
      if (!catching.length) continue;
      const cvId = Number(rel.comicid) || null;
      const nameKey = nameKeyOf(rel.series, rel.seriesyear);
      const key = cvId ? 'id:' + cvId : 'name:' + nameKey;
      const ship = day(rel.shipdate);
      const number = rel.issue != null && String(rel.issue) !== '' ? String(rel.issue) : null;
      let row = rows.get(key);
      if (!row) {
        row = {
          key, nameKey, cvId,
          series: String(rel.series || '').trim(),
          publisher: rel.publisher ? String(rel.publisher).trim() : null,
          seriesYear: rel.seriesyear != null && String(rel.seriesyear) !== '' ? String(rel.seriesyear) : null,
          type: rel.type ? String(rel.type).trim() : null,
          number: null, shipdate: null,
          issues: 0, upcoming: [],
          ahead: false, first: false, catching,
        };
        rows.set(key, row);
      }
      row.issues++;
      row.upcoming.push({ number, shipdate: ship });
      if (isFirstIssue(number)) row.first = true;
      // The issue shown (and the one a "from the upcoming issue" rule starts
      // at) is the earliest still on this week's list or later; a series only
      // seen in past weeks falls back to its earliest issue there.
      const better = !row.shipdate || (ship && ship < row.shipdate);
      if (!w.past) {
        if (!row.ahead || better) { row.number = number; row.shipdate = ship; }
        row.ahead = true;
      } else if (!row.ahead && (row.number == null || better)) { row.number = number; row.shipdate = ship; }
    }
  }
  const out = [];
  for (const row of rows.values()) {
    const waiting = pending.has(row.nameKey);
    if (!row.ahead && !waiting) continue;
    const rule = row.catching.find((r) => !r.newOnly || row.first || waiting);
    if (!rule) continue;
    const { catching, ...rest } = row;
    out.push({ ...rest, ruleId: rule.id ?? null, keyword: ruleLabel(rule), scope: rule.scope || 'all', ask: !!rule.ask, libraryId: rule.libraryId ?? null });
  }
  return out.sort((a, b) =>
    String(a.shipdate || '9999').localeCompare(String(b.shipdate || '9999')) || a.series.localeCompare(b.series));
}

// What happens to each caught series:
//   waiting  the list has no catalog id for it yet; it is looked at again on every run
//   skipped  someone said "not this one"
//   library  already in the library, however it got there
//   removed  a rule added it before and it was deleted since; never added twice
//   ask      its rule asks first, and nobody has said yes yet
//   new      will be added on the next run
// `needsOk` marks a series that is held until someone says yes: every `ask`
// one, and a `waiting` one whose rule asks first. `hold` says why it is held:
// 'rule' when its rule asks first, 'burst' when its rule caught more series
// than it may add on its own in one go.
// `tracked` maps catalog id to library series id; `handled` maps catalog id to
// the plugin's own record of it ({ status: 'added' | 'skipped' }); `skippedKeys`
// and `approvedKeys` hold the name keys of series someone said no or yes to;
// `heldKeys` those of series an earlier burst put on hold (a hold sticks
// until someone answers, however few are left). With `burstMax`, a rule that
// would add more series than that at once has all of them held instead.
export function classify(matches, { tracked = new Map(), handled = new Map(), skippedKeys = new Set(), approvedKeys = new Set(), heldKeys = new Set(), burstMax = Infinity } = {}) {
  const out = matches.map((m) => {
    const h = m.cvId ? handled.get(m.cvId) : null;
    const seriesId = m.cvId ? tracked.get(m.cvId) ?? null : null;
    const why = approvedKeys.has(m.nameKey) ? null : m.ask ? 'rule' : heldKeys.has(m.nameKey) ? 'burst' : null;
    let state = 'new';
    if (h?.status === 'skipped' || skippedKeys.has(m.nameKey)) state = 'skipped';
    else if (!m.cvId) state = 'waiting';
    else if (seriesId != null) state = 'library';
    else if (h?.status === 'added') state = 'removed';
    else if (why) state = 'ask';
    const needsOk = !!why && (state === 'ask' || state === 'waiting');
    return { ...m, state, seriesId, needsOk, hold: needsOk ? why : null };
  });
  // What each rule is about to add on its own. A series someone already said
  // yes to is not part of the count: it has its answer.
  const about = new Map();
  for (const m of out) {
    if (m.state !== 'new' || approvedKeys.has(m.nameKey)) continue;
    if (!about.has(m.ruleId)) about.set(m.ruleId, []);
    about.get(m.ruleId).push(m);
  }
  for (const rows of about.values()) {
    if (rows.length <= burstMax) continue;
    for (const m of rows) { m.state = 'ask'; m.needsOk = true; m.hold = 'burst'; }
  }
  return out;
}

// Of a just-added series' wanted issues, the ones that are already out. The
// catalog rarely has dates this early, but the release list says which issue
// numbers are still to ship: anything numbered below the first of those is
// out. An issue shipping today counts as out; one with no ship date does not.
export function alreadyOut(issues, upcoming, today) {
  const ahead = (upcoming || [])
    .filter((u) => !u.shipdate || u.shipdate > today)
    .map((u) => parseFloat(u.number)).filter(Number.isFinite);
  if (!ahead.length) return [...issues];
  const first = Math.min(...ahead);
  return issues.filter((i) => { const n = parseFloat(i.issue_number); return !Number.isFinite(n) || n < first; });
}

// The catalog's existing series a rule would have caught: the same name,
// publisher and left-out-words tests, minus what is already in the library.
// The catalog has no format field, so "single issues only" goes by the name.
// `volumes` are { id, name, publisher, start_year, count_of_issues } (the
// publisher may be an object with a name); newest first.
export function pickExisting(rule, volumes, trackedIds = new Set()) {
  const seen = new Set();
  const out = [];
  for (const v of volumes || []) {
    const id = Number(v?.id);
    if (!id || seen.has(id) || trackedIds.has(id)) continue;
    const publisher = v.publisher && typeof v.publisher === 'object' ? v.publisher.name : v.publisher;
    if (!ruleMatches({ ...rule, skipCollected: false }, { series: v.name, publisher })) continue;
    if (rule.skipCollected && isCollected(v.name)) continue;
    seen.add(id);
    out.push({
      cvId: id,
      series: String(v.name || '').trim(),
      publisher: publisher ? String(publisher).trim() : null,
      seriesYear: v.start_year != null && String(v.start_year) !== '' ? String(v.start_year) : null,
      issues: Number(v.count_of_issues) || 0,
    });
  }
  return out.sort((a, b) => String(b.seriesYear || '').localeCompare(String(a.seriesYear || '')) || a.series.localeCompare(b.series));
}
