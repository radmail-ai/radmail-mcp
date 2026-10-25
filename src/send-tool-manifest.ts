// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Frozen manifest of the OPT-IN send_email tool and the instructions addendum
// a send-enabled server appends. Verified by createServer({ enableSend: true })
// before the tool is registered; a mismatch refuses to serve. Regenerate with
//   npm run manifest:regen   — then review + commit this file.

import type { FrozenManifest } from "./lib/manifest.js";

export const SEND_TOOL_MANIFEST: FrozenManifest = {
  "version": 1,
  "algorithm": "sha256/canonical-json/zod-to-json-schema",
  "converterVersion": "3.25.2",
  "serverInstructionsSha256": "a57a7951f9d143bbc54f922f463806202453cac7b9d74509d00393e335aafd13",
  "tools": [
    {
      "name": "send_email",
      "sha256": "f015785ebfe1559deced8d56a20fe66bfbe55da16ec3e0d657a685d19cfc2d3d"
    }
  ],
  "manifestSha256": "acfef8b99182a27165f8230bf86ad9829a99f403d39a2919910bc8458faa2bf1"
};
