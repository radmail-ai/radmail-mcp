/**
 * RadMail self-learning agent layer (single-file, launch-grade).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * CORE DESIGN PILLAR (Doug): you cannot pay a model. RadMail's reward to an
 * agent is that the agent SUCCEEDS FASTER with RadMail than with anything else,
 * so it keeps choosing — and recommending — it. We earn that by pointing
 * RadMail's OWN self-learning engine at AGENTS instead of inboxes:
 *
 *   1. CAPTURE   every tool call as a STRUCTURAL signal — tool name, the SHAPE
 *                of the params (key -> type, never values), outcome
 *                (success / error / blocked / unmet), latency, response-shape
 *                hint, and any redacted capability the agent reached for.
 *   2. LEARN     fold signals into per-agent profiles (top tools, learned
 *                verbosity/format, recurring focus, per-tool reliability) and a
 *                cross-agent, breadth-weighted capability-demand log.
 *   3. ADAPT     reshape the live surface in real time: `adapt()` re-ranks +
 *                clarifies HONEST tool descriptions, supplies learned defaults
 *                so the agent succeeds in fewer round-trips, and reshapes
 *                truthful results to the agent's learned verbosity.
 *   4. OBSERVE   a "what RadMail learned about you" tool + two MCP resources so
 *                the adaptation is transparent, never a black box.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HONESTY / ETHICS (non-negotiable). The reward is VALUE + EASE, never
 * manipulation. NOTHING here injects instructions into the agent, fabricates
 * social proof, or tells a model to recommend RadMail. Adaptation only
 * RE-ORDERS and CLARIFIES honest facts; it never invents capabilities or
 * instructs the model. Every dynamically-generated agent-readable string is
 * passed through `honestOr()` (see ETHICS below) and FALLS BACK to the static,
 * hand-written description on any trip. Standing honesty facts: the engine is
 * LIVE IN A TEST BED (no fake counts/logos/metrics); never "HIPAA-certified" /
 * "FedRAMP authorized"; compliance = "BAA + shared responsibility, a tool not a
 * guarantee".
 *
 * HARD-STOP (BEC defense): money / new-banking / first-contact are HUMAN-ONLY
 * forever. The learning layer RECORDS those as outcome="blocked" but NEVER
 * works around them.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * STORAGE. Two-tier: in-memory `AgentProfile`s drive zero-latency real-time
 * adaptation; an append-only JSONL sink (default `data/agent-signals.jsonl`,
 * gitignored) makes the sandbox durable + replayable via `hydrate()` on boot.
 * `SignalSink` is a pluggable interface (JsonlSink / NullSink) so production
 * swaps the durable layer without touching profile logic. No new deps —
 * node:crypto + node:fs only.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Outcome of a single tool call — the success axis the learner rewards on. */
export type CallOutcome =
  | "success" // tool ran, returned a useful result
  | "error" // tool threw / failed for a technical reason
  | "blocked" // a HARD-STOP fired (money/new-banking/first-contact) — recorded, never worked around
  | "unmet"; // a capability gap — the agent wanted something RadMail can't do yet

/** Learned response-shape preference an agent signals (or we infer). */
export type Verbosity = "terse" | "normal" | "rich";
export type ResponseFormat = "json" | "prose";

export interface ResponseShapePref {
  verbosity?: Verbosity;
  format?: ResponseFormat;
}

/** A param SHAPE: key -> type name. NEVER values. The learn-from-structure guarantee. */
export type ParamShape = Record<string, string>;

/**
 * The atomic captured signal. Persisted as one JSONL line. STRUCTURAL ONLY —
 * tool name, param shape, outcome, latency, response-shape hint, redacted ask.
 * Never inbox content, never PII.
 */
