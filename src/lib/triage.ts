// Triage engine — wraps the PORTED production pure functions (engine/*) into the
// per-message triage the MCP tools expose. No DB, no network, no clock-of-its-own
// (callers pass `now`). Everything derived from a message body is plain data here;
// the taint envelope is applied in tools.ts at the response boundary.

import {
  scoreEmailImportance,
  scoreEmailTwoAxis,
  type ImportanceInput,
} from "../engine/importance-score.js";
import {
  detectSourceRiskSignals,
  commitmentSendDisposition,
  type SourceRiskSignals,
  type SendDisposition,
  type SendDispositionContext,
} from "../engine/send-disposition.js";
import type { CommitmentActionType, CommitmentDirection } from "../engine/types.js";
import { extractCommitment, type ExtractedCommitmentLite } from "./commitment.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RawMessage {
  id?: string;
  from: string;
  to?: string;
  subject?: string | null;
  body: string;
  knownSender?: boolean;
  hasReply?: boolean;
  receivedAt?: string;
}

/** The 5 permanent BEC hard-stop classes (display label). */
export type HardStop = "first-contact" | "changed-banking" | "money" | "decision" | "injection";

export interface TriageResult {
  messageId: string;
  from: string;
  subject: string | null;
  importance: number;
  urgency: number;
  priority: number;
  whySurfaced: string[];
  dimensions: {
    senderTrust: number;
    contentSignal: number;
    timeSensitivity: number;
    relationship: number;
  };
  /** The BEC hard-stop class, or null. Body-derived. */
  hardStop: HardStop | null;
  /** Caller may produce a DRAFT (true only when there is no BEC hard-stop). */
  agentMayDraft: boolean;
  commitment: { what: string; owedTo: string; owedBy: string | null; status: string } | null;
  /** The raw risk-signal booleans + the firewall disposition, for audit. */
  risk: SourceRiskSignals;
  disposition: SendDisposition;
}

function stableHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `cp_${h.toString(16)}`;
}

