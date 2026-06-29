// Lightweight commitment + due-date extraction for the sandbox engine.
//
// This is a HEURISTIC extractor (the sandbox is heuristic by design — the
// production "99%" engine is launch-gated). It pulls a single most-salient
// commitment sentence out of a message body and resolves a relative due phrase
// to an absolute YYYY-MM-DD, so the importance scorer + the firewall have a
// deterministic deadline to reason over.
//
// EVERYTHING here reads an attacker-controllable email body — its outputs are
// tainted by the caller (see lib/taint.ts). It performs NO action; it only
// extracts text + a date.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a relative due phrase ("by Thursday", "EOD", "tomorrow", "in 3 days",
 *  an explicit date) to an absolute YYYY-MM-DD, relative to `now`. null if none. */
export function resolveDuePhrase(text: string, now: Date): { phrase: string; date: string } | null {
  const t = text.toLowerCase();

  // Explicit ISO / numeric dates first.
  const isoM = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoM) {
    const d = new Date(isoM[1]);
    if (!isNaN(d.getTime())) return { phrase: isoM[1], date: iso(d) };
  }
  const mdM = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (mdM) {
    const month = parseInt(mdM[1], 10) - 1;
    const day = parseInt(mdM[2], 10);
    let year = mdM[3] ? parseInt(mdM[3], 10) : now.getUTCFullYear();
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return { phrase: mdM[0], date: iso(d) };
  }

  if (/\b(today|eod|end of day|cob|by close of business)\b/.test(t)) {
    return { phrase: "today", date: iso(now) };
  }
  if (/\btomorrow\b/.test(t)) {
    return { phrase: "tomorrow", date: iso(new Date(now.getTime() + DAY_MS)) };
  }
  const inDays = t.match(/\bin\s+(\d{1,2})\s+(day|business day|week)s?\b/);
  if (inDays) {
    const n = parseInt(inDays[1], 10);
    const mult = inDays[2].startsWith("week") ? 7 : 1;
    return { phrase: inDays[0], date: iso(new Date(now.getTime() + n * mult * DAY_MS)) };
  }
  if (/\bnext week\b/.test(t)) {
    return { phrase: "next week", date: iso(new Date(now.getTime() + 7 * DAY_MS)) };
  }
  if (/\bend of (the )?week\b/.test(t)) {
    // Friday of the current week.
    const dow = now.getUTCDay();
    const delta = (5 - dow + 7) % 7;
    return { phrase: "end of week", date: iso(new Date(now.getTime() + delta * DAY_MS)) };
  }

  // Named weekday → the NEXT occurrence (today counts only if "by today" matched above).
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const re = new RegExp(`\\b(?:by|before|on|this|next|due)?\\s*${WEEKDAYS[i]}\\b`);
    if (re.test(t)) {
      const dow = now.getUTCDay();
      let delta = (i - dow + 7) % 7;
      if (delta === 0) delta = 7; // "Thursday" said on a Thursday = next Thursday
      return { phrase: WEEKDAYS[i], date: iso(new Date(now.getTime() + delta * DAY_MS)) };
    }
  }
  return null;
}

const ASK_RE =
  /\b(can you|could you|please|would you|need|let me know|send (?:me|over|us)|get (?:me|us|back)|follow up|circle back|by\s|deadline|due|confirm|review|provide|share|update me|waiting on|expect)\b/i;

function splitSentences(body: string): string[] {
  return body
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ExtractedCommitmentLite {
  /** verbatim sentence from the body — TAINTED at the call site. */
  what: string;
  owedTo: string;
  owedBy: string | null;
  status: "open" | "due" | "overdue";
  duePhrase: string | null;
  /** who is being asked: 'us' (we owe a deliverable/answer) vs 'them'. */
  direction: "owed_by_us" | "owed_to_us";
  isQuestion: boolean;
  hasAsk: boolean;
}

/** Pull the single most-salient commitment out of a message. null if none found. */
export function extractCommitment(
  msg: { from: string; subject?: string | null; body: string },
  now: Date,
): ExtractedCommitmentLite | null {
  const sentences = splitSentences(msg.body);
  if (sentences.length === 0) return null;

  // Score each sentence: a question or an ask-verb wins; a due phrase boosts.
  let best: { s: string; score: number } | null = null;
  for (const s of sentences) {
    let score = 0;
    const isQ = s.includes("?");
    if (isQ) score += 3;
    if (ASK_RE.test(s)) score += 2;
    if (resolveDuePhrase(s, now)) score += 2;
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  if (!best) return null;

  const what = best.s.length > 200 ? best.s.slice(0, 197) + "…" : best.s;
  const due = resolveDuePhrase(best.s, now) ?? resolveDuePhrase(msg.body, now);
  let status: "open" | "due" | "overdue" = "open";
  if (due) {
    const days = Math.floor((new Date(due.date).getTime() - now.getTime()) / DAY_MS);
    status = days < 0 ? "overdue" : days <= 1 ? "due" : "open";
  }

  // Direction: an inbound asking us to do/send/answer = we owe them (owed_by_us);
  // an inbound saying "I'll send you X" = they owe us (owed_to_us).
  const owedToUs = /\b(i'?ll|we'?ll|i will|we will|i'?m going to|let me get|i can send|on my way)\b/i.test(
    best.s,
  );
  return {
    what,
    owedTo: msg.from,
    owedBy: due?.date ?? null,
    status,
    duePhrase: due?.phrase ?? null,
    direction: owedToUs ? "owed_to_us" : "owed_by_us",
    isQuestion: best.s.includes("?"),
    hasAsk: ASK_RE.test(best.s),
  };
}
