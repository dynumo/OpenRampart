# syntax=docker/dockerfile:1

# OpenRampart container image.
#   docker build -t openrampart .
# Optional extra OCR languages (Debian tesseract-ocr-* package suffixes):
#   docker build --build-arg OCR_LANGUAGE_PACKS="eng cym" -t openrampart .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Build: install all dependencies, build the web app and bundle the server ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---- Runtime: Node plus the OCR toolchain, running as an unprivileged user ----
FROM ${NODE_IMAGE} AS runtime
ARG OCR_LANGUAGE_PACKS="eng"
RUN set -eux; \
    langs=""; for l in ${OCR_LANGUAGE_PACKS}; do langs="$langs tesseract-ocr-$l"; done; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates tini \
      tesseract-ocr $langs \
      ocrmypdf ghostscript qpdf \
      poppler-utils \
      libheif-examples; \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# The image runs as the "node" user (uid 1000). Nothing under /app is writable;
# uploads are streamed through the system temp directory and stored in S3.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
