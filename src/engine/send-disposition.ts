// ─────────────────────────────────────────────────────────────────────────────
// PORTED VERBATIM (pure, no-DB) from the RadMail main app:
//   /Users/GreenLife/Documents/CODE/RadMail/src/server/commitments/send-disposition.ts
// Recovered into radmail-mcp so the MCP sandbox runs the SAME deterministic BEC
// firewall as production. This is the sacred firewall — it may only be TIGHTENED,
// never loosened. Keep byte-for-byte with source.
// ─────────────────────────────────────────────────────────────────────────────

// Auto-send disposition — the single authoritative multi-signal pure-fn (scope §4).
//
// NEVER a confidence threshold. `commitmentSendDisposition(ctx)` is the ONE
// predicate that answers auto_send | needs_approval | hard_stop. Decoupled-switch
// doctrine — no shadow switch anywhere; every caller asks THIS.
//
// AUTO-SEND only when ALL hold (AND-gate, not OR):
//   · tenant opted into auto-send for this class
//   · direction = owed_by_us AND action_type = follow_up (a self check-in, not a
//     deliverable, not money)
//   · counterparty KNOWN (counterparty_id present)
//   · recipient domain allowlisted (passed in pre-checked)
//   · regime scrubber clean (assertOutboundAllowed passed in pre-checked)
//   · completion re-checked at the last millisecond → still open
//   · not previously sent
//   · entitlement: autonomous_followup (Pro+) — passed in pre-checked
//
// PERMANENT HARD-STOPS (never auto-anything, ever — BEC defense):
//   action_type ∈ {payment, decision, contact_third_party, send_deliverable},
//   OR any money / new-banking / decision signal in the source. These never
//   become auto-send for ANY tenant at ANY rollout rung. Everything else that
//   isn't a clean auto-send = human-gated draft (needs_approval).
//
// Pure, pin-tested (auto vs hold vs hard-stop).

import type { CommitmentDirection, CommitmentActionType } from "./types.js"; // (port note: .js extension required by NodeNext)

export type SendDispositionContext = {
  direction: CommitmentDirection;
  actionType: CommitmentActionType;
  // ── Tenant + commercial gates (resolved by the caller, handed in) ──
  tenantOptedInClass: boolean; //   tenant flipped auto-send ON for this class
  entitled: boolean; //             autonomous_followup entitlement (Pro+)
  // ── Safety preconditions (each resolved by the caller, handed in) ──
  counterpartyKnown: boolean; //    counterparty_id present
  recipientDomainAllowed: boolean; // isRecipientDomainAllowed passed
  scrubberClean: boolean; //        assertOutboundAllowed passed on the FINAL body
  completionRecheckedOpen: boolean; // isCommitmentLikelyFulfilled → not fulfilled
  alreadySent: boolean; //          a prior sent follow-up exists on this commitment
  // ── BEC / risk signals from the source email. REQUIRED (not optional) so a
  //    caller that forgets to evaluate them fails the BUILD, not silently at runtime.
  //    Wire them with detectSourceRiskSignals() below (or a stronger extractor). ──
  hasMoneySignal: boolean; //      $ amounts / invoice / payment language
  hasNewBankingSignal: boolean; // changed remittance / new account / wire details
  hasDecisionSignal: boolean; //   approval / sign-off / commit-the-tenant
  injectionSignal: boolean; //     prompt-injection / anomaly in the source
  /** sla_basis: a guessed deadline ('default_by_type') never auto-sends. */
  slaBasis?: "explicit" | "relative" | "default_by_type" | "manual";
};

export type SendDisposition =
  | { disposition: "auto_send" }
  | { disposition: "needs_approval"; reason: string }
  | { disposition: "hard_stop"; reason: string };

// The action types that may EVER auto-send (the narrowest class).
function isAutoSendableType(t: CommitmentActionType): boolean {
  return t === "follow_up";
}

