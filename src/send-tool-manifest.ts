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
  "serverInstructionsSha256": "9fafa962bc57f7a52bbd4a3b5b97ce2a1ded477c8175cdc37aafdc8ba3aad7d8",
  "tools": [
    {
      "name": "send_email",
      "sha256": "1b121437a0158ab1b0c18494b7d3c50d44a87b23237b5c4b9016beb67a48ee2a"
    }
  ],
  "manifestSha256": "fee8df74656ae823eb253648d774ebdb860d40b772ee094d96d9a8011d3dd8f3"
};
