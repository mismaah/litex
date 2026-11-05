package x

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"litex/xtid"
)

// Scrapes what we need from X's web app: GraphQL query ids and their feature switches
// (main.js + lazy chunks), feature switch values (__INITIAL_STATE__), and the page used to
// build the transaction-id generator. Cached to disk (same file format as the Node server).

type OpMeta struct {
	QueryID  string   `json:"queryId"`
	Features []string `json:"features"`
	Toggles  []string `json:"toggles"`
}

type metaCache struct {
	At       int64             `json:"at"`
	Ops      map[string]OpMeta `json:"ops"`
	Switches map[string]any    `json:"switches"`
}

const (
	refreshEvery = 6 * time.Hour
	assetBase    = "https://abs.twimg.com/responsive-web/client-web/"
)

var (
	opRe        = regexp.MustCompile(`queryId:"([^"]+)",operationName:"([^"]+)",operationType:"[^"]+",metadata:\{(?:featureSwitches:\[([^\]]*)\])?,?(?:fieldToggles:\[([^\]]*)\])?`)
	quotedRe    = regexp.MustCompile(`"([^"]+)"`)
	chunkMapRe  = regexp.MustCompile(`(\d+):"([a-zA-Z0-9~._\-/]+)"`)
	hashRe      = regexp.MustCompile(`^[a-f0-9]{16}$`)
	skipChunkRe = regexp.MustCompile(`^(i18n|emoji|countries|ondemand\.countries)`)
	mainJSRe    = regexp.MustCompile(`https://abs\.twimg\.com/responsive-web/client-web/main\.[a-z0-9]+\.js`)
	grokRe      = regexp.MustCompile(`(?i)grok`)
)

var (
	metaMu         sync.Mutex
	cache          *metaCache
	gen            *xtid.Generator
	genAt          time.Time
	refreshing     chan struct{}
	refreshErr     error
	lastInvalidate time.Time
	httpClient     = &http.Client{Timeout: 30 * time.Second}
)

func cacheFile() string {
	dir := os.Getenv("CACHE_DIR")
	if dir == "" {
		dir = ".cache"
	}
	return filepath.Join(dir, "xmeta.json")
}

func fetchText(url string, withCookies bool) (string, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("user-agent", UA)
	req.Header.Set("accept-language", "en-US,en;q=0.9")
	if withCookies {
		req.Header.Set("cookie", cookieHeader())
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("GET %s -> %d", url, res.StatusCode)
	}
	b, err := io.ReadAll(res.Body)
	return string(b), err
}

func parseInitialState(page string) map[string]any {
	out := map[string]any{}
	const marker = "window.__INITIAL_STATE__="
	start := strings.Index(page, marker)
	if start < 0 {
		return out
	}
	end := strings.Index(page[start:], ";window.__META_DATA__")
	if end < 0 {
		return out
	}
	var state map[string]any
	if json.Unmarshal([]byte(page[start+len(marker):start+end]), &state) != nil {
		return out
	}
	fs := objOr(state["featureSwitch"])
	for _, src := range []any{fs["defaultConfig"], g(fs, "user", "config")} {
		for k, v := range objOr(src) {
			out[k] = g(v, "value")
		}
	}
	return out
}

// Chunk maps in the html look like {12:"bundle.Foo",...} and {12:"abcdef0123456789",...}.
func chunkURLs(page string) []string {
	names := map[string]string{}
	hashes := map[string]string{}
	var order []string
	for _, m := range chunkMapRe.FindAllStringSubmatch(page, -1) {
		if hashRe.MatchString(m[2]) {
			hashes[m[1]] = m[2]
		} else {
			if _, seen := names[m[1]]; !seen {
				order = append(order, m[1])
			}
			names[m[1]] = m[2]
		}
	}
	var urls []string
	for _, id := range order {
		if h, ok := hashes[id]; ok && !skipChunkRe.MatchString(names[id]) {
			urls = append(urls, assetBase+names[id]+"."+h+"a.js")
		}
	}
	return urls
}

