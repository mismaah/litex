// litex server (Go). Serves the web app and a small JSON API backed by X's web API.
package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"litex/x"
)

var (
	idRe    = regexp.MustCompile(`^\d{1,25}$`)
	snRe    = regexp.MustCompile(`^\w{1,15}$`)
	quoteRe = regexp.MustCompile(`^https://(x|twitter)\.com/\w+/status/\d+$`)
	mock    bool
	api     backend
)

// backend is the set of operations the HTTP layer needs; real (X) or mock.
type backend struct {
	Me               func() (*x.User, error)
	Home             func(tab, cursor string) (x.Page, error)
	TweetDetail      func(id, cursor string) (x.Page, error)
	Quotes           func(id, cursor string) (x.Page, error)
	UserByScreenName func(sn string) (*x.User, error)
	UserTimeline     func(id, tab, cursor string) (x.Page, error)
	Follows          func(id, kind, cursor string) (x.Page, error)
	Search           func(q, tab, cursor string) (x.Page, error)
	Explore          func(tab, cursor string) (x.Page, error)
	Notifications    func(tab, cursor string) (x.Page, error)
	Bookmarks        func(cursor string) (x.Page, error)
	Lists            func() (x.Page, error)
	ListInfo         func(id string) (*x.List, error)
	ListTweets       func(id, cursor string) (x.Page, error)
	Act              func(action, id string) error
	Follow           func(id string, on bool) error
	CreateTweet      func(o x.ComposeOpts) (*x.Tweet, error)
	UploadImage      func(data []byte, mime string) (string, error)
}

var realBackend = backend{
	Me: x.Me, Home: x.Home, TweetDetail: x.TweetDetail, Quotes: x.Quotes, UserByScreenName: x.UserByScreenName,
	UserTimeline: x.UserTimeline, Follows: x.Follows, Search: x.Search, Explore: x.Explore, Notifications: x.Notifications,
	Bookmarks: x.Bookmarks, Lists: x.Lists, ListInfo: x.ListInfo, ListTweets: x.ListTweets, Act: x.Act, Follow: x.Follow,
	CreateTweet: x.CreateTweet, UploadImage: x.UploadImage,
}

// ---------- env ----------

// loadEnvFile reads KEY=VALUE lines from .env if present; existing env vars win (like node --env-file).
func loadEnvFile(name string) {
	f, err := os.Open(name)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(strings.TrimPrefix(k, "export ")), strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		} else if i := strings.Index(v, " #"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		if _, exists := os.LookupEnv(k); !exists {
			os.Setenv(k, v)
		}
	}
}

// ---------- response helpers ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var xe *x.XError
	if errors.As(err, &xe) {
		body := map[string]any{"error": xe.Msg}
		if xe.Code != nil {
			body["code"] = *xe.Code
		}
		if xe.Reset != nil {
			body["reset"] = *xe.Reset
		}
		writeJSON(w, xe.Status, body)
		return
	}
	log.Println(err)
	writeJSON(w, 500, map[string]any{"error": "Server error"})
}

// ---------- short-lived read cache ----------

// Reads are cached 15s so tab switching / back navigation doesn't refetch.
type cacheEntry struct {
	at   time.Time
	body any
}

var (
	cacheMu   sync.Mutex
	respCache = map[string]cacheEntry{}
	cacheKeys []string
)

func cached[T any](key string, fn func() (T, error)) (any, error) {
	cacheMu.Lock()
	if e, ok := respCache[key]; ok && time.Since(e.at) < 15*time.Second {
		cacheMu.Unlock()
		return e.body, nil
	}
	cacheMu.Unlock()
	v, err := fn()
	if err != nil {
		return nil, err
	}
	cacheMu.Lock()
	if _, ok := respCache[key]; !ok {
		cacheKeys = append(cacheKeys, key)
	}
	respCache[key] = cacheEntry{time.Now(), v}
	if len(respCache) > 300 {
		for _, k := range cacheKeys[:100] {
			delete(respCache, k)
		}
		cacheKeys = slices.Clone(cacheKeys[100:])
	}
	cacheMu.Unlock()
	return v, nil
}

