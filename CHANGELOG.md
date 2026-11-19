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
- The rule form shows what a rule would catch in the weeks ahead while you
  type, before it is saved.
- A rule can download every issue of a series it adds, or only the upcoming
  issue and later. Collected editions are left out unless a rule asks for them.
- **Caught in the weeks ahead** lists each caught series and what will happen
  to it, with **Skip** to keep one out. A series is added once: deleting it
  later does not bring it back unless you press **Add again**.
- A notification names each series that was added and the rule that caught it.
- The pass appears under **System → Jobs** as **Add upcoming series that
  match a rule**, and **Check now** on the page runs it on the spot.
- A **Manage auto-add rules** permission, held by administrators by default.
- Available in English, French, German, Spanish, Italian, Portuguese,
  Brazilian Portuguese, Dutch, Polish, Japanese and Simplified Chinese.
