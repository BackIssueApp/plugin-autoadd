# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests. Entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Added

- First version. An **Auto-add** page in the sidebar holds keyword rules: a
  phrase to look for in series names, optionally narrowed by publisher and by
  words to leave out. Twice a day the release list is read for this week and
  the eight after it, and a series a rule catches that is not in the library
  yet is added and monitored like one added by hand.
- A brand-new series is often on the release list before the catalog has a
  record for it. It is announced with a **Coming up** notification the first
  time a rule catches it, shows as **Waiting for details**, and is added on the
  first check after its record arrives. It is followed for four weeks after it
  ships, so a late record is not missed.
- The rule form shows what a rule would catch in the weeks ahead while you
  type, before it is saved.
- **New series only** on a rule leaves out series that are already past their
  first issue, so a broad phrase does not pull in long-running titles.
- A rule can download every issue of a series it adds, or only the upcoming
  issue and later. Collected editions are left out unless a rule asks for them.
- **Existing series** on a rule searches the catalog for series already
  published that the rule matches and that are not in the library, to tick and
  add by hand.
- **Caught in the weeks ahead** lists each caught series and what will happen
  to it, with **Skip** to keep one out, whether it is about to be added or
  still waiting. A series is added once: deleting it later does not bring it
  back unless you press **Add again**.
- A notification names each series that was added and the rule that caught it.
- The pass appears under **System → Jobs** as **Add upcoming series that
  match a rule**, and **Check now** on the page runs it on the spot.
- A **Manage auto-add rules** permission, held by administrators by default.
- Available in English, French, German, Spanish, Italian, Portuguese,
  Brazilian Portuguese, Dutch, Polish, Japanese and Simplified Chinese.
