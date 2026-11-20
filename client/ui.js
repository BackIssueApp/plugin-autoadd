// Auto-add client, injected via window.BackIssue. Adds an "Auto-add" entry to
// the sidebar that opens one page: the rules (each with a look at the series
// already published that it catches), a form to write a rule or change one, with a live look
// at what it would catch, the series the rules catch in the weeks ahead, and
// the record of what they have added. Shown only to accounts that may manage
// the rules; the server enforces that regardless.
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
    const toast = (msg, type) => { try { api.toast?.(msg, type); } catch { /* older host */ } };
    const CODE_TEXT = {
      duplicate: () => tr('error.duplicate', 'A rule like this one already exists.'),
      gone: () => tr('error.gone', 'That series is no longer waiting to be added.'),
      library: () => tr('error.library', 'That library no longer exists.'),
    };
    const say = (err) => toast((err?.code && CODE_TEXT[err.code]?.()) || String(err?.message || err), 'error');
    const icon = (name, fallback) => (api.icon && api.icon(name)) || fallback;

    const ADD_CHUNK = 5;       // back-catalogue series added per request
    const CONFIRM_OVER = 10;   // ask before adding more than this many at once
    const PREVIEW_MAX = 25;    // series a preview lists before it just counts the rest

    let overlay = null;
    let state = { rules: [], history: [], lastRun: null, weeksAhead: 8, burstMax: 10 };
    let libraries = [];      // the comic libraries this account can see: { id, name }
    let editing = null;      // id of the rule loaded in the form, when changing one
    let matches = null;      // null = still loading
    let matchesError = null;
    let previewTimer = null;
    let previewSeq = 0;
    // The back-catalogue panel under a rule, by rule id:
    // { loading, error, series, selected: Set, progress: { done, total } | null }
    const finders = new Map();

    const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const day = (iso) => {
      if (!iso) return '';
      const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T12:00:00' : iso);
      if (isNaN(d)) return String(iso);
      try { return d.toLocaleDateString(api.lang?.() || undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
      catch { return d.toLocaleDateString(); }
    };
    const nameOf = (m) => esc(m.series || '') + (m.seriesYear ? ' <span class="aa-dim">(' + esc(m.seriesYear) + ')</span>' : '');
    const shipsOf = (m) => {
      if (!m.shipdate) return '';
      const out = m.shipdate < today();
      if (m.number) {
        return out ? tr('match.shipped', '#{number} shipped {date}', { number: m.number, date: day(m.shipdate) })
          : tr('match.ships', '#{number} ships {date}', { number: m.number, date: day(m.shipdate) });
      }
      return out ? tr('match.shippedNoNumber', 'Shipped {date}', { date: day(m.shipdate) }) : tr('match.shipsNoNumber', 'Ships {date}', { date: day(m.shipdate) });
    };
    const STATE_LABEL = {
      new: () => tr('state.new', 'Will be added'),
      waiting: () => tr('state.waiting', 'Waiting for details'),
      ask: () => tr('state.ask', 'Needs your OK'),
      library: () => tr('state.library', 'In your library'),
      skipped: () => tr('state.skipped', 'Skipped'),
      removed: () => tr('state.removed', 'Removed from your library'),
    };
    const chip = (st) => '<span class="aa-chip aa-chip--' + st + '">' + esc(STATE_LABEL[st]()) + '</span>';
    const attr = (v) => esc(String(v ?? ''));

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
    // Where a rule may send its series. Asked of the app, which only lists the
    // libraries this account can see; the field stays hidden with fewer than two.
    async function loadLibraries() {
      let r = null;
      try { r = await api.get('/api/libraries'); } catch { /* the field stays hidden */ }
      libraries = (r?.libraries || []).filter((l) => l.type === 'comic').map((l) => ({ id: l.id, name: l.name }));
      paintLibraryField();
      paintRules();
    }
    function paintLibraryField() {
      const field = overlay?.querySelector('.aa-field--library');
      if (!field) return;
      const sel = field.querySelector('select');
      // A rule being changed keeps its library when the list arrives late.
      const keep = sel.value || String((editing != null && state.rules.find((r) => r.id === editing)?.libraryId) || '');
      sel.innerHTML = '<option value="">' + esc(tr('form.libraryDefault', 'Default library')) + '</option>' +
        libraries.map((l) => '<option value="' + l.id + '">' + esc(l.name) + '</option>').join('');
      sel.value = libraries.some((l) => String(l.id) === keep) ? keep : '';
      field.hidden = libraries.length < 2;
    }

    // ---- rules ----
    // A rule goes by the name it looks for, or by its publisher when it has none.
    const labelOf = (r) => r?.keyword || r?.publisher || '';
    const titleOf = (r) => (r.keyword ? r.keyword : tr('rule.everything', 'Everything from {publisher}', { publisher: r.publisher }));
    function ruleDetails(r) {
      const bits = [];
      if (r.publisher && r.keyword) bits.push(tr('rule.publisher', 'Publisher: {publisher}', { publisher: r.publisher }));
      if (r.exclude) bits.push(tr('rule.exclude', 'Leaves out: {words}', { words: r.exclude }));
      if (r.newOnly) bits.push(tr('rule.newOnly', 'New series only'));
      if (r.ask) bits.push(tr('rule.ask', 'Asks before adding'));
      bits.push(r.skipCollected ? tr('rule.noCollected', 'Single issues only') : tr('rule.withCollected', 'Collected editions too'));
      bits.push(r.scope === 'new' ? tr('rule.scopeNew', 'From the upcoming issue on') : tr('rule.scopeAll', 'Every issue'));
      const lib = r.libraryId != null ? libraries.find((l) => l.id === r.libraryId) : null;
      if (lib) bits.push(tr('rule.library', 'Library: {library}', { library: lib.name }));
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
        '<div class="aa-rule" data-id="' + r.id + '">' +
          '<div class="aa-row' + (r.enabled ? '' : ' aa-row--off') + (editing === r.id ? ' aa-row--editing' : '') + '">' +
            '<label class="switch switch--sm" title="' + esc(tr('rules.toggle', 'Turn this rule on or off')) + '"><input type="checkbox" class="aa-rule__on"' + (r.enabled ? ' checked' : '') + '><span class="switch__track"></span></label>' +
            '<div class="aa-row__main"><div class="aa-row__title">' + esc(titleOf(r)) + '</div><div class="aa-row__meta">' + ruleDetails(r) + '</div></div>' +
            // A rule with no name to look for has no back catalogue to list.
            (r.keyword ? '<button class="btn btn--ghost btn--sm aa-rule__existing" title="' + esc(tr('existing.title', 'Series already published that this rule catches')) + '">' + esc(finders.has(r.id) ? tr('existing.hide', 'Hide') : tr('existing.button', 'Existing series')) + '</button>' : '') +
            '<button class="btn btn--ghost btn--sm aa-rule__edit">' + esc(tr('rules.edit', 'Edit')) + '</button>' +
            '<button class="btn btn--ghost btn--sm aa-rule__del">' + esc(tr('rules.delete', 'Delete')) + '</button>' +
          '</div>' +
          '<div class="aa-existing"' + (finders.has(r.id) ? '' : ' hidden') + '></div>' +
        '</div>').join('');
      for (const box of el.querySelectorAll('.aa-rule')) {
        const id = Number(box.dataset.id);
        box.querySelector('.aa-rule__on').onchange = async (e) => {
          try { await post('/api/autoadd/rules/' + id, { enabled: e.target.checked }); await reload(); }
          catch (err) { say(err); e.target.checked = !e.target.checked; }
        };
        box.querySelector('.aa-rule__del').onclick = async () => {
          const rule = state.rules.find((x) => x.id === id);
          if (!window.confirm(tr('rules.deleteConfirm', 'Delete the rule “{keyword}”? Series it already added stay in your library.', { keyword: labelOf(rule) }))) return;
          try {
            await post('/api/autoadd/rules/' + id + '/delete');
            finders.delete(id);
            if (editing === id) stopEdit();
            toast(tr('rules.deleted', 'Rule deleted'));
            await reload();
          } catch (err) { say(err); }
        };
        box.querySelector('.aa-rule__edit').onclick = () => startEdit(id);
        const existing = box.querySelector('.aa-rule__existing');
        if (existing) existing.onclick = () => {
          if (finders.has(id)) { finders.delete(id); paintRules(); } else openFinder(id);
        };
        if (finders.has(id)) paintFinder(id);
      }
    }

    // ---- series already published that a rule catches ----
    async function openFinder(id) {
      const f = { loading: true, error: null, series: [], selected: new Set(), progress: null };
      finders.set(id, f);
      paintRules();
      try { f.series = (await get('/api/autoadd/rules/' + id + '/existing')).series || []; }
      catch (e) { f.error = String(e?.message || e); }
      f.loading = false;
      if (finders.get(id) === f) paintFinder(id);
    }
    function paintFinder(id) {
      const box = overlay?.querySelector('.aa-rule[data-id="' + id + '"] .aa-existing');
      const f = finders.get(id);
      if (!box || !f) return;
      if (f.loading) { box.innerHTML = '<p class="aa-note">' + esc(tr('existing.loading', 'Searching the catalog…')) + '</p>'; return; }
      if (f.error) { box.innerHTML = '<p class="aa-note aa-note--bad">' + esc(tr('existing.failed', 'The catalog could not be searched: {error}', { error: f.error })) + '</p>'; return; }
      if (!f.series.length) { box.innerHTML = '<p class="aa-note">' + esc(tr('existing.none', 'No series already published match this rule, apart from the ones in your library.')) + '</p>'; return; }
      const busy = !!f.progress;
      box.innerHTML =
        '<div class="aa-existing__head">' +
          '<p class="aa-note">' + esc(tr('existing.count', { one: '{count} series already published matches this rule and is not in your library.', other: '{count} series already published match this rule and are not in your library.' }, { count: f.series.length })) + '</p>' +
          '<button type="button" class="btn btn--ghost btn--sm aa-existing__all"' + (busy ? ' disabled' : '') + '>' + esc(f.selected.size === f.series.length ? tr('existing.selectNone', 'Select none') : tr('existing.selectAll', 'Select all')) + '</button>' +
        '</div>' +
        '<ul class="aa-existing__list">' + f.series.map((s) =>
          '<li><label><input type="checkbox" value="' + s.cvId + '"' + (f.selected.has(s.cvId) ? ' checked' : '') + (busy ? ' disabled' : '') + '>' +
          '<span class="aa-existing__text"><span class="aa-existing__name">' + nameOf(s) + '</span>' +
          '<span class="aa-dim">' + esc([s.publisher, s.issues ? tr('existing.issues', { one: '{count} issue', other: '{count} issues' }, { count: s.issues }) : ''].filter(Boolean).join(' · ')) + '</span></span></label></li>').join('') + '</ul>' +
        '<div class="aa-existing__foot">' +
          '<button type="button" class="btn btn--primary btn--sm aa-existing__add"></button>' +
          '<span class="aa-note aa-existing__progress"></span>' +
        '</div>';
      const addBtn = box.querySelector('.aa-existing__add');
      const sync = () => {
        addBtn.textContent = tr('existing.add', { one: 'Add {count} series', other: 'Add {count} series' }, { count: f.selected.size });
        addBtn.disabled = busy || f.selected.size === 0;
        box.querySelector('.aa-existing__progress').textContent = f.progress ? tr('existing.adding', 'Adding {done} of {total}…', f.progress) : '';
      };
      sync();
      for (const cb of box.querySelectorAll('input[type="checkbox"]')) {
        cb.onchange = () => {
          const cv = Number(cb.value);
          if (cb.checked) f.selected.add(cv); else f.selected.delete(cv);
          sync();
          box.querySelector('.aa-existing__all').textContent = f.selected.size === f.series.length ? tr('existing.selectNone', 'Select none') : tr('existing.selectAll', 'Select all');
        };
      }
      box.querySelector('.aa-existing__all').onclick = () => {
        if (f.selected.size === f.series.length) f.selected.clear(); else f.selected = new Set(f.series.map((s) => s.cvId));
        paintFinder(id);
      };
      addBtn.onclick = () => addExisting(id);
    }
    async function addExisting(id) {
      const f = finders.get(id);
      if (!f || f.progress || !f.selected.size) return;
      const ids = [...f.selected];
      if (ids.length > CONFIRM_OVER && !window.confirm(tr('existing.confirm', { one: 'Add {count} series? Every issue of it becomes wanted.', other: 'Add {count} series? Every issue of each one becomes wanted.' }, { count: ids.length }))) return;
      let added = 0; let failed = 0;
      f.progress = { done: 0, total: ids.length };
      paintFinder(id);
      try {
        for (let i = 0; i < ids.length; i += ADD_CHUNK) {
          const chunk = ids.slice(i, i + ADD_CHUNK);
          const r = await post('/api/autoadd/rules/' + id + '/existing', { cvIds: chunk });
          added += r.added?.length || 0; failed += r.failed?.length || 0;
          for (const a of r.added || []) f.selected.delete(a.cvId);
          f.progress = { done: Math.min(i + chunk.length, ids.length), total: ids.length };
          if (finders.get(id) === f) paintFinder(id);
          // A chunk cut short means the catalog asked for a pause: stop here.
          if ((r.added?.length || 0) + (r.failed?.length || 0) < chunk.length) { failed += chunk.length - (r.added?.length || 0) - (r.failed?.length || 0); break; }
        }
      } catch (err) { say(err); }
      f.progress = null;
      if (added) toast(tr('run.added', { one: '{count} series added', other: '{count} series added' }, { count: added }), 'ok');
      if (failed) toast(tr('existing.someFailed', { one: '{count} series could not be added.', other: '{count} series could not be added.' }, { count: failed }), 'error');
      // What was added is in the library now: drop it from the list.
      const gone = new Set(f.series.map((s) => s.cvId).filter((cv) => ids.includes(cv) && !f.selected.has(cv)));
      f.series = f.series.filter((s) => !gone.has(s.cvId));
      await reload();
    }

    // ---- the rule form (a new rule, or one being changed) + preview ----
    function formRule() {
      const q = (s) => overlay.querySelector(s);
      return {
        keyword: q('.aa-f__keyword').value,
        publisher: q('.aa-f__publisher').value,
        exclude: q('.aa-f__exclude').value,
        skipCollected: q('.aa-f__collected').checked,
        newOnly: q('.aa-f__newonly').checked,
        ask: q('.aa-f__ask').checked,
        scope: q('.aa-f__scope').value,
        libraryId: Number(q('.aa-f__library').value) || null,
      };
    }
    // A rule needs a name to look for, or a publisher when the name is empty.
    const usable = (rule) => {
      const name = rule.keyword.trim();
      return name ? name.length >= 2 : rule.publisher.trim().length >= 2;
    };
    // The form's wording follows what it is doing: writing a rule or changing one.
    function paintFormMode() {
      if (!overlay) return;
      const rule = editing != null ? state.rules.find((r) => r.id === editing) : null;
      const note = overlay.querySelector('.aa__editing');
      note.hidden = !rule;
      note.textContent = rule ? tr('form.editing', 'Changing the rule “{keyword}”', { keyword: labelOf(rule) }) : '';
      overlay.querySelector('.aa-f__save').textContent = rule ? tr('form.saveChanges', 'Save changes') : tr('form.save', 'Save rule');
      overlay.querySelector('.aa-f__cancel').hidden = !rule;
    }
    function startEdit(id) {
      const rule = state.rules.find((r) => r.id === id);
      if (!rule) return;
      editing = id;
      const q = (s) => overlay.querySelector(s);
      q('.aa-f__keyword').value = rule.keyword || '';
      q('.aa-f__publisher').value = rule.publisher || '';
      q('.aa-f__exclude').value = rule.exclude || '';
      q('.aa-f__collected').checked = !!rule.skipCollected;
      q('.aa-f__newonly').checked = !!rule.newOnly;
      q('.aa-f__ask').checked = !!rule.ask;
      q('.aa-f__scope').value = rule.scope === 'new' ? 'new' : 'all';
      const lib = rule.libraryId != null && libraries.some((l) => l.id === rule.libraryId) ? String(rule.libraryId) : '';
      q('.aa-f__library').value = lib;
      paintFormMode(); paintRules(); schedulePreview();
      q('.aa__form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      q('.aa-f__keyword').focus({ preventScroll: true });
    }
    function stopEdit() {
      editing = null;
      overlay.querySelector('.aa__form').reset();
      clearTimeout(previewTimer); previewSeq++; paintPreview('');
      overlay.querySelector('.aa-f__save').disabled = true;
      paintFormMode(); paintRules();
    }
    function paintPreview(html) { const el = overlay?.querySelector('.aa__preview'); if (el) el.innerHTML = html; }
    function schedulePreview() {
      clearTimeout(previewTimer);
      const rule = formRule();
      overlay.querySelector('.aa-f__save').disabled = !usable(rule);
      if (!usable(rule)) { previewSeq++; paintPreview(''); return; }
      previewTimer = setTimeout(async () => {
        const seq = ++previewSeq;
        paintPreview('<p class="aa-note">' + esc(tr('preview.loading', 'Looking at the weeks ahead…')) + '</p>');
        let r;
        try { r = await post('/api/autoadd/preview', { ...rule, id: editing }); }
        catch (e) { r = { matches: [], error: String(e?.message || e) }; }
        if (seq !== previewSeq) return; // an older answer arriving late
        if (r.error) return paintPreview('<p class="aa-note aa-note--bad">' + esc(tr('preview.failed', 'The release list could not be read: {error}', { error: r.error })) + '</p>');
        if (r.invalid) return paintPreview('');
        const list = r.matches || [];
        if (!list.length) return paintPreview('<p class="aa-note">' + esc(tr('preview.none', 'Nothing in the next {weeks} weeks matches yet. The rule keeps watching.', { weeks: state.weeksAhead })) + '</p>');
        paintPreview(
          '<p class="aa-note">' + esc(tr('preview.count', { one: 'This rule catches {count} series in the next {weeks} weeks:', other: 'This rule catches {count} series in the next {weeks} weeks:' }, { count: list.length, weeks: state.weeksAhead })) + '</p>' +
          '<ul class="aa-preview">' + list.slice(0, PREVIEW_MAX).map((m) =>
            '<li><span class="aa-preview__name">' + nameOf(m) + '</span><span class="aa-dim">' + esc([m.publisher, shipsOf(m)].filter(Boolean).join(' · ')) + '</span>' + chip(m.state) + '</li>').join('') + '</ul>' +
          (list.length > PREVIEW_MAX ? '<p class="aa-note">' + esc(tr('preview.more', { one: 'and {count} more', other: 'and {count} more' }, { count: list.length - PREVIEW_MAX })) + '</p>' : '') +
          // Said before saving, so a rule wider than intended is no surprise.
          (list.filter((m) => m.hold === 'burst').length > maxAtOnce() ? '<p class="aa-note aa-note--warn">' + esc(tr('preview.burst', 'More than {max} of these would be added at once, so Auto-add will not add them on its own. They will wait for your OK on this page.', { max: maxAtOnce() })) + '</p>' : ''));
      }, 350);
    }
    async function saveRule(e) {
      e.preventDefault();
      const btn = overlay.querySelector('.aa-f__save');
      btn.disabled = true;
      try {
        if (editing != null) {
          await post('/api/autoadd/rules/' + editing, formRule());
          toast(tr('form.updated', 'Rule updated'));
        } else {
          await post('/api/autoadd/rules', formRule());
          toast(tr('form.saved', 'Rule saved'));
        }
        stopEdit();
        await reload();
      } catch (err) { say(err); btn.disabled = false; }
    }

    // ---- what the rules catch ----
    const maxAtOnce = () => Number(state.burstMax) || 10;
    // Say yes to everything one rule has on hold, one series after the other.
    async function addAllHeld(box, keys) {
      if (!window.confirm(tr('burst.confirm', 'Add all {count} series to your library?', { count: keys.length }))) return;
      const note = box.querySelector('.aa-burst__progress');
      // No answers by hand while the lot goes in.
      for (const b of overlay.querySelectorAll('.aa__matches button')) b.disabled = true;
      let added = 0;
      try {
        for (let i = 0; i < keys.length; i++) {
          note.textContent = tr('existing.adding', 'Adding {done} of {total}…', { done: i + 1, total: keys.length });
          try {
            const r = await post('/api/autoadd/approve', { key: keys[i] });
            if (r.added) added++;
          } catch (err) { if (err.code !== 'gone') throw err; /* answered meanwhile: on to the next */ }
        }
      } catch (err) { say(err); }
      if (added) toast(tr('run.added', { one: '{count} series added', other: '{count} series added' }, { count: added }), 'ok');
      await reload();
    }
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
      // A rule that caught more than it adds on its own: say so once, above
      // the list, with one button for the lot.
      const bursts = [];
      for (const m of matches) {
        if (m.state !== 'ask' || m.hold !== 'burst') continue;
        let b = bursts.find((x) => x.ruleId === m.ruleId);
        if (!b) bursts.push(b = { ruleId: m.ruleId, keyword: m.keyword, keys: [] });
        b.keys.push(m.key);
      }
      el.innerHTML = bursts.map((b, i) =>
        '<div class="aa-burst" data-i="' + i + '">' +
          '<p class="aa-note">' + esc(tr('burst.note', '“{keyword}” caught more than {max} series at once. That is more than Auto-add adds on its own, so they are waiting for your OK.', { keyword: b.keyword, max: maxAtOnce() })) + '</p>' +
          '<div class="aa-burst__acts">' +
            (b.keys.length > 1 ? '<button type="button" class="btn btn--sm aa-burst__all">' + esc(tr('burst.addAll', 'Add all {count}', { count: b.keys.length })) + '</button>' : '') +
            '<span class="aa-note aa-burst__progress"></span>' +
          '</div>' +
        '</div>').join('') + matches.map((m) => {
        let action = '';
        const skip = '<button class="btn btn--ghost btn--sm" data-act="skip">' + esc(tr('matches.skip', 'Skip')) + '</button>';
        // A rule that asks first: yes adds it now, or as soon as it can be.
        if (m.state === 'ask') action = '<button class="btn btn--primary btn--sm" data-act="approve">' + esc(tr('matches.add', 'Add')) + '</button>' + skip;
        else if (m.state === 'waiting' && m.needsOk) action = '<button class="btn btn--sm" data-act="approve">' + esc(tr('matches.addWhenReady', 'Add when ready')) + '</button>' + skip;
        else if (m.state === 'new' || m.state === 'waiting') action = skip;
        else if (m.state === 'skipped') action = '<button class="btn btn--ghost btn--sm" data-act="forget">' + esc(tr('matches.allow', 'Allow')) + '</button>';
        else if (m.state === 'removed') action = '<button class="btn btn--ghost btn--sm" data-act="forget">' + esc(tr('matches.addAgain', 'Add again')) + '</button>';
        else if (m.state === 'library' && m.seriesId != null) action = '<button class="btn btn--ghost btn--sm" data-act="open">' + esc(tr('matches.open', 'Open')) + '</button>';
        return '<div class="aa-row" data-cv="' + attr(m.cvId) + '" data-key="' + attr(m.key) + '" data-namekey="' + attr(m.nameKey) + '" data-series="' + attr(m.seriesId) + '">' +
          '<div class="aa-row__main"><div class="aa-row__title">' + nameOf(m) + '</div>' +
          '<div class="aa-row__meta">' + esc([m.publisher, shipsOf(m), tr('match.rule', 'Rule: {keyword}', { keyword: m.keyword })].filter(Boolean).join(' · ')) + '</div></div>' +
          '<div class="aa-row__acts">' + chip(m.state) + action + '</div></div>';
      }).join('');
      wireRowActions(el);
      for (const box of el.querySelectorAll('.aa-burst')) {
        const all = box.querySelector('.aa-burst__all');
        if (all) all.onclick = () => addAllHeld(box, bursts[Number(box.dataset.i)].keys);
      }
    }
    function wireRowActions(el) {
      for (const b of el.querySelectorAll('.aa-row button[data-act]')) {
        const row = b.closest('.aa-row');
        b.onclick = async () => {
          try {
            if (b.dataset.act === 'open') { close(); return api.openSeries ? api.openSeries(Number(row.dataset.series)) : (location.href = '/volume/' + Number(row.dataset.series)); }
            b.disabled = true;
            if (b.dataset.act === 'skip') await post('/api/autoadd/skip', { key: row.dataset.key });
            if (b.dataset.act === 'approve') {
              const title = (matches || []).find((x) => x.key === row.dataset.key)?.series || '';
              const r = await post('/api/autoadd/approve', { key: row.dataset.key });
              toast(r.added ? tr('matches.added', '{title} added', { title }) : tr('matches.approved', '{title} will be added once its details are available.', { title }), 'ok');
            }
            if (b.dataset.act === 'forget') await post('/api/autoadd/forget', { cvId: Number(row.dataset.cv) || null, nameKey: row.dataset.namekey || null });
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
        return '<div class="aa-row" data-cv="' + attr(h.cvId) + '" data-series="' + attr(h.seriesId) + '">' +
          '<div class="aa-row__main"><div class="aa-row__title">' + nameOf(h) + '</div>' +
          '<div class="aa-row__meta">' + esc([h.publisher, when, h.keyword ? tr('match.rule', 'Rule: {keyword}', { keyword: h.keyword }) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          '<div class="aa-row__acts">' + (st === 'library' ? '' : chip(st)) + action + '</div></div>';
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
        else if (!r?.held) toast(tr('run.nothing', 'Nothing new to add'));
        if (r?.held) toast(tr('run.held', '{count} series are waiting for your OK', { count: r.held }));
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
            '<p class="aa__lead">' + esc(tr('page.lead', 'A rule watches the release list, which reaches {weeks} weeks ahead, and tells you as soon as it catches a series. The series is added to your library once its details are available, which for a brand-new series is usually around the week its first issue ships. It is then monitored like one you added yourself.', { weeks: state.weeksAhead })) + '</p>' +
            '<section><h3 class="aa__h">' + esc(tr('rules.heading', 'Rules')) + '</h3><div class="aa__rules aa-list"></div>' +
              '<form class="aa__form">' +
                '<p class="aa-note aa__editing" hidden></p>' +
                '<div class="aa__fields">' +
                  '<label class="aa-field aa-field--wide"><span>' + esc(tr('form.keyword', 'Series name contains')) + '</span><input type="text" class="aa-f__keyword" maxlength="80" placeholder="' + esc(tr('form.keywordHint', 'e.g. Star Trek')) + '" autocomplete="off">' +
                    '<small class="aa-field__hint">' + esc(tr('form.keywordEmpty', 'Leave this empty and name a publisher to catch every series that publisher has coming.')) + '</small></label>' +
                  '<label class="aa-field"><span>' + esc(tr('form.publisher', 'Publisher (optional)')) + '</span><input type="text" class="aa-f__publisher" maxlength="80" autocomplete="off"></label>' +
                  '<label class="aa-field"><span>' + esc(tr('form.exclude', 'Leave out names containing (optional)')) + '</span><input type="text" class="aa-f__exclude" placeholder="' + esc(tr('form.excludeHint', 'Words, separated by commas')) + '" autocomplete="off"></label>' +
                  '<label class="aa-field"><span>' + esc(tr('form.scope', 'Download')) + '</span><select class="aa-f__scope"><option value="all">' + esc(tr('form.scopeAll', 'Every issue of the series')) + '</option><option value="new">' + esc(tr('form.scopeNew', 'Only the upcoming issue and later')) + '</option></select></label>' +
                  '<label class="aa-field aa-field--library" hidden><span>' + esc(tr('form.library', 'Add to')) + '</span><select class="aa-f__library"><option value="">' + esc(tr('form.libraryDefault', 'Default library')) + '</option></select></label>' +
                  '<label class="aa-check"><input type="checkbox" class="aa-f__newonly"><span>' + esc(tr('form.newOnly', 'New series only (leave out series that are already past their first issue)')) + '</span></label>' +
                  '<label class="aa-check"><input type="checkbox" class="aa-f__ask"><span>' + esc(tr('form.ask', 'Ask before adding (each series waits for your OK on this page)')) + '</span></label>' +
                  '<label class="aa-check"><input type="checkbox" class="aa-f__collected" checked><span>' + esc(tr('form.collected', 'Single issues only (skip trade paperbacks, hardcovers and omnibuses)')) + '</span></label>' +
                '</div>' +
                '<div class="aa__preview"></div>' +
                '<div class="aa__formfoot">' +
                  '<button class="btn btn--primary aa-f__save" disabled>' + esc(tr('form.save', 'Save rule')) + '</button>' +
                  '<button type="button" class="btn btn--ghost aa-f__cancel" hidden>' + esc(tr('form.cancel', 'Cancel')) + '</button>' +
                '</div>' +
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
      overlay.querySelector('.aa-f__cancel').onclick = stopEdit;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('is-open')) close(); });
    }
    function open() {
      if (!overlay) build();
      overlay.classList.add('is-open');
      reload();
      loadLibraries();
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
