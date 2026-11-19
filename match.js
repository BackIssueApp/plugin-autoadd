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

// Validate what the rule form sent. Returns { rule } or { error }.
export function cleanRule(input = {}) {
  const keyword = String(input.keyword ?? '').replace(/\s+/g, ' ').trim();
  if (normalize(keyword).length < 2) return { error: 'a keyword of at least two characters is required' };
  if (keyword.length > MAX_TEXT) return { error: 'the keyword is too long' };
  const publisher = String(input.publisher ?? '').replace(/\s+/g, ' ').trim();
  if (publisher.length > MAX_TEXT) return { error: 'the publisher is too long' };
  const exclude = excludesOf(input.exclude).filter((x) => normalize(x));
  if (exclude.length > MAX_EXCLUDES || exclude.some((x) => x.length > MAX_TEXT)) return { error: 'too many words to leave out' };
  return {
    rule: {
      keyword,
      publisher,
      exclude: exclude.join(', '),
      skipCollected: input.skipCollected === undefined ? true : !!input.skipCollected,
      scope: SCOPES.includes(input.scope) ? input.scope : 'all',
    },
  };
}

// Does this rule catch that release-list entry?
export function ruleMatches(rule, rel) {
  const name = normalize(rel?.series);
  if (!name || !hasPhrase(name, normalize(rule.keyword))) return false;
  if (excludesOf(rule.exclude).some((x) => hasPhrase(name, normalize(x)))) return false;
  if (rule.publisher && !normalize(rel.publisher).includes(normalize(rule.publisher))) return false;
  if (rule.skipCollected && isCollected(rel.type)) return false;
  return true;
}

const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);

// Every series the rules catch across the given weeks, one row per series,
// carrying the first issue of it that shows up (the weeks arrive oldest
// first). The first rule that catches a series owns it. A series the list
// has no catalog id for yet is kept, keyed by name and start year, so the
// page can say it is waiting.
export function collect(rules, weeks) {
  const active = (rules || []).filter((r) => r.enabled !== false && r.enabled !== 0);
  const out = new Map();
  for (const w of weeks || []) {
    for (const rel of w?.releases || []) {
      const rule = active.find((r) => ruleMatches(r, rel));
      if (!rule) continue;
      const cvId = Number(rel.comicid) || null;
      const key = cvId ? 'id:' + cvId : 'name:' + normalize(rel.series) + '|' + (rel.seriesyear ?? '');
      const ship = day(rel.shipdate);
      const seen = out.get(key);
      if (seen) {
        seen.issues++;
        seen.upcoming.push({ number: rel.issue ?? null, shipdate: ship });
        if (ship && (!seen.shipdate || ship < seen.shipdate)) { seen.shipdate = ship; seen.number = rel.issue ?? seen.number; }
        continue;
      }
      out.set(key, {
        key, cvId,
        series: String(rel.series || '').trim(),
        publisher: rel.publisher ? String(rel.publisher).trim() : null,
        seriesYear: rel.seriesyear != null && String(rel.seriesyear) !== '' ? String(rel.seriesyear) : null,
        type: rel.type ? String(rel.type).trim() : null,
        number: rel.issue != null && String(rel.issue) !== '' ? String(rel.issue) : null,
        shipdate: ship,
        issues: 1,
        upcoming: [{ number: rel.issue ?? null, shipdate: ship }],
        ruleId: rule.id ?? null,
        keyword: rule.keyword,
        scope: rule.scope || 'all',
      });
    }
  }
  return [...out.values()].sort((a, b) =>
    String(a.shipdate || '9999').localeCompare(String(b.shipdate || '9999')) || a.series.localeCompare(b.series));
}

// What happens to each caught series:
//   waiting  the list has no catalog id for it yet; it is looked at again on every run
//   skipped  someone said "not this one"
//   library  already in the library, however it got there
//   removed  a rule added it before and it was deleted since; never added twice
//   new      will be added on the next run
// `tracked` maps catalog id to library series id; `handled` maps catalog id to
// the plugin's own record of it ({ status: 'added' | 'skipped' }).
export function classify(matches, { tracked = new Map(), handled = new Map() } = {}) {
  return matches.map((m) => {
    const h = m.cvId ? handled.get(m.cvId) : null;
    const seriesId = m.cvId ? tracked.get(m.cvId) ?? null : null;
    let state = 'new';
    if (!m.cvId) state = 'waiting';
    else if (h?.status === 'skipped') state = 'skipped';
    else if (seriesId != null) state = 'library';
    else if (h?.status === 'added') state = 'removed';
    return { ...m, state, seriesId };
  });
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
