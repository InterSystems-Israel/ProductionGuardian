# Health Scan dashboard — build the single-file bundle, serve it with nginx.
#
# Two stages so the runtime image carries no Node and no source: the output is one
# HTML file plus an nginx config.
#
# NOT the Vite dev server. `npm run dev` is for development; a container running it
# would ship a dev build behind a watcher. This serves the same `dist/index.html`
# artefact the file:// fallback is verified against (CLAUDE.md §6), so the container
# and the fallback cannot drift apart.

# BUILD CONTEXT IS THE REPO ROOT, not this directory — see docker-compose.yml's dashboard
# service. `BrochureView.tsx` imports ../../../../docs/Brochure-A3.webp so the asset has one
# copy in git; that import cannot resolve from a context rooted here. Every COPY below is
# therefore repo-relative, and the source tree is reproduced at the same depth so the relative
# import resolves inside the image exactly as it does on a host.
FROM node:22-alpine AS build
WORKDIR /repo/apps/dashboard

# package files first so `npm ci` is cached independently of source edits.
COPY apps/dashboard/package.json apps/dashboard/package-lock.json ./
RUN npm ci

COPY apps/dashboard/ ./

# Only the one asset the bundle imports, not all of docs/ — that directory holds the deck, the
# MVP docx files and the concept demo, none of which belong in a build layer.
#
# THE FILENAME HERE IS LOAD-BEARING AND `tsc` CANNOT SEE IT. This line named Brochure.png until
# the brochure became a vector master; the import moved to the WebP render of it, and a host
# `npm run build` stayed green because a host has the whole repo on disk. Only the image build
# fails, with `Could not resolve "../../../../docs/Brochure-A3.webp"` — the exact failure
# CLAUDE.md §6 records from MVP 3. Change the import, change this line, in the same commit.
# The A3 PDF master is deliberately NOT copied: nothing in the bundle imports it, and an <img>
# could not render it if it did.
COPY docs/Brochure-A3.webp /repo/docs/Brochure-A3.webp

# The header's Management Portal link, and the ONE value in this bundle that cannot be relative.
#
# WHY AN ARG AND NOT AN ENV ON THE SERVE STAGE. `import.meta.env.VITE_*` is substituted by Vite
# during `npm run build`, i.e. inside this stage — it is a compile-time constant in the emitted
# HTML, not something nginx can envsubst later like HEALTHSCAN_UPSTREAM. So a runtime environment
# variable on the serve stage would be silently ignored, which is the trap this ARG exists to
# close: until it was added there was NO way for a container build to override
# AppShell.tsx's `DEFAULT_PORTAL_URL`, and every image ever built from this file pointed the
# button at `http://localhost:52773`. Correct under `docker compose up`, which publishes 52773 on
# the host; wrong everywhere else, and reported from the EKS deployment where the button opened
# the viewer's own machine.
#
# EMPTY DEFAULT ON PURPOSE — do not put a URL here. `portalUrl()` treats unset and empty
# identically and falls back to `DEFAULT_PORTAL_URL`, so an unpassed build keeps today's
# compose-correct behaviour and this file stays free of any hostname (apps/dashboard/CLAUDE.md
# §5/§9, #25). The deployment that knows its own IRIS hostname is the one that supplies it.
#
# CONSEQUENCE FOR TAGGING: passing this makes the image environment-specific. Two images built
# from the same commit with different values are NOT interchangeable, so do not reuse one tag for
# both — see the k8s deployment notes for the tagging scheme it uses.
#
# Declared here rather than at the top of the stage so changing the URL does not invalidate the
# `npm ci` layer.
ARG VITE_IRIS_PORTAL_URL=""
ENV VITE_IRIS_PORTAL_URL=${VITE_IRIS_PORTAL_URL}

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
COPY --from=build /repo/apps/dashboard/dist/index.html /usr/share/nginx/html/index.html

EXPOSE 80

# Compose can gate on this with `depends_on: condition: service_healthy`. Checks the
# document rather than the port, because nginx accepts connections before the template
# has been rendered and a config error would otherwise look healthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1/index.html || exit 1
