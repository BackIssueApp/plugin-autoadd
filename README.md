# Auto-add

Keyword rules that add upcoming series to your BackIssue library for you. Write
a rule such as **Star Trek** once. From then on the plugin watches the release
list, which reaches about eight weeks ahead, tells you as soon as a series with
that phrase in its name turns up, and adds it to your library for you. You
never have to know the series exists. A rule can also ask you first, so
nothing is added without your say.

## Install

One click from **Sidebar → Plugins** in BackIssue, or drop this folder into the
app's `plugins/` directory and restart. It needs BackIssue 0.9.4 or newer.

## Use

Open **Auto-add** in the sidebar and write a rule:

- **Series name contains**: the phrase to look for. It matches whole words and
  ignores case, accents and punctuation, so `star trek` catches
  *Star Trek: Zero Point* but not *Stargate*. Leave it empty and name a
  publisher to catch every series that publisher has coming.
- **Publisher** (optional when there is a name): only series from a publisher
  whose name contains this.
- **Leave out names containing** (optional): words that rule a series out,
  separated by commas.
- **Download**: every issue of the series, or only the upcoming issue and the
  ones after it.
- **Add to**: the library the rule's series go to. The field appears when you
  have more than one comics library; otherwise series go to your default
  library.
- **New series only**: leave out series that are already past their first
  issue. A series counts as new when its first issue is on the release list or
  shipped in the last four weeks. Turn this on for a broad rule, so that a
  phrase like `batman` does not pull in every long-running title and its back
  issues.
- **Ask before adding**: the rule adds nothing on its own. Each series it
  catches waits on the Auto-add page for you to press **Add** or **Skip**, and
  a notification tells you it is there. A good fit for a publisher rule or
  any other rule you expect to catch more than you want.
- **Single issues only**: on by default, so trade paperbacks, hardcovers and
  omnibuses are not added as series of their own.

While you type, the page shows what the rule would catch in the weeks ahead,
so you can see its reach before you save it.

Press **Edit** on a rule to change it. The form fills with the rule as it is,
shows what the changed rule would catch, and **Save changes** replaces it.
Series the rule already added are not touched.

## What happens next

Twice a day the plugin reads the release list for this week and the eight
after it. For each series a rule catches that is not in your library yet:

- **A series the catalog already knows** is added on that check and monitored
  exactly like one you added by hand. This is the usual case for a series that
  is already running.
- **A brand-new series** often appears on the release list weeks before the
  catalog has a record for it. You get a **Coming up** notification the first
  time it is caught, with its ship date, and it shows as **Waiting for
  details**. It is added on the first check after its record arrives, which is
  usually around the week its first issue ships. The plugin keeps following it
  for four weeks after it ships, so a late record is not missed.
- **A series caught by a rule that asks first** shows as **Needs your OK**
  once the catalog knows it. **Add** puts it in your library on the spot. While
  it is still waiting for details you can press **Add when ready**, and it is
  added on the first check after its record arrives. A series you never answer
  stays on the page until four weeks after its issue ships.
- **A rule that would add more than ten series in one check** adds none of
  them. They all show as **Needs your OK**, a note above the list says why,
  and one notification tells you. Press **Add** or **Skip** on each, or
  **Add all** to take the lot. The page warns you before you save a rule that
  wide. After that the rule carries on as usual: the one or two new series it
  catches in a later check are added without asking.

Once a series is added:

- Issues that are already out are queued right away when **Download on add**
  is on in Settings and a download source is enabled.
- Issues still to come are picked up on release day by the app's own
  new-release search.
- A notification names the series and the rule that caught it.

The schedule is **Add upcoming series that match a rule** under
**System → Jobs**, where you can change the times or turn it off. **Check now**
on the Auto-add page runs it on the spot.

## The back catalogue

A rule only looks ahead, so a series that has already finished is never caught
by it. Press **Existing series** on a rule to search the catalog for series
already published that the rule's name, publisher and left-out words match and
that are not in your library. Tick the ones you want and add them. Nothing here
is added on its own: you choose each time.

## Staying in control

- **Caught in the weeks ahead** lists every series your rules catch and what
  will happen to it. Press **Skip** on one you do not want. That works both
  for a series about to be added and for one still waiting for details.
- Turn on **Ask before adding** for a rule you want the last word on. It then
  only proposes series, and you add the ones you want.
- No rule adds more than ten series in one go on its own. A bigger catch
  waits for your OK, so a rule that turns out wider than you meant cannot fill
  your library unasked.
- A series is added once. If you delete it from your library later, it does not
  come back. **Add again** on the page lifts that.
- Deleting a rule leaves the series it already added in your library.
- Writing and running rules needs the **Manage auto-add rules** permission.
  Administrators have it; you can grant it to another role on the Users page.

## Limits

- The release list reaches about eight weeks ahead. A series announced further
  out is caught once it enters that window.
- A series can only be added once the catalog has a record for it. For most
  brand-new series that is close to release, not eight weeks before. You are
  told about the series when it is caught, and nothing is lost by the wait:
  issues that shipped in the meantime are queued when the series is added.
- A rule with a name matches the series name only. A tie-in that does not
  carry the phrase in its name is not caught.
- **Existing series** needs a name to search for, so a rule with only a
  publisher does not offer it.
- The list covers the main publishers. A small-press title that never appears
  on it, or never gets a catalog record, cannot be added.

## Development

```bash
node --test tests/*.test.js
```

The matching rules live in `match.js` and have no dependency on the app, the
record of what was added lives in `store.js`, and `scan.js` is the pass that
ties them to the release list.