// The action types that are PERMANENTLY human-only (hard-stop forever).
function isHardStopType(t: CommitmentActionType): boolean {
  return t === "payment" || t === "decision" || t === "contact_third_party" || t === "send_deliverable";
}

// ── Deterministic source-side BEC risk detection (pure, pin-tested). ──
// Doctrine: a false positive (one extra human review) is cheap; a false negative
// (auto-sending money / banking-change / decision mail) is catastrophic. These
// patterns fire READILY by design — when in doubt, hard-stop to a human.
const MONEY_RE =
  /(\$\s?\d)|(\b\d{2,}\s?(usd|dollars|eur|gbp)\b)|\b(wire\s?transfer|wire|remit\w*|invoice|payment|deposit|ach|routing\s?number|swift|iban|amount\s?due|balance\s?due|past\s?due|payable|payout)\b/i;
const BANKING_RE =
  /\b(new|updated?|chang(?:e|ed|ing)|revis\w+|different|switch(?:ed)?)\b[^.!?\n]{0,50}\b(bank|account|remit\w*|wire|routing|payment\s+(?:details|info|information|instructions))\b/i;
const BANKING_RE2 =
  /\b(bank|account|routing|remit\w*|wire|payment\s+(?:details|info|information|instructions))\b[^.!?\n]{0,50}\b(chang(?:e|ed|ing)|updated?|new|revis\w+|different)\b/i;
const DECISION_RE =
  /\b(approv\w+|sign[\s-]?off|signoff|authoriz\w+|go[\s-]?ahead|green[\s-]?light)\b|\b(please\s+)?confirm\b[^.!?\n]{0,30}\b(order|po|purchase|wire|payment|deal|contract|invoice)\b/i;
// Prompt-injection in inbound mail that could steer an autonomous reply. Expanded
// for the autonomy path — a single "ignore previous instructions" regex is too thin
// once mail can drive an action. Fires readily (false-positive bias = an extra human
// review). NOT a complete defense; the human hard-stop is the floor.
const INJECTION_RE =
  /\b(ignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|context)|disregard\s+(?:your|the|all|any)\s+(?:instructions?|rules?|guidelines?)|system\s+prompt|developer\s+(?:message|prompt)|you\s+are\s+now\s+|new\s+instructions?\s*:|prior\s+instructions?\s+(?:no\s+longer|do\s+not)\s+apply|do\s+not\s+(?:tell|inform|mention\s+to)\s+(?:the\s+)?(?:user|human|operator)|instead\s+of\s+(?:replying|responding|your\s+task)|when\s+you\s+reply[, ].{0,40}\b(?:cc|bcc|forward|send\s+to)\b|<\s*(?:system|assistant)\s*>)\b/i;

/** Normalize text to defeat trivial injection obfuscation before scanning:
 *  strip zero-width / bidi unicode, and decode long base64 runs (appended so the
 *  decoded payload is also scanned). Pure + cheap. */
function normalizeForScan(text: string): string {
  // Cap the scanned span — the real call sites pass short strings (subject + the
  // ≤140-char action + the evidence sentence); the cap defends the public fn from
  // a huge body causing regex backtracking / a giant match array.
  const t = text.slice(0, 16_384).replace(/[​-‏‪-‮⁠﻿]/g, "");
  const decoded: string[] = [];
  // Bound each base64 run (24..512) and the number of decodes (≤16) for safety.
  for (const m of (t.match(/[A-Za-z0-9+/]{24,512}={0,2}/g) ?? []).slice(0, 16)) {
    try {
      const d = Buffer.from(m, "base64").toString("utf8");
      // Only keep decodes that look like readable text (avoid binary noise).
      if (d && /[\x20-\x7e]{8,}/.test(d) && !/[\x00-\x08\x0e-\x1f]/.test(d)) decoded.push(d);
    } catch {
      /* not valid base64 — ignore */
    }
  }
  return decoded.length ? `${t}\n${decoded.join("\n")}` : t;
}