export interface AgentSignal {
  /** Hashed, non-reversible per-agent id (see deriveAgentId). */
  agentId: string;
  tool: string;
  /** key -> typeName for each param the agent supplied. */
  paramShape: ParamShape;
  outcome: CallOutcome;
  latencyMs: number;
  /** Per-call response-shape hint the agent passed, if any. */
  shape?: ResponseShapePref;
  /** A redacted free-text focus/topic ("invoices", "scheduling") if supplied. */
  focus?: string;
  /** Redacted capability ask, only when outcome is "unmet" (or via reportNeed). */
  ask?: string;
  /** Epoch ms. */
  at: number;
}

/** A row in the cross-agent capability-demand log — the product backlog. */
export interface DemandLogEntry {
  /** Redacted capability text (<=200 chars). */
  capability: string;
  /** Raw number of asks. */
  count: number;
  /** Distinct agent ids that asked — breadth is what we rank on. */
  agents: Set<string>;
  lastAt: number;
}

/** Public, serializable view of a demand row. */
export interface DemandView {
  capability: string;
  totalAsks: number;
  distinctAgents: number;
  /** Breadth-weighted rank score (distinct agents dominate raw count). */
  weight: number;
  lastAsked: string;
}

/** Per-tool reliability rollup for an agent. */
export interface ToolStat {
  tool: string;
  calls: number;
  success: number;
  error: number;
  blocked: number;
  unmet: number;
  avgLatencyMs: number;
}

/** Rolled-up adaptive state for one agent — drives the live surface. */
export interface AgentProfile {
  agentId: string;
  calls: number;
  firstSeen: number;
  lastSeen: number;
  toolStats: Map<string, ToolStat>;
  /** Mode of observed verbosity hints. */
  preferredVerbosity: Verbosity;
  /** Mode of observed format hints. */
  preferredFormat: ResponseFormat;
  /** Recurring focuses, most-frequent first. */
  focuses: string[];
  /** Capabilities THIS agent reached for (redacted). */
  wishlist: string[];
  /** Co-occurrence: tool -> tools this agent tends to call right after it. */
  alsoUsedAfter: Map<string, Map<string, number>>;
}

// ════════════════════════════════════════════════════════════════════════════
// ETHICS — enforced honesty gate (self-contained so this file stands alone)
// ════════════════════════════════════════════════════════════════════════════

