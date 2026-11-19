// Auto-add client, injected via window.BackIssue. Adds an "Auto-add" entry to
// the sidebar that opens one page: the rules, a form for a new rule with a
// live look at what it would catch, the series the rules catch in the weeks
// ahead, and the record of what they have added. Shown only to accounts that
// may manage the rules; the server enforces that regardless.
(function () {
  window.BackIssue.registerClient((api) => {
    const esc = api.escapeHtml;
    // Translations: api.t when the host has it, the inline English otherwise.
    // Catalog: locales/<lang>.json, namespace "autoadd". `en` may be a
    // { one, other } pair; the fallback picks on params.count.
    const fill = (s, p) => {
      if (s && typeof s === 'object') s = p && Number(p.count) === 1 ? s.one : s.other;
      return p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k]))) : String(s);
    };
    const tr = (key, en, params) => { if (typeof api.t !== 'function') return fill(en, params); const v = api.t('autoadd.' + key, params); return v === 'autoadd.' + key ? fill(en, params) : v; };

    // The host answers a refused request with { error } instead of throwing;
    // either way the caller gets an exception, with the server's `code` on it.
    const checked = async (p) => {
      const r = await p;
      if (r && typeof r === 'object' && r.error) throw Object.assign(new Error(r.error), { code: r.code || null });
      return r;
    };
    const get = (path) => checked(api.get(path));
    const post = (path, body) => checked(api.post(path, body || {}));
    const CODE_TEXT = {
      duplicate: () => tr('error.duplicate', 'A rule like this one already exists.'),
      gone: () => tr('error.gone', 'That series is no longer waiting to be added.'),
    };
    const say = (err) => toast((err?.code && CODE_TEXT[err.code]?.()) || String(err?.message || err), 'error');
    const toast = (msg, type) => { try { api.toast?.(msg, type); } catch { /* older host */ } };
    const icon = (name, fallback) => (api.icon && api.icon(name)) || fallback;

    let overlay = null;
    let state = { rules: [], history: [], lastRun: null, weeksAhead: 8 };
    let matches = null;      // null = still loading
    let matchesError = null;
    let previewTimer = null;
    let previewSeq = 0;

    const day = (iso) => {
      if (!iso) return '';
      const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T12:00:00' : iso);
      if (isNaN(d)) return String(iso);
      try { return d.toLocaleDateString(api.lang?.() || undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
      catch { return d.toLocaleDateString(); }
    };
    const nameOf = (m) => esc(m.series || '') + (m.seriesYear ? ' <span class="aa-dim">(' + esc(m.seriesYear) + ')</span>' : '');
    const shipsOf = (m) => {
      if (m.number && m.shipdate) return tr('match.ships', '#{number} ships {date}', { number: m.number, date: day(m.shipdate) });
      if (m.shipdate) return tr('match.shipsNoNumber', 'Ships {date}', { date: day(m.shipdate) });
      return '';
    };
    const STATE_LABEL = {
      new: () => tr('state.new', 'Will be added'),
      waiting: () => tr('state.waiting', 'Waiting for details'),
      library: () => tr('state.library', 'In your library'),
      skipped: () => tr('state.skipped', 'Skipped'),
      removed: () => tr('state.removed', 'Removed from your library'),
    };
    const chip = (st) => '<span class="aa-chip aa-chip--' + st + '">' + esc(STATE_LABEL[st]()) + '</span>';

    // ---- data ----
    async function loadState() {
      state = await get('/api/autoadd/state');
      paintRules(); paintHistory(); paintLastRun();
    }
    async function loadMatches() {
      matches = null; matchesError = null; paintMatches();
      try {
        const r = await get('/api/autoadd/matches');
        matches = r.matches || [];
      } catch (e) { matches = []; matchesError = String(e?.message || e); }
      paintMatches();
    }
    const reload = () => Promise.all([loadState(), loadMatches()]).catch(say);

    // ---- rules ----
    function ruleDetails(r) {
      const bits = [];
      if (r.publisher) bits.push(tr('rule.publisher', 'Publisher: {publisher}', { publisher: r.publisher }));
      if (r.exclude) bits.push(tr('rule.exclude', 'Leaves out: {words}', { words: r.exclude }));
      bits.push(r.skipCollected ? tr('rule.noCollected', 'Single issues only') : tr('rule.withCollected', 'Collected editions too'));
      bits.push(r.scope === 'new' ? tr('rule.scopeNew', 'From the upcoming issue on') : tr('rule.scopeAll', 'Every issue'));
      return bits.map(esc).join(' · ');
    }
    function paintRules() {
      const el = overlay?.querySelector('.aa__rules');
      if (!el) return;
      if (!state.rules.length) {
        el.innerHTML = '<p class="aa-empty">' + esc(tr('rules.empty', 'No rules yet. Write one below.')) + '</p>';
        return;
      }
      el.innerHTML = state.rules.map((r) =>
        '<div class="aa-row' + (r.enabled ? '' : ' aa-row--off') + '" data-id="' + r.id + '">' +
          '<label class="switch switch--sm" title="' + esc(tr('rules.toggle', 'Turn this rule on or off')) + '"><input type="checkbox" class="aa-rule__on"' + (r.enabled ? ' checked' : '') + '><span class="switch__track"></span></label>' +
          '<div class="aa-row__main"><div class="aa-row__title">' + esc(r.keyword) + '</div><div class="aa-row__meta">' + ruleDetails(r) + '</div></div>' +
          '<button class="btn btn--ghost btn--sm aa-rule__del">' + esc(tr('rules.delete', 'Delete')) + '</button>' +
        '</div>').join('');
      for (const row of el.querySelectorAll('.aa-row')) {
        const id = Number(row.dataset.id);
        row.querySelector('.aa-rule__on').onchange = async (e) => {
          try { await post('/api/autoadd/rules/' + id, { enabled: e.target.checked }); await reload(); }
          catch (err) { say(err); e.target.checked = !e.target.checked; }
        };
        row.querySelector('.aa-rule__del').onclick = async () => {
          const rule = state.rules.find((x) => x.id === id);
          if (!window.confirm(tr('rules.deleteConfirm', 'Delete the rule “{keyword}”? Series it already added stay in your library.', { keyword: rule?.keyword || '' }))) return;
          try { await post('/api/autoadd/rules/' + id + '/delete'); toast(tr('rules.deleted', 'Rule deleted')); await reload(); }
          catch (err) { say(err); }
        };
      }
    }

    // ---- new rule + preview ----
    function formRule() {
      const q = (s) => overlay.querySelector(s);
      return {
        keyword: q('.aa-f__keyword').value,
        publisher: q('.aa-f__publisher').value,
        exclude: q('.aa-f__exclude').value,
        skipCollected: q('.aa-f__collected').checked,
        scope: q('.aa-f__scope').value,
      };
    }
    function paintPreview(html) { const el = overlay?.querySelector('.aa__preview'); if (el) el.innerHTML = html; }
    function schedulePreview() {
      clearTimeout(previewTimer);
      const rule = formRule();
      overlay.querySelector('.aa-f__save').disabled = rule.keyword.trim().length < 2;
      if (rule.keyword.trim().length < 2) { previewSeq++; paintPreview(''); return; }
      previewTimer = setTimeout(async () => {
        const seq = ++previewSeq;
        paintPreview('<p class="aa-note">' + esc(tr('preview.loading', 'Looking at the weeks ahead…')) + '</p>');
        let r;
        try { r = await post('/api/autoadd/preview', rule); }
        catch (e) { r = { matches: [], error: String(e?.message || e) }; }
        if (seq !== previewSeq) return; // an older answer arriving late
        if (r.error) return paintPreview('<p class="aa-note aa-note--bad">' + esc(tr('preview.failed', 'The release list could not be read: {error}', { error: r.error })) + '</p>');
        if (r.invalid) return paintPreview('');
        const list = r.matches || [];
        if (!list.length) return paintPreview('<p class="aa-note">' + esc(tr('preview.none', 'Nothing in the next {weeks} weeks matches yet. The rule keeps watching.', { weeks: state.weeksAhead })) + '</p>');
        paintPreview(
          '<p class="aa-note">' + esc(tr('preview.count', { one: 'This rule catches {count} series in the next {weeks} weeks:', other: 'This rule catches {count} series in the next {weeks} weeks:' }, { count: list.length, weeks: state.weeksAhead })) + '</p>' +
          '<ul class="aa-preview">' + list.map((m) =>
            '<li><span class="aa-preview__name">' + nameOf(m) + '</span><span class="aa-dim">' + esc([m.publisher, shipsOf(m)].filter(Boolean).join(' · ')) + '</span>' + chip(m.state) + '</li>').join('') + '</ul>');
      }, 350);
    }
    async function saveRule(e) {
      e.preventDefault();
      const btn = overlay.querySelector('.aa-f__save');
      btn.disabled = true;
      try {
        await post('/api/autoadd/rules', formRule());
        toast(tr('form.saved', 'Rule saved'));
        overlay.querySelector('.aa__form').reset();
        previewSeq++; paintPreview('');
        await reload();
      } catch (err) { say(err); btn.disabled = false; }
    }

    // ---- what the rules catch ----
    function paintMatches() {
      const el = overlay?.querySelector('.aa__matches');
      if (!el) return;
      if (matches === null) { el.innerHTML = '<p class="aa-note">' + esc(tr('matches.loading', 'Reading the release list…')) + '</p>'; return; }
      if (matchesError) { el.innerHTML = '<p class="aa-note aa-note--bad">' + esc(tr('preview.failed', 'The release list could not be read: {error}', { error: matchesError })) + '</p>'; return; }
      if (!matches.length) {
        el.innerHTML = '<p class="aa-empty">' + esc(state.rules.some((r) => r.enabled)
          ? tr('matches.empty', 'Nothing in the next {weeks} weeks matches your rules yet.', { weeks: state.weeksAhead })
          : tr('matches.noRules', 'Series your rules catch show up here.')) + '</p>';
        return;
      }
      el.innerHTML = matches.map((m) => {
        let action = '';
        if (m.state === 'new') action = '<button class="btn btn--ghost btn--sm" data-act="skip">' + esc(tr('matches.skip', 'Skip')) + '</button>';
        else if (m.state === 'skipped') action = '<button class="btn btn--ghost btn--sm" data-act="forget">' + esc(tr('matches.allow', 'Allow')) + '</button>';
        else if (m.state === 'removed') action = '<button class="btn btn--ghost btn--sm" data-act="forget">' + esc(tr('matches.addAgain', 'Add again')) + '</button>';
        else if (m.state === 'library' && m.seriesId != null) action = '<button class="btn btn--ghost btn--sm" data-act="open">' + esc(tr('matches.open', 'Open')) + '</button>';
        return '<div class="aa-row" data-cv="' + (m.cvId || '') + '" data-series="' + (m.seriesId ?? '') + '">' +
          '<div class="aa-row__main"><div class="aa-row__title">' + nameOf(m) + '</div>' +
          '<div class="aa-row__meta">' + esc([m.publisher, shipsOf(m), tr('match.rule', 'Rule: {keyword}', { keyword: m.keyword })].filter(Boolean).join(' · ')) + '</div></div>' +
          chip(m.state) + action + '</div>';
      }).join('');
      wireRowActions(el);
    }
    function wireRowActions(el) {
      for (const b of el.querySelectorAll('button[data-act]')) {
        const row = b.closest('.aa-row');
        const cvId = Number(row.dataset.cv);
        b.onclick = async () => {
          try {
            if (b.dataset.act === 'open') { close(); return api.openSeries ? api.openSeries(Number(row.dataset.series)) : (location.href = '/volume/' + Number(row.dataset.series)); }
            b.disabled = true;
            if (b.dataset.act === 'skip') await post('/api/autoadd/skip', { cvId });
            if (b.dataset.act === 'forget') await post('/api/autoadd/forget', { cvId });
            await reload();
          } catch (err) { say(err); b.disabled = false; }
        };
      }
    }

    // ---- record ----
    function paintHistory() {
      const el = overlay?.querySelector('.aa__history');
      if (!el) return;
      const rows = state.history || [];
      if (!rows.length) { el.innerHTML = '<p class="aa-empty">' + esc(tr('history.empty', 'Nothing has been added yet.')) + '</p>'; return; }
      el.innerHTML = rows.map((h) => {
        const st = h.status === 'skipped' ? 'skipped' : (h.inLibrary ? 'library' : 'removed');
        let action = '';
        if (st === 'library') action = '<button class="btn btn--ghost btn--sm" data-act="open">' + esc(tr('matches.open', 'Open')) + '</button>';
        else if (st === 'skipped') action = '<button class="btn btn--ghost btn--sm" data-act="forget">' + esc(tr('matches.allow', 'Allow')) + '</button>';
        else action = '<button class="btn btn--ghost btn--sm" data-act="forget">' + esc(tr('matches.addAgain', 'Add again')) + '</button>';
        const when = h.status === 'skipped' ? tr('history.skippedOn', 'Skipped {date}', { date: day(h.at) }) : tr('history.addedOn', 'Added {date}', { date: day(h.at) });
        return '<div class="aa-row" data-cv="' + h.cvId + '" data-series="' + (h.seriesId ?? '') + '">' +
          '<div class="aa-row__main"><div class="aa-row__title">' + nameOf(h) + '</div>' +
          '<div class="aa-row__meta">' + esc([h.publisher, when, h.keyword ? tr('match.rule', 'Rule: {keyword}', { keyword: h.keyword }) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          (st === 'library' ? '' : chip(st)) + action + '</div>';
      }).join('');
      wireRowActions(el);
    }
    function paintLastRun() {
      const el = overlay?.querySelector('.aa__last');
      if (!el) return;
      const r = state.lastRun;
      el.textContent = r?.at
        ? tr('run.last', 'Last checked {date}', { date: new Date(r.at).toLocaleString(api.lang?.() || undefined, { dateStyle: 'medium', timeStyle: 'short' }) })
        : tr('run.never', 'Not checked yet');
    }
    async function runNow() {
      const btn = overlay.querySelector('.aa__run');
      btn.disabled = true; btn.textContent = tr('run.running', 'Checking…');
      try {
        const r = await post('/api/autoadd/run');
        const n = r?.added?.length || 0;
        if (n) toast(tr('run.added', { one: '{count} series added', other: '{count} series added' }, { count: n }), 'ok');
        else if (r?.failed?.length) toast(tr('run.failed', { one: '{count} series could not be added. It is tried again on the next check.', other: '{count} series could not be added. They are tried again on the next check.' }, { count: r.failed.length }), 'error');
        else toast(tr('run.nothing', 'Nothing new to add'));
      } catch (err) { say(err); }
      btn.disabled = false; btn.textContent = tr('run.now', 'Check now');
      await reload();
    }

    // ---- page ----
    function build() {
      overlay = document.createElement('div');
      overlay.className = 'aa';
      overlay.innerHTML =
        '<div class="aa__backdrop"></div>' +
        '<div class="aa__panel" role="dialog" aria-label="' + esc(tr('page.title', 'Auto-add')) + '">' +
          '<div class="aa__head">' +
            '<div class="aa__title">' + esc(tr('page.title', 'Auto-add')) + '</div>' +
            '<span class="aa__last"></span>' +
            '<button class="btn btn--sm aa__run">' + esc(tr('run.now', 'Check now')) + '</button>' +
            '<button class="aa__close" title="' + esc(tr('page.close', 'Close (Esc)')) + '" aria-label="' + esc(tr('page.close', 'Close (Esc)')) + '">' + icon('close', '✕') + '</button>' +
          '</div>' +
          '<div class="aa__body">' +
            '<p class="aa__lead">' + esc(tr('page.lead', 'A rule adds a series to your library as soon as it appears on the release list, up to {weeks} weeks before its first issue ships. The series is then monitored like one you added yourself.', { weeks: state.weeksAhead })) + '</p>' +
            '<section><h3 class="aa__h">' + esc(tr('rules.heading', 'Rules')) + '</h3><div class="aa__rules aa-list"></div>' +
              '<form class="aa__form">' +
                '<div class="aa__fields">' +
                  '<label class="aa-field aa-field--wide"><span>' + esc(tr('form.keyword', 'Series name contains')) + '</span><input type="text" class="aa-f__keyword" maxlength="80" placeholder="' + esc(tr('form.keywordHint', 'e.g. Star Trek')) + '" autocomplete="off"></label>' +
                  '<label class="aa-field"><span>' + esc(tr('form.publisher', 'Publisher (optional)')) + '</span><input type="text" class="aa-f__publisher" maxlength="80" autocomplete="off"></label>' +
                  '<label class="aa-field"><span>' + esc(tr('form.exclude', 'Leave out names containing (optional)')) + '</span><input type="text" class="aa-f__exclude" placeholder="' + esc(tr('form.excludeHint', 'Words, separated by commas')) + '" autocomplete="off"></label>' +
                  '<label class="aa-field"><span>' + esc(tr('form.scope', 'Download')) + '</span><select class="aa-f__scope"><option value="all">' + esc(tr('form.scopeAll', 'Every issue of the series')) + '</option><option value="new">' + esc(tr('form.scopeNew', 'Only the upcoming issue and later')) + '</option></select></label>' +
                  '<label class="aa-check"><input type="checkbox" class="aa-f__collected" checked><span>' + esc(tr('form.collected', 'Single issues only (skip trade paperbacks, hardcovers and omnibuses)')) + '</span></label>' +
                '</div>' +
                '<div class="aa__preview"></div>' +
                '<button class="btn btn--primary aa-f__save" disabled>' + esc(tr('form.save', 'Save rule')) + '</button>' +
              '</form>' +
            '</section>' +
            '<section><h3 class="aa__h">' + esc(tr('matches.heading', 'Caught in the weeks ahead')) + '</h3><div class="aa__matches aa-list"></div></section>' +
            '<section><h3 class="aa__h">' + esc(tr('history.heading', 'Added so far')) + '</h3><div class="aa__history aa-list"></div></section>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.querySelector('.aa__close').onclick = close;
      overlay.querySelector('.aa__backdrop').onclick = close;
      overlay.querySelector('.aa__run').onclick = runNow;
      const form = overlay.querySelector('.aa__form');
      form.onsubmit = saveRule;
      form.addEventListener('input', schedulePreview);
      form.addEventListener('change', schedulePreview);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('is-open')) close(); });
    }
    function open() {
      if (!overlay) build();
      overlay.classList.add('is-open');
      reload();
    }
    function close() { overlay?.classList.remove('is-open'); }

    // ---- sidebar entry ----
    (async () => {
      let allowed = false;
      try {
        // The session may not be resolved yet when this file runs.
        let r = api.me?.();
        if (!r || (!r.user && !r.openMode)) r = await api.get('/api/auth/me');
        const perms = r.openMode ? ['*'] : (r.user?.permissions || []);
        allowed = !!r.openMode || perms.includes('*') || perms.includes('autoadd.manage');
      } catch { allowed = false; }
      if (!allowed) return; // no permission, no surface
      const btn = api.addMenuAction(tr('menu.label', 'Auto-add'), open, icon('zap', ''), { section: 'Discover' });
      if (btn) { btn.id = 'autoadd-btn'; btn.title = tr('menu.title', 'Rules that add upcoming series for you'); }
    })();
  });
})();
