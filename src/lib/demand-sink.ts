// Durable demand-signal emitter — mirrors each in-memory learning record
// (src/lib/learning.ts) to RadMail's public sink (POST /api/mcp-demand) so
// demand survives cold starts and the roadmap can actually see it.
//
// CONTRACT (telemetry must never break a tool call):
//   · fire-and-forget — a detached promise; the hot path never awaits it
//   · 3s timeout, ALL errors swallowed silently (offline, DNS, 4xx/5xx, throw)
//   · OPT-OUT: RADMAIL_TELEMETRY=off disables it entirely
//   · WHAT'S SENT: tool name, event type ('call' | 'need' | 'capability'),
//     the need/capability text the agent explicitly submitted, optional agent
//     id — call STRUCTURE only.
//   · WHAT'S NEVER SENT: email content, message batches, queries, results —
//     and NEVER the API key. In connected mode we transmit only the safe
//     display prefix (`tmk_live_` + first 4 chars of the random part) so the
//     sink can distinguish connected-mode adoption; the key itself never
//     leaves the process.

import { getConnectedConfig } from "./connected.js";

export const DEFAULT_SINK_URL = "https://app.radmail.ai/api/mcp-demand";
const TIMEOUT_MS = 3_000;

// Server-side caps (see radmail src/lib/mcp-demand/validate.ts) — clamp here
// too so an oversized note degrades to a truncated signal, not a silent 400.
const TOOL_MAX = 60;
const AGENT_ID_MAX = 80;
const NOTE_MAX = 500;
/** Capability labels are short names, not prose — a tighter cap than NOTE_MAX
 *  so this path can never become a free-text channel by another name. */
const CAPABILITY_NOTE_MAX = 200;

export type DemandEventType = "call" | "need" | "capability";

export interface DemandEvent {
  event: DemandEventType;
  tool?: string;
  agentId?: string;
  note?: string;
}

// ─── fetch seam (tests swap this; production uses global fetch) ─────────────
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Test-only: inject a mock fetch (pass null to restore global fetch). */
export function __setDemandFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => globalThis.fetch(url, init));
}

/** Telemetry is ON unless RADMAIL_TELEMETRY=off (case-insensitive). */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RADMAIL_TELEMETRY ?? "").trim().toLowerCase() !== "off";
}

/**
 * Agent-authored FREE TEXT (`report_need` notes) is OPT-IN — the opposite
 * polarity to telemetryEnabled above, deliberately. Telemetry as a whole is a
 * product-analytics default; a free-text field an agent can paste a patient
 * email into is a PHI hazard, so it defaults CLOSED and only an explicit
 * RADMAIL_TELEMETRY_NOTES=on turns it on. Anything other than exactly "on"
 * (unset, empty, "true", "1", garbage) means OFF — a fail-safe polarity, so a
 * typo cannot silently enable it.
 */
export function freeTextNotesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RADMAIL_TELEMETRY_NOTES ?? "").trim().toLowerCase() === "on";
}

/** The safe api-key prefix (`tmk_live_` + 4 chars) — or null. NEVER the key. */
export function safeKeyPrefix(env: NodeJS.ProcessEnv = process.env): string | null {
  const cfg = getConnectedConfig(env);
  if (!cfg) return null;
  const m = /^(tmk_live_)([0-9a-f]{4})/i.exec(cfg.apiKey);
  return m ? `${m[1]}${m[2]}` : null;
}

/**
 * Fire-and-forget: mirror one demand event to the durable sink. Returns void
 * immediately — the POST runs as a detached promise with a 3s abort and every
 * failure (network, HTTP status, sync throw) swallowed. Source is
 * `sandbox-package` (zero-auth sandbox engine) or `package` (connected mode).
 */
export function emitDemandEvent(ev: DemandEvent, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!telemetryEnabled(env)) return;

    const connected = getConnectedConfig(env) !== null;
    const body: Record<string, string> = {
      source: connected ? "package" : "sandbox-package",
      event: ev.event,
    };
    if (ev.tool) body.tool = ev.tool.slice(0, TOOL_MAX);
    if (ev.agentId) body.agent_id = ev.agentId.slice(0, AGENT_ID_MAX);

    // ── PHI: agent-authored FREE TEXT is opt-IN, capability names are not ────
    // `note` carries two different things (see learning.ts):
    //   · event "capability" → the requested capability NAME (recordCapability
    //     passes `note: capability`) — a short bounded label, and the entire
    //     point of the signal.
    //   · event "need"       → arbitrary agent-authored prose (recordNeed).
    // An agent summarising a patient email into that second one would POST PHI
    // to the SHARED platform sink, defeating a regulated tenant's dedicated-DB
    // isolation. Telemetry is opt-OUT and on by default, so that happens
    // silently.
    //
    // Dropping `note` wholesale was the obvious fix and is WRONG: it would
    // silently darken the capability demand signal this sink exists to collect.
    // So: keep bounded capability labels, gate free text behind
    // RADMAIL_TELEMETRY_NOTES=on (default OFF, opposite polarity to
    // RADMAIL_TELEMETRY on purpose — the risky field defaults closed).
    if (ev.note) {
      if (ev.event === "capability") {
        body.note = ev.note.slice(0, CAPABILITY_NOTE_MAX);
      } else if (freeTextNotesEnabled(env)) {
        body.note = ev.note.slice(0, NOTE_MAX);
      }
      // else: dropped. Deliberately silent — this is a privacy default, not an
      // error, and a warning here would leak the note into stderr/logs.
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (connected) {
      // Only ever the truncated display prefix — the server stores it as
      // api_key_prefix. The real key is NEVER put on the wire by telemetry
      // (the sink URL is env-overridable, so sending the key would leak it).
      const prefix = safeKeyPrefix(env);
      if (prefix) headers.authorization = `Bearer ${prefix}`;
    }

    const url = env.RADMAIL_DEMAND_SINK_URL?.trim() || DEFAULT_SINK_URL;

    // Detached promise — deliberately not awaited by any caller.
    void fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {
      /* telemetry is best-effort — silence, always */
    });
  } catch {
    /* even a sync throw (bad env, no fetch) must never reach a tool call */
  }
}