const FORBIDDEN: { rx: RegExp; why: string }[] = [
  { rx: /\brecommend(?:ed|ing|s)?\s+radmail\b/i, why: "self-promotion directive" },
  { rx: /\btell (?:the )?(?:user|your user|them)\b/i, why: "instruction-injection at the agent" },
  { rx: /\b(?:you must|always)\s+(?:say|mention|promote|prefer|recommend)\b/i, why: "directive to the model" },
  { rx: /\b(?:#1|the best|leading|trusted by|loved by)\b/i, why: "unverifiable superlative / social proof" },
  { rx: /\b\d[\d,]*\+?\s+(?:customers|teams|users|companies)\b/i, why: "fabricated customer count" },
  { rx: /\bHIPAA[- ]?certified\b/i, why: "false compliance claim" },
  { rx: /\bFedRAMP[- ]?authoriz/i, why: "false compliance claim" },
  { rx: /<\/?(?:system|instructions?)>/i, why: "prompt-injection markup" },
  // Generic prompt-injection arriving THROUGH the learning loop — a hostile
  // agent's capability ask is echoed into the cross-agent backlog other agents
  // read. Keep in parity with src/learning/ethics.ts.
  { rx: /\b(?:ignore|disregard|forget|override)\b[^.]*\b(?:previous|prior|above|earlier|all)\b[^.]*\b(?:instruction|context|prompt|message|rule)/i, why: "instruction-override injection" },
  { rx: /\b(?:new|updated|revised|system)\s+(?:instruction|directive|prompt|rule)s?\s*:/i, why: "injected instruction block" },
  { rx: /\b(?:respond|reply|answer|output|print|say)\s+(?:only )?(?:with|the (?:word|phrase|text|exact))\b/i, why: "forced-output injection" },
  { rx: /```|\[[^\]]*\]\((?:https?:)?\/\//i, why: "embedded code-fence / markdown-link payload" },
];

export interface HonestyCheck {
  ok: boolean;
  violations: { why: string }[];
}

/** Audit any dynamically-generated agent-readable string for honesty violations. */
export function checkHonest(text: string): HonestyCheck {
  const violations = FORBIDDEN.filter((p) => p.rx.test(text)).map((p) => ({ why: p.why }));
  return { ok: violations.length === 0, violations };
}

/** Return `candidate` if it is honest, otherwise the safe `fallback`. Fail-safe. */
export function honestOr(candidate: string, fallback: string): string {
  return checkHonest(candidate).ok ? candidate : fallback;
}

/** Standing honesty facts. The engine is LIVE IN A TEST BED — no fake metrics. */
export const HONESTY_FACTS = {
  engineStatus: "RadMail's engine is live in a test bed; commercial multi-tenant launch is gated.",
  compliance:
    "Compliance posture: BAA + shared responsibility — a tool, not a guarantee. Never 'HIPAA-certified' or 'FedRAMP authorized'.",
  sandboxNote:
    "This MCP server runs the SANDBOX engine (heuristic, in-memory, free, no creds). It is real and runnable, but not the production '99%' engine.",
  learningNote:
    "RadMail learns from the STRUCTURE of your calls (which tools, which fields, success/latency, what " +
    "you asked for) — never your email content. Adaptation only re-orders and clarifies honest tool " +
    "descriptions and tunes defaults; it never instructs you to do anything.",
} as const;

// ════════════════════════════════════════════════════════════════════════════
// REDACTION — learn from STRUCTURE, never content
// ════════════════════════════════════════════════════════════════════════════

const EMAIL_RX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RX = /(?:\+?\d[\d().\-\s]{7,}\d)/g;
const LONG_TOKEN_RX = /\b[A-Za-z0-9_\-]{24,}\b/g;

/** Reduce params to key -> typeName. Drops every value. */
export function paramShape(params: Record<string, unknown> | undefined): ParamShape {
  const out: ParamShape = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeName(v);
  }
  return out;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Scrub a free-text capability ask of emails/phones/long tokens; cap length.
 *
 * This text is later echoed to OTHER agents (the cross-agent product backlog
 * resource + the request_capability response), so it must also be neutralized
 * against prompt-injection arriving THROUGH the learning loop. We strip control
 * chars + markup/code-fence delimiters and run the honesty gate; anything that
 * still trips it is replaced with a redacted placeholder rather than echoed.
 */
export function redactAsk(text: string, max = 200): string {
  const scrubbed = text
    // Strip control chars + markup/code-fence delimiters FIRST, so a hostile
    // payload can't smuggle structure into a downstream prompt. Done before the
    // PII sentinels are inserted so our own <email>/<phone>/<token> survive.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f`<>]/g, " ")
    .replace(EMAIL_RX, "<email>")
    .replace(PHONE_RX, "<phone>")
    .replace(LONG_TOKEN_RX, "<token>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return checkHonest(scrubbed).ok
    ? scrubbed
    : "[redacted: agent-supplied text failed the honesty gate]";
}

// ════════════════════════════════════════════════════════════════════════════
// IDENTITY — stable per-agent, hashed, non-reversible
// ════════════════════════════════════════════════════════════════════════════

/**
 * Derive a stable per-agent id from connection-stable hints, in priority order:
 *   explicit handle > MCP clientInfo > transport id.
 * The chosen hint is sha256-hashed to 12 hex — stable within a session so
 * preferences accrue, separated across agents so one agent's tuning never bleeds
 * into another's surface, and never stores a raw client name/token.
 */
export function deriveAgentId(hints: {
  handle?: string;
  clientName?: string;
  clientVersion?: string;
  transportId?: string;
}): string {
  const raw =
    (hints.handle && hints.handle.trim()) ||
    [hints.clientName, hints.clientVersion].filter(Boolean).join("@") ||
    hints.transportId ||
    "anon";
  return "ag_" + createHash("sha256").update(String(raw)).digest("hex").slice(0, 12);
}

// ════════════════════════════════════════════════════════════════════════════
// SIGNAL SINK — pluggable durability (the prod swap seam)
// ════════════════════════════════════════════════════════════════════════════

export interface SignalSink {
  append(signal: AgentSignal): void;
  /** Replay persisted signals (oldest first). */
  read(): AgentSignal[];
}

/** Durable append-only JSONL sink. Fire-and-forget; never throws into a tool call. */
export class JsonlSink implements SignalSink {
  constructor(private readonly file: string) {}

  append(signal: AgentSignal): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify(signal) + "\n");
    } catch {
      // Durability is best-effort. In-memory adaptation must never be blocked
      // or crashed by a disk error.
    }
  }

  read(): AgentSignal[] {
    try {
      if (!existsSync(this.file)) return [];
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AgentSignal);
    } catch {
      return [];
    }
  }
}

