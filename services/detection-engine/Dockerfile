# detection-engine: rolling baseline + the eight rules, serving /api/healthscan/* on :3002.
#
# node:22-alpine because the engine is TypeScript run directly via type stripping -- no
# build step, no tsc in the image. package.json requires >=22.18.0 for that, so the tag is
# load-bearing rather than a default (an older Node fails at startup, not at build).
FROM node:22-alpine

WORKDIR /app

COPY src/ ./src/
COPY fixtures/ ./fixtures/
COPY thresholds.json package.json ./

EXPOSE 3002

# thresholds.json is hot-reloaded (ADR 0003), so mounting it over this copy lets an
# operator tune without rebuilding. The copy is the default rather than the only option.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3002/api/healthscan/health | grep -q '"state"' || exit 1

# PROXY_MODE defaults to mock in the code (ADR 0004), and compose sets it to live. That
# default is deliberate: this image starts and serves with no proxy at all, which is what
# makes the engine+dashboard pair runnable on any machine (#70).
CMD ["node", "src/index.ts"]