func clearCache() {
	cacheMu.Lock()
	respCache = map[string]cacheEntry{}
	cacheKeys = nil
	cacheMu.Unlock()
}

// ---------- gzip for /api ----------

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g gzipWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

func gzipped(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("accept-encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("content-encoding", "gzip")
		w.Header().Add("vary", "Accept-Encoding")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		next.ServeHTTP(gzipWriter{w, gz}, r)
	})
}

// ---------- API ----------

func oneOf(v string, allowed []string, d string) string {
	if slices.Contains(allowed, v) {
		return v
	}
	return d
}

func apiRoutes() http.Handler {
	mux := http.NewServeMux()
	q := func(r *http.Request, k string) string { return r.URL.Query().Get(k) }
	bad := func(msg string) error { return x.NewError(msg, 400) }
	// handle wraps a read: run fn, write JSON or the error.
	handle := func(pattern string, fn func(r *http.Request) (any, error)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			v, err := fn(r)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, v)
		})
	}

	handle("GET /api/me", func(r *http.Request) (any, error) { return cached("me", api.Me) })
	handle("GET /api/home", func(r *http.Request) (any, error) {
		tab := oneOf(q(r, "tab"), []string{"foryou", "following"}, "foryou")
		cursor := q(r, "cursor")
		// Home is never cached on the first page so refresh always gets new posts.
		if cursor == "" {
			return api.Home(tab, "")
		}
		return cached("home:"+tab+":"+cursor, func() (x.Page, error) { return api.Home(tab, cursor) })
	})
	handle("GET /api/tweet/{id}", func(r *http.Request) (any, error) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			return nil, bad("bad id")
		}
		cursor := q(r, "cursor")
		return cached("tweet:"+id+":"+cursor, func() (x.Page, error) { return api.TweetDetail(id, cursor) })
	})
	handle("GET /api/tweet/{id}/quotes", func(r *http.Request) (any, error) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			return nil, bad("bad id")
		}
		cursor := q(r, "cursor")
		return cached("quotes:"+id+":"+cursor, func() (x.Page, error) { return api.Quotes(id, cursor) })
	})
	handle("GET /api/user/{sn}", func(r *http.Request) (any, error) {
		sn := r.PathValue("sn")
		if !snRe.MatchString(sn) {
			return nil, bad("bad user")
		}
		return cached("user:"+strings.ToLower(sn), func() (*x.User, error) { return api.UserByScreenName(sn) })
	})
	handle("GET /api/user/{id}/timeline", func(r *http.Request) (any, error) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			return nil, bad("bad id")
		}
		tab := oneOf(q(r, "tab"), []string{"posts", "replies", "media", "likes"}, "posts")
		cursor := q(r, "cursor")
		return cached("ut:"+id+":"+tab+":"+cursor, func() (x.Page, error) { return api.UserTimeline(id, tab, cursor) })
	})
	for _, kind := range []string{"followers", "following"} {
		handle("GET /api/user/{id}/"+kind, func(r *http.Request) (any, error) {
			id := r.PathValue("id")
			if !idRe.MatchString(id) {
				return nil, bad("bad id")
			}
			cursor := q(r, "cursor")
			return cached("f:"+id+":"+kind+":"+cursor, func() (x.Page, error) { return api.Follows(id, kind, cursor) })
		})
	}
	handle("GET /api/search", func(r *http.Request) (any, error) {
		query := q(r, "q")
		if u := []rune(query); len(u) > 500 {
			query = string(u[:500])
		}
		if query == "" {
			return nil, bad("missing q")
		}
		tab := oneOf(q(r, "tab"), []string{"top", "latest", "people", "media"}, "top")
		cursor := q(r, "cursor")
		return cached("s:"+tab+":"+query+":"+cursor, func() (x.Page, error) { return api.Search(query, tab, cursor) })
	})
	handle("GET /api/explore", func(r *http.Request) (any, error) {
		tab := oneOf(q(r, "tab"), x.ExploreTabs, "for_you")
		cursor := q(r, "cursor")
		return cached("e:"+tab+":"+cursor, func() (x.Page, error) { return api.Explore(tab, cursor) })
	})
	handle("GET /api/notifications", func(r *http.Request) (any, error) {
		tab := oneOf(q(r, "tab"), []string{"all", "mentions"}, "all")
		cursor := q(r, "cursor")
		return cached("n:"+tab+":"+cursor, func() (x.Page, error) { return api.Notifications(tab, cursor) })
	})
	handle("GET /api/bookmarks", func(r *http.Request) (any, error) {
		cursor := q(r, "cursor")
		return cached("b:"+cursor, func() (x.Page, error) { return api.Bookmarks(cursor) })
	})
	handle("GET /api/lists", func(r *http.Request) (any, error) { return cached("lists", api.Lists) })
	handle("GET /api/list/{id}", func(r *http.Request) (any, error) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			return nil, bad("bad id")
		}
		return cached("li:"+id, func() (*x.List, error) { return api.ListInfo(id) })
	})
	handle("GET /api/list/{id}/tweets", func(r *http.Request) (any, error) {
		id := r.PathValue("id")
		if !idRe.MatchString(id) {
			return nil, bad("bad id")
		}
		cursor := q(r, "cursor")
		return cached("lt:"+id+":"+cursor, func() (x.Page, error) { return api.ListTweets(id, cursor) })
	})

	// ---- writes ----
	for _, action := range []string{"like", "unlike", "rt", "unrt", "bookmark", "unbookmark"} {
		handle("POST /api/tweet/{id}/"+action, func(r *http.Request) (any, error) {
			id := r.PathValue("id")
			if !idRe.MatchString(id) {
				return nil, bad("bad id")
			}
			if err := api.Act(action, id); err != nil {
				return nil, err
			}
			clearCache()
			return map[string]any{"ok": true}, nil
		})
	}
	for _, action := range []string{"follow", "unfollow"} {
		handle("POST /api/user/{id}/"+action, func(r *http.Request) (any, error) {
			id := r.PathValue("id")
			if !idRe.MatchString(id) {
				return nil, bad("bad id")
			}
			if err := api.Follow(id, action == "follow"); err != nil {
				return nil, err
			}
			clearCache()
			return map[string]any{"ok": true}, nil
		})
	}
	handle("POST /api/media", func(r *http.Request) (any, error) {
		if err := r.ParseMultipartForm(6 << 20); err != nil {
			return nil, bad("missing file")
		}
		file, hdr, err := r.FormFile("file")
		if err != nil {
			return nil, bad("missing file")
		}
		defer file.Close()
		mime := hdr.Header.Get("Content-Type")
		if !slices.Contains([]string{"image/jpeg", "image/png", "image/webp", "image/gif"}, mime) || hdr.Size > 5*1024*1024 {
			return nil, bad("Images only, up to 5 MB")
		}
		data, err := io.ReadAll(file)
		if err != nil {
			return nil, err
		}
		id, err := api.UploadImage(data, mime)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": id}, nil
	})
	handle("POST /api/compose", func(r *http.Request) (any, error) {
		var b struct {
			Text     any   `json:"text"`
			ReplyTo  any   `json:"replyTo"`
			Quote    any   `json:"quote"`
			MediaIDs []any `json:"mediaIds"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		text, _ := b.Text.(string)
		if u := []rune(text); len(u) > 25000 {
			text = string(u[:25000])
		}
		var media []string
		for _, m := range b.MediaIDs {
			if s, ok := m.(string); ok && idRe.MatchString(s) && len(media) < 4 {
				media = append(media, s)
			}
		}
		if strings.TrimSpace(text) == "" && len(media) == 0 {
			return nil, bad("Empty post")
		}
		replyTo, _ := b.ReplyTo.(string)
		if replyTo != "" && !idRe.MatchString(replyTo) {
			return nil, bad("bad reply id")
		}
		quote, _ := b.Quote.(string)
		if quote != "" && !quoteRe.MatchString(quote) {
			return nil, bad("bad quote url")
		}
		t, err := api.CreateTweet(x.ComposeOpts{Text: text, ReplyTo: replyTo, Quote: quote, MediaIDs: media})
		if err != nil {
			return nil, err
		}
		clearCache()
		return map[string]any{"tweet": t}, nil
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, map[string]any{"error": "not found"})
	})
	return requireAuth(mux)
}

// ---------- static app ----------

func staticHandler(webDir string) http.Handler {
	indexPath := filepath.Join(webDir, "index.html")
	types := map[string]string{".webmanifest": "application/manifest+json", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml; charset=utf-8", ".html": "text/html; charset=utf-8", ".png": "image/png", ".json": "application/json"}
	serveFile := func(w http.ResponseWriter, r *http.Request, file, cacheControl string) {
		if t, ok := types[strings.ToLower(filepath.Ext(file))]; ok {
			w.Header().Set("content-type", t)
		}
		w.Header().Set("cache-control", cacheControl)
		http.ServeFile(w, r, file)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		clean := path.Clean("/" + r.URL.Path)
		file := filepath.Join(webDir, filepath.FromSlash(clean))
		if clean == "/" {
			file = indexPath
		}
		if st, err := os.Stat(file); err == nil && !st.IsDir() {
			cc := "public, max-age=3600"
			switch {
			case strings.HasPrefix(clean, "/assets/"):
				cc = "public, max-age=31536000, immutable"
			case strings.HasSuffix(file, ".html") || strings.HasSuffix(file, "sw.js"):
				cc = "no-cache"
			}
			serveFile(w, r, file, cc)
			return
		}
		// SPA fallback.
		if _, err := os.Stat(indexPath); err != nil {
			w.Header().Set("content-type", "text/plain; charset=UTF-8")
			w.WriteHeader(503)
			io.WriteString(w, "Frontend not built. Run `npm run build` (or use the Vite dev server).")
			return
		}
		w.Header().Set("content-type", "text/html; charset=UTF-8")
		w.Header().Set("cache-control", "no-cache")
		http.ServeFile(w, r, indexPath)
	})
}

// ---------- main ----------

func main() {
	loadEnvFile(".env")
	x.InitSession()
	initAuth()
	mock = os.Getenv("X_MOCK") == "1"
	api = realBackend
	if mock {
		api = mockBackend()
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8787"
	}
	webDir := os.Getenv("WEB_DIR")
	if webDir == "" {
		webDir = filepath.Join("dist", "web")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", handleLogout)
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"authed": authed(r), "mock": mock, "session": mock || x.HasSession()})
	})
	mux.Handle("/api/", apiRoutes())
	mux.Handle("/", staticHandler(webDir))

	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Println("panic:", rec)
				writeJSON(w, 500, map[string]any{"error": "Server error"})
			}
		}()
		if strings.HasPrefix(r.URL.Path, "/api/") {
			gzipped(mux).ServeHTTP(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})

	if !mock && x.HasSession() && os.Getenv("X_REPLAY") == "" {
		go func() {
			if err := x.Warmup(); err != nil {
				log.Println("[meta] warmup failed:", err)
			}
		}()
	}
	suffix := ""
	if mock {
		suffix = " (mock data)"
	}
	log.Printf("litex on http://localhost:%s%s", port, suffix)
	srv := &http.Server{Addr: ":" + port, Handler: root, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