func strList(s string) []string {
	out := []string{}
	for _, m := range quotedRe.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

func collectOps(js string, into map[string]OpMeta, mu *sync.Mutex) {
	for _, m := range opRe.FindAllStringSubmatch(js, -1) {
		mu.Lock()
		if _, ok := into[m[2]]; !ok {
			into[m[2]] = OpMeta{QueryID: m[1], Features: strList(m[3]), Toggles: strList(m[4])}
		}
		mu.Unlock()
	}
}

func refresh(full bool) error {
	page, err := fetchText("https://x.com/i/jf/", true)
	if err != nil {
		return err
	}
	g, err := xtid.New(page, func(u string) (string, error) { return fetchText(u, false) })
	if err != nil {
		return err
	}
	metaMu.Lock()
	gen, genAt = g, time.Now()
	if !full && cache != nil {
		cache.Switches = parseInitialState(page)
		metaMu.Unlock()
		return nil
	}
	metaMu.Unlock()

	ops := map[string]OpMeta{}
	var mu sync.Mutex
	// main.js first so its entries win (like the Node server's order).
	if u := mainJSRe.FindString(page); u != "" {
		if js, err := fetchText(u, false); err == nil {
			collectOps(js, ops, &mu)
		}
	}
	urls := chunkURLs(page)
	jobs := make(chan string)
	var wg sync.WaitGroup
	for w := 0; w < 12; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for u := range jobs {
				if js, err := fetchText(u, false); err == nil {
					collectOps(js, ops, &mu)
				}
			}
		}()
	}
	for _, u := range urls {
		jobs <- u
	}
	close(jobs)
	wg.Wait()
	if len(ops) < 20 {
		return errors.New("query id scrape found too few operations")
	}
	c := &metaCache{At: time.Now().UnixMilli(), Ops: ops, Switches: parseInitialState(page)}
	metaMu.Lock()
	cache = c
	metaMu.Unlock()
	if b, err := json.Marshal(c); err == nil {
		_ = os.MkdirAll(filepath.Dir(cacheFile()), 0o755)
		_ = os.WriteFile(cacheFile(), b, 0o644)
	}
	log.Printf("[meta] refreshed: %d operations", len(ops))
	return nil
}

// ensure loads/refreshes metadata. With a usable disk cache + generator, refreshes run in the background.
func ensure() error {
	metaMu.Lock()
	if cache == nil {
		if b, err := os.ReadFile(cacheFile()); err == nil {
			var c metaCache
			if json.Unmarshal(b, &c) == nil && c.Ops != nil {
				cache = &c
			}
		}
	}
	opsStale := cache == nil || time.Since(time.UnixMilli(cache.At)) > refreshEvery
	txStale := gen == nil || time.Since(genAt) > refreshEvery
	if !opsStale && !txStale {
		metaMu.Unlock()
		return nil
	}
	wait := cache == nil || gen == nil
	ch := refreshing
	if ch == nil {
		ch = make(chan struct{})
		refreshing = ch
		go func(full bool) {
			err := refresh(full)
			metaMu.Lock()
			refreshErr = err
			refreshing = nil
			metaMu.Unlock()
			if err != nil {
				log.Println("[meta] refresh failed:", err)
			}
			close(ch)
		}(opsStale)
	}
	metaMu.Unlock()
	if wait {
		<-ch
		metaMu.Lock()
		defer metaMu.Unlock()
		if cache == nil || gen == nil {
			if refreshErr != nil {
				return refreshErr
			}
			return errors.New("X metadata unavailable")
		}
	}
	return nil
}

// Invalidate forces a re-scrape (after X rejects a query id). Throttled; false if skipped.
func Invalidate() bool {
	metaMu.Lock()
	if time.Since(lastInvalidate) < 10*time.Minute {
		metaMu.Unlock()
		return false
	}
	lastInvalidate = time.Now()
	if cache != nil {
		cache.At = 0
	}
	metaMu.Unlock()
	return ensure() == nil
}

// Op returns the query id, feature flags and field toggles for an operation.
func Op(name string) (string, *OrderedBools, *OrderedBools, error) {
	if err := ensure(); err != nil {
		return "", nil, nil, err
	}
	metaMu.Lock()
	defer metaMu.Unlock()
	m, ok := cache.Ops[name]
	if !ok {
		return "", nil, nil, fmt.Errorf("unknown X operation %s", name)
	}
	features := &OrderedBools{}
	for _, f := range m.Features {
		v, isBool := cache.Switches[f].(bool)
		features.Set(f, !grokRe.MatchString(f) && isBool && v)
	}
	toggles := &OrderedBools{}
	for _, t := range m.Toggles {
		toggles.Set(t, false)
	}
	return m.QueryID, features, toggles, nil
}

// TransactionID makes an x-client-transaction-id for method + URL path.
func TransactionID(method, path string) (string, error) {
	if err := ensure(); err != nil {
		return "", err
	}
	metaMu.Lock()
	g := gen
	metaMu.Unlock()
	return g.Generate(method, path), nil
}

func Warmup() error { return ensure() }

// OrderedBools is a JSON object that keeps insertion order (X's web client sends features in order).
type OrderedBools struct {
	keys []string
	vals map[string]bool
}

func (o *OrderedBools) Set(k string, v bool) {
	if o.vals == nil {
		o.vals = map[string]bool{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *OrderedBools) Len() int { return len(o.keys) }

func (o *OrderedBools) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		b.Write(kb)
		if o.vals[k] {
			b.WriteString(":true")
		} else {
			b.WriteString(":false")
		}
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}
