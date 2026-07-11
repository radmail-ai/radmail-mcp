// check_send_domain tests — the zero-auth read-only SPF / DKIM / DMARC read.
//
// Proves: (a) the pure parsing/verdict logic against fixture record strings
// (SPF -all/~all/?all/+all/none/multiple; DMARC none/quarantine/reject/missing;
// DKIM selector aggregation incl. CNAME delegation + revoked keys); (b) input
// normalization; (c) the DNS layer is injectable so NO test does live DNS, and
// ENOTFOUND/ENODATA mean "no record" while resolver failures degrade to an
// "unknown" verdict instead of throwing; (d) zero-auth registration — the tool
// is in TOOL_DEFS with no token/key field and every response carries the
// standing safety block.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDomain,
  findSpfRecords,
  spfAllQualifier,
  spfLookupMechanismCount,
  analyzeSpf,
  applySpfRedirect,
  findDmarcRecord,
  dmarcPolicy,
  analyzeDmarc,
  classifyDkimTxt,
  dkimVerdict,
  buildAdvice,
  checkDomainHealth,
  DKIM_PROBE_SELECTORS,
  __setDnsForTests,
  type DnsLike,
  type DkimSelectorResult,
} from "../src/lib/domain-health.js";
import { checkSendDomainTool, TOOL_DEFS } from "../src/tools.js";
import { PERMANENT_HARD_STOPS } from "../src/lib/taint.js";

afterEach(() => __setDnsForTests(null));

function assertSafety(r: unknown) {
  const s = (r as { safety?: { permanentHardStops?: readonly string[] } }).safety;
  assert.ok(s, "response must carry a top-level safety block");
  assert.deepEqual(s!.permanentHardStops, PERMANENT_HARD_STOPS);
}

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** A fake DNS layer from name→TXT-records / name→CNAME-target maps.
 *  Missing names raise ENOTFOUND (the "no record" shape). */
function fakeDns(
  txt: Record<string, string[]>,
  cname: Record<string, string> = {},
): DnsLike {
  return {
    async resolveTxt(name: string) {
      const recs = txt[name];
      if (!recs) throw dnsError("ENOTFOUND");
      return recs.map((r) => [r]); // one chunk per record
    },
    async resolveCname(name: string) {
      const target = cname[name];
      if (!target) throw dnsError("ENODATA");
      return [target];
    },
  };
}

// ─── input normalization ─────────────────────────────────────────────────────

test("normalizeDomain: strips protocol, path, port, userinfo, trailing dot; lowercases", () => {
  assert.equal(normalizeDomain("https://Example.COM/some/path?q=1#frag"), "example.com");
  assert.equal(normalizeDomain("  example.com.  "), "example.com");
  assert.equal(normalizeDomain("example.com:8443"), "example.com");
  assert.equal(normalizeDomain("//cdn.Example.org"), "cdn.example.org");
  assert.equal(normalizeDomain("doug@sub.example.co.uk"), "sub.example.co.uk");
});

test("normalizeDomain: rejects obviously invalid input", () => {
  for (const bad of ["", "   ", "not a domain!!", "example", "localhost", "1.2.3.4", "-bad-.com", "a..b.com", 42, null, undefined]) {
    assert.equal(normalizeDomain(bad as never), null, `should reject: ${String(bad)}`);
  }
});

// ─── SPF pure logic ──────────────────────────────────────────────────────────

test("SPF: -all and ~all pass; qualifier is extracted", () => {
  const strict = analyzeSpf(["v=spf1 include:_spf.google.com -all"]);
  assert.equal(strict.verdict, "pass");
  assert.equal(strict.allQualifier, "-all");

  const soft = analyzeSpf(["v=spf1 include:_spf.google.com ~all"]);
  assert.equal(soft.verdict, "pass");
  assert.equal(soft.allQualifier, "~all");
});

test("SPF: ?all / +all / missing-all warn", () => {
  assert.equal(analyzeSpf(["v=spf1 include:x.com ?all"]).verdict, "warn");
  assert.equal(analyzeSpf(["v=spf1 include:x.com +all"]).allQualifier, "+all");
  assert.equal(analyzeSpf(["v=spf1 include:x.com +all"]).verdict, "warn");
  assert.equal(analyzeSpf(["v=spf1 mx all"]).allQualifier, "+all"); // bare all = +all
  const noAll = analyzeSpf(["v=spf1 include:x.com"]);
  assert.equal(noAll.verdict, "warn");
  assert.equal(noAll.allQualifier, null);
});

