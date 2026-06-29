// ─────────────────────────────────────────────────────────────────────────────
// PORTED VERBATIM (pure, no-DB) from the RadMail main app:
//   /Users/GreenLife/Documents/CODE/RadMail/src/lib/importance/signals.ts
// Behavioral-signal dependency of the importance scorer. Recovered into
// radmail-mcp so the MCP sandbox runs the SAME deterministic math as production.
// Keep byte-for-byte with source.
// ─────────────────────────────────────────────────────────────────────────────

// Importance BEHAVIORAL SIGNALS — pure-fn lib. Ported AS-IS from the source
// engine's buyer-inbox-importance-signals.ts (architecture §4). No tenant
// surgery needed — this layer keys on per-sender stats (loaded per-org by the
// caller), not on a vendor/store FK, so the math ports byte-for-byte.
//
// WHY THIS LAYER EXISTS: the content scorer (score.ts) is a pure additive sum of
// CONTENT signals (class, $, due-date) with NO behavioral signal — so a chatty
// counterparty email the owner REPLIED to, a paid invoice that got `processed`,
// or a recurring correspondent whose mail always matters all sink to 'low'.
// Gmail Priority Inbox's lesson: importance = predicted probability the user
// ACTS, learned from sender behavior, with a global prior to beat cold-start and
// a per-(org,sender) correction layer, optimized so FALSE-NEGATIVES (a buried
// important email) are rare. This file computes that behavioral layer — every
// signal is a named number you can read. No black box.
//
// CAN'T RUN AWAY: (1) the learned per-sender score is BLENDED toward, gated by
// action-count, so a brand-new sender can't swing the score; (2) the total
// behavioral contribution is HARD-CAPPED (BEHAVIOR_MAX_POINTS) — behavior can
// lift a buried-but-real email out of 'low' but can never manufacture a
// 'critical' or bury a recall; (3) the EW update step is bounded + recency-
// weighted. PURE. No DB, no network, no clock-of-its-own. Fully unit-pinned.
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Global category priors (cold-start, research brief §2.3 step 1) ──────
// The "global model": a hand-set behavioral prior per class on a 0–100 scale,
// representing "how likely is a typical email of this class to be acted on."
// This gives sane behavior on day one before any per-sender history exists.
// These are LEARNED-LAYER priors (P(act)), distinct from the content scorer's
// point values — they seed the per-sender learned score, they don't replace
// the regulatory content scoring.
export const CATEGORY_PRIORS: Record<string, number> = {
  recall: 95,
  wslcb_notice: 95,
  invoice: 85,
  po_confirmation: 70,
  coa: 65,
  shipping: 45,
  other: 40,
  unclassified: 40,
  meeting: 35,
  availability: 18,
  sample: 15,
  marketing: 10,
  system: 10,
};
export const DEFAULT_CATEGORY_PRIOR = 40;

export function categoryPrior(classification: string | null): number {
  if (!classification) return DEFAULT_CATEGORY_PRIOR;
  return CATEGORY_PRIORS[classification.toLowerCase()] ?? DEFAULT_CATEGORY_PRIOR;
}

// ─── Per-(store,sender) behavioral stats ──────────────────────────────────
// Aggregated from history (buyer_inbox_sender_stats row, migration 0517). The
// caller loads this for the email's sender; absent = a never-seen sender.
export interface SenderStats {
  /** Distinct inbound emails seen from this sender (the denominator). */
  emailCount: number;
  /** How many the user replied to. */
  replyCount: number;
  /** How many the user opened (firstViewed). */
  openCount: number;
  /** How many were archived without ever being opened (negative signal). */
  archivedUnreadCount: number;
  /** Times the user pulled this sender's mail OUT of the digest (strong +). */
  pullbackCount: number;
  /** The online-EW learned action-likelihood score in [0,100]. */
  learnedScore: number;
  /** ISO/Date of the most recent inbound we corresponded around, or null. */
  lastCorrespondedAt: string | Date | null;
}

