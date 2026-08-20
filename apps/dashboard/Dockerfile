# Health Scan dashboard — build the single-file bundle, serve it with nginx.
#
# Two stages so the runtime image carries no Node and no source: the output is one
# HTML file plus an nginx config.
#
# NOT the Vite dev server. `npm run dev` is for development; a container running it
# would ship a dev build behind a watcher. This serves the same `dist/index.html`
# artefact the file:// fallback is verified against (CLAUDE.md §6), so the container
# and the fallback cannot drift apart.

FROM node:22-alpine AS build
WORKDIR /app

# package files first so `npm ci` is cached independently of source edits.
# Paths are relative to the REPOSITORY ROOT since MVP 3 -- see the context note in
# docker-compose.yml. The brochure is copied in separately because it lives outside this app.
COPY apps/dashboard/package.json apps/dashboard/package-lock.json ./
RUN npm ci

COPY apps/dashboard/ ./
# docs/ is read-only source material (root CLAUDE.md §3); this reads it, never writes it. The build
# script copies it into dist/assets/, so there is one brochure in the repository and no committed
# duplicate to go stale (#84).
COPY docs/Brochure.png /repo/docs/Brochure.png

# `npm run build` runs `tsc --noEmit` first, so a type error fails the image build
# rather than producing one that serves a stale bundle.
RUN npm run build


FROM nginx:1.27-alpine AS serve

# host:port of the findings API, no scheme. `detection-engine` is the compose service
# name; override to host.docker.internal:3002 to run this container against an engine
# on the host, which is how it was verified.
ENV HEALTHSCAN_UPSTREAM=detection-engine:3002

# Only substitute our own placeholder. Without a filter the entrypoint's envsubst
# considers every environment variable, and nginx's own `$host`/`$uri` are one
# accidental collision away from being rewritten to nothing.
# Opt in to the image deriving NGINX_LOCAL_RESOLVERS from /etc/resolv.conf. Its
# 15-local-resolvers.envsh returns early unless this is set -- so without it the template's
# ${NGINX_LOCAL_RESOLVERS} renders LITERALLY and nginx dies with
# `host not found in resolver "${NGINX_LOCAL_RESOLVERS}"`. Found by reading the script
# rather than guessing at the variable name.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
ENV NGINX_ENVSUBST_FILTER="HEALTHSCAN_UPSTREAM|NGINX_LOCAL_RESOLVERS"

COPY apps/dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
# The served brochure. Without this line the view renders its own "could not be loaded" fallback --
# honest, but the asset exists and should be here.
COPY --from=build /app/dist/assets/brochure.png /usr/share/nginx/html/assets/brochure.png

EXPOSE 80

# Compose can gate on this with `depends_on: condition: service_healthy`. Checks the
# document rather than the port, because nginx accepts connections before the template
# has been rendered and a config error would otherwise look healthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1/index.html || exit 1
