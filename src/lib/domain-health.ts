// Domain send-health — the pure + DNS layers behind the zero-auth
// `check_send_domain` tool: a READ-ONLY SPF / DKIM / DMARC posture read for
// any domain an agent asks about.
//
// SPF answers "who may send FROM this domain", DKIM answers "is mail from it
// cryptographically signed", DMARC answers "what should receivers DO when
// neither aligns". A domain weak on these lands in spam — the single most
// common silent email-deliverability failure.
//
// The SPF + DMARC parsing/verdict logic is ported from the proven watchdog
// reference implementation (/CODE/watchdog/checks/domain-spf-dmarc.mjs) into
// this repo's TypeScript conventions; v1 adds the DKIM-alignment layer the
// reference deliberately skipped: probe the COMMON selector names via DNS TXT
// at `<selector>._domainkey.<domain>` (plus CNAME-delegation detection, the
// M365/SES shape).
//
// Design contract (mirrors lib/connected.ts):
//   · READ-ONLY DNS. Nothing is sent; no record is ever mutated.
//   · Fail-soft: ENOTFOUND/ENODATA = "no record" (a legitimate answer, not an
//     error); timeouts / resolver failures surface as `lookupFailed`, never as
//     a thrown exception out of the tool.
//   · The DNS layer is injectable (__setDnsForTests) so unit tests never do
//     live DNS — same seam pattern as connected.ts's __setFetchForTests.
//   · All verdict logic is pure + exported for fixture-string unit tests.

import { promises as realDns } from "node:dns";

// ─── Injectable DNS layer ────────────────────────────────────────────────────