/** A fresh, never-seen sender (cold start). */
export function emptySenderStats(): SenderStats {
  return {
    emailCount: 0,
    replyCount: 0,
    openCount: 0,
    archivedUnreadCount: 0,
    pullbackCount: 0,
    learnedScore: 0,
    lastCorrespondedAt: null,
  };
}

// ─── Thread features (research brief §2.2 "thread family") ────────────────
export interface ThreadSignal {
  /** The user has replied IN this thread before (participation). */
  userInThread: boolean;
  /** This inbound is a reply to a user's outbound — closes a waiting-on. */
  isReplyToUserOutbound: boolean;
  /** How deep the thread is (more back-and-forth = more invested). */
  threadDepth: number;
}

export function emptyThreadSignal(): ThreadSignal {
  return { userInThread: false, isReplyToUserOutbound: false, threadDepth: 0 };
}

// ─── Tuning constants (PIN-TESTED) ────────────────────────────────────────
/** Action-count at which the learned per-sender score is fully trusted. */
export const LEARN_KNEE = 5;
/** Recency: behavior within this many days is "fresh" (full strength). */
export const RECENCY_FULL_DAYS = 14;
/** Recency fully decays to half-strength by this horizon. */
export const RECENCY_HALF_DAYS = 60;
/** Hard cap on total points behavior can ADD to the content score. The cap is
 *  generous enough that a reliably-replied, recent correspondent (the buried-
 *  recall case) clears the 'high' band off a near-zero content base, but small
 *  enough that behavior can never manufacture a 'critical' (≥80) on its own. */
export const BEHAVIOR_MAX_POINTS = 42;
/** EW update: weight of the newest action vs. the running score. */
export const EW_ALPHA = 0.2;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ─── The behavioral feature vector (explainable) ──────────────────────────
export interface BehavioralSignalInput {
  classification: string | null;
  /** From buyer_inbox_sender_stats for this email's sender. */
  senderStats?: SenderStats;
  /** From buyer_inbox_threads for this email's thread. */
  thread?: ThreadSignal;
  /** Operator's explicit thumbs (buyer_inbox_importance_feedback), or null. */
  explicitLabel?: "important" | "not" | null;
}

export interface BehavioralSignals {
  /** Blend of category prior + per-sender learned score, in [0,100]. */
  blendedScore: number;
  /** The cold-start global prior used. */
  prior: number;
  /** The learned per-sender score (0 if cold). */
  learnedScore: number;
  /** How much weight the learned score got (0..1), grows with action count. */
  learnedWeight: number;
  /** Recency strength of the last correspondence (0..1). */
  recencyStrength: number;
  /** Derived sender reply rate (0..1) — strongest social signal. */
  replyRate: number;
  /** The named contributions actually applied, for explainability. */
  contributions: BehavioralContribution[];
  /** Final bounded point bonus the content scorer should ADD. */
  pointBonus: number;
  /** Did an explicit operator override fire? */
  explicitOverride: "important" | "not" | null;
}

export interface BehavioralContribution {
  signal: string;
  /** Plain-English driver, e.g. "Replies to this sender 80% of the time". */
  label: string;
  /** Points contributed to pointBonus (can be negative). */
  points: number;
}

/**
 * Recency strength of last correspondence: 1.0 if within RECENCY_FULL_DAYS,
 * decaying linearly to 0.5 at RECENCY_HALF_DAYS, then 0.5→0 out to 2×. A
 * recent correspondent matters more than a year-stale one.
 */
export function recencyStrength(
  lastCorrespondedAt: string | Date | null,
  now: Date,
): number {
  const last = toDate(lastCorrespondedAt);
  if (!last) return 0;
  const ageDays = (now.getTime() - last.getTime()) / DAY_MS;
  if (ageDays <= RECENCY_FULL_DAYS) return 1;
  if (ageDays <= RECENCY_HALF_DAYS) {
    const span = RECENCY_HALF_DAYS - RECENCY_FULL_DAYS;
    return clamp(1 - 0.5 * ((ageDays - RECENCY_FULL_DAYS) / span), 0.5, 1);
  }
  const span = RECENCY_HALF_DAYS; // 60→120 days fades the last half to 0
  return clamp(0.5 - 0.5 * ((ageDays - RECENCY_HALF_DAYS) / span), 0, 0.5);
}