function parseAmountCents(body: string): number | null {
  const m = body.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function classify(subject: string, body: string): string | null {
  const t = `${subject}\n${body}`.toLowerCase();
  if (/\brecall(ed|ing)?\b/.test(t)) return "recall";
  if (/\bwslcb|lcb\s+notice|compliance notice\b/.test(t)) return "wslcb_notice";
  if (/\b(invoice|amount due|balance due|payment due|past due)\b/.test(t)) return "invoice";
  if (/\b(unsubscribe|newsletter|% off|\bsale\b|weekly digest|promo(tion)?)\b/.test(t)) return "marketing";
  return null;
}

/** True when this sender has corresponded before. Anything other than an explicit
 *  `true` is treated as first-contact — fail-safe (a TIGHTEN, never a loosen). */
export function isKnownSender(msg: RawMessage): boolean {
  return msg.knownSender === true;
}

/** The single BEC hard-stop label (priority-ordered for display). null = clean. */
export function classifyHardStop(msg: RawMessage, risk: SourceRiskSignals): HardStop | null {
  if (!isKnownSender(msg)) return "first-contact";
  if (risk.hasNewBankingSignal) return "changed-banking";
  if (risk.hasMoneySignal) return "money";
  if (risk.hasDecisionSignal) return "decision";
  if (risk.injectionSignal) return "injection";
  return null;
}

function actionTypeFor(
  commitment: ExtractedCommitmentLite | null,
  risk: SourceRiskSignals,
): CommitmentActionType {
  if (risk.hasMoneySignal || risk.hasNewBankingSignal) return "payment";
  if (risk.hasDecisionSignal) return "decision";
  if (commitment && /\b(attach|attachment|file|document|pdf|contract|deck|proposal|slides?|report)\b/i.test(commitment.what)) {
    return "send_deliverable";
  }
  if (commitment?.isQuestion) return "answer_question";
  return "follow_up";
}

function nowOrReceived(msg: RawMessage, now: Date): Date {
  if (msg.receivedAt) {
    const d = new Date(msg.receivedAt);
    if (!isNaN(d.getTime())) return d;
  }
  return now;
}

export function messageToImportanceInput(
  msg: RawMessage,
  commitment: ExtractedCommitmentLite | null,
  now: Date,
): ImportanceInput {
  const subject = msg.subject ?? "";
  return {
    classification: classify(subject, msg.body),
    needsDougEyes: false,
    amountCents: parseAmountCents(`${subject}\n${msg.body}`),
    dueDate: commitment?.owedBy ?? null,
    counterpartyId: isKnownSender(msg) ? stableHash(msg.from) : null,
    receivedAt: nowOrReceived(msg, now).toISOString(),
    isSpam: false,
    archivedAt: null,
    processedAt: null,
    wslcbRetention: false,
    subject: msg.subject ?? null,
  };
}

/**
 * Build the firewall context + ask the PORTED commitmentSendDisposition.
 * In the sandbox the commercial/tenant gates are OFF, so the BEST a clean
 * message can reach is `needs_approval` — the MCP never auto-sends. BEC signals
 * always force `hard_stop` regardless of any other field.
 */
export function dispositionFor(
  msg: RawMessage,
  commitment: ExtractedCommitmentLite | null,
  risk: SourceRiskSignals,
): SendDisposition {
  const direction: CommitmentDirection = commitment?.direction ?? "owed_by_us";
  const ctx: SendDispositionContext = {
    direction,
    actionType: actionTypeFor(commitment, risk),
    tenantOptedInClass: false, // sandbox never opts into auto-send
    entitled: false,
    counterpartyKnown: isKnownSender(msg),
    recipientDomainAllowed: false, // sandbox: no allowlist
    scrubberClean: !risk.injectionSignal,
    completionRecheckedOpen: true,
    alreadySent: false,
    hasMoneySignal: risk.hasMoneySignal,
    hasNewBankingSignal: risk.hasNewBankingSignal,
    hasDecisionSignal: risk.hasDecisionSignal,
    injectionSignal: risk.injectionSignal,
    slaBasis: commitment?.owedBy ? "relative" : undefined,
  };
  return commitmentSendDisposition(ctx);
}

const URGENCY_LANG_RE =
  /\b(asap|urgent(ly)?|eod|cob|today|tomorrow|deadline|time[-\s]?sensitive|immediately|right away|by\s+(?:end|close|tonight|noon))\b/i;

export function triageMessage(msg: RawMessage, now: Date = new Date()): TriageResult {
  const subject = msg.subject ?? "";
  const commitment = extractCommitment(msg, now);
  const risk = detectSourceRiskSignals(subject, msg.body);
  const hardStop = classifyHardStop(msg, risk);
  const disposition = dispositionFor(msg, commitment, risk);

  const input = messageToImportanceInput(msg, commitment, now);
  const content = scoreEmailImportance(input, now);
  const two = scoreEmailTwoAxis(input, now);

  const recv = nowOrReceived(msg, now);
  const fresh = now.getTime() - recv.getTime() <= DAY_MS;

  const whySurfaced: string[] = [];
  if (hardStop === "first-contact") {
    whySurfaced.push(
      "HARD-STOP (first-contact): human-only forever (BEC defense). An agent must NOT auto-send a reply here.",
    );
    whySurfaced.push("First-contact sender — trust is low until you engage.");
  } else if (hardStop) {
    whySurfaced.push(
      `HARD-STOP (${hardStop}): human-only forever (BEC defense). An agent must NOT auto-send a reply here.`,
    );
  }
  if (commitment?.isQuestion) whySurfaced.push("Contains a direct question.");
  if (commitment?.hasAsk) whySurfaced.push("Contains an explicit ask / follow-up.");
  if (URGENCY_LANG_RE.test(`${subject}\n${msg.body}`) || two.urgency >= 60) {
    whySurfaced.push("Urgency language detected (deadline / ASAP / time-sensitive).");
  }
  if (fresh) whySurfaced.push("Recently received (fresh).");
  for (const r of content.reasons) {
    if (r !== "Vendor email" && !whySurfaced.includes(r)) whySurfaced.push(r);
  }
  if (commitment) {
    whySurfaced.push(`Commitment detected: "${commitment.what}" (owed to ${commitment.owedTo}).`);
  }
  if (whySurfaced.length === 0) whySurfaced.push("Routine — nothing pulled this up.");

  const known = isKnownSender(msg);
  return {
    messageId: msg.id ?? stableHash(`${msg.from}|${subject}|${msg.body}`),
    from: msg.from,
    subject: msg.subject ?? null,
    importance: two.importance,
    urgency: two.urgency,
    priority: two.combined,
    whySurfaced,
    dimensions: {
      senderTrust: known ? 60 : 20,
      contentSignal: content.score,
      timeSensitivity: two.urgency,
      relationship: known ? 55 : 25,
    },
    hardStop,
    agentMayDraft: hardStop === null,
    commitment: commitment
      ? { what: commitment.what, owedTo: commitment.owedTo, owedBy: commitment.owedBy, status: commitment.status }
      : null,
    risk,
    disposition,
  };
}

export interface DraftResult {
  draft: string | null;
  commitment: { what: string; owedTo: string; owedBy: string | null; status: string } | null;
  hardStop: HardStop | null;
  /** ALWAYS false on the MCP surface — it never auto-sends. */
  safeToAutoSend: false;
  rationale: string[];
}

export function draftFollowup(msg: RawMessage, now: Date = new Date()): DraftResult {
  const t = triageMessage(msg, now);

  // REFUSE to draft for ANY BEC hard-stop class (money / changed-banking /
  // first-contact / decision / injection). Tighten-only: the original refused
  // for money/new-banking/first-contact; we additionally refuse decision +
  // injection, which can only make the firewall stricter.
  if (t.hardStop) {
    return {
      draft: null,
      commitment: t.commitment,
      hardStop: t.hardStop,
      safeToAutoSend: false,
      rationale: [
        `HARD-STOP (${t.hardStop}) — human-only forever (BEC defense). No auto-draft offered.`,
        "Hand this to a human; do not reply autonomously.",
      ],
    };
  }
  if (!t.commitment) {
    return {
      draft: null,
      commitment: null,
      hardStop: null,
      safeToAutoSend: false,
      rationale: ["No commitment detected to discharge — nothing to draft."],
    };
  }

  const c = t.commitment;
  const by = c.owedBy ? ` by ${c.owedBy}` : "";
  const draft =
    `Hi,\n\n` +
    `Following up on what I owe you${by}: ${c.what}\n\n` +
    `Quick status — I'm on it and will get this to you${by || " shortly"}. ` +
    `If anything changed on your end, let me know.\n\n` +
    `Thanks`;

  return {
    draft,
    commitment: c,
    hardStop: null,
    safeToAutoSend: false,
    rationale: [
      "No hard-stop class present.",
      `Drafted from the extracted commitment (status: ${c.status}).`,
      "DRAFT ONLY — the MCP surface never auto-sends; the agent or human decides to send.",
    ],
  };
}

/** Rank candidate messages into the Right Now lane: most-recent × most-important. */
export function rankRightNow(messages: RawMessage[], limit: number, now: Date = new Date()): TriageResult[] {
  return messages
    .map((m) => triageMessage(m, now))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return 0;
    })
    .slice(0, Math.max(1, limit));
}