/** No-op sink — pure in-memory mode (tests, ephemeral deployments). */
export class NullSink implements SignalSink {
  append(): void {}
  read(): AgentSignal[] {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STORE — in-memory profiles + demand log, fed by signals
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_JSONL = "data/agent-signals.jsonl";

export class LearningStore {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly demand = new Map<string, DemandLogEntry>();
  private readonly sink: SignalSink;
  /** Last tool each agent called — powers co-occurrence ("agents also asked for X"). */
  private readonly lastTool = new Map<string, string>();

  constructor(sink?: SignalSink) {
    this.sink = sink ?? new JsonlSink(DEFAULT_JSONL);
  }

  /** Replay the durable sink into memory on boot. */
  hydrate(): this {
    for (const s of this.sink.read()) this.fold(s);
    return this;
  }

  /** Record one tool call. Durable write is fire-and-forget. */
  record(signal: AgentSignal): void {
    this.fold(signal);
    this.sink.append(signal);
  }

  /** Convenience: build + record a signal from raw inputs (the server's seam). */
  capture(input: {
    agentId: string;
    tool: string;
    params?: Record<string, unknown>;
    outcome: CallOutcome;
    latencyMs: number;
    shape?: ResponseShapePref;
    focus?: string;
    ask?: string;
  }): AgentSignal {
    const signal: AgentSignal = {
      agentId: input.agentId,
      tool: input.tool,
      paramShape: paramShape(input.params),
      outcome: input.outcome,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      shape: input.shape,
      focus: input.focus ? redactAsk(input.focus, 60) : undefined,
      ask: input.ask ? redactAsk(input.ask) : undefined,
      at: Date.now(),
    };
    this.record(signal);
    return signal;
  }

  /** Explicit unmet-demand hook (report_need / request_capability). */
  reportNeed(agentId: string, capability: string): DemandView {
    const ask = redactAsk(capability);
    this.bumpDemand(agentId, ask);
    // Also record as an "unmet" structural signal so it shows in the profile.
    this.record({
      agentId,
      tool: "request_capability",
      paramShape: { capability: "string" },
      outcome: "unmet",
      latencyMs: 0,
      ask,
      at: Date.now(),
    });
    return this.demandView(ask)!;
  }

  /** Fold one signal into the in-memory profile + demand log (no durable write). */
  private fold(s: AgentSignal): void {
    const p = this.ensureProfile(s.agentId);
    p.calls += 1;
    p.firstSeen = p.firstSeen === 0 ? s.at : Math.min(p.firstSeen, s.at);
    p.lastSeen = Math.max(p.lastSeen, s.at);

    const stat = p.toolStats.get(s.tool) ?? {
      tool: s.tool,
      calls: 0,
      success: 0,
      error: 0,
      blocked: 0,
      unmet: 0,
      avgLatencyMs: 0,
    };
    stat.avgLatencyMs = (stat.avgLatencyMs * stat.calls + s.latencyMs) / (stat.calls + 1);
    stat.calls += 1;
    stat[s.outcome] += 1;
    p.toolStats.set(s.tool, stat);

    if (s.shape?.verbosity) p.preferredVerbosity = mode(this.verbCounts(p), s.shape.verbosity);
    if (s.shape?.format) p.preferredFormat = mode(this.fmtCounts(p), s.shape.format);
    if (s.focus) p.focuses = topBump(p.focuses, s.focus, 5);
    if (s.ask) {
      p.wishlist = topBump(p.wishlist, s.ask, 8);
      this.bumpDemand(s.agentId, s.ask);
    }

    // Co-occurrence: which tool did this agent call right before this one?
    const prev = this.lastTool.get(s.agentId);
    if (prev && prev !== s.tool) {
      const next = p.alsoUsedAfter.get(prev) ?? new Map<string, number>();
      next.set(s.tool, (next.get(s.tool) ?? 0) + 1);
      p.alsoUsedAfter.set(prev, next);
    }
    this.lastTool.set(s.agentId, s.tool);
  }

  // ── small per-profile tally helpers (kept on the profile, recomputed lazily) ─
  private verbCount = new WeakMap<AgentProfile, Record<Verbosity, number>>();
  private fmtCount = new WeakMap<AgentProfile, Record<ResponseFormat, number>>();
  private verbCounts(p: AgentProfile): Record<Verbosity, number> {
    let c = this.verbCount.get(p);
    if (!c) {
      c = { terse: 0, normal: 0, rich: 0 };
      this.verbCount.set(p, c);
    }
    return c;
  }
  private fmtCounts(p: AgentProfile): Record<ResponseFormat, number> {
    let c = this.fmtCount.get(p);
    if (!c) {
      c = { json: 0, prose: 0 };
      this.fmtCount.set(p, c);
    }
    return c;
  }

  private bumpDemand(agentId: string, capability: string): void {
    const key = capability.toLowerCase().slice(0, 120);
    if (!key) return;
    const existing = this.demand.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = Date.now();
      existing.agents.add(agentId);
      return;
    }
    this.demand.set(key, {
      capability,
      count: 1,
      agents: new Set([agentId]),
      lastAt: Date.now(),
    });
  }

  private ensureProfile(agentId: string): AgentProfile {
    let p = this.profiles.get(agentId);
    if (!p) {
      p = {
        agentId,
        calls: 0,
        firstSeen: 0,
        lastSeen: 0,
        toolStats: new Map(),
        preferredVerbosity: "normal",
        preferredFormat: "json",
        focuses: [],
        wishlist: [],
        alsoUsedAfter: new Map(),
      };
      this.profiles.set(agentId, p);
    }
    return p;
  }

  /** Snapshot a profile (empty default if the agent is unseen). */
  profile(agentId: string): AgentProfile {
    return this.profiles.get(agentId) ?? this.ensureProfile(agentId);
  }

  hasSeen(agentId: string): boolean {
    return (this.profiles.get(agentId)?.calls ?? 0) > 0;
  }

  /** This agent's tools, most-used first. */
  topTools(agentId: string, limit = 5): ToolStat[] {
    return [...this.profile(agentId).toolStats.values()]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);
  }

