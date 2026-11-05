package xtid

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// Parity with the JS library: testdata/ holds a logged-out X page, its ondemand.s script, and the
// JS library's output for that page (regenerate with `npm run xtid:fixture`). XTID_FIXTURE can
// point at another directory with the same files.
func TestMatchesJSLibrary(t *testing.T) {
	dir := os.Getenv("XTID_FIXTURE")
	if dir == "" {
		dir = "testdata"
	}
	page, err := os.ReadFile(filepath.Join(dir, "page.html"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	fetch := DefaultFetch
	if od, err := os.ReadFile(filepath.Join(dir, "ondemand.js")); err == nil {
		fetch = func(string) (string, error) { return string(od), nil }
	}
	var want struct {
		RowIndex     int    `json:"rowIndex"`
		KeyIndices   []int  `json:"keyIndices"`
		KeyBytes     []int  `json:"keyBytes"`
		AnimationKey string `json:"animationKey"`
		Cases        []struct {
			Method, Path, ID string
			Time             int64
			Rnd              int
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	g, err := New(string(page), fetch)
	if err != nil {
		t.Fatal(err)
	}
	if g.RowIndex != want.RowIndex || !slices.Equal(g.KeyIndices, want.KeyIndices) {
		t.Fatalf("indices: got %d %v, want %d %v", g.RowIndex, g.KeyIndices, want.RowIndex, want.KeyIndices)
	}
	kb := make([]int, len(g.KeyBytes))
	for i, b := range g.KeyBytes {
		kb[i] = int(b)
	}
	if !slices.Equal(kb, want.KeyBytes) {
		t.Fatalf("key bytes differ")
	}
	if g.AnimationKey != want.AnimationKey {
		t.Fatalf("animation key: got %q, want %q", g.AnimationKey, want.AnimationKey)
	}
	for _, c := range want.Cases {
		if got := g.GenerateAt(c.Method, c.Path, c.Time, byte(c.Rnd)); got != c.ID {
			t.Errorf("%s %s t=%d r=%d: got %s, want %s", c.Method, c.Path, c.Time, c.Rnd, got, c.ID)
		}
	}
	t.Logf("matched animation key %s and %d transaction ids", g.AnimationKey, len(want.Cases))
}

func TestFloatToHexAndRound(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want string
	}{{0, ""}, {1, "1"}, {0.5, ".8"}, {255, "FF"}, {0.01, ".028F5C28F5C28F6"}} {
		if got := floatToHex(c.in); got != c.want {
			t.Errorf("floatToHex(%v) = %q, want %q", c.in, got, c.want)
		}
	}
	for _, c := range [][2]float64{{2.5, 3}, {-2.5, -2}, {0.49, 0}, {-0.5, -0}} {
		if got := jsRound(c[0]); got != c[1] {
			t.Errorf("jsRound(%v) = %v, want %v", c[0], got, c[1])
		}
	}
}
