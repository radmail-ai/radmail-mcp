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
- Everything that was already on `main` after 0.5.0 (see the git log) ships in this release.