test("SPF: no record = none; multiple v=spf1 records = fail (permerror)", () => {
  assert.equal(analyzeSpf(["some-verification=abc"]).verdict, "none");
  const multi = analyzeSpf(["v=spf1 include:a.com -all", "v=spf1 include:b.com -all"]);
  assert.equal(multi.verdict, "fail");
  assert.equal(multi.recordCount, 2);
});

test("SPF: only v=spf1 lines are picked out of the TXT set (ported parseSpfRecord)", () => {
  const records = findSpfRecords(["google-site-verification=x", " V=SPF1 mx -all ", "v=spf10 fake"]);
  assert.deepEqual(records, ["V=SPF1 mx -all"]);
  assert.equal(spfAllQualifier("v=spf1 a mx include:x.y ~all"), "~all");
});

test("SPF: lookup-mechanism count flags the >10 RFC 7208 permerror risk", () => {
  assert.equal(spfLookupMechanismCount("v=spf1 include:a a mx ptr exists:%{i}.x redirect=y ip4:1.2.3.4 -all"), 6);
  const eleven = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:s${i}.example.com`).join(" ")} -all`;
  const risky = analyzeSpf([eleven]);
  assert.equal(risky.lookupCountRisk, true);
  assert.equal(risky.verdict, "warn"); // even with -all, permerror risk demotes to warn
});

test("SPF: redirect= target extracted; applySpfRedirect lifts the target's all-qualifier", () => {
  const base = analyzeSpf(["v=spf1 redirect=_spf.google.com"]);
  assert.equal(base.verdict, "warn"); // pure layer can't see the target
  assert.equal(base.redirectTarget, "_spf.google.com");

  const resolved = applySpfRedirect(base, ["v=spf1 include:netblocks.google.com ~all"]);
  assert.equal(resolved.verdict, "pass");
  assert.equal(resolved.allQualifier, "~all");
  assert.equal(resolved.allViaRedirect, true);

  // Target without a clean single SPF record → honest fallback to base.
  assert.equal(applySpfRedirect(base, ["unrelated=txt"]).verdict, "warn");
});

