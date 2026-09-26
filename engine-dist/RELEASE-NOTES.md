# RadMail engine: release notes

The vendorable engine (`engine-dist/radmail-engine.bundle.ts`) is released by an
**engine tag**, `radmail-engine-v<version>`, where `<version>` is `package.json`'s
version at the tagged commit. `scripts/install-engine-into.mjs` installs only the
newest such tag. It refuses a working tree unless you pass `--allow-unreleased`,
and a copy installed that way says `UNRELEASED` in its hash line.

Why a separate prefix instead of the package's `v*` tags: a `v*` tag says an npm
release happened. An engine release does not need one. As of 2026-09-26, npm serves
0.5.0 and `main` is 0.5.1. Under the separate prefix, cutting the engine release
makes no claim about npm.

---

## radmail-engine-v0.5.1 (proposed, NOT YET TAGGED)

**What it is:** the first engine release. It contains no new engine code.

- Modules: `src/engine/types.ts` and `src/engine/send-disposition.ts`. Both are
  **byte-identical to v0.4.0** (blobs `d431258d…` and `c3c9df75…`). The last change
  to either file was `683f88b` (2026-06-29, the `BANKING_RE` fix that closed a BEC
  false negative on "banking"), and v0.4.0 already contains it.
- Exports that consumers use: `detectSourceRiskSignals(...parts)`, which flags money,
  changed-banking, decision and prompt-injection signals, and
  `commitmentSendDisposition(ctx)`.
- Pure code: no network, no database, no model. It can run in-process inside a
  regulated org's own app (CUI or PHI), and no email content leaves that app.
- Body hash: `sha256(body) = 175f304b61954c9e1af40326405cfb9b2f6e46abb2c1526391ec62028dce8068`.

**Why it is needed:** VRG's `main` already carries this bundle. It was vendored by
the pre-tag installer (#16) and stamped `radmail-mcp@0.5.1`, but no 0.5.1 exists
that anyone can check out. This tag makes the copy provable. It does not change
the copy.

### What the tag must match (measured 2026-09-26, read-only on VRG)

Measured on VRG `origin/main` at `821e29ba` (VRG #363, v9.7.16800):

| VRG file | git blob | must equal at the tagged commit |
|---|---|---|
| `vendor/radmail-engine.bundle.ts` | `3b5f6b05dff0bdbed6fbc184ed2e20865f911aee` | `engine-dist/radmail-engine.bundle.ts` |
| `vendor/RADMAIL-ENGINE.sha256` | `98059cd620dbdcd6afe8b23c262e60d466891cbf` | `engine-dist/RADMAIL-ENGINE.sha256` |

The only radmail-mcp commit whose `engine-dist/radmail-engine.bundle.ts` has that
blob is `d4e838b` (#16). **d4e838b cannot carry the tag**, because it predates
`engine.json`, and the installer correctly refuses a tag without one
(CANNOT-VERIFY). The tag must therefore point at a commit that has:

1. `engine.json` present, the commit that adds it or a later one;
2. `package.json` `"version": "0.5.1"`, because the bundle header prints this version
   and a bump would change the header bytes;
3. both blob ids above, unchanged;
4. `node scripts/bundle-engine.mjs --check` passing, so the bundle is the one the
   tagged source implies. The installer checks this again at install time.

This PR's merge commit meets all four, as long as nothing merged before it bumps
`package.json`. Check a candidate before tagging:

```bash
C=<candidate sha>
git rev-parse "${C}:engine-dist/radmail-engine.bundle.ts"   # expect 3b5f6b05dff0…
git rev-parse "${C}:engine-dist/RADMAIL-ENGINE.sha256"      # expect 98059cd620db…
git show "${C}:package.json" | grep '"version"'             # expect 0.5.1
git cat-file -e "${C}:engine.json" && echo has-descriptor
```

Then cut and push the tag (a release act, reserved for a person):

```bash
git tag -a radmail-engine-v0.5.1 "$C" -m "radmail engine 0.5.1: first engine release; BEC risk core, byte-identical to v0.4.0 source"
git push origin refs/tags/radmail-engine-v0.5.1
```

**Then prove VRG's copy is this release.** Run a dry run only. It never writes
without `--apply`, and VRG is report-only:

```bash
node scripts/install-engine-into.mjs ~/dev/vrg-app      # expect: "identical bytes — nothing to do"
```

If it reports anything other than identical bytes, **do not `--apply` into VRG**.
The fleet's D4 rule makes VRG report-only, so file the difference instead.
