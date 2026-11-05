# 1) Build the web app (Node is only needed at build time)
FROM node:22-alpine AS web
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY shared ./shared
COPY web ./web
RUN npx vite build

# 2) Build the Go server as a static binary
FROM golang:1.25-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/litex . && mkdir -p /out/.cache

# 3) Tiny runtime image: binary + web files + CA certs (distroless/static), non-root
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=server /out/litex /app/litex
COPY --from=web /app/dist/web /app/dist/web
COPY --from=server --chown=65532:65532 /out/.cache /app/.cache
ENV PORT=8787 CACHE_DIR=/app/.cache
EXPOSE 8787
ENTRYPOINT ["/app/litex"]
