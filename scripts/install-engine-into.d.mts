// Types for scripts/install-engine-into.mjs, for test/engine-install.test.ts.
export interface ResolvedSource {
  ok: true;
  unreleased: boolean;
  source: string;
  version: string;
  bundle: string;
  hash: string;
  manifestLine: string;
  sentinel: string;
  vendorDir: string;
  bundleName: string;
  manifestName: string;
}
export interface Refusal { ok: false; exit: 1 | 2; message: string }
export interface InstallPlan {
  action: "create" | "same" | "replace" | "refuse";
  exit?: number;
  destBundle: string;
  destManifest: string;
  message: string;
}
export const ENGINE_ROOT: string;
export function bodyHash(contents: string, sentinel: string): string | null;
export function claimedHash(contents: string): string | null;
export function stampedVersion(contents: string): string | null;
export function compareSemver(a: string, b: string): number;
export function engineTags(root: string, prefix: string): string[];
export function resolveSource(root: string, opts?: { allowUnreleased?: boolean }): ResolvedSource | Refusal;
export function planInstall(src: ResolvedSource, repo: string, opts?: { force?: boolean }): InstallPlan;
export function applyInstall(src: ResolvedSource, plan: InstallPlan): { ok: boolean; message: string };
