// ─────────────────────────────────────────────────────────────────────────────
// PORTED VERBATIM (pure, no-DB) from the RadMail main app:
//   /Users/GreenLife/Documents/CODE/RadMail/src/lib/importance/score.ts
// The crown-jewel two-axis importance scorer. Recovered into radmail-mcp so the
// MCP sandbox ranks mail with the SAME deterministic math as production.
// Keep byte-for-byte with source.
// ─────────────────────────────────────────────────────────────────────────────

// Importance score — the crown-jewel scorer. Ported AS-IS from the source
// engine's buyer-inbox-importance.ts (architecture §4). The ONLY change is the
// per-tenant rename `vendorId` → `counterpartyId` in ImportanceInput (the source
// FK'd a cannabis `vendors` table; the spinoff FKs a per-tenant counterparty
// registry). The scoring math is byte-identical — these are genuinely pure
// functions and the pin tests carry over unchanged.
//
// PURE function — no DB, no network, no clock-of-its-own (caller passes `now`).
// Fully unit-pinned in __tests__/score.test.ts. The signals are all on the
// inbox_emails row, so this scores at query time with no migration.
//
// Approved ranking order: recalls / regulatory → needs-your-eyes → invoices/POs
// due within ~7 days → big-dollar → known counterparty by recency; with
// "credit"/"return" mentions and any dollar amount weighted up; spam / archived
// / marketing sink.

const DAY_MS = 24 * 60 * 60 * 1000;

export type ImportanceBand = "critical" | "high" | "normal" | "low";

export interface ImportanceInput {
  classification: string | null;
  needsDougEyes: boolean;
  /** llm_extracted_amount_cents (bigint cents) or null. */
  amountCents: number | null;
  /** llm_extracted_due_date — 'YYYY-MM-DD' string, Date, or null. */
  dueDate: string | Date | null;
  /** Per-tenant counterparty FK (was vendorId in the source). */
  counterpartyId: string | null;
  receivedAt: string | Date;
  isSpam: boolean;
  archivedAt: string | Date | null;
  processedAt: string | Date | null;
  wslcbRetention: boolean;
  /** subject line — light keyword scan for credit/return/refund. */
  subject: string | null;
}

export interface ImportanceResult {
  /** 0–100. */
  score: number;
  band: ImportanceBand;
  /** Human-readable drivers, for the UI chip ("Recall", "Invoice due in 2d", "$4,200"). */
  reasons: string[];
}

function toDate(v: string | Date | null): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  // 'YYYY-MM-DD' parses as UTC midnight, which is fine for day-granularity due dates.
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function bandFor(score: number): ImportanceBand {
  if (score >= 80) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "normal";
  return "low";
}

const CREDIT_RETURN_RE = /\b(credit|return|refund|charge-?back|rma|short(ed|age)?|damag)/i;

/**
 * Per-signal LEARNED multipliers. Each value scales the contribution of one
 * signal family. The DEFAULT is all-1.0 = "use the original hand-tuned point
 * values exactly", so omitting this arg reproduces the original scorer
 * byte-for-byte (existing pins stay green). The nightly tuner in weights.ts
 * learns these from labeled history within hard bounds (recall/wslcb can never
 * drop below a regulatory floor).
 */
export interface ImportanceSignalWeights {
  recall: number;
  wslcb: number;
  needsEyes: number;
  dueDate: number;
  amount: number;
  creditReturn: number;
  vendorRecency: number;
}

const IDENTITY_WEIGHTS: ImportanceSignalWeights = {
  recall: 1,
  wslcb: 1,
  needsEyes: 1,
  dueDate: 1,
  amount: 1,
  creditReturn: 1,
  vendorRecency: 1,
};

/**
 * Score a single inbox email's importance to the OWNER. Higher = more likely to
 * need attention / easier to lose if buried. `now` is injected so the function
 * stays pure + testable. `weights` (optional) scales each signal family —
 * defaults to identity so the original hand-tuned behavior is unchanged.
 */
