# litex

A lightweight, mobile-first web client for browsing X. It has timelines, threads, profiles, search, explore, notifications, bookmarks, and lists, plus like, repost, quote, reply, post with images, and follow. It has no ads, Grok, premium upsells, communities, or messages.

It talks to X's own web API through a small server that uses **your** logged-in session cookies. That breaks X's terms of service and could get the account rate-limited or flagged. Use it at your own risk.

## Why it stays fast

- **Chunked virtual feed** ([web/src/feed/feed.ts](web/src/feed/feed.ts)): posts render in chunks of 10, one chunk per frame, and only when they come near the screen. A chunk more than about 2 screens away is emptied and held open at its measured height. DOM size stays flat (about 1k nodes) however far you scroll.
- **Media**: boxes reserve their space with `aspect-ratio`, so there's no layout shift. Images load lazily at small sizes. Videos show a poster until you tap them. Only one video plays at a time, and GIFs play only while on screen. Every `<video>` is unloaded when it leaves the DOM.
- **Cheap paint**: the header is opaque (no blur), there are no heavy shadows, posts use `contain: content`, and animations only use transform and opacity.
- **Instant Back**: recent pages stay alive in the background, and the scroll position is restored exactly.
- **Small payloads**: the server turns X's responses into compact JSON. The frontend is about 18 KB of gzipped JS, with no framework.
- **Small server**: a single Go binary (about 8 MB, about 30 MB of RAM).

## Setup

1. Log in to x.com in a desktop browser and open DevTools → Application → Cookies → `https://x.com`. Copy `auth_token` and `ct0`.
2. Copy `.env.example` to `.env` and fill in:
   - `X_AUTH_TOKEN`, `X_CT0`: the two cookies.
   - `APP_PASSWORD`: the password for the litex login screen.
   - `SESSION_SECRET`: any long random string, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Run it. This needs Node (to build the web app) and Go 1.25+ (for the server):

```sh
npm install
npm run build        # web app -> dist/web, server -> dist/litex(.exe)
npm start            # http://localhost:8787
```

For development, `npm run dev` runs the Go server plus Vite on :5173, which proxies `/api`. Restart it after server changes. `npm test` runs the Go tests.

To work on the UI without an X account, use mock data: set `X_MOCK=1` (in `.env` or the environment) and start the server.

## Deploy

```sh
docker build -t litex .
docker run -d -p 8787:8787 --env-file .env -v litex-cache:/app/.cache litex
```

The image is just the static Go binary, the web files, and CA certificates, on `distroless/static`, running as a non-root user.

Put it behind HTTPS (Caddy, nginx, Fly, Render, and so on). The session cookie gets `Secure` automatically when the proxy sends `X-Forwarded-Proto: https`. You can force that with `COOKIE_SECURE=1`. Once it's on HTTPS, you can "Add to Home Screen" on your phone and it runs like an app.

## How it talks to X

The server is in [server/](server/):

- [x/meta.go](server/x/meta.go) loads X's web app and scrapes GraphQL query IDs and feature flags from `main.js` and its lazy chunks. It caches them in `.cache/xmeta.json` and refreshes them every 6 hours.
- [xtid/](server/xtid/xtid.go) generates the `x-client-transaction-id` header. It is a Go port of the [`x-client-transaction-id`](https://www.npmjs.com/package/x-client-transaction-id) JS library (v0.3.2) and is tested to produce identical IDs.
- [x/client.go](server/x/client.go) sends requests with the web client's headers. If X rotates `ct0`, it picks up the new value. On a 404 it retries with the other HTTP method, then re-scrapes the query IDs.
- [x/normalize.go](server/x/normalize.go) turns timeline instructions into compact items. It drops promoted entries, who-to-follow, Grok, premium, and community modules.

**Record and replay (testing):** set `X_RECORD=dir` to save every X response, or `X_REPLAY=dir` to serve saved responses without contacting X. This is useful for reproducing a bug or checking changes offline.

**Updating the transaction-ID port:** the JS library is kept as a dev dependency (pinned to 0.3.2). `npm run xtid:fixture` saves a fresh logged-out X page plus the library's output for it into `server/xtid/testdata/`, and `npm test` checks that the Go port produces identical IDs. If X changes the algorithm, update the library, run both, and fix any difference in Go.

If something stops loading after X ships a change, restart the server to force a fresh scrape. If your cookies expire, the API returns 401. Update them in `.env` and restart.