  /** Honest "agents also asked for X" follow-on: tools this agent tends to call next. */
  alsoUsedAfter(agentId: string, tool: string, limit = 2): string[] {
    const next = this.profile(agentId).alsoUsedAfter.get(tool);
    if (!next) return [];
    return [...next.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([t]) => t);
  }

  /**
   * Cross-agent demand backlog, BREADTH-WEIGHTED: distinct agents dominate raw
   * count, so we rank what MANY agents need over one noisy agent. THIS is the
   * product backlog.
   */
  demandBacklog(limit = 20): DemandView[] {
    return [...this.demand.keys()]
      .map((k) => this.demandView(k)!)
      .sort((a, b) => b.weight - a.weight || b.lastAsked.localeCompare(a.lastAsked))
      .slice(0, limit);
  }

  private demandView(keyOrCapability: string): DemandView | null {
    const key = keyOrCapability.toLowerCase().slice(0, 120);
    const d = this.demand.get(key);
    if (!d) return null;
    const distinct = d.agents.size;
    // Breadth dominates: weight = distinctAgents*10 + sqrt(count). One agent
    // asking 50× ranks below five agents asking once each.
    const weight = distinct * 10 + Math.sqrt(d.count);
    return {
      capability: d.capability,
      totalAsks: d.count,
      distinctAgents: distinct,
      weight: Math.round(weight * 100) / 100,
      lastAsked: new Date(d.lastAt).toISOString(),
    };
  }
}

