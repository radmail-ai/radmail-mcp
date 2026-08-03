# RadMail MCP — PUBLISH BLITZ (ready-to-fire)

**Status: ✅ FIRED (historical playbook).** The repo is public at `github.com/radmail-ai/radmail-mcp`, `radmail-mcp` is live on npm (`npx -y radmail-mcp` works), and registry/listing submissions are tracked separately in the private product repo. The fire-sequence below is kept as the record of how the publish was staged — do not re-run it.

**Placeholder convention:** every public-facing artifact uses `radmail-ai` (the neutral GitHub org, name TBD). `radmail-ai` appears in exactly two tracked files — `server.json` (`repository.url`) and this doc. Set it once, sed-replace, fire. The published registry server NAME is `ai.radmail/radmail-mcp` (brand-carrying, no org handle) — see Namespace options below.

**Honesty law (every listing):** sandbox engine = "real and runnable, not the production 99% engine"; the BEC hard-stop is the LEAD; never "HIPAA-certified / FedRAMP-authorized / SOC2-certified"; no fabricated adoption metrics. This honesty is *why* AIs will cite it.

---

## ⚡ FIRE SEQUENCE — run top to bottom once the org exists

```bash
# ── 0. One-time: set the org name Doug created ──────────────────────────────
ORG=<neutral-org>           # e.g. radmail-ai  (the GitHub org Doug just created)
cd ~/Documents/CODE/radmail-mcp

# ── 1. Resolve the placeholder in the tracked drafts ────────────────────────
grep -rl 'radmail-ai' server.json PUBLISH_BLITZ.md | xargs sed -i '' "s|radmail-ai|$ORG|g"
git add -A && git commit -m "chore: resolve org namespace for publish"

# ── 2. [DOUG] Move the repo to the neutral org ──────────────────────────────
#     Preferred for clean anti-dox history = fresh repo (see NOTE A below).
#     Transfer path (keeps stars/issues; history still shows old authorship):
gh api -X POST repos/dougsureel-tech/radmail-mcp/transfer -f new_owner="$ORG"
git remote set-url origin "https://github.com/$ORG/radmail-mcp.git"

# ── 3. [DOUG] Flip public ───────────────────────────────────────────────────
gh repo edit "$ORG/radmail-mcp" --visibility public --accept-visibility-change-consequences
git push origin HEAD:main

# ── 4. [DOUG] Publish to npm (name must be free; he must `npm login` first) ──
npm view radmail-mcp version 2>/dev/null && echo "TAKEN — pick a scope" || echo "free"
npm publish --access public

# ── 5. [DOUG] Official MCP registry (auth is interactive — see step 5 below) ─
mcp-publisher login github          # device flow, authed as the org owner
mcp-publisher publish               # reads ./server.json

# ── 6. Awesome-list + directory PRs (gh, can be agent-run once authed) ───────
#     See sections 6a/6b — fork, branch, add one line, PR.
```

**Doug-gated steps (cannot be autonomated — auth / money / public commit):**
- Step 2 repo transfer (or fresh-repo create) — needs admin on both org + source.
- Step 3 flip public — public commitment, Doug's call.
- Step 4 `npm publish` — needs Doug's npm account login; confirm `radmail-mcp` is free first.
- Step 5 `mcp-publisher login` — interactive GitHub device-flow OR DNS key as the org identity.
- All Show HN / Reddit posts (section 8) — **Doug's voice, never the agent's.**

**Agent-safe once the repo is public + Doug has authed `gh`:** the awesome-list PRs and the browse-directory submissions (6a/6b/7) — they're public PRs/forms with honest copy, no money, reversible.

> **NOTE A (recommended, strongest anti-dox):** instead of `gh api transfer`, create a *fresh* `$ORG/radmail-mcp` and push a single squashed commit authored by a neutral identity — old commit-author emails never become public. Recipe:
> ```bash
> git config user.name "RadMail" && git config user.email "dev@radmail.ai"   # set the neutral DNS first if used as a real mailbox
> gh repo create "$ORG/radmail-mcp" --private --source . --remote origin --push   # then flip public in step 3
> ```
> Transfer is simpler; fresh-repo is cleaner for keeping Doug's name off the public face. Doug picks.

