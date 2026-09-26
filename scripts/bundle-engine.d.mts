// Types for scripts/bundle-engine.mjs. Without this file, `npm run typecheck` fails
// with TS7016 on every test that imports the bundler. That failure has kept main's
// CI red since #16.
export const ENGINE_ORDER: string[];
export const OUT_DIR: string;
export const OUT_FILE: string;
export const HASH_FILE: string;
export function buildBundle(
  readModule?: (rel: string) => string,
  version?: string,
): { contents: string; hash: string; version: string };
