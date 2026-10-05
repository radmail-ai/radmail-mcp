// Types for scripts/check-public-denylist.mjs, so tests can import it under strict typecheck.
export interface DenylistHit {
  file?: string;
  rule: "email-outside-example-domains" | "absolute-home-path" | "internal-finding-id" | "denylisted-term";
  line: number;
  excerpt: string;
}
export const ALLOWED_ADDRESSES: Set<string>;
export const FORBIDDEN_PACK_PATHS: RegExp[];
export function isAllowedDomain(domain: string): boolean;
export function parseDenylist(raw: string | undefined | null): string[];
export function scanText(text: string, opts?: { terms?: string[] }): DenylistHit[];
export function scanFiles(files: string[], base: string, opts?: { terms?: string[] }): DenylistHit[];
export function trackedFiles(root?: string): string[];
export function packTarball(root?: string): { dir: string; files: string[]; cleanup: () => void };
