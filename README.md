# Auto-add

Keyword rules that add upcoming series to your BackIssue library for you. Write
a rule such as **Star Trek** once, and every new series with that phrase in its
name is added as soon as it appears on the release list, up to eight weeks
before its first issue ships. You never have to know the series exists.

## Install

One click from **Sidebar → Plugins** in BackIssue, or drop this folder into the
app's `plugins/` directory and restart.

## Use

Open **Auto-add** in the sidebar and write a rule:

- **Series name contains**: the phrase to look for. It matches whole words and
  ignores case, accents and punctuation, so `star trek` catches
  *Star Trek: Zero Point* but not *Stargate*.
- **Publisher** (optional): only series from a publisher whose name contains
  this.
- **Leave out names containing** (optional): words that rule a series out,
  separated by commas.
- **Download**: every issue of the series, or only the upcoming issue and the
  ones after it. Pick the second for a long-running series you do not want the
  back issues of.
- **Single issues only**: on by default, so trade paperbacks, hardcovers and
  omnibuses are not added as series of their own.

While you type, the page shows what the rule would catch in the weeks ahead,
so you can see its reach before you save it.

## What happens next

Twice a day the plugin reads the release list for this week and the eight
after it. A series a rule catches, and that is not in your library yet, is
added and monitored exactly like one you added by hand:

- Issues that are already out are queued right away when **Download on add**
  is on in Settings and a download source is enabled.
- Issues still to come are picked up on release day by the app's own
  new-release search.
- A notification names each series that was added and the rule that caught it.

The schedule is **Add upcoming series that match a rule** under
**System → Jobs**, where you can change the times or turn it off. **Check now** on the Auto-add
page runs it on the spot.

## Staying in control

- **Caught in the weeks ahead** lists every series your rules catch and what
  will happen to it. Press **Skip** on one you do not want before it is added.
- A series is added once. If you delete it from your library later, it does not
  come back. **Add again** on the page lifts that.
- Deleting a rule leaves the series it already added in your library.
- Writing and running rules needs the **Manage auto-add rules** permission.
  Administrators have it; you can grant it to another role on the Users page.

## Limits

- The release list reaches about eight weeks ahead. A series announced further
  out is caught once it enters that window.
- A rule matches the series name only. A tie-in that does not carry the phrase
  in its name is not caught.
- Some entries on the list do not have their details yet. They show as
  **Waiting for details** and are added on a later check, once the details
  arrive.
- The list covers the main publishers. A small-press title that never appears
  on it cannot be caught.

## Development

```bash
node --test tests/*.test.js
```

The matching rules live in `match.js` and have no dependency on the app, the
record of what was added lives in `store.js`, and `scan.js` is the pass that
ties them to the release list.
