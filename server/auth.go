package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Single-password gate. A signed, expiring cookie marks a logged-in browser
// (same cookie format as the Node server, so existing sessions stay valid).

const (
	sessionCookie = "litex_s"
	sessionMaxAge = 60 * 60 * 24 * 60 // 60 days
)

var (
	password string
	secret   []byte
	openAPI  bool // no password: only allowed in mock mode or with NO_AUTH=1 (local use)
)

func initAuth() {
	password = os.Getenv("APP_PASSWORD")
	if s := os.Getenv("SESSION_SECRET"); s != "" {
		secret = []byte(s)
	} else {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		secret = []byte(hex.EncodeToString(b))
		log.Println("[auth] SESSION_SECRET not set; sessions reset on restart")
	}
	openAPI = password == "" && (os.Getenv("X_MOCK") == "1" || os.Getenv("NO_AUTH") == "1")
	if password == "" {
		if openAPI {
			log.Println("[auth] no APP_PASSWORD: API is open (local use only)")
		} else {
			log.Println("[auth] APP_PASSWORD not set: nobody can log in")
		}
	}
}

func sign(v string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(v))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func validToken(tok string) bool {
	exp, sig, ok := strings.Cut(tok, ".")
	if !ok || exp == "" || sig == "" {
		return false
	}
	e, err := strconv.ParseFloat(exp, 64)
	if err != nil || e < float64(time.Now().Unix()) {
		return false
	}
	return hmac.Equal([]byte(sig), []byte(sign(exp)))
}

func authed(r *http.Request) bool {
	if openAPI {
		return true
	}
	c, err := r.Cookie(sessionCookie)
	return err == nil && validToken(c.Value)
}

// Login attempts per IP: max 8 failures per 15 minutes.
var (
	failMu sync.Mutex
	fails  = map[string]struct {
		n  int
		at time.Time
	}{}
)

// clientIP: behind Cloudflare (Tunnel), cf-connecting-ip is the real client address.
func clientIP(r *http.Request) string {
	if v := r.Header.Get("cf-connecting-ip"); v != "" {
		return v
	}
	if v := r.Header.Get("x-forwarded-for"); v != "" {
		first, _, _ := strings.Cut(v, ",")
		return strings.TrimSpace(first)
	}
	if v := r.Header.Get("x-real-ip"); v != "" {
		return v
	}
	return "local"
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	key := clientIP(r)
	failMu.Lock()
	f := fails[key]
	recent := time.Since(f.at) < 15*time.Minute
	failMu.Unlock()
	if recent && f.n >= 8 {
		writeJSON(w, 429, map[string]any{"error": "Too many attempts. Try later."})
		return
	}
	var body struct {
		Password any `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	got, _ := body.Password.(string)
	if password == "" || len(got) != len(password) || subtle.ConstantTimeCompare([]byte(got), []byte(password)) != 1 {
		failMu.Lock()
		n := 0
		if recent {
			n = f.n
		}
		fails[key] = struct {
			n  int
			at time.Time
		}{n + 1, time.Now()}
		failMu.Unlock()
		writeJSON(w, 401, map[string]any{"error": "Wrong password"})
		return
	}
	failMu.Lock()
	delete(fails, key)
	failMu.Unlock()
	exp := strconv.FormatInt(time.Now().Unix()+sessionMaxAge, 10)
	secure := r.Header.Get("x-forwarded-proto") == "https" || r.TLS != nil || os.Getenv("COOKIE_SECURE") == "1"
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: exp + "." + sign(exp), HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure, Path: "/", MaxAge: sessionMaxAge})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// requireAuth guards /api/*. Writes also need the x-litex header: a cheap CSRF guard, since
// browsers can't send custom headers cross-site without CORS.
func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			writeJSON(w, 401, map[string]any{"error": "auth"})
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("x-litex") != "1" {
			writeJSON(w, 400, map[string]any{"error": "bad request"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
