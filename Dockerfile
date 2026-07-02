# syntax=docker/dockerfile:1
# RadMail MCP — stdio server for agent hosts (Claude Desktop, etc.) and for
# registry introspection (Glama / Smithery build + run this to score the server).
#
# Zero-auth in-memory sandbox: NO secrets or config are required to start. The
# server comes up on the MCP stdio transport and answers tools/list immediately.
# The BEC hard-stop (money / changed-banking / first-contact = human-only forever)
# is enforced in-server; independently verifiable at
# https://radmail.ai/.well-known/agent-safety.json

# ---- build stage: compile TypeScript -> dist/ ----
FROM node:20-alpine AS build
WORKDIR /app
# deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci
# sources that tsconfig `include`s (src + api); build emits dist/src/index.js
COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN npm run build

# ---- runtime stage: production deps + compiled output only ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# runtime deps only (@modelcontextprotocol/sdk + zod); no tsx/typescript/types
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# stdio MCP transport — the agent host / registry scanner speaks over stdin/stdout.
# Matches package.json "start" and bin: node dist/src/index.js
CMD ["node", "dist/src/index.js"]