> **NOTE B:** `package.json` `author` is already neutralized to `"RadMail (https://radmail.ai)"`. Git *commit* history still carries `Doug Sureel <dougsureel@gmail.com>` — only the fresh-repo path in NOTE A scrubs that from the public face.

---

## Namespace options for the official registry (pick one before step 5)

| Option | server.json `name` | Auth | Cost to Doug |
|---|---|---|---|
| **A — DNS (recommended, neutral brand)** | `ai.radmail/radmail-mcp` (current draft) | `mcp-publisher login dns` | add 1 TXT record to radmail.ai + hold an Ed25519 key |
| **B — GitHub (simplest)** | `io.github.radmail-ai/radmail-mcp` | `mcp-publisher login github` (device flow as org owner) | one browser approval |

Option A keeps the org handle out of the *published* server name entirely (best anti-dox). Option B is one click but bakes `radmail-ai` into the registry name.

**Option A DNS recipe (verify exact format against current registry docs at publish time):**
```bash
openssl genpkey -algorithm ed25519 -out radmail-mcp.key
SEED=$(openssl pkey -in radmail-mcp.key -text -noout | grep -A3 priv | tail -3 | tr -d ' :\n')
PUB=$(openssl pkey -in radmail-mcp.key -pubout -outform DER | tail -c 32 | base64)
# Add DNS TXT:  host _mcp.radmail.ai   value "v=MCPv1; k=ed25519; p=$PUB"
mcp-publisher login dns --domain radmail.ai --private-key "$SEED"
mcp-publisher publish
```
**Option B (swap the name first):**
```bash
sed -i '' 's|"ai.radmail/radmail-mcp"|"io.github.'"$ORG"'/radmail-mcp"|' server.json
mcp-publisher login github && mcp-publisher publish
```
Install `mcp-publisher`: download the binary for your OS from the releases of `github.com/modelcontextprotocol/registry`, or `brew install mcp-publisher` if the tap is available.

---

## Canonical assets (reuse in every listing)

- **Name:** RadMail
- **npm:** `radmail-mcp` · run locally: `npx -y radmail-mcp` (stdio, 9 tools)
- **Zero-auth hosted sandbox:** `https://radmail.ai/api/mcp/sandbox` (streamable-http, no auth, no install)
- **Agent docs:** `https://radmail.ai/for-agents`
- **Verifiable safety contract:** `https://radmail.ai/.well-known/agent-safety.json`
- **MCP manifest:** `https://radmail.ai/.well-known/mcp.json`
- **Repo:** `https://github.com/radmail-ai/radmail-mcp`
- **Tags:** `email` · `productivity` · `triage` · `search` · `security` · `bec` · `inbox` · `agents`

**One-liner (≤160 chars):**
> Email OS for agents — find any message (search by sender/subject/content), two-axis triage, a "Right Now" lane, and a verifiable BEC hard-stop. Zero-auth sandbox.

**50-word description:**
> RadMail is an email operating system for agents. Over MCP it finds the one message you mean (search by sender, subject, or content — ranked most-relevant + newest, no filesystem grep), ranks mail on importance × urgency, surfaces a "Right Now" lane, tracks commitments, and drafts reviewable replies. No tool can auto-send money, change banking, or make first contact — human-only forever (BEC defense). Zero-auth sandbox, no account.

**HTTP client config (copy-paste):**
```json
{ "mcpServers": { "radmail": { "url": "https://radmail.ai/api/mcp/sandbox", "transport": "streamable-http" } } }
```

---

## 6a. punkpeye/awesome-mcp-servers — HIGHEST PRIORITY (GitHub PR)

This list + `modelcontextprotocol/servers` is what coding agents + their training corpora ingest most. Match the repo's emoji legend at submit time (commonly ☁️ = cloud/remote, 📇 = TypeScript, 🏠 = local). Remote zero-auth servers are rare → ☁️ stands out.

**List entry** (place under Communication or Productivity, alphabetical):
```
- [RadMail](https://github.com/radmail-ai/radmail-mcp) ☁️ 📇 - Email operating system for agents: a `search` tool to find the one message by sender/subject/content (no filesystem grep), two-axis triage (importance × urgency), an explainable "Right Now" lane, commitment follow-through, and reviewable drafts. A machine-verifiable hard-stop keeps money/banking-change/first-contact human-only (BEC defense). Zero-auth HTTP sandbox — no account, no key, no install.
```