test("checkDomainHealth: redirect-only SPF is followed one hop (gmail.com shape)", async () => {
  __setDnsForTests(
    fakeDns({
      [DOMAIN]: ["v=spf1 redirect=_spf.google.com"],
      "_spf.google.com": ["v=spf1 include:netblocks.google.com ~all"],
      [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=reject; rua=mailto:d@example.com"],
      [`google._domainkey.${DOMAIN}`]: ["v=DKIM1; p=MIGfMA0"],
    }),
  );
  const h = await checkDomainHealth(DOMAIN);
  assert.equal(h.spf.verdict, "pass");
  assert.equal(h.spf.allQualifier, "~all");
  assert.equal(h.spf.allViaRedirect, true);
  assert.ok(!h.advice.some((a) => a.includes("no `all` mechanism")), "must not mis-grade a delegating record");
});

// ─── DMARC pure logic ────────────────────────────────────────────────────────

test("DMARC: p=quarantine / p=reject pass; p=none warns; missing = none", () => {
  assert.equal(analyzeDmarc(["v=DMARC1; p=quarantine; rua=mailto:d@x.com"]).verdict, "pass");
  assert.equal(analyzeDmarc(["v=DMARC1; p=reject"]).verdict, "pass");
  assert.equal(analyzeDmarc(["v=DMARC1; p=none; rua=mailto:d@x.com"]).verdict, "warn");
  assert.equal(analyzeDmarc(["unrelated=txt"]).verdict, "none");
  assert.equal(analyzeDmarc([]).verdict, "none");
});

test("DMARC: parsed details — policy, sp, pct, rua presence", () => {
  const d = analyzeDmarc(["v=DMARC1; p=quarantine; sp=reject; pct=50; rua=mailto:agg@x.com"]);
  assert.equal(d.policy, "quarantine");
  assert.equal(d.subdomainPolicy, "reject");
  assert.equal(d.pct, 50);
  assert.equal(d.hasRua, true);

  const bare = analyzeDmarc(["v=DMARC1; p=reject"]);
  assert.equal(bare.pct, 100); // pct defaults to 100
  assert.equal(bare.hasRua, false);
});

test("DMARC: v=DMARC1 with no p= tag is invalid → fail; finder ports parseDmarcRecord", () => {
  assert.equal(analyzeDmarc(["v=DMARC1; rua=mailto:d@x.com"]).verdict, "fail");
  assert.equal(findDmarcRecord(["other", "  v=dmarc1; p=none  "]), "v=dmarc1; p=none");
  assert.equal(dmarcPolicy("v=DMARC1; p = Quarantine ;"), "quarantine");
});

// ─── DKIM pure logic ─────────────────────────────────────────────────────────

test("DKIM: TXT classification — key-published / key-revoked / none (ported dkimKeyPublished)", () => {
  assert.equal(classifyDkimTxt(["v=DKIM1; k=rsa; p=MIGfMA0GCSq"]), "key-published");
  assert.equal(classifyDkimTxt(["k=rsa; p=MIGfMA0GCSq"]), "key-published"); // p= alone counts
  assert.equal(classifyDkimTxt(["v=DKIM1; k=rsa; p="]), "key-revoked"); // empty p= = revoked
  assert.equal(classifyDkimTxt(["some other txt"]), "none");
});

test("DKIM: verdict aggregation — any live selector passes; none found warns (never fails)", () => {
  const live: DkimSelectorResult[] = [{ selector: "google", status: "key-published" }];
  assert.equal(dkimVerdict(live), "pass");
  const delegated: DkimSelectorResult[] = [{ selector: "resend", status: "delegated", delegatedTo: "x.dkim.provider.com" }];
  assert.equal(dkimVerdict(delegated), "pass");
  assert.equal(dkimVerdict([{ selector: "s1", status: "key-revoked" }]), "warn");
  assert.equal(dkimVerdict([]), "warn");
});

// ─── orchestrated health read (mock DNS — never live) ───────────────────────

const DOMAIN = "example.com";

test("checkDomainHealth: healthy domain — SPF pass, DMARC pass, DKIM found via TXT", async () => {
  __setDnsForTests(
    fakeDns({
      [DOMAIN]: ["v=spf1 include:_spf.resend.com -all", "verification=xyz"],
      [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"],
      [`resend._domainkey.${DOMAIN}`]: ["v=DKIM1; k=rsa; p=MIGfMA0GCSq"],
    }),
  );
  const h = await checkDomainHealth(DOMAIN);
  assert.equal(h.spf.verdict, "pass");
  assert.equal(h.spf.record, "v=spf1 include:_spf.resend.com -all");
  assert.equal(h.dmarc.verdict, "pass");
  assert.equal(h.dkim.verdict, "pass");
  assert.deepEqual(h.dkim.selectorsFound, [{ selector: "resend", status: "key-published" }]);
  assert.equal(h.lookupFailures, false);
  assert.deepEqual(h.advice, ["SPF, DKIM, and DMARC all look healthy — no changes recommended."]);
});

test("checkDomainHealth: CNAME-delegated DKIM selector counts as delegated, likely valid", async () => {
  __setDnsForTests(
    fakeDns(
      {
        [DOMAIN]: ["v=spf1 include:spf.protection.outlook.com -all"],
        [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=quarantine; rua=mailto:d@example.com"],
      },
      { [`s1._domainkey.${DOMAIN}`]: "s1.dkim.provider.example." },
    ),
  );
  const h = await checkDomainHealth(DOMAIN);
  assert.equal(h.dkim.verdict, "pass");
  assert.deepEqual(h.dkim.selectorsFound, [
    { selector: "s1", status: "delegated", delegatedTo: "s1.dkim.provider.example" },
  ]);
  assert.ok(h.advice.some((a) => a.includes("CNAME-delegated")), "advice should mention delegation");
});

test("checkDomainHealth: bare/missing everything — none/warn verdicts + actionable advice", async () => {
  __setDnsForTests(fakeDns({})); // every lookup ENOTFOUND = no record, NOT an error
  const h = await checkDomainHealth(DOMAIN);
  assert.equal(h.spf.verdict, "none");
  assert.equal(h.dmarc.verdict, "none");
  assert.equal(h.dkim.verdict, "warn");
  assert.equal(h.lookupFailures, false); // ENOTFOUND is an answer, not a failure
  assert.ok(h.advice.some((a) => a.startsWith("No SPF record")));
  assert.ok(h.advice.some((a) => a.startsWith("No DMARC record")));
  assert.ok(
    h.advice.some((a) => a.includes("custom selector")),
    "no-DKIM advice must say a custom selector may still exist",
  );
});

test("checkDomainHealth: softfail SPF + p=none DMARC produce the ratchet advice lines", async () => {
  __setDnsForTests(
    fakeDns({
      [DOMAIN]: ["v=spf1 include:_spf.google.com ~all"],
      [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=none"],
    }),
  );
  const h = await checkDomainHealth(DOMAIN);
  assert.ok(h.advice.some((a) => a.includes("~all (softfail)")), "softfail advice");
  assert.ok(h.advice.some((a) => a.includes("p=none")), "p=none ratchet advice");
  assert.ok(h.advice.some((a) => a.includes("rua=")), "missing-rua advice");
});

test("checkDomainHealth: resolver failure degrades to unknown verdicts — never throws", async () => {
  __setDnsForTests({
    async resolveTxt() {
      throw dnsError("ETIMEOUT"); // not ENOTFOUND/ENODATA → a real lookup failure
    },
    async resolveCname() {
      throw dnsError("ETIMEOUT");
    },
  });
  const h = await checkDomainHealth(DOMAIN);
  assert.equal(h.spf.verdict, "unknown");
  assert.equal(h.dmarc.verdict, "unknown");
  assert.equal(h.lookupFailures, true);
  assert.ok(h.advice.some((a) => a.includes("lookups failed")), "transient-noise advice");
  assert.ok(!h.advice.some((a) => a.startsWith("No SPF record")), "must not claim absence it could not observe");
});

// ─── the tool itself ─────────────────────────────────────────────────────────

test("checkSendDomainTool: normalizes input, returns structured verdicts + safety block", async () => {
  __setDnsForTests(
    fakeDns({
      [DOMAIN]: ["v=spf1 -all"],
      [`_dmarc.${DOMAIN}`]: ["v=DMARC1; p=reject; rua=mailto:d@example.com"],
      [`google._domainkey.${DOMAIN}`]: ["v=DKIM1; p=MIGfMA0"],
    }),
  );
  const r = (await checkSendDomainTool({ domain: "https://Example.com/mail" })) as {
    ok: boolean;
    domain: string;
    spf: { verdict: string };
    dmarc: { verdict: string };
    dkim: { verdict: string; selectorsFound: { selector: string }[] };
    advice: string[];
    readOnly: boolean;
  };
  assertSafety(r);
  assert.equal(r.ok, true);
  assert.equal(r.domain, "example.com");
  assert.equal(r.readOnly, true);
  assert.equal(r.spf.verdict, "pass");
  assert.equal(r.dmarc.verdict, "pass");
  assert.equal(r.dkim.verdict, "pass");
  assert.deepEqual(r.dkim.selectorsFound.map((s) => s.selector), ["google"]);
  assert.ok(Array.isArray(r.advice) && r.advice.length > 0);
});

test("checkSendDomainTool: invalid domain → clean structured error, no lookup, no throw", async () => {
  __setDnsForTests({
    async resolveTxt() {
      throw new Error("must not be called for invalid input");
    },
    async resolveCname() {
      throw new Error("must not be called for invalid input");
    },
  });
  const r = (await checkSendDomainTool({ domain: "not a domain!!" })) as {
    ok: boolean;
    error?: { kind: string; message: string };
  };
  assertSafety(r);
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, "invalid-domain");
  assert.ok(r.error?.message.includes("example.com"));
});

// ─── zero-auth registration ──────────────────────────────────────────────────

test("registration: check_send_domain is in TOOL_DEFS on the zero-auth surface (no token/key input)", () => {
  const def = TOOL_DEFS.find((d) => d.name === "check_send_domain");
  assert.ok(def, "check_send_domain must be registered");
  assert.ok(def!.description.includes("ZERO-AUTH"), "description advertises zero-auth");
  assert.ok(def!.description.toLowerCase().includes("read-only"), "description advertises read-only");
  const fields = Object.keys(def!.inputSchema);
  assert.ok(fields.includes("domain"), "takes a domain");
  assert.ok(!fields.includes("token"), "no tenant token — zero-auth by construction");
  assert.ok(!fields.some((f) => /key/i.test(f)), "no API-key field — zero-auth by construction");
});

test("registration: handler works end-to-end with ONLY a domain arg (mocked DNS)", async () => {
  __setDnsForTests(fakeDns({ [DOMAIN]: ["v=spf1 mx ~all"] }));
  const def = TOOL_DEFS.find((d) => d.name === "check_send_domain")!;
  const r = (await def.handler({ domain: DOMAIN })) as { ok: boolean; domain: string };
  assertSafety(r);
  assert.equal(r.ok, true);
  assert.equal(r.domain, DOMAIN);
});

test("probe list: the advertised common selectors are exactly the v1 set", () => {
  assert.deepEqual(
    [...DKIM_PROBE_SELECTORS],
    ["default", "google", "resend", "sendgrid", "mail", "k1", "s1", "s2"],
  );
});
