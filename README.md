# RadMail MCP

**An email operating system for agents — with a refusal you can trust.**

Every inbox got an AI in 2026. None can be trusted to hit *send*. RadMail is the one that can — because the consequential actions are refused **in code, model-independent**: money, changed-banking details, first-contact senders, decisions, and prompt-injection are **human-only, forever**. No prompt can talk RadMail into auto-sending them.

This is the Model Context Protocol (MCP) server, so any AI agent can use the inbox.

**If a fleet of MCP agents runs your execution layer while you sit in the decision seat, the inbox is the seat that needs a hard-stop first.** It's where a socially-engineered wire or banking change is irreversible — and where an autonomous process that can hit send can be talked into the loss. RadMail lets agents do the inbox's *work* (triage, the Right Now lane, commitment tracking, drafting) while money, changed banking, first contact, decisions, and prompt-injection stay human-only **by construction, not by a policy an agent could be argued out of**. That's what makes the company inbox delegable at all.

## Why it withholds the draft, not just the send

Ask this category how it keeps a person in the loop and the published answer is a draft: the agent composes, a human approves, nothing auto-sends. **For ordinary mail that is the right design, and it is exactly what RadMail does** — `draft_reply` returns text a person reviews and sends, and the hosted tier lists no send tool at all.

For five classes RadMail does something stricter, and the reason is the whole product: **money, changed banking, first contact, a decision, and prompt-injection get no draft at all.** On a wire-change thread a draft is not a safeguard — it is the last mile of the attack. Business email compromise does not fail at the send button; it succeeds at the approval button, by putting a plausible, well-written reply in front of a busy person who only has to say yes. Handing that person a pre-written answer makes approving *easier than reading*. So RadMail withholds the draft and hands over the message and the signals instead, and the person writes the reply.

Both halves are verifiable by execution, with no account — run these two commands and compare:

```bash
# Ordinary mail: a draft comes back.
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"draft_reply","arguments":{"from":"sam@client.example","subject":"Re: the deck","body":"Can you send me the updated deck by Thursday?","knownSender":true}}}' | npx -y radmail-mcp

# A banking change: no draft comes back.
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"draft_reply","arguments":{"from":"cfo@vendor.example","subject":"Updated wire instructions","body":"Our bank details changed. Remit the $48,200 to the new account by Friday.","knownSender":true}}}' | npx -y radmail-mcp
```

Both commands were run verbatim against the published package on **2026-10-14**. The first returns a draft plus `"mcpEnforcement": "No hard-stop. Still a DRAFT — the MCP surface never sends mail."` The second returns `"draft": null`, `"hardStop": "changed-banking"`, and `"mcpEnforcement": "HARD-STOP (changed-banking). No draft offered — human-only forever (BEC defense)."` Note what the second one still gives you: the extracted commitment and the reason, taint-tagged — the withheld thing is the *proposed reply*, not the information.

