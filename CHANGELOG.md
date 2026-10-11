# Changelog

## 0.5.1 (unreleased)

- **Packaging:** the npm tarball now ships only the runtime build (`dist/src`, without
  compiled tests or source maps), `README.md`, `LICENSE` and this changelog. Tests,
  scripts, TypeScript sources and the vendorable engine bundle are no longer published.
- **Fixtures:** all test data now uses reserved documentation domains
  (`example.com`, `.example`) and fictional names.
- **Docs and comments:** removed internal deployment notes and local filesystem paths.
- **New gate:** `scripts/check-public-denylist.mjs` fails CI when the repository or the
  packed tarball contains an address outside the reserved documentation domains, an
  absolute home-directory path, an internal record id, or a term from a private
  denylist held as a repository secret.
- **Docs:** *Verify before you connect* now publishes the check behind the strongest claim in
  the README — that no tool can release a held send. The hosted `tools/list` cannot reach it
  (the send tool is not on the hosted tier), so the command runs the existing
  `release a held send` assertions from the MIT source, and a second command shows the
  check failing when a release route is added. Observed 2026-10-05: 3 pass, 0 fail.
- **Registry record:** `server.json` migrates from the deprecated `2025-09-29` server schema to
  `2025-12-11` (no breaking changes between them per the registry's own changelog) and declares a
  `title` — the human-readable display name a directory renders as its page title. Measured
  2026-10-10 by diffing both published schemas: `title` exists in `2025-12-11` and not in
  `2025-09-29`, so a record on the older schema cannot carry one and falls back to the bare package
  slug. `mcp-publisher validate` went from a deprecation warning to `✅ server.json is valid`.
- **New pin:** `test/manifest.test.ts` refuses a `title` declared on a schema version that has no
  `title` field — a combination the registry accepts while silently dropping the title. Proven to
  fail on both broken shapes before it was kept.
- **Docs:** new *How a directory lists this server* section in `README.md` and `llms.txt`, with the
  two commands that read what `main` declares against what the live registry serves, and the honest
  statement that they do not match until the next registry publish (live `isLatest` is still 0.5.0
  on the old schema, so it carries no title).
- Everything that was already on `main` after 0.5.0 (see the git log) ships in this release.
