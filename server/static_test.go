package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The PWA files must be served without a session cookie and with the types Chrome expects,
// otherwise Android only offers "Add to Home screen" (a shortcut) instead of installing.
func TestStaticPWAFiles(t *testing.T) {
	pub := filepath.Join("..", "web", "public")
	h := staticHandler(pub)
	cases := map[string]string{
		"/manifest.webmanifest":  "application/manifest+json",
		"/sw.js":                 "text/javascript; charset=utf-8",
		"/icon-192.png":          "image/png",
		"/icon-512.png":          "image/png",
		"/icon-maskable-512.png": "image/png",
	}
	for p, ct := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != 200 {
			t.Errorf("%s: status %d", p, rec.Code)
		}
		if got := rec.Header().Get("content-type"); got != ct {
			t.Errorf("%s: content-type %q, want %q", p, got, ct)
		}
	}

	// Every icon in the manifest must exist, and there must be installable PNGs.
	data, err := os.ReadFile(filepath.Join(pub, "manifest.webmanifest"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Display string
		Icons   []struct{ Src, Sizes, Type, Purpose string }
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if m.Display != "standalone" {
		t.Errorf("display %q", m.Display)
	}
	have := map[string]bool{}
	for _, ic := range m.Icons {
		if _, err := os.Stat(filepath.Join(pub, filepath.FromSlash(ic.Src))); err != nil {
			t.Errorf("icon %s missing: %v", ic.Src, err)
		}
		if ic.Type == "image/png" {
			have[ic.Sizes+" "+ic.Purpose] = true
		}
	}
	for _, want := range []string{"192x192 any", "512x512 any", "512x512 maskable"} {
		if !have[want] {
			t.Errorf("manifest has no PNG icon %q", want)
		}
	}
}
