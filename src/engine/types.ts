// ─────────────────────────────────────────────────────────────────────────────
// PORTED VERBATIM (pure, no-DB) from the RadMail main app:
//   /Users/GreenLife/Documents/CODE/RadMail/src/server/commitments/types.ts
// Recovered into radmail-mcp so the MCP sandbox runs the SAME deterministic
// commitment enums as production. Do not diverge — keep byte-for-byte with source.
// ─────────────────────────────────────────────────────────────────────────────

// Commitment engine — shared types (Wave 7). The closed enums are load-bearing:
// they drive the SLA table, the draft style, the send-disposition gate, and the
// escalation tier. Keep them CLOSED — an unknown value coerces to a safe default.
//
// scope: RADMAIL_SCOPE_AUTONOMOUS_FOLLOWUP_2026_06_19.md §1.2, §2.1, §2.2.

// ─── Direction (who owes the action) ──────────────────────────────────
export const COMMITMENT_DIRECTIONS = ["owed_by_us", "owed_to_us"] as const;
export type CommitmentDirection = (typeof COMMITMENT_DIRECTIONS)[number];

// ─── Action type (CLOSED enum — the spine of every downstream decision) ─
// send_deliverable | follow_up | contact_third_party | answer_question | other
// Plus the scope's two HARD-STOP classes (payment/decision) carried so the
// disposition gate can permanently refuse them (BEC defense).
export const COMMITMENT_ACTION_TYPES = [
  "send_deliverable",
  "follow_up",
  "contact_third_party",
  "answer_question",
  "payment",
  "decision",
  "other",
] as const;
export type CommitmentActionType = (typeof COMMITMENT_ACTION_TYPES)[number];

export function isCommitmentActionType(v: string): v is CommitmentActionType {
  return (COMMITMENT_ACTION_TYPES as readonly string[]).includes(v);
}

/** Coerce an arbitrary LLM-returned action_type to the closed enum (unknown → 'other'). */
export function coerceActionType(v: unknown): CommitmentActionType {
  const s = String(v ?? "").toLowerCase().trim();
  return isCommitmentActionType(s) ? s : "other";
}

// ─── State machine ────────────────────────────────────────────────────
export const COMMITMENT_STATES = [
  "detected",
  "confirmed",
  "needs_due_date",
  "scheduled",
  "drafted",
  "sent",
  "done",
  "overdue",
  "escalated",
  "dismissed",
  "snoozed",
  "cancelled",
] as const;
export type CommitmentState = (typeof COMMITMENT_STATES)[number];

// ─── SLA basis — how the due date was determined ──────────────────────
export const SLA_BASES = ["explicit", "relative", "default_by_type", "manual"] as const;
export type SlaBasis = (typeof SLA_BASES)[number];

// ─── The extracted-commitment shape (post-coercion, pre-DB) ───────────
export type ExtractedCommitment = {
  direction: CommitmentDirection;
  party: string;
  action: string; // ≤140 chars
  actionType: CommitmentActionType;
  duePhrase: string | null;
  confidence: number; // 0..1, SOFT (presentation, never authorization)
  evidenceSpan: string; // exact sentence — mandatory; no span → dropped
};
