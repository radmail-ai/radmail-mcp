# RadMail engine: release notes

The vendorable engine (`engine-dist/radmail-engine.bundle.ts`) is released by an
**engine tag**, `radmail-engine-v<version>`, where `<version>` is `package.json`'s
version at the tagged commit. `scripts/install-engine-into.mjs` installs only the
newest such tag. It refuses a working tree unless you pass `--allow-unreleased`,
and a copy installed that way says `UNRELEASED` in its hash line.

Why a separate prefix instead of the package's `v*` tags: a `v*` tag says an npm
release happened. An engine release does not need one, so cutting an engine tag
makes no claim about npm.

---

## radmail-engine-v0.5.1 (proposed, NOT YET TAGGED)

**What it is:** the first engine release. It contains no new engine logic.

- Modules: `src/engine/types.ts` and `src/engine/send-disposition.ts`.
- Exports that consumers use: `detectSourceRiskSignals(...parts)`, which flags money,
  changed-banking, decision and prompt-injection signals, and
  `commitmentSendDisposition(ctx)`.
- Pure code: no network, no database, no model. It can run in-process inside an
  organisation's own app, and no email content leaves that app.
- Body hash: see `engine-dist/RADMAIL-ENGINE.sha256`.

### Choosing the commit to tag

The tag must point at a commit that has:

1. `engine.json` present;
2. `package.json` `"version"` equal to the tag's version, because the bundle header
   prints this version;
3. `node scripts/bundle-engine.mjs --check` passing, so the bundle is the one the
   tagged source implies. The installer checks this again at install time.

```bash
C=<candidate sha>
git show "${C}:package.json" | grep '"version"'
git cat-file -e "${C}:engine.json" && echo has-descriptor
```

Then cut and push the tag (a release act, reserved for a maintainer):

```bash
git tag -a radmail-engine-v0.5.1 "$C" -m "radmail engine 0.5.1: first engine release"
git push origin refs/tags/radmail-engine-v0.5.1
```

### Proving a consumer's copy is this release

Run a dry run only. It never writes without `--apply`:

```bash
node scripts/install-engine-into.mjs <path-to-consumer-repo>   # expect: "identical bytes — nothing to do"
```

"Identical bytes" means the **whole vendored file** equals the tag's bundle byte for
byte, and the hash file equals the tag's hash line. The body hash is not enough on
its own: it covers only the text from the sentinel on, so code added above the
sentinel (for example an extra export in the header) leaves it unchanged. A copy
whose body hash matches but whose bytes differ is REFUSED as "EDITED IN PLACE … not
proof" (exit 1).

If it reports anything other than identical bytes, do not `--force` it: find out
why the consumer's copy differs first.
