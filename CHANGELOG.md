# Changelog

## 0.5.1 (unreleased)

- **Docs:** answers the **BEC control checklist the email-security category publishes**, in that
  category's own vocabulary, and gives three of its five controls a flat *no*. Second authorized
  reviewer on wires / payroll / vendor-bank changes: **applies and is stricter** (no approval request
  exists to waive, and the draft is withheld too). Out-of-band callback verification to a known-good
  number: **not implemented and will not be** — the hard-stop buys the pause in which a person makes
  that call, it does not make the call. SPF/DKIM/DMARC authentication: **partial** — `check_send_domain`
  is a zero-auth read-only DNS read for a domain you name, not per-message header authentication of
  received mail. Impersonation detection and automated remediation/quarantine: **no — this is not an
  email-security product, and if you have no inbound gateway RadMail is not a substitute.** Reproducible
  on the frozen manifest: `quarantine` / `delete` / `archive` each `grep -ic` to 0 and `send` to 1 (the
  noun inside `check_send_domain`); hosted `tools/list` 6 tools / 0 send-capable, observed 2026-10-23.
  Mirrored in `llms.txt`.

- **Docs:** cites the first *independent* grade of this server's tool surface — AxioRank's MCP
  Security Index scorecard (grade **A**, blast radius **0/100**, 6 tools, 0 capabilities
  flagged, Execute/Delete/Write/Read = 0/0/0/6), read 2026-10-22 — on a page RadMail does not
  own, never submitted to and cannot edit, with AxioRank's own caveats quoted verbatim ("not
  whether it is secure or trustworthy"; "a minimal grade means a small blast radius, not an
  endorsement"). Also names the `high` advisory shown on that same page rather than linking
  the grade and skipping the red word: it is a keyword match on the single occurrence of
  `RADMAIL_API_KEY` in the **description** of `search` (measured over the whole hosted
  `tools/list` payload: `api_key` 1, `token`/`credential`/`secret`/`password` 0 each), which
  is a sentence *about* a key and not a tool that handles one. The sentence stays; the count
  gets published.

- **Docs:** publishes the no-account way to reproduce the *explainability* claim itself,
  and the one argument name this README had named `why_surfaced` three times without ever
  writing down. Two `curl`s against the hosted zero-auth sandbox (`list_right_now` for an
  id, then `why_surfaced` with `message_id`) return six named scoring signals plus the
  base number they move; three consecutive calls on 2026-10-19 returned byte-identical
  433-byte payloads (sha256 published), which is what "not a black box" is being used to
  mean — an explanation that repeats can be diffed and pinned in a test. Also publishes
  the deliberate per-tier difference in the argument shape (hosted sandbox takes
  `message_id` into a fixed demo inbox; the local stdio package takes the message object,
  because it has no inbox of its own) and the exact error the camelCase guess returns, so
  the convention is read rather than discovered.

- **Docs:** the README and `llms.txt` now reconcile the contract's own arithmetic before an
  auditor has to guess — the published contract's `forbiddenActions` is 3 while the
  hard-stopped classes are 5, because the five are filed under two keys
  (`forbiddenActions` + `draftRefusalClasses`) — and name the second, code-pinned copy of
  the contract in this repo, which has an older shape and no `enforcementModel`, so a
  disagreement between the two copies reads as a named gap rather than as a lie.
- **Docs:** answers the money-safety checklist published audits grade money-moving MCP
  servers by (configurable spending budget · documented human-approval step · velocity
  limit). Two of the three are *not applicable* by construction, with a no-account way to
  reproduce that rather than take it on trust; the third applies and is stricter than the
  field expects. States the cost: RadMail cannot pay an invoice and will not acquire the
  ability to.

- **Docs:** the README and `llms.txt` now answer the draft-vs-refusal question this
  category argues about, at the top rather than in an appendix: `draft_reply` returns a
  draft for ordinary mail, and returns no draft at all for the five hard-stop classes,
  because on a wire-change thread a pre-written reply makes approving easier than
  reading. Two `npx -y radmail-mcp` one-liners let an evaluator reproduce both outcomes
  with no account; both were run verbatim against the published package on 2026-10-14.
  States the cost of the position explicitly: if you need a reply ready to approve on
  every thread, a draft-and-approve server is the right tool and RadMail is not.
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
- **Docs:** `README.md` and `llms.txt` now answer the question a category round-up asks
  before it asks anything else — which ARCHITECTURE is this. Measured 2026-10-11 from a live
  category answer, which sorted email MCP servers into three shapes (transactional/lifecycle
  sending, an inbox the agent owns, OAuth into a mailbox a person already owns) and had no slot
  for a read-and-triage layer over a human-owned mailbox. The corpus had no answer to this:
  `agent-owned`, `transactional` and `architecture` each returned 0 hits across both files
  before the edit. The new text names the fourth shape, gives three checks an evaluator can run
  without an account, and states the honest cost — if you need an agent that owns an address and
  answers mail with no person in the loop, RadMail is the wrong tool. Names no competitor and
  characterises no competitor's architecture.
- Everything that was already on `main` after 0.5.0 (see the git log) ships in this release.
