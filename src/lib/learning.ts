// Per-agent learning store — backs report_need / request_capability /
// radmail_learning_insights. In-memory + ephemeral, like the live sandbox.
//
// PRIVACY: this layer learns from the STRUCTURE of calls (which tools, which
// fields, what capability was asked for) — NEVER from email content. Email
// bodies never enter this store.

export interface AgentProfile {
  agentId: string;
  calls: number;
  firstSeen: string;
  lastSeen: string;
  toolCalls: Map<string, number>;
  wishlist: string[];
  focuses: string[];
  preferredVerbosity: "terse" | "normal" | "rich";
}

const profiles = new Map<string, AgentProfile>();

interface DemandRow {
  capability: string;
  totalAsks: number;
  agents: Set<string>;
  lastAsked: string;
}
const demand = new Map<string, DemandRow>();

function profileFor(agentId: string): AgentProfile {
  const id = agentId || "anon";
  let p = profiles.get(id);
  if (!p) {
    const now = new Date().toISOString();
    p = {
      agentId: id,
      calls: 0,
      firstSeen: now,
      lastSeen: now,
      toolCalls: new Map(),
      wishlist: [],
      focuses: [],
      preferredVerbosity: "normal",
    };
    profiles.set(id, p);
  }
  return p;
}

/** Record one tool call against an agent's profile (structure only, no content). */
export function recordCall(agentId: string | undefined, tool: string, focus?: string): void {
  const p = profileFor(agentId ?? "anon");
  p.calls += 1;
  p.lastSeen = new Date().toISOString();
  p.toolCalls.set(tool, (p.toolCalls.get(tool) ?? 0) + 1);
  if (focus && !p.focuses.includes(focus)) p.focuses.push(focus);
}

export function recordNeed(agentId: string | undefined, note: string): AgentProfile {
  const p = profileFor(agentId ?? "anon");
  recordCall(agentId, "report_need");
  bumpDemand(note, p.agentId);
  return p;
}

export function recordCapability(agentId: string | undefined, capability: string): DemandRow {
  const p = profileFor(agentId ?? "anon");
  recordCall(agentId, "request_capability");
  if (!p.wishlist.includes(capability)) p.wishlist.push(capability);
  return bumpDemand(capability, p.agentId);
}

function bumpDemand(capability: string, agentId: string): DemandRow {
  const key = capability.slice(0, 200);
  let row = demand.get(key);
  if (!row) {
    row = { capability: key, totalAsks: 0, agents: new Set(), lastAsked: new Date().toISOString() };
    demand.set(key, row);
  }
  row.totalAsks += 1;
  row.agents.add(agentId);
  row.lastAsked = new Date().toISOString();
  return row;
}

function weight(row: DemandRow): number {
  // Distinct-agent demand dominates; total asks contribute logarithmically.
  return Math.round((row.agents.size * 8 + Math.log2(row.totalAsks + 1) * 3) * 100) / 100;
}

export function topDemand(limit = 5): Array<{
  capability: string;
  totalAsks: number;
  distinctAgents: number;
  weight: number;
  lastAsked: string;
}> {
  return [...demand.values()]
    .map((r) => ({
      capability: r.capability,
      totalAsks: r.totalAsks,
      distinctAgents: r.agents.size,
      weight: weight(r),
      lastAsked: r.lastAsked,
    }))
    .sort((a, b) => b.weight - a.weight || b.totalAsks - a.totalAsks)
    .slice(0, limit);
}

export function topTools(agentId: string | undefined, limit = 5): Array<{ tool: string; calls: number }> {
  const p = profileFor(agentId ?? "anon");
  return [...p.toolCalls.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, limit);
}

export function getProfile(agentId: string | undefined): AgentProfile {
  return profileFor(agentId ?? "anon");
}

/** Test helper. */
export function _resetLearning(): void {
  profiles.clear();
  demand.clear();
}