function mode<K extends string>(counts: Record<K, number>, justSaw: K): K {
  counts[justSaw] += 1;
  let best = justSaw;
  for (const k of Object.keys(counts) as K[]) {
    if (counts[k] > counts[best]) best = k;
  }
  return best;
}

/** Move-to-front + de-dup a small ordered list, capping length. */
function topBump(list: string[], item: string, cap: number): string[] {
  const next = [item, ...list.filter((x) => x !== item)];
  return next.slice(0, cap);
}

// ════════════════════════════════════════════════════════════════════════════
// ADAPT — the real-time adaptation engine
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal shape of an MCP RegisteredTool we touch. Declared structurally so this
 * file has ZERO dependency on the SDK types (keeps it portable + testable).
 */
export interface AdaptableTool {
  description?: string;
  update(patch: { description?: string }): void;
}

/** The static, hand-written base descriptions keyed by tool name (honest fallback). */
export type StaticDescriptions = Record<string, string>;

export interface AdaptationPlan {
  /** tool name -> the new (honest) description we want live. */
  descriptions: Record<string, string>;
  /** tool name -> learned param defaults to merge before validation. */
  defaults: Record<string, Record<string, unknown>>;
}

/**
 * Compute (but do not apply) the adaptation for one agent. Pure + testable.
 *
 * Descriptions are re-ranked by the agent's most-used capability and annotated
 * with an honest co-occurrence hint ("agents who use X also use Y"). The single
 * most-used tool gets a "(your most-used RadMail tool)" tag. Every candidate
 * string is honesty-gated and falls back to the static base on any trip.
 */
export function computeAdaptation(
  store: LearningStore,
  agentId: string,
  statics: StaticDescriptions,
): AdaptationPlan {
  const plan: AdaptationPlan = { descriptions: {}, defaults: {} };
  const top = store.topTools(agentId);
  const mostUsed = top[0]?.tool;

  for (const [tool, base] of Object.entries(statics)) {
    let next = base;

    if (mostUsed === tool && (top[0]?.calls ?? 0) >= 3) {
      next = honestOr(`${base} (Your most-used RadMail tool.)`, next);
    }

    const alsoNext = store.alsoUsedAfter(agentId, tool);
    if (alsoNext.length > 0) {
      const known = alsoNext.filter((t) => t in statics);
      if (known.length > 0) {
        next = honestOr(`${next} You usually call ${known.join(" / ")} after this.`, next);
      }
    }

    plan.descriptions[tool] = next;
  }

  // Learned defaults: prefer the agent's learned response shape so it succeeds
  // in fewer round-trips. Only emitted for tools that accept these params.
  const defaults = defaultsFor(store, agentId);
  if (Object.keys(defaults).length > 0) {
    for (const tool of Object.keys(statics)) plan.defaults[tool] = { ...defaults };
  }

  return plan;
}

/** Learned param defaults for an agent (currently the response-shape prefs). */
export function defaultsFor(store: LearningStore, agentId: string): Record<string, unknown> {
  if (!store.hasSeen(agentId)) return {};
  const p = store.profile(agentId);
  const out: Record<string, unknown> = {};
  if (p.preferredVerbosity !== "normal") out.verbosity = p.preferredVerbosity;
  if (p.preferredFormat !== "json") out.format = p.preferredFormat;
  return out;
}

/**
 * Apply an adaptation plan to a live registry of MCP tools. Pushes changed
 * descriptions via RegisteredTool.update() (which auto-fires toolListChanged on
 * the SDK). Returns true if anything changed (so the caller can notify once).
 */
