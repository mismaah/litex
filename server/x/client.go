package x

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// XError carries the HTTP status litex should answer with.
type XError struct {
	Msg    string
	Status int
	Code   *float64
	Reset  *float64
}

func (e *XError) Error() string { return e.Msg }

func xerr(msg string, status int) *XError { return &XError{Msg: msg, Status: status} }

// NewError builds an XError (used for request validation in the HTTP layer).
func NewError(msg string, status int) *XError { return xerr(msg, status) }

// ---- Dev/test: record real X responses (X_RECORD=dir) or replay them (X_REPLAY=dir). ----
// Same file naming as the Node server (operation + sha1 of canonical args), so recordings are shared.

var (
	recordDir = func() string { return os.Getenv("X_RECORD") }
	replayDir = func() string { return os.Getenv("X_REPLAY") }
	nonWord   = regexp.MustCompile(`[^\w]`)
)

// canon serializes like JS JSON.stringify with sorted object keys (and no HTML escaping).
func canon(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, jsonString(k)+":"+canon(t[k]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case map[string]string:
		m := map[string]any{}
		for k, v := range t {
			m[k] = v
		}
		return canon(m)
	case []any:
		parts := make([]string, len(t))
		for i, x := range t {
			parts[i] = canon(x)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case []map[string]any:
		parts := make([]string, len(t))
		for i, x := range t {
			parts[i] = canon(x)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case string:
		return jsonString(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func jsonString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(buf.String(), "\n")
}

func fixtureFile(dir, name string, args any) string {
	sum := sha1.Sum([]byte(canon(args)))
	return filepath.Join(dir, nonWord.ReplaceAllString(name, "_")+"__"+hex.EncodeToString(sum[:])[:12]+".json")
}

func replayed(name string, args any) (any, error) {
	b, err := os.ReadFile(fixtureFile(replayDir(), name, args))
	if err != nil {
		return nil, xerr("no recording for "+name+" "+canon(args), 502)
	}
	var v any
	return v, json.Unmarshal(b, &v)
}

func recorded(name string, args any, data any) {
	dir := recordDir()
	if dir == "" {
		return
	}
	f := fixtureFile(dir, name, args)
	_ = os.MkdirAll(dir, 0o755)
	if _, err := os.Stat(f); err == nil {
		return // first response wins
	}
	if b, err := json.Marshal(data); err == nil {
		_ = os.WriteFile(f, b, 0o644)
	}
}

// ---- requests ----

var apiClient = &http.Client{Timeout: 45 * time.Second}

func send(method string, u *url.URL, body io.Reader, extra map[string]string) (any, error) {
	if !HasSession() {
		return nil, xerr("X session not configured: set X_AUTH_TOKEN and X_CT0", 503)
	}
	tid, err := TransactionID(method, u.EscapedPath())
	if err != nil {
		return nil, xerr("X metadata unavailable: "+err.Error(), 502)
	}
	req, err := http.NewRequest(method, u.String(), body)
	if err != nil {
		return nil, err
	}
	h := map[string]string{
		"authorization":             "Bearer " + Bearer,
		"x-csrf-token":              csrf(),
		"cookie":                    cookieHeader(),
		"x-twitter-auth-type":       "OAuth2Session",
		"x-twitter-active-user":     "yes",
		"x-twitter-client-language": "en",
		"x-client-transaction-id":   tid,
		"user-agent":                UA,
		"origin":                    "https://x.com",
		"referer":                   "https://x.com/",
		"accept-language":           "en-US,en;q=0.9",
	}
	for k, v := range extra {
		h[k] = v
	}
	for k, v := range h {
		req.Header.Set(k, v)
	}
	res, err := apiClient.Do(req)
	if err != nil {
		return nil, xerr("Could not reach X: "+err.Error(), 502)
	}
	defer res.Body.Close()
	absorbCookies(res)
	raw, _ := io.ReadAll(res.Body)
	var j any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &j)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var code *float64
		var msg string
		if errs := arr(g(j, "errors")); len(errs) > 0 {
			if c, ok := g(errs[0], "code").(float64); ok {
				code = &c
			}
			msg = sv(errs[0], "message")
		}
		switch res.StatusCode {
		case 429:
			e := &XError{Msg: "Rate limited by X. Try again in a few minutes.", Status: 429, Code: ptr(88.0)}
			if r, err := strconv.ParseFloat(res.Header.Get("x-rate-limit-reset"), 64); err == nil && r != 0 {
				e.Reset = &r
			}
			return nil, e
		case 401:
			return nil, &XError{Msg: "X session rejected (401). Your cookies may be expired.", Status: 401, Code: code}
		}
		if msg == "" {
			msg = fmt.Sprintf("X returned HTTP %d", res.StatusCode)
		}
		status := res.StatusCode
		if status >= 500 {
			status = 502
		}
		return nil, &XError{Msg: msg, Status: status, Code: code}
	}
	// GraphQL often returns 200 with errors and no data.
	if errs := arr(g(j, "errors")); len(errs) > 0 && g(j, "data") == nil {
		e := errs[0]
		msg := sv(e, "message")
		if msg == "" {
			msg = "X error"
		}
		status := 502
		c, hasCode := g(e, "code").(float64)
		if hasCode && c == 144 {
			status = 404
		}
		xe := &XError{Msg: msg, Status: status}
		if hasCode {
			xe.Code = &c
		}
		return nil, xe
	}
	return j, nil
}

const gqlBase = "https://x.com/i/api/graphql/"

var (
	preferredMu sync.Mutex
	// X has moved operations between GET and POST before; remember what worked.
	preferred = map[string]string{}
)

func notFound(err error) bool {
	var xe *XError
	return errors.As(err, &xe) && xe.Status == 404 && (xe.Code == nil || *xe.Code != 144)
}

// Vars is a GraphQL variables object; nil values are dropped (like JS undefined).
type Vars map[string]any

func (v Vars) clean() map[string]any {
	out := map[string]any{}
	for k, x := range v {
		if x != nil {
			out[k] = x
		}
	}
	return out
}

func gqlOnce(name string, vars map[string]any, method string) (any, error) {
	qid, features, toggles, err := Op(name)
	if err != nil {
		return nil, xerr(err.Error(), 502)
	}
	u, _ := url.Parse(gqlBase + qid + "/" + name)
	vb, _ := json.Marshal(vars)
	fb, _ := json.Marshal(features)
	if method == "GET" {
		q := url.Values{}
		q.Set("variables", string(vb))
		q.Set("features", string(fb))
		if toggles.Len() > 0 {
			tb, _ := json.Marshal(toggles)
			q.Set("fieldToggles", string(tb))
		}
		u.RawQuery = q.Encode()
		return send("GET", u, nil, nil)
	}
	body := map[string]any{"variables": vars, "features": features, "queryId": qid}
	if toggles.Len() > 0 {
		body["fieldToggles"] = toggles
	}
	bb, _ := json.Marshal(body)
	return send("POST", u, bytes.NewReader(bb), map[string]string{"content-type": "application/json"})
}

// GQL calls a GraphQL operation. On 404 tries the other HTTP method, then re-scrapes query ids once.
func GQL(name string, v Vars, method string) (any, error) {
	vars := v.clean()
	if replayDir() != "" {
		return replayed(name, vars)
	}
	data, err := gqlLive(name, vars, method)
	if err == nil {
		recorded(name, vars, data)
	}
	return data, err
}

func gqlLive(name string, vars map[string]any, method string) (any, error) {
	preferredMu.Lock()
	first := method
	if p, ok := preferred[name]; ok {
		first = p
	}
	preferredMu.Unlock()
	r, err := gqlOnce(name, vars, first)
	if err == nil || !notFound(err) {
		return r, err
	}
	alt := "GET"
	if first == "GET" {
		alt = "POST"
	}
	r, err = gqlOnce(name, vars, alt)
	if err == nil {
		preferredMu.Lock()
		preferred[name] = alt
		preferredMu.Unlock()
		return r, nil
	}
	if !notFound(err) {
		return nil, err
	}
	if Invalidate() {
		return gqlOnce(name, vars, first)
	}
	return nil, xerr("X rejected "+name+" (404). Query ids may be stale; restart the server to re-scrape.", 502)
}

// RestForm is a REST v1.1 form POST (follow/unfollow etc.).
func RestForm(path string, form url.Values) (any, error) {
	if replayDir() != "" {
		return map[string]any{}, nil
	}
	u, _ := url.Parse("https://x.com/i/api/1.1/" + path)
	return send("POST", u, strings.NewReader(form.Encode()), map[string]string{"content-type": "application/x-www-form-urlencoded"})
}

func RestGet(path string, params map[string]string) (any, error) {
	args := map[string]any{}
	for k, v := range params {
		args[k] = v
	}
	if replayDir() != "" {
		return replayed("rest:"+path, args)
	}
	u, _ := url.Parse("https://x.com/i/api/1.1/" + path)
	q := url.Values{}
	for k, v := range params {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	data, err := send("GET", u, nil, nil)
	if err == nil {
		recorded("rest:"+path, args, data)
	}
	return data, err
}

// UploadImage does the simple (non-chunked) upload: INIT -> APPEND -> FINALIZE.
func UploadImage(data []byte, mime string) (string, error) {
	const base = "https://upload.x.com/i/media/upload.json"
	withQuery := func(q url.Values) *url.URL {
		u, _ := url.Parse(base)
		u.RawQuery = q.Encode()
		return u
	}
	cat := "tweet_image"
	if mime == "image/gif" {
		cat = "tweet_gif"
	}
	r, err := send("POST", withQuery(url.Values{"command": {"INIT"}, "total_bytes": {strconv.Itoa(len(data))}, "media_type": {mime}, "media_category": {cat}}), nil, nil)
	if err != nil {
		return "", err
	}
	id := sv(r, "media_id_string")

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, _ := mw.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="media"; filename="blob"`},
		"Content-Type":        {mime},
	})
	_, _ = part.Write(data)
	_ = mw.Close()
	if _, err := send("POST", withQuery(url.Values{"command": {"APPEND"}, "media_id": {id}, "segment_index": {"0"}}), &buf, map[string]string{"content-type": mw.FormDataContentType()}); err != nil {
		return "", err
	}

	r, err = send("POST", withQuery(url.Values{"command": {"FINALIZE"}, "media_id": {id}}), nil, nil)
	if err != nil {
		return "", err
	}
	// GIFs may need async processing.
	info := g(r, "processing_info")
	for st := sv(info, "state"); st == "pending" || st == "in_progress"; st = sv(info, "state") {
		wait := num(g(info, "check_after_secs"))
		if wait <= 0 {
			wait = 1
		}
		time.Sleep(time.Duration(min(5, wait)) * time.Second)
		r, err = send("GET", withQuery(url.Values{"command": {"STATUS"}, "media_id": {id}}), nil, nil)
		if err != nil {
			return "", err
		}
		info = g(r, "processing_info")
	}
	if sv(info, "state") == "failed" {
		return "", xerr("Media processing failed", 422)
	}
	return id, nil
}