export function scoreEmailImportance(
  e: ImportanceInput,
  now: Date,
  weights: ImportanceSignalWeights = IDENTITY_WEIGHTS,
): ImportanceResult {
  const w = weights;
  const reasons: string[] = [];

  // --- Hard sinks first (a done/junk email is never "important to surface"). ---
  if (e.isSpam) {
    return { score: 2, band: "low", reasons: ["Spam"] };
  }
  const archived = toDate(e.archivedAt);
  if (archived) {
    return { score: 5, band: "low", reasons: ["Archived"] };
  }

  const cls = (e.classification ?? "").toLowerCase();
  let score = 0;

  // --- Regulatory: must-not-miss. ---
  if (cls === "recall") {
    score += 100 * w.recall;
    reasons.push("Product recall");
  } else if (cls === "wslcb_notice" || e.wslcbRetention) {
    score += 90 * w.wslcb;
    reasons.push("WSLCB notice");
  }

  // --- The classifier was unsure → it WANTS a human. ---
  if (e.needsDougEyes) {
    score += 55 * w.needsEyes;
    reasons.push("Needs your review");
  }

  // --- Money: invoices / POs with deadlines, scaled by proximity. Applies to
  //     ANY class that carries an extracted due date — a deadline is
  //     date-sensitive regardless of how it classified. ---
  const due = toDate(e.dueDate);
  if (due) {
    const days = Math.floor((due.getTime() - now.getTime()) / DAY_MS);
    if (days <= 0) {
      score += 70 * w.dueDate;
      reasons.push(days === 0 ? "Due today" : `Overdue ${Math.abs(days)}d`);
    } else if (days <= 2) {
      score += 60 * w.dueDate;
      reasons.push(`Due in ${days}d`);
    } else if (days <= 7) {
      score += 45 * w.dueDate;
      reasons.push(`Due in ${days}d`);
    } else {
      score += 18 * w.dueDate;
      reasons.push(`Due in ${days}d`);
    }
  } else if (cls === "invoice") {
    score += 30 * w.dueDate;
    reasons.push("Invoice");
  }

  // --- Dollar amount present → weight up (anything with a $ amount). ---
  if (e.amountCents != null && e.amountCents > 0) {
    const dollars = e.amountCents / 100;
    let amtBoost = 6;
    if (dollars >= 5000) amtBoost = 22;
    else if (dollars >= 1000) amtBoost = 14;
    else if (dollars >= 250) amtBoost = 9;
    score += amtBoost * w.amount;
    reasons.push("$" + Math.round(dollars).toLocaleString("en-US"));
  }

  // --- Credit / return / refund language. ---
  if (e.subject && CREDIT_RETURN_RE.test(e.subject)) {
    score += 25 * w.creditReturn;
    reasons.push("Credit / return");
  }

  // --- Low-value classes for the OWNER: menus, marketing, samples, meeting
  //     invites, system mail. Cap them so they never crowd the top. ---
  const LOW_VALUE = new Set(["marketing", "sample", "availability", "meeting", "system"]);
  if (LOW_VALUE.has(cls)) {
    score = Math.min(score, 15);
    if (reasons.length === 0) {
      reasons.push(cls === "availability" ? "Menu" : cls.charAt(0).toUpperCase() + cls.slice(1));
    }
  }

  // --- Known counterparty + recency: small base so a normal, recent email
  //     still ranks above an old unknown one, without overriding signals above. ---
  if (e.counterpartyId) {
    score += 8 * w.vendorRecency;
  }
  const received = toDate(e.receivedAt);
  if (received) {
    const ageMs = now.getTime() - received.getTime();
    if (ageMs <= DAY_MS) score += 6 * w.vendorRecency;
    else if (ageMs <= 3 * DAY_MS) score += 3 * w.vendorRecency;
  }

  // A processed/auto-filed email is mostly handled, but not as dead as archived
  // — soften rather than zero, so a filed-but-still-due invoice keeps some rank.
  if (toDate(e.processedAt)) {
    score = Math.round(score * 0.5);
  }

  score = clamp(Math.round(score), 0, 100);
  if (reasons.length === 0) reasons.push("Vendor email");
  return { score, band: bandFor(score), reasons };
}

// ═══════════════════════════════════════════════════════════════════════════
// TWO-AXIS SCORING + BEHAVIORAL SIGNALS + EXPLAINABILITY
//
// Splits the score into two independent axes (Eisenhower: importance vs
// urgency), folds in the behavioral layer from signals.ts, and emits a "why
// surfaced" template — WITHOUT changing scoreEmailImportance()'s default
// behavior (the pins stay byte-identical; these are additive new exports).
// ═══════════════════════════════════════════════════════════════════════════

