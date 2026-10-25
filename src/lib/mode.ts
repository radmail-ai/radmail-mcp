// Which engine is this process actually running?
//
// MEASURED 2026-09-24: with RADMAIL_API_KEY set, every startup line still said
// "radmail-mcp (sandbox engine) ready on stdio". An operator reading the launch
// log — or `claude mcp list` output, or a session transcript — had no way to
// tell a connected server from the demo tenant, which is exactly the failure
// the launcher's exit-66 rule exists to prevent one layer down. The string
// was written when sandbox was the only mode and never revisited when
// connected mode (v0.2.0) was added.
//
// One derivation, used by every entry point (stdio, http, index), so the three
// banners cannot disagree with each other or with tools.ts's own check.

import { triageToolsEnabled } from "./inbox-actions.js";

export type EngineMode = "connected" | "sandbox";

/** Same predicate tools.ts uses: a non-empty RADMAIL_API_KEY means connected. */
export function engineMode(env: NodeJS.ProcessEnv = process.env): EngineMode {
  const k = env.RADMAIL_API_KEY;
  return typeof k === "string" && k.trim().length > 0 ? "connected" : "sandbox";
}

/** The startup line. Never prints a key — only that one is present. */
export function startupBanner(transport: string, env: NodeJS.ProcessEnv = process.env): string {
  const mode = engineMode(env);
  const base =
    mode === "connected"
      ? `radmail-mcp CONNECTED to a real inbox (read-only, RADMAIL_API_KEY present) ${transport}`
      : `radmail-mcp (sandbox engine — no RADMAIL_API_KEY, demo tenant only) ${transport}`;
  // The SAME predicate the entries use to register the inbox-action tools: an
  // operator reading the launch log must see that this server can change mail.
  return triageToolsEnabled(env)
    ? `${base} — INBOX ACTIONS ON (archive / snooze / read state / labels via a separate RADMAIL_TRIAGE_API_KEY; never trash, delete or send)`
    : base;
}
