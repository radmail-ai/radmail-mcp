/**
 * Light auth / tenant model.
 *
 * RadMail's MCP surface is FRICTION-FIRST: an agent can go zero -> working
 * triage in ONE call. So auth is layered, not gated:
 *
 *   - provision_sandbox needs NOTHING. It mints a free tenant token instantly.
 *   - Every other tool accepts the tenant token in `args.token`. If the agent
 *     omits it, the tool AUTO-PROVISIONS an ephemeral sandbox tenant on the
 *     spot (so a first triage call never errors on missing auth) and tells the
 *     agent the token to reuse.
 *   - On Streamable-HTTP, the token may instead arrive as a Bearer header or
 *     `X-RadMail-Token`; we read it off the request and stash it for the call.
 *   - `agentId` (for the self-learning layer) comes from `X-RadMail-Agent`
 *     header, an `args.agentId`, or falls back to the tenant id. Never PII.
 *
 * Tenants are ephemeral + free in sandbox. At launch, prod tokens
 * (RADMAIL_API_KEY-scoped) resolve to durable tenants via the prod engine —
 * same resolveTenant() seam.
 */

import { resolveTenant, type Tenant } from "./lib/tenants.js";

export type { Tenant };

export interface CallContext {
  /** Token lifted off an HTTP header, if any (stdio leaves this undefined). */
  headerToken?: string;
  /** Agent id lifted off a header, if any. */
  headerAgentId?: string;
}

export interface ResolvedAuth {
  tenant: Tenant;
  agentId: string;
  /** True when we minted a tenant just-in-time (told to the agent). */
  autoProvisioned: boolean;
}

/**
 * Resolve a tenant for a tool call. Prefers an explicit token (arg > header).
 * If none resolves, auto-provisions an ephemeral sandbox tenant so the agent
 * is never blocked on auth for its first call.
 */
export function resolveAuth(
  argToken: string | undefined,
  argAgentId: string | undefined,
  ctx: CallContext,
): ResolvedAuth {
  const token = argToken || ctx.headerToken;
  const { tenant, autoProvisioned } = resolveTenant(token);
  const agentId =
    argAgentId || ctx.headerAgentId || tenant.tenantId;
  return { tenant, agentId: agentId.slice(0, 80), autoProvisioned };
}

/** Pull token + agent id off Node HTTP-ish headers (case-insensitive). */
export function contextFromHeaders(headers: Record<string, unknown>): CallContext {
  const get = (name: string): string | undefined => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : undefined;
  };
  const bearer = get("authorization");
  const headerToken =
    (bearer && /^Bearer\s+(.+)$/i.exec(bearer)?.[1]) || get("x-radmail-token") || undefined;
  return { headerToken, headerAgentId: get("x-radmail-agent") };
}