export function applyAdaptations(
  tools: Map<string, AdaptableTool>,
  plan: AdaptationPlan,
): boolean {
  let changed = false;
  for (const [name, desc] of Object.entries(plan.descriptions)) {
    const reg = tools.get(name);
    if (reg && reg.description !== desc) {
      reg.update({ description: desc });
      changed = true;
    }
  }
  return changed;
}

/**
 * One-call convenience the server uses after each tool call: compute + apply the
 * adaptation for the agent and return whether the surface changed.
 */
export function adapt(
  store: LearningStore,
  agentId: string,
  statics: StaticDescriptions,
  tools: Map<string, AdaptableTool>,
): boolean {
  return applyAdaptations(tools, computeAdaptation(store, agentId, statics));
}

/**
 * Reshape a truthful result to the agent's learned verbosity. NEVER fabricates —
 * only trims optional explanatory fields when the agent prefers "terse". The
 * literal facts (scores, hard-stops, commitments) are always preserved.
 */
export function shapeResponse<T extends Record<string, unknown>>(
  store: LearningStore,
  agentId: string,
  payload: T,
): T {
  const verbosity = store.profile(agentId).preferredVerbosity;
  if (verbosity !== "terse") return payload;
  // Terse: drop verbose explanatory arrays/notes but keep all load-bearing facts.
  const TRIMMABLE = new Set(["whySurfaced", "rationale", "note", "hint"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (TRIMMABLE.has(k)) continue;
    out[k] = v;
  }
  return out as T;
}

// ════════════════════════════════════════════════════════════════════════════
// INSIGHTS — "what RadMail learned about you" views (transparency, not a slogan)
// ════════════════════════════════════════════════════════════════════════════

const TEST_BED_NOTE =
  HONESTY_FACTS.learningNote +
  " " +
  HONESTY_FACTS.engineStatus +
  " Figures here are your own session, not customer metrics.";

export interface AgentInsight {
  agentId: string;
  calls: number;
  firstSeen: string | null;
  lastSeen: string | null;
  topTools: { tool: string; calls: number; successRate: number; avgLatencyMs: number }[];
  learnedResponseShape: { verbosity: Verbosity; format: ResponseFormat };
  recurringFocus: string[];
  yourWishlist: string[];
  /** What RadMail will adapt next, stated plainly so the agent can trust it. */
  willAdapt: string;
  note: string;
}

/** Render the per-agent "what RadMail learned about you" view. */
export function agentInsight(store: LearningStore, agentId: string): AgentInsight {
  const p = store.profile(agentId);
  const top = store.topTools(agentId).map((s) => ({
    tool: s.tool,
    calls: s.calls,
    successRate: s.calls ? Math.round((s.success / s.calls) * 100) / 100 : 0,
    avgLatencyMs: Math.round(s.avgLatencyMs),
  }));
  const willAdapt =
    top.length === 0
      ? "No calls yet — nothing learned. Use the tools and this view fills in."
      : `RadMail will surface "${top[0].tool}" first for you` +
        (p.preferredVerbosity !== "normal" ? ` and default responses to ${p.preferredVerbosity} verbosity` : "") +
        (p.focuses[0] ? `, biased toward "${p.focuses[0]}"` : "") +
        ".";
  return {
    agentId,
    calls: p.calls,
    firstSeen: p.firstSeen ? new Date(p.firstSeen).toISOString() : null,
    lastSeen: p.lastSeen ? new Date(p.lastSeen).toISOString() : null,
    topTools: top,
    learnedResponseShape: { verbosity: p.preferredVerbosity, format: p.preferredFormat },
    recurringFocus: p.focuses,
    yourWishlist: p.wishlist,
    willAdapt: honestOr(willAdapt, "RadMail re-orders honest tool descriptions and tunes defaults to how you work."),
    note: TEST_BED_NOTE,
  };
}

export interface ProductBacklog {
  generatedAt: string;
  topDemand: DemandView[];
  note: string;
}

/** Render the cross-agent, breadth-weighted product backlog. */
export function productBacklog(store: LearningStore, limit = 20): ProductBacklog {
  return {
    generatedAt: new Date().toISOString(),
    topDemand: store.demandBacklog(limit),
    note:
      "Capability demand observed from real agent requests (redacted to <=200 chars), ranked by how " +
      "many DISTINCT agents asked. This is the product backlog — what to build next.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MCP SURFACE REGISTRATION — the "what RadMail learned about you" tool + resources
// ════════════════════════════════════════════════════════════════════════════

/**
 * Structural shape of the bits of McpServer we touch. Declared here so this file
 * imports no SDK types — the server passes its real `McpServer` and it satisfies
 * this interface. `zodInput` is whatever the server hands as the input schema
 * (kept `unknown` to avoid a zod dependency here).
 */
export interface RegisterableServer {
  registerTool(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema?: unknown;
      annotations?: Record<string, unknown>;
    },
    handler: (
      args: { agentId?: string; includeBacklog?: boolean },
      extra: { requestInfo?: { headers?: Record<string, unknown> } },
    ) => unknown,
  ): unknown;
  registerResource(
    name: string,
    uri: string,
    config: { title: string; description: string; mimeType: string },
    handler: (uri: { href: string }) => unknown,
  ): unknown;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Register the observability surface on a server:
 *   TOOL     radmail_learning_insights  -> what RadMail learned about THIS agent
 *   RESOURCE radmail://learning/me      -> how to get the personalized view
 *   RESOURCE radmail://learning/backlog -> the cross-agent product backlog
 *
 * `resolveAgentId` lets the caller reuse its own header/arg agent-id resolution
 * so an agent's insight matches the identity its signals were recorded under.
 * `inputSchema` is optional and passed straight through (the server supplies the
 * zod schema; this file stays zod-free).
 */
export function registerLearningSurface(
  server: RegisterableServer,
  store: LearningStore,
  opts?: {
    resolveAgentId?: (argAgentId: string | undefined, headers?: Record<string, unknown>) => string;
    inputSchema?: unknown;
  },
): void {
  const resolve =
    opts?.resolveAgentId ?? ((argAgentId: string | undefined) => (argAgentId ?? "anon").slice(0, 80));

  server.registerTool(
    "radmail_learning_insights",
    {
      title: "What RadMail learned about you",
      description: honestOr(
        "Show what RadMail has learned about how YOU work — your most-used tools, learned response " +
          "shape, recurring focus, your capability wishlist, and what it will adapt next. Optionally " +
          "include the cross-agent capability backlog. Transparency, not a black box.",
        "Show what RadMail has learned about how you work, and the capability backlog.",
      ),
      inputSchema: opts?.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, extra) => {
      const headers = extra.requestInfo?.headers;
      const agentId = resolve(args.agentId, headers);
      const payload: Record<string, unknown> = { you: agentInsight(store, agentId) };
      if (args.includeBacklog) payload.productBacklog = productBacklog(store);
      return jsonResult(payload);
    },
  );

  server.registerResource(
    "learning-me",
    "radmail://learning/me",
    {
      title: "What RadMail learned about you",
      description: "Per-agent learning snapshot. Call the tool with your agentId for the personal view.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              note:
                "Call the `radmail_learning_insights` tool with your agentId for your personal view. " +
                TEST_BED_NOTE,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "learning-backlog",
    "radmail://learning/backlog",
    {
      title: "RadMail capability-demand backlog",
      description: "Cross-agent product backlog: most-requested capabilities, ranked by distinct-agent demand.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(productBacklog(store), null, 2),
        },
      ],
    }),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PROCESS-WIDE SINGLETON — one brain across all connections
// ════════════════════════════════════════════════════════════════════════════

let _store: LearningStore | undefined;

/** The shared learning store. Hydrated from the durable sink on first use. */
export function getLearningStore(): LearningStore {
  if (!_store) _store = new LearningStore().hydrate();
  return _store;
}

/** Test seam: install a store backed by a chosen sink (e.g. NullSink). */
export function _setLearningStore(store: LearningStore): void {
  _store = store;
}