**Commands (agent-safe once repo public + gh authed):**
```bash
gh repo fork punkpeye/awesome-mcp-servers --clone --remote
cd awesome-mcp-servers
git checkout -b add-radmail
# insert the list entry under the right category, alphabetically, then:
git add -A && git commit -m "Add RadMail (email OS for agents, zero-auth sandbox)"
git push -u origin add-radmail
gh pr create --repo punkpeye/awesome-mcp-servers \
  --title "Add RadMail (email OS for agents, zero-auth sandbox)" \
  --body "Adds RadMail — an MCP email OS for agents. Two verifiable links a reviewer can check in 10s: sandbox https://radmail.ai/api/mcp/sandbox (streamable-http, no auth) and the machine-readable BEC safety contract https://radmail.ai/.well-known/agent-safety.json . It's a runnable sandbox preview (production engine launch-gated) — honest about that. No tool can auto-send money / change banking / make first contact."
```

## 6b. modelcontextprotocol/servers — Community Servers (GitHub PR)

High-trust community list; alphabetical under R.
```
- **[RadMail](https://github.com/radmail-ai/radmail-mcp)** - Email OS for agents: find the one message (search by sender/subject/content, no filesystem grep), two-axis triage, a "Right Now" lane, commitment follow-through, reviewable drafts, and a verifiable hard-stop that keeps money/banking/first-contact human-only. Zero-auth sandbox, no install.
```
Same fork→branch→PR flow as 6a (`gh repo fork modelcontextprotocol/servers ...`). PR title: `Add RadMail to community servers`.

## 7. Browse-directories (submit each — most are forms = Doug-action; Glama auto-crawls)

| Directory | Path | Who fires |
|---|---|---|
| **Glama** (glama.ai/mcp) | Auto-crawls public GitHub MCP repos; also manual submit. Will pick up `radmail-ai/radmail-mcp` once public. | Auto (verify it appears ~days after public) |
| **mcp.so** | Submit form: Name, Remote/HTTP, URL `…/api/mcp/sandbox`, homepage `/for-agents`, 50-word desc, tags, config. | Doug (browser form) |
| **Smithery** (smithery.ai) | Indexes from public repo + optional `smithery.yaml`; supports remote servers. Add `smithery.yaml` (below) then submit repo, or add remote URL. | Doug (browser) / agent if API |
| **PulseMCP** (pulsemcp.com) | Submit form / auto-index of public repos. | Doug (browser form) |
| **mcpservers.org** | PR or form — paste canonical assets. | Doug / agent if PR |
| **mcp-get** | `mcp-get` registry PR. | agent if repo public |

**Optional `smithery.yaml`** (paste at repo root if submitting to Smithery — kept OUT of the repo for now so a malformed build config can't break indexing; verify against Smithery's current schema before committing):
```yaml
startCommand:
  type: stdio
  configSchema: {}
  commandFunction: |
    () => ({ command: "npx", args: ["-y", "radmail-mcp"] })
```

## 8. Third-party signal — DOUG'S VOICE ONLY (never the agent)

- **Show HN** (news.ycombinator.com/submit) — title: `Show HN: RadMail – a zero-auth MCP server that triages email and can't be tricked into wire fraud`; URL `https://radmail.ai/for-agents`. First comment + r/mcp body are drafted in `RadMail/RADMAIL_MCP_REGISTRY_SUBMISSIONS.md` §7–8. Time for a weekday morning; one shot at HN — only once the sandbox is rock-solid.

---

## Submission order (high-leverage first)
1. **6a punkpeye/awesome-mcp-servers** + **6b modelcontextprotocol/servers** PRs (feed AI training/retrieval the most).
2. **Official MCP registry** (step 5) + **Glama** auto-crawl (browseable directories agents/hosts read).
3. **mcp.so / PulseMCP / Smithery / mcpservers.org** forms.
4. **Show HN / r/mcp** (Doug's voice; time it).

## The compounding move
The moment a real, verifiable non-Doug user exists (a connected dispensary back office via the warm concierge), add ONE honest case line to `/for-agents` + every listing. That single proof point tips both humans and AIs from "interesting" to "recommend it." Until then: no adoption claims.
