package x

import (
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
)

// The X session we act as. Cookies come from env; ct0 may be rotated by X via set-cookie.
const (
	UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	Bearer = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

var (
	jarMu sync.RWMutex
	jar   = map[string]string{}
	// Cookie order for the header (auth_token, ct0 first, like the Node server).
	jarOrder = []string{}
)

// InitSession loads cookies from the environment. Call after env is loaded.
func InitSession() {
	jarMu.Lock()
	defer jarMu.Unlock()
	jar = map[string]string{}
	jarOrder = nil
	if v := strings.TrimSpace(os.Getenv("X_AUTH_TOKEN")); v != "" {
		setCookie("auth_token", v)
	}
	if v := strings.TrimSpace(os.Getenv("X_CT0")); v != "" {
		setCookie("ct0", v)
	}
}

func setCookie(k, v string) {
	if _, ok := jar[k]; !ok {
		jarOrder = append(jarOrder, k)
	}
	jar[k] = v
}

func HasSession() bool {
	jarMu.RLock()
	defer jarMu.RUnlock()
	return jar["auth_token"] != "" && jar["ct0"] != ""
}

func csrf() string {
	jarMu.RLock()
	defer jarMu.RUnlock()
	return jar["ct0"]
}

func cookieHeader() string {
	jarMu.RLock()
	defer jarMu.RUnlock()
	parts := make([]string, 0, len(jarOrder))
	for _, k := range jarOrder {
		parts = append(parts, k+"="+jar[k])
	}
	return strings.Join(parts, "; ")
}

var keepCookies = map[string]bool{"ct0": true, "auth_token": true, "twid": true, "kdt": true, "att": true, "guest_id": true}

// absorbCookies keeps cookies X hands back (notably a rotated ct0) so the session stays valid.
func absorbCookies(res *http.Response) {
	jarMu.Lock()
	defer jarMu.Unlock()
	for _, c := range res.Header.Values("Set-Cookie") {
		pair, _, _ := strings.Cut(c, ";")
		k, v, ok := strings.Cut(pair, "=")
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if !ok || !keepCookies[k] || v == "" || strings.Contains(strings.ToLower(c), "expires=thu, 01 jan 1970") {
			continue
		}
		if k == "ct0" && jar["ct0"] != v {
			log.Println("[session] ct0 rotated")
		}
		setCookie(k, v)
	}
}