/**
 * Blend the global category prior with the per-sender learned score, weighted
 * by how much history we have (the n-gated cold-start discipline). With 0
 * actions the prior fully dominates; at LEARN_KNEE actions the learned score
 * is fully trusted. This IS the Gmail global-prior + per-user-correction blend.
 */
export function blendLearnedScore(
  prior: number,
  stats: SenderStats,
): { blended: number; learnedWeight: number } {
  const actions = stats.replyCount + stats.openCount + stats.pullbackCount
    + stats.archivedUnreadCount;
  const learnedWeight = clamp(actions / LEARN_KNEE, 0, 1);
  const blended = prior * (1 - learnedWeight) + stats.learnedScore * learnedWeight;
  return { blended: round1(clamp(blended, 0, 100)), learnedWeight: round1(learnedWeight) };
}

/**
 * Compute the explainable behavioral signal bundle for one email. The caller
 * passes the per-sender stats + thread features it loaded; this is pure math.
 *
 * The point bonus is the bounded amount the content scorer should ADD so a
 * behaviorally-important-but-content-quiet email (the replied-to chatty vendor)
 * can climb out of 'low'. It is HARD-CAPPED at BEHAVIOR_MAX_POINTS and never
 * touches the regulatory floor (recall/WSLCB are scored before behavior).
 */
export function computeBehavioralSignals(
  e: BehavioralSignalInput,
  now: Date,
): BehavioralSignals {
  const stats = e.senderStats ?? emptySenderStats();
  const thread = e.thread ?? emptyThreadSignal();
  const prior = categoryPrior(e.classification);
  const { blended, learnedWeight } = blendLearnedScore(prior, stats);
  const rec = round1(recencyStrength(stats.lastCorrespondedAt, now));
  const replyRate = stats.emailCount > 0
    ? round1(stats.replyCount / stats.emailCount)
    : 0;

  const contributions: BehavioralContribution[] = [];
  let bonus = 0;

  // ── Social: sender reply-rate × recency (strongest signal). A sender Doug
  //    reliably replies to, recently, is one whose mail should surface. ──
  if (stats.emailCount > 0 && replyRate > 0) {
    const pts = round1(replyRate * rec * 24);
    if (pts > 0) {
      bonus += pts;
      contributions.push({
        signal: "sender_reply_rate",
        label: `You reply to this sender ${Math.round(replyRate * 100)}% of the time`,
        points: pts,
      });
    }
  }

  // ── Social: pull-backs from the digest are an explicit "you were wrong,
  //    this matters" correction — the strongest behavioral positive. ──
  if (stats.pullbackCount > 0) {
    const pts = round1(Math.min(stats.pullbackCount, 3) * 4 * rec);
    if (pts > 0) {
      bonus += pts;
      contributions.push({
        signal: "sender_pullback",
        label: `You've rescued this sender from the digest ${stats.pullbackCount}×`,
        points: pts,
      });
    }
  }

  // ── Social: archived-unread rate is a negative signal — a sender whose mail
  //    you sweep away unread should NOT be lifted. ──
  if (stats.emailCount >= LEARN_KNEE) {
    const archiveRate = stats.archivedUnreadCount / stats.emailCount;
    if (archiveRate >= 0.6) {
      const pts = -round1(archiveRate * 8);
      bonus += pts;
      contributions.push({
        signal: "sender_archive_unread",
        label: `You usually sweep this sender away unread (${Math.round(archiveRate * 100)}%)`,
        points: pts,
      });
    }
  }

  // ── Thread: replying to a user's outbound closes a waiting-on item — high
  //    importance (the vendor finally answered). ──
  if (thread.isReplyToUserOutbound) {
    const pts = 16;
    bonus += pts;
    contributions.push({
      signal: "reply_to_outbound",
      label: "Replies to a message you sent (closes a waiting-on)",
      points: pts,
    });
  } else if (thread.userInThread) {
    const pts = 7;
    bonus += pts;
    contributions.push({
      signal: "user_in_thread",
      label: "You're already part of this thread",
      points: pts,
    });
  }

  // ── Learned per-sender lift: when history says this sender's mail gets
  //    acted on ABOVE its class prior, lift toward the learned score —
  //    weighted by how much history we trust. ──
  if (learnedWeight > 0 && blended > prior) {
    const pts = round1((blended - prior) / 100 * 22 * learnedWeight);
    if (pts > 0) {
      bonus += pts;
      contributions.push({
        signal: "learned_sender_score",
        label: `History says this sender's mail matters (learned ${Math.round(
          stats.learnedScore,
        )} vs prior ${Math.round(prior)})`,
        points: pts,
      });
    }
  }

  // ── Hard cap: behavior can lift, never run away. ──
  const pointBonus = round1(clamp(bonus, -BEHAVIOR_MAX_POINTS, BEHAVIOR_MAX_POINTS));

  return {
    blendedScore: blended,
    prior,
    learnedScore: round1(stats.learnedScore),
    learnedWeight,
    recencyStrength: rec,
    replyRate,
    contributions,
    pointBonus,
    explicitOverride: e.explicitLabel ?? null,
  };
}