export type SourceRiskSignals = {
  hasMoneySignal: boolean;
  hasNewBankingSignal: boolean;
  hasDecisionSignal: boolean;
  injectionSignal: boolean;
};

/** Scan the SOURCE-side text (subject + commitment action + verbatim evidence span)
 *  for BEC risk. Pass every available source string; nulls are ignored. */
export function detectSourceRiskSignals(...parts: Array<string | null | undefined>): SourceRiskSignals {
  const raw = parts.filter((p): p is string => !!p).join("\n");
  // Injection scan runs over the de-obfuscated text (zero-width stripped, base64
  // decoded); money/banking/decision scan over raw (those don't get obfuscated).
  const scan = normalizeForScan(raw);
  return {
    hasMoneySignal: MONEY_RE.test(raw),
    hasNewBankingSignal: BANKING_RE.test(raw) || BANKING_RE2.test(raw),
    hasDecisionSignal: DECISION_RE.test(raw),
    injectionSignal: INJECTION_RE.test(raw) || INJECTION_RE.test(scan),
  };
}

export function commitmentSendDisposition(ctx: SendDispositionContext): SendDisposition {
  // ── FAIL-CLOSED: the four BEC risk signals MUST be evaluated by the caller.
  //    If any arrives non-boolean (detection was never wired), refuse to auto-send.
  //    This is the runtime backstop to the compile-time `required` contract above. ──
  for (const k of ["hasMoneySignal", "hasNewBankingSignal", "hasDecisionSignal", "injectionSignal"] as const) {
    if (typeof ctx[k] !== "boolean") {
      return { disposition: "hard_stop", reason: `risk signal ${k} not evaluated — fail-closed (BEC defense)` };
    }
  }

  // ── PERMANENT HARD-STOPS first — these can never be overridden. ──
  if (isHardStopType(ctx.actionType)) {
    return { disposition: "hard_stop", reason: `action_type=${ctx.actionType} is human-only forever` };
  }
  if (ctx.hasMoneySignal) return { disposition: "hard_stop", reason: "money signal — human-only (BEC defense)" };
  if (ctx.hasNewBankingSignal) return { disposition: "hard_stop", reason: "new-banking signal — human-only (BEC defense)" };
  if (ctx.hasDecisionSignal) return { disposition: "hard_stop", reason: "decision signal — human-only" };
  if (ctx.injectionSignal) return { disposition: "hard_stop", reason: "injection/anomaly signal — escalate" };

  // ── AUTO-SEND requires the FULL AND-gate. Any miss → needs_approval. ──
  if (ctx.direction !== "owed_by_us") {
    return { disposition: "needs_approval", reason: "owed_to_us — nudge starts human-gated" };
  }
  if (!isAutoSendableType(ctx.actionType)) {
    return { disposition: "needs_approval", reason: `action_type=${ctx.actionType} is not an auto-sendable class` };
  }
  if (!ctx.tenantOptedInClass) return { disposition: "needs_approval", reason: "tenant has not opted into auto-send for this class" };
  if (!ctx.entitled) return { disposition: "needs_approval", reason: "autonomous_followup not entitled (Pro+)" };
  if (!ctx.counterpartyKnown) return { disposition: "needs_approval", reason: "counterparty not known" };
  if (!ctx.recipientDomainAllowed) return { disposition: "needs_approval", reason: "recipient domain not allowlisted" };
  if (!ctx.scrubberClean) return { disposition: "needs_approval", reason: "outbound scrubber not clean" };
  if (!ctx.completionRecheckedOpen) return { disposition: "needs_approval", reason: "completion re-check did not confirm open" };
  if (ctx.alreadySent) return { disposition: "needs_approval", reason: "a follow-up was already sent (single-send dedup)" };
  if (ctx.slaBasis === "default_by_type") return { disposition: "needs_approval", reason: "due date was guessed (default_by_type) — never auto-send on a guessed deadline" };

  return { disposition: "auto_send" };
}