import {
  computeBehavioralSignals,
  type BehavioralSignalInput,
  type BehavioralSignals,
} from "./signals.js"; // (port note: .js extension required by NodeNext module resolution)

export type EisenhowerQuadrant =
  | "do" // important + urgent
  | "schedule" // important, not urgent
  | "delegate" // urgent, not important
  | "drop"; // neither

export interface TwoAxisResult {
  /** Does this matter / need attention? 0–100. */
  importance: number;
  /** Deadline-driven time pressure, extracted from due dates. 0–100. */
  urgency: number;
  /** Blended rank used for a single-column sort (importance-led). 0–100. */
  combined: number;
  band: ImportanceBand;
  quadrant: EisenhowerQuadrant;
  reasons: string[];
  /** One-line "why surfaced", template over the top-3 signals (no LLM). */
  why: string;
  /** Named breakdown of every contributing signal, for audit + UI. */
  breakdown: SignalContribution[];
}

export interface SignalContribution {
  signal: string;
  /** Plain-English driver. */
  label: string;
  /** Points contributed to importance (urgency tracked separately). */
  points: number;
  axis: "importance" | "urgency";
}

/** Importance threshold above which an email counts as "important" for the quadrant. */
export const IMPORTANCE_AXIS_THRESHOLD = 45;
/** Urgency threshold above which an email counts as "urgent" for the quadrant. */
export const URGENCY_AXIS_THRESHOLD = 50;

/**
 * URGENCY = pure time pressure, extracted from the due date. Independent of
 * importance: a recall with no date is important-not-urgent; a routine menu
 * "order by EOD" is urgent-not-important. Recall/WSLCB carry a standing urgency
 * floor (regulatory windows are inherently time-bound).
 */
export function extractUrgency(
  e: ImportanceInput,
  now: Date,
): { urgency: number; reasons: string[] } {
  const reasons: string[] = [];
  if (e.isSpam || toDate(e.archivedAt)) return { urgency: 0, reasons: [] };

  let urgency = 0;
  const cls = (e.classification ?? "").toLowerCase();

  const due = toDate(e.dueDate);
  if (due) {
    const days = Math.floor((due.getTime() - now.getTime()) / DAY_MS);
    if (days <= 0) {
      urgency = 100;
      reasons.push(days === 0 ? "Due today" : `Overdue ${Math.abs(days)}d`);
    } else if (days <= 2) {
      urgency = 85;
      reasons.push(`Due in ${days}d`);
    } else if (days <= 7) {
      urgency = 60;
      reasons.push(`Due in ${days}d`);
    } else {
      urgency = 30;
      reasons.push(`Due in ${days}d`);
    }
  }

  // Regulatory standing urgency floor — a recall/WSLCB is time-bound even with
  // no parsed date.
  if (cls === "recall") urgency = Math.max(urgency, 90);
  else if (cls === "wslcb_notice" || e.wslcbRetention) urgency = Math.max(urgency, 70);

  return { urgency: clamp(Math.round(urgency), 0, 100), reasons };
}

/** Derive the Eisenhower quadrant from the two axes. */
export function eisenhowerQuadrant(
  importance: number,
  urgency: number,
): EisenhowerQuadrant {
  const imp = importance >= IMPORTANCE_AXIS_THRESHOLD;
  const urg = urgency >= URGENCY_AXIS_THRESHOLD;
  if (imp && urg) return "do";
  if (imp && !urg) return "schedule";
  if (!imp && urg) return "delegate";
  return "drop";
}

/**
 * Render the one-line "why surfaced" from the top contributing signals — a
 * TEMPLATE over the breakdown, NO extra LLM call. Picks the highest-magnitude
 * positive contributions so the explanation matches what actually drove the rank.
 */