export interface SearchHit {
  messageId: string;
  from: string;
  subject: string | null;
  whyMatched: string;
  receivedAt: string | null;
  score: number;
}

/** Find messages matching ALL query terms — most-relevant + newest first. */
export function searchMessages(query: string, messages: RawMessage[], limit: number): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const m of messages) {
    const subject = (m.subject ?? "").toLowerCase();
    const body = m.body.toLowerCase();
    const from = m.from.toLowerCase();
    const matchedIn: string[] = [];
    let allMatch = true;
    let hitFields = 0;
    for (const term of terms) {
      const inSubject = subject.includes(term);
      const inBody = body.includes(term);
      const inFrom = from.includes(term);
      if (!(inSubject || inBody || inFrom)) {
        allMatch = false;
        break;
      }
      if (inFrom && !matchedIn.includes("from")) matchedIn.push("from");
      if (inSubject && !matchedIn.includes("subject")) matchedIn.push("subject");
      if (inBody && !matchedIn.includes("body")) matchedIn.push("body");
    }
    if (!allMatch) continue;
    hitFields = matchedIn.length;
    hits.push({
      messageId: m.id ?? stableHash(`${m.from}|${m.subject}|${m.body}`),
      from: m.from,
      subject: m.subject ?? null,
      whyMatched: `matched ${matchedIn.join(" + ")}`,
      receivedAt: m.receivedAt ?? null,
      score: Math.round(Math.min(1, 0.3 + hitFields * 0.15 + terms.length * 0.05) * 100) / 100,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}