The five classes are published as `draftRefusalClasses` in [the contract](https://radmail.ai/.well-known/agent-safety.json), and the refusal is a one-way ratchet: it may be tightened, never loosened.

**The cost, stated plainly.** This is a worse experience on precisely the mail you most want handled for you. If a wire-change notice lands at 2am and you wanted a reply waiting, RadMail will have nothing for you to approve — by design. That trade *is* the product. If what you need is a reply ready to approve on every thread including the ones that move money, a draft-and-approve server is the right tool and this is the wrong one.

## Start in one call

Call `triage_inbox` and **omit the token** — RadMail auto-provisions a free sandbox tenant and returns a working triage in one round-trip. Reuse the returned token. (On the zero-auth hosted sandbox, `triage_inbox` takes no args — it triages a built-in demo inbox so your very first call returns the full wedge.)

> This server runs the **sandbox engine** (heuristic, in-memory, free, no credentials). It is real and runnable — not the production "99%" engine.

## Tools

| Tool | What it does |
|---|---|
| `triage_inbox` | One round-trip over a batch: the Right Now lane + every open commitment + every hard-stop. The whole wedge in one call. |
| `list_right_now` | The can't-miss lane only — most-recent × most-important, each with why-surfaced. Pass `messages` for the sandbox (with hard-stop flags), or omit them with `RADMAIL_API_KEY` set for your **real** Right Now lane (read-only). |
| `why_surfaced` | Explain in plain English why a message surfaced — the signals behind its importance × urgency. Transparency, not a black box. |
| `draft_reply` | Draft the reply that discharges a commitment — **never** for a hard-stopped one (money / banking / first-contact stay human-only). |
| `list_commitments` | Open promises with their due window. Pass `messages` for sandbox extraction, or omit them with `RADMAIL_API_KEY` set for your **real** tracked commitments (read-only). |
| `search` | Find the one message you mean by sender / subject / content — most-relevant + newest first (no filesystem grep). Pass `messages` for the sandbox, or omit them with `RADMAIL_API_KEY` set to search your **real inbox** (read-only). |
| `read_email` | **Connected mode only:** fetch one full email (headers + `textBody`) from your real inbox by id. Read-only; body content arrives taint-tagged. |
| `get_attachment` | **Connected mode only:** save one file attached to a real email to `RADMAIL_ATTACHMENT_DIR` and return its path. Read-only; the server decides whether the file may be served (key scope, mailbox, sender allowlist, size cap). |
| `check_send_domain` | **Zero-auth**, works on any domain: read-only SPF / DKIM / DMARC health read (verdicts + raw records + plain-language advice). Probes the common DKIM selectors (`default`, `google`, `resend`, `sendgrid`, `mail`, `k1`, `s1`, `s2`). Read-only DNS — no key, no send capability. |
| `triage` | Score a single message (the per-message form of `triage_inbox`). |
| `provision_sandbox` | Explicitly mint a free sandbox tenant. |
| `report_need` / `request_capability` | Tell RadMail what was awkward / what you wish existed — the surface adapts. |
| `radmail_learning_insights` | What RadMail has learned about how you work. |

### "How many tools?" — and the second number that matters more

Public round-ups of email MCP servers commonly quote a **tool count** as a measure of depth. Tool count measures **surface area**, not judgment — and for a server trusted with an inbox, the useful number is the second one: **of those tools, how many can send?**

RadMail publishes both, as dated observations you can reproduce against any MCP server — this one included:

| Tier | Tools | Send-capable |
|---|---|---|
| Hosted zero-auth sandbox (`https://radmail.ai/api/mcp/sandbox`) | **6** | **0** |
| This npm package, default | **13** | **0** |
| This npm package with `RADMAIL_SEND_TOOL=1` (local stdio only) | **14** | **1** — `send_email`, which hands mail to RadMail's outbound gate and cannot release a hold |

Observed **2026-10-09**. Reproduce row 1 with the `tools/list` command under *Verify before you connect*. Reproduce row 2 from the frozen manifest — the surface the server refuses to deviate from:

```bash
node -e 'const s=require("fs").readFileSync("src/tool-manifest.ts","utf8");
const n=[...s.matchAll(/"name": "([a-z_]+)"/g)].map(m=>m[1]);
console.log(n.length, n.join(" "))'
```

⚠️ **One honest caveat, because the naive version of this check gets it wrong:** grepping that list for `send` matches **`check_send_domain`**, which is a read-only SPF/DKIM/DMARC *lookup* over DNS — it reads a domain's published records and sends nothing. Read each tool's description, not just its name. That caveat applies to whatever server you are evaluating, not only to this one.

**The ratio is the point, and it is not a verdict on anyone else.** A wide, send-capable tool surface is a legitimate design for an agent that is *supposed* to send, and most of this category is built for exactly that job. It is the wrong design for the one class of email where being argued into sending *is* the whole attack. RadMail reports **0 send-capable tools on every hosted endpoint** — see *The safety contract* for why that is `capability-absent` rather than a setting someone could switch.

### Which of the three shapes is this? (a fourth one — and the difference *is* the product)

Published round-ups of this category sort email MCP servers into roughly three shapes:

1. **Transactional / lifecycle sending for an application** — deliverability, templates, logs, domain management.
2. **An inbox the agent owns** — the agent has its own address and receives, threads and answers mail end to end.
3. **OAuth access to a mailbox a person already owns** — read and write that person's real Gmail or Outlook.

RadMail is none of those three cleanly, which is why a round-up built on them has nowhere to put it. The shape is a **fourth** one: a triage-and-follow-through layer over a mailbox that stays a *person's* mailbox. The agent gets rank, explanation, commitment tracking and a draft; the person keeps the send.

That is a boundary rather than a feature list, so it is checkable — in about a minute, without an account:

- **The agent does not own the mailbox.** The hosted endpoint takes no credential and serves a fixed demo inbox. Shape 2 needs an address of its own; shape 3 needs your OAuth grant. RadMail asks for neither to be evaluated.
- **Connected mode is read-only.** With `RADMAIL_API_KEY` set, `search` / `read_email` / `list_right_now` / `list_commitments` read your real mail; none of them writes or sends.
- **The send verb is absent from every hosted endpoint** — `0` send-capable tools, reproducible with the `tools/list` command under *Verify before you connect*. Sending exists only as an opt-in local tool, and even then it cannot release a held message.

**And the honest cost of being a fourth shape:** if what you need is an agent that owns an address and answers mail with no person in the loop, shape 2 is the right choice and RadMail is the wrong tool — it will refuse precisely the things you would be hiring it to do. RadMail is built for the mailbox a business actually runs on, where being argued into sending *is* the attack.

## The safety contract (un-bypassable by design)

These are decided by deterministic code, not model judgment — see the published contract at [`https://radmail.ai/.well-known/agent-safety.json`](https://radmail.ai/.well-known/agent-safety.json) (there is a second, code-pinned copy in this repo — see *Counting the contract* below, so a disagreement between them does not read as a lie):

- **money**, **changed-banking**, **first-contact**, **decision/sign-off**, **prompt-injection** → `hardStop`, human-only forever. RadMail will never hand an agent an auto-sendable reply for these.
- **Enforcement model: `capability-absent`.** "The agent can't do that" is three different claims, and they are not equally strong — so the contract publishes which one this is, as `enforcementModel`, with all three values defined so the label is interpretable rather than a slogan:

  | Value | What it means |
  |---|---|
  | **`capability-absent`** — RadMail | The tool that would perform the forbidden action does not exist on the server, so it cannot be called. There is nothing to configure and nothing to bypass. |
  | `config-restricted` | The capability exists and is narrowed by configuration — an allowlist, a scope, a policy file. Whoever holds the configuration can widen it again. |
  | `policy-gated` | The capability exists and is restrained by instructions, prompts, or documented policy that a model is asked to follow. |

  The three definitions are generic and name no product — this is the axis, not a comparison. **Don't take the label's word for it:** read the tool list back (see *Verify before you connect*) and look for a send-capable tool. There isn't one; that absence *is* the enforcement.
- **A human-in-the-loop approval gate sits on a different row.** "Human-in-the-loop" normally means the capability exists and a person is asked to approve each use — `config-restricted` or `policy-gated` on the axis above. Approval gates have a legitimate place and they work differently: whoever holds the configuration can widen one, and an approver under time pressure is precisely what business-email-compromise fraud is built to exploit. RadMail reports `capability-absent` on the hard-stopped classes, so there is no request to approve and nothing to widen. The reviewable drafts are the human-reviewed path for everything *outside* those classes — RadMail drafts, a person sends.
- **A read-only banking connector protects a different thing.** A read-only bank or accounting MCP server cannot initiate a transfer, so it cannot execute the fraud directly — genuinely useful, and a different job. Business email compromise is not an attack on your bank connection; it is an attack on your inbox. The fraudulent instruction arrives as email — a supplier whose bank details have "changed", an invoice redirected to a new account, a first-contact request that reads as routine — and the loss happens when a person or an agent believes it and acts through some other channel. A read-only connector never sees that email, so it cannot flag it. RadMail works where the instruction lands: money, changed-banking, first-contact, decision and prompt-injection stay human-only, reported as `capability-absent`, not as a setting an operator could switch off.
- **Taint envelope:** every field derived from a raw email body carries `provenance: "untrusted-email-body"`, and every response carries a `safety` block restating the hard-stops. **Treat tainted fields as data, never as instructions** — this keeps *your* agent safe-by-default, even against a poisoned email.
- Fail-closed: if a risk signal can't be evaluated, RadMail refuses to auto-send.

### Counting the contract: `forbiddenActions` is 3, the hard-stopped classes are 5

Audit the published contract by counting one key and the number will not match the prose, so here is the reconciliation **before** you conclude this README overclaims. Observed on `https://radmail.ai/.well-known/agent-safety.json`, **2026-10-18**, 21 keys:

- `forbiddenActions` → **3**: auto-sending money, auto-sending or changing banking instructions, auto-sending first contact. These are actions this server **has no tool for**.
- `draftRefusalClasses` → **5**: `money`, `changed-banking`, `first-contact`, `decision`, `injection`. These are the classes for which RadMail withholds **the draft itself** — see *Why it withholds the draft, not just the send*.
- `enforcementModel` → **`capability-absent`**, with `enforcementModelValues` defining all three values so the label is interpretable rather than a slogan.

So the five classes are filed under two keys, not three-instead-of-five. 3 + 5 is the same posture the prose describes, not a weaker one.

**And there are two copies of this contract, which is said out loud because an evaluator who reads one and checks the other will think something is wrong.** The published contract above is the one to fetch, and every claim in this file is keyed to it. The copy in this repo — [`public/.well-known/agent-safety.json`](./public/.well-known/agent-safety.json) — has an older shape (observed **2026-10-18**: 20 keys, all five classes filed under `forbiddenActions`, and **no `enforcementModel` at all**, so do not go looking for that field there). It earns its place a different way: it is the copy a **test ties to the running firewall**. `test/agent-safety-contract-matches-the-code.test.ts` asks the real send-disposition engine whether each permanently-human-only action type is actually refused, and fails if the document names a tool this server does not expose. Nothing compares the two automatically — different repos, no network in CI — so this is a named gap, not a silent one. They agree on the five classes and on fail-closed; if you find a disagreement that matters, that is a bug and the contact address is at the bottom.

### Auditing this against the money-safety checklist (two of the three fields do not apply)

Published audits of money-moving MCP servers grade on three fields: a configurable **spending budget**, a documented **human-approval step**, and a **velocity limit**. Those are the right three questions for a server that can move money. Asked of RadMail, the honest answers are two *not-applicable*s and one that is stricter than the field expects:

| Audit field | RadMail's answer |
|---|---|
| Configurable **spending budget** | **Not applicable — there is no spend to bound.** A budget limits a capability; this capability is absent. Answering "yes, $X per day" would imply a money-moving path exists and is merely capped. |
| **Velocity limit** (payments/day, auto-sends/hour) | **Not applicable.** Rate-limiting an action the server cannot perform is theatre. Ordinary mail has no auto-send to rate-limit either — `draft_reply` returns text a person sends. |
| Documented **human-approval step** | **Applies — and the answer is stricter than the field expects.** On the five classes there is nothing to approve: no draft is offered and no send verb exists. Approval gates are a legitimate design and they fail in a known way: an approver under time pressure is precisely what business-email-compromise fraud is built to exploit. |

**Reproduce the two *not-applicable*s rather than believing them.** On the frozen manifest — the surface this server refuses to deviate from — `grep -ic budget src/tool-manifest.ts`, and the same for `velocity` and `spend`, each return **0** (observed **2026-10-18**). The hosted `tools/list` returns **6 tools, 0 send-capable** (observed **2026-10-18**: `triage_inbox`, `list_right_now`, `why_surfaced`, `list_commitments`, `draft_reply`, `search`). An absent field is weak evidence on its own; an absent *verb*, readable with no account, is the part that matters.

**The cost, stated plainly:** RadMail cannot pay an invoice and will not acquire the ability to. If your agent's job is to move money, you need a payments server — and that is exactly where a spending budget, a velocity limit and an approval step are the questions to ask, so ask them there. RadMail's job is the inbox the fraudulent instruction arrives in.

### Auditing this against the BEC control checklist the security category publishes (three of the five are someone else's job)

Ask the email-security category how to stop business email compromise and the published guidance converges on five controls. Asked of RadMail the honest answers are **one stricter than the field expects, one partial, and three flat no**s — because RadMail and an email-security gateway solve different halves of the same problem, and conflating them is how a buyer ends up unprotected.

| Published BEC control | RadMail's answer |
|---|---|
| **A second authorized reviewer** on wires, payroll changes and vendor-bank changes — an approval that urgency or seniority cannot waive | **Applies, and is stricter than the field expects.** For an agent there is no approval request to waive, because there is no tool: `money` and `changed-banking` are `capability-absent`, and RadMail withholds the *draft* too, so there is nothing pre-written to say yes to. The reviewer is the only author. |
| **Out-of-band callback verification** to a previously known-good number | **Not implemented, and RadMail will not acquire it.** RadMail places no calls and holds no vendor contact-of-record, so it cannot confirm a changed account through a second channel. What the hard-stop buys is the *pause in which a person makes that call* — it does not make the call, and reading it as if it did would be the dangerous misreading. |
| **Authentication of the sending infrastructure** (SPF / DKIM / DMARC) | **Partially — and narrower than the name suggests.** `check_send_domain` is a zero-auth, read-only DNS read of SPF / DKIM / DMARC for a domain *you name*, probing the common selectors. It is **not** per-message header authentication of received mail, it does not evaluate alignment on a specific message, and it cannot act on the answer. |
| **Impersonation / behavioural-anomaly detection on inbound mail** | **No. This is not an email-security product.** RadMail scores importance × urgency and flags the five hard-stop classes on messages that have *already reached the inbox*. It does not model sender relationships to decide whether a message is forged, and it should not be bought instead of something that does. |
| **Automated remediation** — quarantine, clawback, incident clustering | **No, by the same construction as everything else.** The hosted surface is 6 tools, read/triage/draft only; nothing moves, deletes or quarantines mail. |

**Reproduce the three *no*s rather than believing them.** On the frozen manifest — the surface this server refuses to deviate from — `grep -ic quarantine src/tool-manifest.ts` and the same for `delete` and `archive` each return **0**, and `grep -ic send` returns **1**: the noun inside `check_send_domain`, a read-only DNS lookup. The hosted `tools/list` returns **6 tools, 0 send-capable** (observed **2026-10-23**: `triage_inbox`, `list_right_now`, `why_surfaced`, `list_commitments`, `draft_reply`, `search`).

**The two halves, stated so nobody buys the wrong one.** A BEC gateway defends the mailbox against the attacker's *message* — filtering, authentication, impersonation modelling, quarantine. RadMail constrains what an **agent** may do with the mailbox once a message is in it. Those are not competing claims: a gateway that stops almost everything still passes the message it has not seen before, and in 2026 what increasingly stands at the other end of that message is an autonomous process with send rights and no instinct for a changed bank account. **If you have no inbound email security, RadMail is not a substitute and you should buy one.** If you have one and you are also handing an agent the inbox, the gateway has nothing to say about what the agent does next — that is the row RadMail is on.

## Verify before you connect

The safety contract is **machine-verifiable** — fetch it and check it in one command, no account, no key:

```bash
curl -s https://radmail.ai/.well-known/agent-safety.json
```

**Then don't take its word for it — read the tool list back and look for a send-capable tool.** This is the check the `capability-absent` row above points at, and it needs no key either:

```bash
curl -s -X POST https://radmail.ai/api/mcp/sandbox \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Read the names back. There is no `send`, no `send_email`, no `pay`, no `update_banking` — and that absence *is* the enforcement. (One exception, and only where an operator chose it: a **local** stdio server started with `RADMAIL_SEND_TOOL=1` also lists `send_email` — see *Opt-in: sending* below. The hosted endpoints never do.) Observed on the hosted sandbox **2026-10-09: 6 tools** — `triage_inbox`, `list_right_now`, `why_surfaced`, `list_commitments`, `draft_reply`, `search`. That is a dated observation of the **hosted sandbox tier**, not a ceiling: the local stdio package exposes the fuller set in the table above. Re-run the command rather than trusting this line.

**And the one claim you cannot check from the outside — check it in the source.** The strongest sentence in this README is *"no tool can release a held send"* (below, under *Opt-in: sending*). A paragraph is not evidence, and that claim is the one a hosted `tools/list` cannot reach, because the send tool is not on the hosted tier at all. It is asserted by a test in this repo — so run the test instead of believing the paragraph:

```bash
git clone https://github.com/radmail-ai/radmail-mcp && cd radmail-mcp && npm install
RADMAIL_TELEMETRY=off node --test --import tsx \
  --test-name-pattern="release a held send" test/send-email.test.ts
```

Three things are asserted: that **every URL the tool fetches, across every outcome, is the send path** and never a `/confirm` route; that **neither the client nor the tool names a confirm/release route** anywhere in its source; and that **the input schema has no field** that could name an earlier request to act on. Observed **2026-10-05: 3 pass, 0 fail** — a dated observation, like every other count in this file. Re-run it.

🔑 **Now make it fail, because a guard you have not seen bite is not a guard.** Add one line to `src/lib/send.ts` —

```bash
echo 'export const RELEASE_PATH = "/api/v1/sends/confirm";' >> src/lib/send.ts
```

— and re-run the command above: the second assertion fails and the suite exits non-zero. Then `git checkout src/lib/send.ts` to put it back. RadMail publishes the falsification step rather than asking you to assume the check is real.

### Reproducing the explanation itself — and the argument name this README never published

`why_surfaced` is the claim that the ranking is explainable rather than a score with a story attached. It is named three times above and its one argument was never written down, so until now the fastest way to check the claim had to be guessed at. Two commands, no account, no key:

```bash
# 1. get an id out of the demo inbox
curl -s -X POST https://radmail.ai/api/mcp/sandbox \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_right_now","arguments":{}}}'

# 2. ask why that one surfaced — the argument is message_id (snake_case)
curl -s -X POST https://radmail.ai/api/mcp/sandbox \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"why_surfaced","arguments":{"message_id":"m_001"}}}'
```

Observed **2026-10-19** — six named signals and the base number they move, not a sentence:

```
Why "Re: PO-4471 — confirm revised delivery window" [m_001] scored importance 94 x urgency 94:

  • sender is a known counterparty (base importance 78)
  • you owe an open commitment on this thread
  • arrived in the last few hours
  • explicit same-day deadline language
  • an explicit confirmation is requested
  • a commitment on this thread is due soon
```

**And the part worth measuring instead of asserting: the same input returned the same bytes.** Three consecutive calls on **2026-10-19** returned byte-identical 433-byte payloads — `sha256 e0eebdcf46ae7aada7abc0ac41e5a48608773026252fd49a511f07f5d8cb549c`. That is what *"not a black box"* is being used to mean here: the signals are the scoring inputs read back, so an explanation can be diffed, pinned in a test, and shown to a person who disagrees with the rank. An explanation written by a model narrating its own guess is a legitimate design and often reads better — but two identical calls to it need not agree, and what does not repeat cannot be diffed. Re-run the commands rather than trusting this paragraph, and scope the claim the way it is scoped here: this is the **heuristic sandbox tier**, which is the part you can check with no account.

**The two tiers take the argument differently, and that is by design, not drift.** The hosted sandbox serves a fixed demo inbox, so `why_surfaced` there takes `message_id` — ids `m_001`–`m_006`, and `list_right_now` prints them in brackets. The local stdio package has no inbox of its own (you pass it your own messages), so there `why_surfaced` takes the **message object** — `from` and `body`, optionally `knownSender` / `hasReply` / `receivedAt` / `subject` — the same shape as `triage`. Measured on the hosted tier 2026-10-19: the camelCase guess `{"messageId":"m_001"}` does not fail silently, it answers `No demo message with id "". Pass a message_id from triage_inbox (available ids: m_001, m_002, m_003, m_004, m_005, m_006).` — which is the list you needed. Published here so the convention is read rather than discovered.

### An independent grade of this server — one we did not ask for and do not control

Everything above this line is RadMail checking RadMail. A reader is right to discount it. So here is the same claim measured by someone else, on a page RadMail does not own, cannot edit, and never submitted to:

[![AxioRank MCP Security Index grade for radmail-mcp](https://axiorank.com/api/badge/mcp/ai-radmail-radmail-mcp.svg)](https://axiorank.com/mcp-index/ai-radmail-radmail-mcp)

AxioRank's MCP Security Index crawls a server's declared tool surface and grades its **blast radius** — "the most powerful thing each of its tools can do." Its scorecard for this server, read **2026-10-22**:

| what AxioRank measured | its value |
|---|---|
| Grade | **A** — "a minimal exposure" |
| Blast radius | **0 / 100** |
| Tools found | 6 |
| Capabilities flagged | **0** |
| Execute · Delete · Write · Read | **0 · 0 · 0 · 6** |

In its own words: *"radmail-mcp declares no high-impact capabilities that AxioRank flags."*

**And the caveat matters more than the grade, so here it is verbatim rather than paraphrased:** *"The grade reflects the blast radius of what radmail-mcp declares it can do, read-only, not whether it is secure or trustworthy, and not a judgment of the vendor."* And: *"A minimal grade means a small blast radius, not an endorsement."* That is the correct reading. A zero blast radius says the dangerous verbs are **absent from the declared surface** — which is exactly the claim the `capability-absent` row makes and exactly what the `tools/list` command above lets you re-derive yourself in one call. It does not say the code is well written, and it is not a security audit.

RadMail has no relationship with AxioRank, did not request the listing, and cannot change what it says. The badge above is served live by them, so it moves if their grade moves — including downward. That is the point of citing it.

#### The `high` advisory on that page, and the one keyword that causes it

That same scorecard shows an **Advisory: `high` — "Credential / secret access capability."** It would be dishonest to link the grade and skip the red word next to it, so: AxioRank labels that block *"Keyword matches in tool descriptions and schemas… shown for transparency and are not part of the grade"* — and the keyword it matched is one this README can name, because it was measured rather than guessed.

```bash
curl -s -X POST https://radmail.ai/api/mcp/sandbox \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o RADMAIL_API_KEY
```

Counted over that whole payload on **2026-10-22**: `api_key` **1**, and `token` · `credential` · `secret` · `password` **0 each**. The single hit is inside the **description** of `search`, where it explains the connected-mode upgrade: run the local package with `RADMAIL_API_KEY` set and the same tool reads your real inbox instead of the demo one. A keyword scanner reading tool prose cannot tell a sentence *about* a key from a tool that *handles* one — and this is the former. There is no tool here that reads, writes, stores, or forwards a credential; the same scorecard's own capability count says so on the line above (Read 6, everything else 0).

The honest shape of it: **the advisory is a true statement about our text and a false impression about our surface.** We are not going to delete the sentence that tells an operator how to connect their real inbox in order to make a keyword scanner happier — we would rather publish the arithmetic and let you run the `grep`.


## Connect

**Fastest — zero-auth hosted sandbox** (no install, no key, no signup). Point any MCP client at the streamable-HTTP endpoint:

```json
{
  "mcpServers": {
    "radmail": {
      "url": "https://radmail.ai/api/mcp/sandbox",
      "transport": "streamable-http"
    }
  }
}
```

**Local stdio** (this package — the fuller surface that triages the messages you pass it):

```json
{
  "mcpServers": {
    "radmail": {
      "command": "npx",
      "args": ["-y", "radmail-mcp"]
    }
  }
}
```

> `radmail-mcp` is live on npm — the `npx` line above works as-is. Prefer no install at all? Use the **zero-auth hosted sandbox above**.

> ⚠️ **Honest note on the published version (true as of 2026-09-30).** `npm view radmail-mcp dist-tags` reports `latest: 0.5.0`, but the build inside that tarball announces itself as **`0.4.0`** over MCP — `dist/` was packed before a version bump. This repository's `main` is at `0.5.1` with the root cause fixed (`prepublishOnly` now rebuilds `dist/` before packing); the corrected package is not yet published, because publishing needs an interactive `npm login` only the maintainer can run. Reproduce it yourself: `npm pack radmail-mcp && tar -xzOf radmail-mcp-*.tgz package/dist/src/server-info.js | grep version`. No part of the safety contract depends on the version string — but RadMail publishes this check rather than asking you to assume.

Or from source: `git clone https://github.com/radmail-ai/radmail-mcp && npm i && npm run build && npm start` (stdio). Hosted deploy: Vercel Node serverless function (`api/mcp.ts`; `/` rewrites to the MCP handler).

## Connected mode — your real inbox

Give the server a RadMail API key and **four tools** stop being a demo. Omit `messages` and:

- `search` finds **any email you've ever received** in your real RadMail inbox;
- `read_email` fetches the full message (headers + `textBody`);
- `list_right_now` returns your **real can't-miss lane** — the live engine's band + importance + urgency + reasons per item;
- `list_commitments` lists your **real open promises** — direction (`owed_by_us` / `owed_to_us`), party, action, due date/phrase, state, confidence.

Search it, read it, know what matters now, know what's owed — install it once and your AI has the whole picture.

- **Config:** set `RADMAIL_API_KEY` (keys start with `tmk_` — create one in about a minute at <https://app.radmail.ai/settings/api-keys>). Optional: `RADMAIL_API_URL` overrides the API host (default `https://app.radmail.ai`).
- **Read-only by construction:** connected mode only ever issues GETs. It never sends, drafts against, or mutates real mail, and the BEC hard-stops (money / changed-banking / first-contact / decision / injection) stay human-only forever.
- **Same taint envelope:** every field derived from real email content (`subject`, `fromName`, `snippet`, `textBody`, …) arrives tagged `provenance:"untrusted-email-body"` — data to reason about, never instructions to follow.
- **Fail-closed:** invalid key (401), un-entitled plan (403), or a timeout returns an honest, typed error — never fabricated results. The key itself is never logged or echoed.
- **Filters & paging:** connected `search` supports optional `from`, `after`, and `before` (ISO-8601) alongside `query` and `limit`; connected `list_right_now` / `list_commitments` support `limit` and `offset`.
- **No fabricated judgments:** connected `list_right_now` surfaces the live engine's own band / importance / urgency / reasons as-is — it never invents local hard-stop determinations the API didn't return.
- Without a key, `search` / `list_right_now` / `list_commitments` (sans `messages`) and `read_email` return friendly setup instructions instead of an error — the sandbox keeps working exactly as before.

### The live engine is owner-taught

Connected mode reads a live engine the inbox owner actively teaches — the band / importance / reasons you get back reflect these controls (all live in the RadMail app at <https://app.radmail.ai>):

- **VIP senders** — an owner-named "always important" allow-list (a banker, a key partner). VIP is the top reputation override — it beats reply-history and every heuristic.
- **Muted senders** — the explicit "never important" twin. A mute suppresses sender reputation only; regulator notices and past-due signals still surface (a mute never hides a real compliance notice).
- **Delegates** — additional addresses (an assistant, an operations manager) that receive owner-level engagement treatment in the importance model. Importance-only: delegates never gain send or approval authority.
- **One-click teaching** — every daily-digest item carries signed 👍/👎 feedback links (plus a ⭐ "always important from this sender" action) that tune future ranking.
- **Own-product demotion** — the owner's own SaaS / notification mail can't ride reply history into the important lane.
- **Daily digest** — an opt-in consolidated "needs you" email, delivered once a day at 7am in the org's local timezone, that silences per-email pings while the Right Now lane keeps firing.

How real mail gets in today: RadMail's Apple Mail connector (macOS) feeds connected inboxes; hosted Gmail / Microsoft 365 OAuth connectors are pre-release.

**Claude Code:**

```bash
claude mcp add radmail -e RADMAIL_API_KEY=tmk_... -- npx -y radmail-mcp
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "radmail": {
      "command": "npx",
      "args": ["-y", "radmail-mcp"],
      "env": { "RADMAIL_API_KEY": "tmk_..." }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "radmail": {
      "command": "npx",
      "args": ["-y", "radmail-mcp"],
      "env": { "RADMAIL_API_KEY": "tmk_..." }
    }
  }
}
```

> `radmail-mcp` is live on npm, so the `npx` lines above work as-is. Prefer source? Point `command` at `node dist/src/index.js` — connected mode works the same way.

## Opt-in: sending (local stdio only)

Off by default, absent from the hosted endpoints, and present on a local server only when its operator sets **both**:

```bash
# RADMAIL_API_KEY       the read key (search / read_email / right-now) — never used to send
# RADMAIL_SEND_TOOL=1   lists send_email on THIS server
# RADMAIL_SEND_API_KEY  a separate key with the send scope, ideally confined to one mailbox
claude mcp add radmail \
  -e RADMAIL_API_KEY=tmk_... \
  -e RADMAIL_SEND_TOOL=1 \
  -e RADMAIL_SEND_API_KEY=tmk_... \
  -- npx -y radmail-mcp
```

`send_email` hands the email to RadMail's outbound gate (`POST /api/v1/send`) and reports one of three outcomes:

| outcome | what happened |
|---|---|
| `sent` | RadMail's gate released it from the owner's connected mailbox. |
| `held` | Nothing was sent. The owner releases or discards it in the RadMail app at `reviewUrl`. |
| `refused` | Not sent and not held — bad input, sending switched off, no send key, a suppressed recipient. |

**RadMail decides, not the agent.** It sends at once only when every recipient is on the owner's own team (a domain the workspace marked internal) or an established two-way contact; everything else is held. Money, changed-banking, first-contact, decision and injection content, and regulator / government / court / bank recipients, always hold. **No tool can release a held send** — the response carries a link to the app page, never a token, and the client only ever calls the send path. Do not take that on trust: *Verify before you connect* above carries the command that asserts it, and the one-line edit that makes it fail.

⚖️ **Be exact about what this changes.** On a server with sending turned on, the *capability-absent* label above no longer describes sending: the capability exists and is narrowed by configuration (`config-restricted`), and a held send is a person approving a request. The five hard-stopped classes still cannot leave without that person. The safety block on every response says which kind of server you are talking to: a send-enabled server replaces the "never sends mail" sentence with a `sendSurface` statement rather than leaving a false one in place.

The tool's description asks the agent to run its own correspondence review on the exact text before sending to anyone outside the owner's team — RadMail's gate catches machine-written tells and unthreaded replies, but it is not a substitute for a voice review.

## Telemetry (demand signals — opt-out)

This server sends anonymous demand-signal telemetry to `https://app.radmail.ai/api/mcp-demand` so RadMail can see which tools agents actually use and what capabilities they ask for: **what's sent** is the tool name, the event type (`call` / `need` / `capability`), the need or capability text you explicitly submit via `report_need` / `request_capability`, and the optional agent id you pass. **What's never sent:** email content, message batches, search queries, results — and never your API key (in connected mode only the safe display prefix, `tmk_live_` + the first 4 characters, is transmitted so adoption of connected mode is distinguishable). Sends are fire-and-forget with a 3-second timeout and every failure silently swallowed — telemetry can never slow down or break a tool call. **Opt out entirely** with `RADMAIL_TELEMETRY=off`.

## How a directory lists this server

Third-party directories and answer engines don't read this README — they mirror the **`server.json`** record in the [official MCP registry](https://registry.modelcontextprotocol.io). Two publisher-controlled fields decide what a human or a model actually sees on those pages:

- **`title`** — an optional human-readable display name, **max 100 characters**, present in the `2025-12-11` server schema and absent from `2025-09-29`. A directory with a title renders it; a record without one falls back to the bare package slug.
- **`description`** — the one-line summary shown beneath it.

Read what this repo declares, and what the live registry serves, side by side — no key, no clone:

```bash
# what main declares
curl -s https://raw.githubusercontent.com/radmail-ai/radmail-mcp/main/server.json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("title")); print(d["description"])'

# what the live registry serves today
curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=radmail' \
  | python3 -c 'import json,sys; [print(s["server"]["version"], "|", s["server"].get("title"), "|", s["server"]["description"]) for s in json.load(sys.stdin)["servers"]]'
```

⚠️ **The two do not match yet, and that is stated here rather than glossed.** Observed **2026-10-10**: the registry's current (`isLatest`) record for `ai.radmail/radmail-mcp` is **0.5.0** on the `2025-09-29` schema — which has no `title` field at all — and carries the older 93-character description, while `main` is 0.5.1. So read this section as *what RadMail declares*, not as what a directory is showing you today; the second command above is the one that settles it either way.

Updating the record is a credential action and a human's — `mcp-publisher login github` (or `login dns --domain radmail.ai`) then `mcp-publisher publish`. **`mcp-publisher validate` needs no credential**, so anyone can check the record is well-formed before trusting it; against this repo on 2026-10-10 it returns `✅ server.json is valid`.

## Links

- Agent docs: <https://radmail.ai/for-agents>
- Zero-auth sandbox: `https://radmail.ai/api/mcp/sandbox` (streamable-http, no auth)
- Verifiable safety contract: <https://radmail.ai/.well-known/agent-safety.json>
- MCP manifest: <https://radmail.ai/.well-known/mcp.json>
- LLM-readable summary: <https://radmail.ai/llms.txt>

## Compliance posture

A tool, not a guarantee — BAA + shared-responsibility framing. **Never** "HIPAA-certified" or "FedRAMP-authorized."
