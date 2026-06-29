// In-memory tenant store + auto-provision — mirrors the live radmail-mcp sandbox.
//
// The sandbox engine is heuristic + in-memory + free + no creds. A tenant is just
// a token (`rm_sbx_<hex>`) so the surface can do zero-to-triage in one call:
// most tools OMIT the token and auto-provision on the spot. There is no DB; the
// map lives for the lifetime of the serverless instance (ephemeral by design).

import { randomBytes } from "node:crypto";

export interface Tenant {
  token: string;
  tenantId: string;
  label: string | null;
  createdAt: string;
}

const tenants = new Map<string, Tenant>();

/** rm_sbx_<32 hex> — the sandbox token shape the live server hands out. */
export function mintToken(): string {
  return `rm_sbx_${randomBytes(16).toString("hex")}`;
}

/** Provision a fresh free sandbox tenant. */
export function provisionTenant(label?: string | null): Tenant {
  const token = mintToken();
  const shortHex = token.slice("rm_sbx_".length, "rm_sbx_".length + 6);
  const slug = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const tenant: Tenant = {
    token,
    tenantId: slug ? `sbx_${slug}_${shortHex}` : `sbx_${shortHex}`,
    label: label ?? null,
    createdAt: new Date().toISOString(),
  };
  tenants.set(token, tenant);
  return tenant;
}

/**
 * Resolve a tenant from an optional token. If the token is missing OR unknown
 * (an ephemeral instance recycled), auto-provision a fresh one — the sandbox is
 * deliberately frictionless. Returns the tenant plus whether it was just minted.
 */
export function resolveTenant(token?: string | null): { tenant: Tenant; autoProvisioned: boolean } {
  if (token && tenants.has(token)) {
    return { tenant: tenants.get(token)!, autoProvisioned: false };
  }
  if (token && /^rm_sbx_[0-9a-f]{32}$/.test(token)) {
    // A well-formed token from a previous (recycled) instance — re-register it so
    // the caller's token keeps working across cold starts. Still sandbox-only.
    const shortHex = token.slice("rm_sbx_".length, "rm_sbx_".length + 6);
    const tenant: Tenant = {
      token,
      tenantId: `sbx_${shortHex}`,
      label: null,
      createdAt: new Date().toISOString(),
    };
    tenants.set(token, tenant);
    return { tenant, autoProvisioned: false };
  }
  return { tenant: provisionTenant(), autoProvisioned: true };
}

/** Test/maintenance helper. */
export function _resetTenants(): void {
  tenants.clear();
}