export interface DnsLike {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

let dnsForTests: DnsLike | null = null;

/** Test hook — inject a fake DNS layer (null restores the real resolver). */
export function __setDnsForTests(d: DnsLike | null): void {
  dnsForTests = d;
}

function dns(): DnsLike {
  return dnsForTests ?? realDns;
}

/** Per-lookup budget. A slow resolver must never wedge the tool. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

type TxtLookup =
  | { ok: true; records: string[] }
  | { ok: false; reason: "no-record" | "lookup-failed" };

function isNoRecordError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`DNS lookup exceeded ${DNS_LOOKUP_TIMEOUT_MS}ms`)),
        DNS_LOOKUP_TIMEOUT_MS,
      );
      // Don't hold the event loop open for the losing branch.
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

/** TXT lookup, fail-soft. Chunked TXT strings are re-joined per record (RFC 1035
 *  splits long values into 255-byte strings with no separator). */
async function lookupTxt(name: string): Promise<TxtLookup> {
  try {
    const raw = await withTimeout(dns().resolveTxt(name));
    return { ok: true, records: raw.map((chunks) => chunks.join("")) };
  } catch (e) {
    return { ok: false, reason: isNoRecordError(e) ? "no-record" : "lookup-failed" };
  }
}

/** CNAME lookup, fail-soft: first target (trailing dot stripped) or null. */
async function lookupCname(name: string): Promise<string | null> {
  try {
    const targets = await withTimeout(dns().resolveCname(name));
    const first = targets.find((t) => t.trim().length > 0);
    return first ? first.trim().replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

// ─── Input normalization (pure) ──────────────────────────────────────────────

// DNS-name labels (underscore allowed — _spf.google.com, _dmarc.* are real
// DNS names even though they aren't valid HOSTnames); TLD must be alphabetic.
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** Normalize agent input ("https://Example.COM/path", "example.com.") to a bare
 *  lowercase domain, or null when it can't be a DNS domain. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // protocol
  d = d.replace(/^\/\//, ""); // protocol-relative
  const at = d.lastIndexOf("@"); // userinfo or a pasted email address
  if (at !== -1) d = d.slice(at + 1);
  d = d.split(/[/?#]/)[0]; // path / query / fragment
  d = d.split(":")[0]; // port
  d = d.replace(/\.$/, ""); // trailing root dot
  if (!DOMAIN_RE.test(d)) return null;
  return d;
}

// ─── SPF (pure) ──────────────────────────────────────────────────────────────

export type SpfAllQualifier = "-all" | "~all" | "?all" | "+all";
export type RecordVerdict = "pass" | "warn" | "fail" | "none" | "unknown";

export interface SpfAnalysis {
  verdict: RecordVerdict;
  record: string | null;
  recordCount: number;
  allQualifier: SpfAllQualifier | null;
  /** redirect= target, when the record delegates (e.g. gmail.com → _spf.google.com). */
  redirectTarget: string | null;
  /** True when allQualifier was resolved by following the redirect one hop. */
  allViaRedirect: boolean;
  /** DNS-querying mechanisms (include/a/mx/ptr/exists/redirect). >10 = permerror risk. */
  lookupMechanismCount: number;
  lookupCountRisk: boolean;
}

/** Pure: the v=spf1 records among a domain's TXT records (ported from the
 *  reference's parseSpfRecord, widened to return ALL — two SPF records is
 *  itself a failure mode the reference's single-return couldn't express). */
export function findSpfRecords(txtRecords: string[]): string[] {
  return txtRecords
    .map((r) => r.trim())
    .filter((r) => /^v=spf1(\s|$)/i.test(r));
}

/** Pure: the record's `all` qualifier ("v=spf1 ... ~all" → "~all"). A bare
 *  `all` means `+all`. Null when no all-mechanism is present. */
export function spfAllQualifier(record: string): SpfAllQualifier | null {
  const m = /(?:^|\s)([-~?+]?)all(?:\s|$)/i.exec(record);
  if (!m) return null;
  return `${m[1] || "+"}all` as SpfAllQualifier;
}

/** Pure: the redirect= modifier's target domain, or null. A record with
 *  redirect= and no `all` delegates its policy to the target (RFC 7208 §6.1). */
export function spfRedirectTarget(record: string): string | null {
  const m = /(?:^|\s)redirect=([^\s]+)/i.exec(record);
  return m ? m[1].toLowerCase() : null;
}

/** Pure: count the DNS-querying mechanisms/modifiers. RFC 7208 §4.6.4 caps
 *  these at 10; beyond that receivers return permerror = SPF silently void. */
export function spfLookupMechanismCount(record: string): number {
  let count = 0;
  for (const term of record.trim().split(/\s+/).slice(1)) {
    const bare = term.replace(/^[-~?+]/, "").toLowerCase();
    if (/^(include:|exists:|redirect=)/.test(bare)) count += 1;
    else if (/^(a|mx|ptr)(:|\/|$)/.test(bare)) count += 1;
  }
  return count;
}

/** Pure: full SPF analysis from a domain's TXT record strings. */
export function analyzeSpf(txtRecords: string[]): SpfAnalysis {
  const spf = findSpfRecords(txtRecords);
  if (spf.length === 0) {
    return {
      verdict: "none",
      record: null,
      recordCount: 0,
      allQualifier: null,
      redirectTarget: null,
      allViaRedirect: false,
      lookupMechanismCount: 0,
      lookupCountRisk: false,
    };
  }
  if (spf.length > 1) {
    // RFC 7208 §3.2: multiple v=spf1 records = permerror — worse than none.
    return {
      verdict: "fail",
      record: spf.join(" | "),
      recordCount: spf.length,
      allQualifier: null,
      redirectTarget: null,
      allViaRedirect: false,
      lookupMechanismCount: 0,
      lookupCountRisk: false,
    };
  }
  const record = spf[0];
  const allQualifier = spfAllQualifier(record);
  const lookupMechanismCount = spfLookupMechanismCount(record);
  const lookupCountRisk = lookupMechanismCount > 10;
  const strongAll = allQualifier === "-all" || allQualifier === "~all";
  return {
    verdict: strongAll && !lookupCountRisk ? "pass" : "warn",
    record,
    recordCount: 1,
    allQualifier,
    redirectTarget: spfRedirectTarget(record),
    allViaRedirect: false,
    lookupMechanismCount,
    lookupCountRisk,
  };
}

/** Pure: resolve a redirect-only SPF record's policy one hop (gmail.com shape:
 *  "v=spf1 redirect=_spf.google.com" — the `all` lives at the target). Given
 *  the TARGET's TXT records, lift its all-qualifier + lookup load into the
 *  base analysis. Falls back to the base (honest warn) when the target has no
 *  single clean SPF record. */
export function applySpfRedirect(base: SpfAnalysis, targetTxtRecords: string[]): SpfAnalysis {
  const targetSpf = findSpfRecords(targetTxtRecords);
  if (targetSpf.length !== 1) return base;
  const allQualifier = spfAllQualifier(targetSpf[0]);
  if (!allQualifier) return base;
  const lookupMechanismCount = base.lookupMechanismCount + spfLookupMechanismCount(targetSpf[0]);
  const lookupCountRisk = lookupMechanismCount > 10;
  const strongAll = allQualifier === "-all" || allQualifier === "~all";
  return {
    ...base,
    verdict: strongAll && !lookupCountRisk ? "pass" : "warn",
    allQualifier,
    allViaRedirect: true,
    lookupMechanismCount,
    lookupCountRisk,
  };
}

// ─── DMARC (pure) ────────────────────────────────────────────────────────────

export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface DmarcAnalysis {
  verdict: RecordVerdict;
  record: string | null;
  policy: DmarcPolicy | null;
  subdomainPolicy: DmarcPolicy | null;
  /** Percent of failing mail the policy applies to (pct=, default 100). */
  pct: number | null;
  hasRua: boolean;
}

/** Pure: the v=DMARC1 record among _dmarc TXT records (reference's parseDmarcRecord). */
export function findDmarcRecord(txtRecords: string[]): string | null {
  for (const r of txtRecords) {
    if (r.trim().toLowerCase().startsWith("v=dmarc1")) return r.trim();
  }
  return null;
}

/** Pure: extract the p= policy tier (reference's dmarcPolicyTier, null = absent). */
export function dmarcPolicy(record: string, tag: "p" | "sp" = "p"): DmarcPolicy | null {
  const m = new RegExp(`[;\\s]${tag}\\s*=\\s*(reject|quarantine|none)\\b`, "i").exec(
    ` ${record}`,
  );
  return m ? (m[1].toLowerCase() as DmarcPolicy) : null;
}

/** Pure: full DMARC analysis from the _dmarc TXT record strings. */
export function analyzeDmarc(txtRecords: string[]): DmarcAnalysis {
  const record = findDmarcRecord(txtRecords);
  if (!record) {
    return { verdict: "none", record: null, policy: null, subdomainPolicy: null, pct: null, hasRua: false };
  }
  const policy = dmarcPolicy(record, "p");
  const subdomainPolicy = dmarcPolicy(record, "sp");
  const pctMatch = /[;\s]pct\s*=\s*(\d{1,3})\b/i.exec(` ${record}`);
  const pct = pctMatch ? Math.min(100, Number(pctMatch[1])) : 100;
  const hasRua = /[;\s]rua\s*=\s*mailto:/i.test(` ${record}`);
  if (!policy) {
    // A v=DMARC1 record with no p= tag is syntactically invalid — receivers ignore it.
    return { verdict: "fail", record, policy: null, subdomainPolicy, pct, hasRua };
  }
  const verdict: RecordVerdict = policy === "none" ? "warn" : "pass";
  return { verdict, record, policy, subdomainPolicy, pct, hasRua };
}

// ─── DKIM (pure verdict + selector-probe orchestration) ──────────────────────

/** The common selector names probed at `<selector>._domainkey.<domain>`.
 *  Covers the default convention plus Google Workspace, Resend, SendGrid
 *  (mail/s1/s2), and Mailchimp/generic (k1). */
export const DKIM_PROBE_SELECTORS = [
  "default",
  "google",
  "resend",
  "sendgrid",
  "mail",
  "k1",
  "s1",
  "s2",
] as const;

export type DkimSelectorStatus =
  | "key-published" // TXT with v=DKIM1 and/or a non-empty p= public key
  | "key-revoked" // DKIM TXT present but p= is explicitly empty (revoked key)
  | "delegated" // CNAME published (provider-hosted key) — delegated, likely valid
  | "none";

export interface DkimSelectorResult {
  selector: string;
  status: DkimSelectorStatus;
  /** CNAME target when status is "delegated". */
  delegatedTo?: string;
}

export interface DkimAnalysis {
  verdict: RecordVerdict;
  selectorsProbed: readonly string[];
  selectorsFound: DkimSelectorResult[];
}

/** Pure: classify one selector's TXT record strings (reference's
 *  dkimKeyPublished, widened to distinguish revoked keys). */
export function classifyDkimTxt(txtRecords: string[]): DkimSelectorStatus {
  const joined = txtRecords.join(" ").toLowerCase();
  const hasV = joined.includes("v=dkim1");
  const pMatch = /(?:^|[;\s])p\s*=\s*([a-z0-9+/=]*)/i.exec(joined);
  const hasKey = !!(pMatch && pMatch[1] && pMatch[1].length > 0);
  if (hasKey) return "key-published";
  if (hasV) return "key-revoked"; // v=DKIM1 with empty/absent p= = revoked/off
  return "none";
}

/** Pure: aggregate per-selector results into a DKIM verdict. */
export function dkimVerdict(found: DkimSelectorResult[]): RecordVerdict {
  if (found.some((s) => s.status === "key-published" || s.status === "delegated")) return "pass";
  if (found.some((s) => s.status === "key-revoked")) return "warn";
  return "warn"; // none found — DKIM may exist under a custom selector, so never "fail"
}

async function probeDkimSelector(selector: string, domain: string): Promise<DkimSelectorResult> {
  const name = `${selector}._domainkey.${domain}`;
  const txt = await lookupTxt(name);
  if (txt.ok) {
    const status = classifyDkimTxt(txt.records);
    // resolveTxt follows CNAMEs, so a delegated selector with a live key lands
    // here as "key-published" already. Anything short of a key: check for a
    // published CNAME — delegated, likely valid (provider hosts the key).
    if (status !== "none") return { selector, status };
  }
  const target = await lookupCname(name);
  if (target) return { selector, status: "delegated", delegatedTo: target };
  return { selector, status: "none" };
}

// ─── Advice (pure) ───────────────────────────────────────────────────────────

/** Pure: plain-language advice lines a human or agent can act on. */
export function buildAdvice(
  spf: SpfAnalysis,
  dmarc: DmarcAnalysis,
  dkim: DkimAnalysis,
  anyLookupFailed: boolean,
): string[] {
  const advice: string[] = [];

  // SPF (skipped when the lookup itself failed — absence wasn't observed)
  if (spf.verdict === "unknown") {
    // no SPF config advice — we couldn't see the record
  } else if (spf.recordCount === 0) {
    advice.push(
      "No SPF record — any server can claim to send as this domain. Add a TXT record like \"v=spf1 include:<your-provider> -all\".",
    );
  } else if (spf.recordCount > 1) {
    advice.push(
      `MULTIPLE SPF records (${spf.recordCount}) — receivers treat this as a permanent error and ignore SPF entirely. Merge them into ONE v=spf1 TXT record.`,
    );
  } else {
    if (spf.allQualifier === "~all") {
      advice.push(
        "SPF ends in ~all (softfail) — consider -all once you've confirmed all legitimate senders are listed.",
      );
    } else if (spf.allQualifier === "?all") {
      advice.push(
        "SPF ends in ?all (neutral) — this asserts nothing and gives no spoofing protection. Move to ~all, then -all.",
      );
    } else if (spf.allQualifier === "+all") {
      advice.push(
        "SPF ends in +all — this explicitly AUTHORIZES the whole internet to send as this domain. Replace with -all (or ~all while validating senders).",
      );
    } else if (spf.allQualifier === null) {
      advice.push(
        spf.redirectTarget
          ? `SPF delegates via redirect=${spf.redirectTarget} but the target's all-qualifier couldn't be resolved — confirm the target record ends in -all (or ~all).`
          : "SPF record has no `all` mechanism — unlisted senders get a neutral result instead of failing. End the record with -all (or ~all).",
      );
    }
    if (spf.lookupCountRisk) {
      advice.push(
        `SPF triggers ~${spf.lookupMechanismCount} DNS lookups — over the RFC 7208 limit of 10, so receivers may return permerror (SPF silently void). Flatten includes or drop unused ones.`,
      );
    }
  }

  // DMARC (skipped when the lookup itself failed)
  if (dmarc.verdict === "unknown") {
    // no DMARC config advice — we couldn't see the record
  } else if (!dmarc.record) {
    advice.push(
      "No DMARC record — add a TXT at _dmarc.<domain>: \"v=DMARC1; p=none; rua=mailto:<you>@<domain>\" to start monitoring, then ratchet p= to quarantine/reject.",
    );
  } else if (dmarc.verdict === "fail") {
    advice.push(
      "DMARC record is present but has no valid p= policy tag — receivers ignore it. Fix the record syntax (e.g. \"v=DMARC1; p=none; rua=mailto:...\").",
    );
  } else {
    if (dmarc.policy === "none") {
      advice.push(
        "DMARC policy is p=none (monitor-only) — spoofed mail is still delivered. Once reports look clean, ratchet to p=quarantine, then p=reject.",
      );
    }
    if (!dmarc.hasRua) {
      advice.push(
        "DMARC has no rua= reporting address — you're not seeing who sends as this domain. Add rua=mailto:<you>@<domain>.",
      );
    }
    if (dmarc.pct !== null && dmarc.pct < 100) {
      advice.push(
        `DMARC pct=${dmarc.pct} — the policy only applies to ${dmarc.pct}% of failing mail. Move to pct=100 when ready.`,
      );
    }
  }

  // DKIM
  const live = dkim.selectorsFound.filter(
    (s) => s.status === "key-published" || s.status === "delegated",
  );
  if (live.length === 0) {
    const revoked = dkim.selectorsFound.filter((s) => s.status === "key-revoked");
    if (revoked.length > 0) {
      advice.push(
        `DKIM selector(s) ${revoked.map((s) => s.selector).join(", ")} exist but publish an EMPTY p= (revoked key) — signing is off. Re-enable DKIM signing at your provider.`,
      );
    } else {
      advice.push(
        `No DKIM record found under the ${dkim.selectorsProbed.length} common selectors probed (${dkim.selectorsProbed.join(", ")}). DKIM may still exist under a custom selector — check your provider's DNS setup page. Without DKIM, forwarded mail breaks SPF and has nothing to fall back on.`,
      );
    }
  } else {
    const delegated = live.filter((s) => s.status === "delegated");
    if (delegated.length > 0 && live.every((s) => s.status === "delegated")) {
      advice.push(
        `DKIM selector(s) ${delegated.map((s) => s.selector).join(", ")} are CNAME-delegated to a provider — likely valid, but a published CNAME does not prove signing is ENABLED. Confirm signing is on in the provider dashboard.`,
      );
    }
  }

  if (anyLookupFailed) {
    advice.push(
      "Some DNS lookups failed or timed out — verdicts marked \"unknown\" are transient resolver noise, not a config finding. Re-run to confirm.",
    );
  }

  if (advice.length === 0) {
    advice.push("SPF, DKIM, and DMARC all look healthy — no changes recommended.");
  }
  return advice;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface DomainHealthResult {
  domain: string;
  spf: SpfAnalysis;
  dmarc: DmarcAnalysis;
  dkim: DkimAnalysis;
  advice: string[];
  /** True when any lookup failed/timed out (verdicts may be "unknown"). */
  lookupFailures: boolean;
}

/** The full read-only health read. Never throws — DNS failures degrade to
 *  "unknown" verdicts with an advice line, never an exception. */
export async function checkDomainHealth(domain: string): Promise<DomainHealthResult> {
  const [apexTxt, dmarcTxt, ...selectorResults] = await Promise.all([
    lookupTxt(domain),
    lookupTxt(`_dmarc.${domain}`),
    ...DKIM_PROBE_SELECTORS.map((sel) => probeDkimSelector(sel, domain)),
  ]);

  const apexFailed = !apexTxt.ok && apexTxt.reason === "lookup-failed";
  const dmarcFailed = !dmarcTxt.ok && dmarcTxt.reason === "lookup-failed";

  let spf: SpfAnalysis = apexFailed
    ? { verdict: "unknown", record: null, recordCount: 0, allQualifier: null, redirectTarget: null, allViaRedirect: false, lookupMechanismCount: 0, lookupCountRisk: false }
    : analyzeSpf(apexTxt.ok ? apexTxt.records : []);

  // Redirect-only SPF (gmail.com shape): the `all` policy lives at the
  // redirect target — follow it ONE hop so a well-configured delegating
  // domain isn't mis-graded as "no all mechanism".
  if (spf.recordCount === 1 && spf.allQualifier === null && spf.redirectTarget) {
    const target = normalizeDomain(spf.redirectTarget);
    if (target) {
      const targetTxt = await lookupTxt(target);
      if (targetTxt.ok) spf = applySpfRedirect(spf, targetTxt.records);
    }
  }

  const dmarc: DmarcAnalysis = dmarcFailed
    ? { verdict: "unknown", record: null, policy: null, subdomainPolicy: null, pct: null, hasRua: false }
    : analyzeDmarc(dmarcTxt.ok ? dmarcTxt.records : []);

  const selectorsFound = selectorResults.filter((s) => s.status !== "none");
  const dkim: DkimAnalysis = {
    verdict: dkimVerdict(selectorsFound),
    selectorsProbed: DKIM_PROBE_SELECTORS,
    selectorsFound,
  };

  const lookupFailures = apexFailed || dmarcFailed;
  const advice = buildAdvice(spf, dmarc, dkim, lookupFailures);

  return { domain, spf, dmarc, dkim, advice, lookupFailures };
}
