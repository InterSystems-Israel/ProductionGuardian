# metrics-proxy: polls IRIS /api/monitor/* and serves per-host JSON on :3001.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-install them.
#
# THE PROXY HAS ONE RUNTIME DEPENDENCY: express. My first version of this file copied only
# source, on the strength of a comment I wrote saying "zero runtime dependencies" -- true of
# the detection engine, not of this service. The image BUILT FINE and failed at startup with
# MODULE_NOT_FOUND, which is the worst shape for a container: green build, dead process.
# `npm ci --omit=dev` rather than `npm install` so the lockfile is authoritative.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Source only. The .env is NOT copied: configuration comes from compose environment, so one
# image works against any IRIS. Copying a .env would bake one deployment's host in.
COPY src/ ./src/
COPY index.js ./

# Port 3001 per root CLAUDE.md §5. Not configurable here on purpose -- the port is part of
# the contract with the engine, and compose maps it if the host needs something else.
EXPOSE 3001

# Health is the proxy's own view of whether it has polled IRIS successfully, not just
# whether the process is up: /proxy/health reports `starting` until the first poll lands,
# which is the distinction that matters when IRIS is slow to come up.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3001/proxy/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "index.js"]