export function explainSurfaced(breakdown: SignalContribution[]): string {
  const positives = breakdown
    .filter((c) => c.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
  if (positives.length === 0) return "Routine — nothing pulled this up.";
  const [lead, ...rest] = positives.map((c) => c.label);
  return rest.length ? `${lead} · ${rest.join(" · ")}` : lead;
}

/**
 * TWO-AXIS scorer. Computes importance (does it matter — content + behavior) and
 * urgency (deadline pressure) as separate numbers, the Eisenhower quadrant, a
 * named signal breakdown, and a templated "why surfaced".
 *
 * Importance reuses scoreEmailImportance() as the content base (so the learned
 * content weights still apply + the regulatory floor is preserved), then folds
 * in the bounded behavioral bonus. Behavior can lift a content-quiet but
 * behaviorally-important email out of 'low'; it is hard-capped and never buries
 * a recall (the content base already floored those).
 */
export function scoreEmailTwoAxis(
  e: ImportanceInput,
  now: Date,
  opts: {
    weights?: ImportanceSignalWeights;
    behavior?: BehavioralSignalInput;
  } = {},
): TwoAxisResult {
  const weights = opts.weights ?? IDENTITY_WEIGHTS;
  const content = scoreEmailImportance(e, now, weights);
  const breakdown: SignalContribution[] = [];

  // Seed the breakdown from the content reasons (each carries its own driver).
  for (const r of content.reasons) {
    breakdown.push({ signal: "content", label: r, points: 0, axis: "importance" });
  }

  // Hard sinks: spam/archived stay sunk on both axes; behavior can't rescue junk.
  const sunk = e.isSpam || toDate(e.archivedAt) != null;

  let importance = content.score;
  let behavioral: BehavioralSignals | null = null;

  if (!sunk && opts.behavior) {
    behavioral = computeBehavioralSignals(opts.behavior, now);

    // Explicit operator override is the human ground truth — it wins, but still
    // can't bury a regulatory-floored content score.
    if (behavioral.explicitOverride === "not") {
      importance = Math.min(importance, 15);
      breakdown.push({
        signal: "operator_override",
        label: "You marked this not important",
        points: 15 - content.score,
        axis: "importance",
      });
    } else {
      if (behavioral.explicitOverride === "important") {
        const lift = Math.max(0, IMPORTANCE_AXIS_THRESHOLD + 5 - importance);
        importance += lift;
        breakdown.push({
          signal: "operator_override",
          label: "You marked this important",
          points: lift,
          axis: "importance",
        });
      }
      importance += behavioral.pointBonus;
      for (const c of behavioral.contributions) {
        breakdown.push({
          signal: c.signal,
          label: c.label,
          points: c.points,
          axis: "importance",
        });
      }
    }
    importance = clamp(Math.round(importance), 0, 100);
  }

  const { urgency, reasons: urgencyReasons } = extractUrgency(e, now);
  for (const r of urgencyReasons) {
    if (!breakdown.some((b) => b.label === r && b.axis === "urgency")) {
      breakdown.push({ signal: "urgency", label: r, points: urgency, axis: "urgency" });
    }
  }

  // Combined rank: importance-led, nudged up by urgency so a tie breaks toward
  // the time-pressured one.
  const combined = clamp(Math.round(importance * 0.8 + urgency * 0.2), 0, 100);
  const band = bandFor(importance);
  const quadrant = eisenhowerQuadrant(importance, urgency);

  const reasons = [...content.reasons];
  for (const r of urgencyReasons) if (!reasons.includes(r)) reasons.push(r);
  if (behavioral) {
    for (const c of behavioral.contributions) {
      if (c.points > 0 && !reasons.includes(c.label)) reasons.push(c.label);
    }
  }

  return {
    importance,
    urgency,
    combined,
    band,
    quadrant,
    reasons,
    why: explainSurfaced(breakdown),
    breakdown,
  };
}

/** Sort comparator: importance desc, then most-recent first. */
export function compareByImportance(
  a: { importance: number; receivedAt: string | Date },
  b: { importance: number; receivedAt: string | Date },
): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  const at = toDate(a.receivedAt)?.getTime() ?? 0;
  const bt = toDate(b.receivedAt)?.getTime() ?? 0;
  return bt - at;
}

/** Window helper for the "last 72h" view. */
export const IMPORTANCE_RECENT_WINDOW_HOURS = 72;

export function isWithinRecentWindow(receivedAt: string | Date, now: Date): boolean {
  const r = toDate(receivedAt);
  if (!r) return false;
  return now.getTime() - r.getTime() <= IMPORTANCE_RECENT_WINDOW_HOURS * 60 * 60 * 1000;
}