// ─── The online EW update (research brief §2.3 step 2) ────────────────────
// One operator action on one of this sender's emails updates the running
// learned_score + the count aggregates. Pure: takes the prior stats + the
// action, returns the next stats. The cron / action handler persists the
// result to buyer_inbox_sender_stats. Recency-weighted, bounded step.

export type SenderAction =
  | "reply"
  | "open"
  | "pullback"
  | "do"
  | "flag"
  | "archive_unread"
  | "digest_without_open"
  | "delete";

/** The target action-likelihood each action implies (0..100). */
const ACTION_TARGET: Record<SenderAction, number> = {
  reply: 100,
  do: 100,
  pullback: 95,
  flag: 90,
  open: 65,
  archive_unread: 5,
  digest_without_open: 10,
  delete: 0,
};

/**
 * Apply one operator action to a sender's running stats. EW-updates the
 * learned_score toward the action's implied target, increments the relevant
 * counter, and stamps recency. Bounded step (EW_ALPHA) so no single action
 * lurches the score; recent behavior dominates over time.
 *
 * Cold start: the FIRST action seeds the learned_score from the category prior
 * (passed in) so the running score never starts at a meaningless 0.
 */
export function updateSenderStats(
  prev: SenderStats,
  action: SenderAction,
  classification: string | null,
  at: string | Date,
  alpha: number = EW_ALPHA,
): SenderStats {
  const seeded = prev.emailCount === 0 && prev.learnedScore === 0
    ? categoryPrior(classification)
    : prev.learnedScore;
  const target = ACTION_TARGET[action];
  const nextLearned = round1(clamp(seeded * (1 - alpha) + target * alpha, 0, 100));

  const next: SenderStats = {
    ...prev,
    learnedScore: nextLearned,
    lastCorrespondedAt: at,
  };

  // Each action implies an inbound email was processed → bump the denominator
  // exactly once per action (an action is "what happened to one email").
  next.emailCount = prev.emailCount + 1;
  if (action === "reply" || action === "do") next.replyCount = prev.replyCount + 1;
  if (action === "open" || action === "reply" || action === "do" || action === "flag") {
    next.openCount = prev.openCount + 1;
  }
  if (action === "pullback") next.pullbackCount = prev.pullbackCount + 1;
  if (action === "archive_unread" || action === "digest_without_open") {
    next.archivedUnreadCount = prev.archivedUnreadCount + 1;
  }
  return next;
}
