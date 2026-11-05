// Package xtid generates X's x-client-transaction-id header.
//
// It is a Go port of the x-client-transaction-id JS library (v0.3.2): the
// verification key and loading-animation SVG on X's web app page, plus indices
// from the "ondemand.s" script, are turned into an "animation key"; each ID is
// then keyBytes + time + sha256(method!path!time+keyword+animationKey), XORed
// with a random byte and base64-encoded. JS number semantics (Math.round,
// float-to-hex) are reproduced exactly so output matches the library.
package xtid

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	keyword          = "obfiowerehiring"
	additionalRandom = 3
	totalTime        = 4096.0
	epochOffset      = 1682924400
	onDemandChunk    = "ondemand.s"
)

var (
	indicesRe    = regexp.MustCompile(`\(\w\[(\d{1,2})\],\s*16\)`)
	onDemandIDRe = regexp.MustCompile(`(\d+):\s*["']ondemand\.s["']`)
	// The JS regex uses a backreference (RE2 has none), so it is matched in steps:
	// "<id>:'ondemand.s'" ... "})[e]||e)+'.'+({" ... "<id>:'<hash>'".
	onDemandSepRe = regexp.MustCompile(`\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{`)
)

// Generator holds the per-page state needed to make IDs.
type Generator struct {
	KeyBytes     []byte
	AnimationKey string
	RowIndex     int
	KeyIndices   []int
}

// FetchFunc downloads a URL (the ondemand.s script).
type FetchFunc func(url string) (string, error)

// DefaultFetch is a plain GET.
func DefaultFetch(url string) (string, error) {
	res, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s -> %d", url, res.StatusCode)
	}
	b, err := io.ReadAll(res.Body)
	return string(b), err
}

// New builds a generator from the HTML of X's web app page (e.g. https://x.com/i/jf/).
func New(pageHTML string, fetch FetchFunc) (*Generator, error) {
	if fetch == nil {
		fetch = DefaultFetch
	}
	doc, err := html.Parse(strings.NewReader(pageHTML))
	if err != nil {
		return nil, err
	}

	// Indices from the ondemand.s chunk.
	url, err := onDemandURL(doc, pageHTML)
	if err != nil {
		return nil, err
	}
	src, err := fetch(url)
	if err != nil {
		return nil, fmt.Errorf("ondemand file: %w", err)
	}
	var idx []int
	for _, m := range indicesRe.FindAllStringSubmatch(src, -1) {
		n, _ := strconv.Atoi(m[1])
		idx = append(idx, n)
	}
	if len(idx) == 0 {
		return nil, errors.New("xtid: no key byte indices in ondemand file")
	}

	// Verification key.
	key := ""
	if el := find(doc, func(n *html.Node) bool { return attr(n, "name") == "twitter-site-verification" }); el != nil {
		key = attr(el, "content")
	}
	if key == "" {
		return nil, errors.New("xtid: site verification key not found")
	}
	keyBytes, err := decodeBase64(key)
	if err != nil {
		return nil, fmt.Errorf("xtid: bad verification key: %w", err)
	}

	g := &Generator{KeyBytes: keyBytes, RowIndex: idx[0], KeyIndices: idx[1:]}
	g.AnimationKey, err = g.animationKey(doc)
	if err != nil {
		return nil, err
	}
	return g, nil
}

// Generate makes a transaction ID for a request (path is the URL path, e.g. /i/api/graphql/x/Op).
func (g *Generator) Generate(method, path string) string {
	return g.GenerateAt(method, path, int64(math.Floor(float64(time.Now().UnixMilli()-epochOffset*1000)/1000)), byte(rand.IntN(256)))
}

// GenerateAt is Generate with the time (seconds since X's epoch) and random byte supplied.
func (g *Generator) GenerateAt(method, path string, timeNow int64, random byte) string {
	t := uint32(timeNow) // JS uses 32-bit bitwise ops on it
	timeBytes := []byte{byte(t), byte(t >> 8), byte(t >> 16), byte(t >> 24)}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s!%s!%d%s%s", method, path, timeNow, keyword, g.AnimationKey)))

	arr := make([]byte, 0, len(g.KeyBytes)+4+16+1)
	arr = append(arr, g.KeyBytes...)
	arr = append(arr, timeBytes...)
	arr = append(arr, sum[:16]...)
	arr = append(arr, additionalRandom)
	out := make([]byte, 0, len(arr)+1)
	out = append(out, random)
	for _, b := range arr {
		out = append(out, b^random)
	}
	return strings.TrimRight(base64.StdEncoding.EncodeToString(out), "=")
}

// ---- page parsing ----

func onDemandURL(doc *html.Node, pageHTML string) (string, error) {
	var sources []string
	walk(doc, func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "script" {
			if t := textContent(n); strings.Contains(t, onDemandChunk) {
				sources = append(sources, t)
			}
		}
	})
	sources = append(sources, pageHTML)
	for _, s := range sources {
		if hash := onDemandHash(s); hash != "" {
			return "https://abs.twimg.com/responsive-web/client-web/" + onDemandChunk + "." + hash + "a.js", nil
		}
	}
	return "", errors.New("xtid: could not resolve ondemand.s URL")
}

func onDemandHash(src string) string {
	for _, m := range onDemandIDRe.FindAllStringSubmatchIndex(src, -1) {
		id := src[m[2]:m[3]]
		rest := src[m[1]:]
		hashRe := regexp.MustCompile(`\b` + id + `:\s*["']([a-zA-Z0-9_-]+)["']`)
		for _, sep := range onDemandSepRe.FindAllStringIndex(rest, -1) {
			if h := hashRe.FindStringSubmatch(rest[sep[1]:]); h != nil {
				return h[1]
			}
		}
	}
	return ""
}

func (g *Generator) animationKey(doc *html.Node) (string, error) {
	kb := g.KeyBytes
	at := func(i int) int {
		if i < 0 || i >= len(kb) {
			return 0 // JS: undefined % 16 -> NaN; never happens with real keys
		}
		return int(kb[i])
	}
	rowIndex := at(g.RowIndex) % 16
	frameTime := 1.0
	for _, i := range g.KeyIndices {
		frameTime *= float64(at(i) % 16)
	}
	frameTime = jsRound(frameTime/10) * 10

	arr := frames2D(doc, kb)
	if rowIndex >= len(arr) || arr[rowIndex] == nil {
		return "", fmt.Errorf("xtid: no animation frame data for row %d", rowIndex)
	}
	return animate(arr[rowIndex], frameTime/totalTime), nil
}

// frames2D reads the "d" path of the chosen loading-x-anim frame into rows of integers.
func frames2D(doc *html.Node, kb []byte) [][]int {
	var frames []*html.Node
	walk(doc, func(n *html.Node) {
		if n.Type == html.ElementNode && strings.HasPrefix(attr(n, "id"), "loading-x-anim") {
			frames = append(frames, n)
		}
	})
	if len(frames) == 0 || len(kb) < 6 {
		return [][]int{{}}
	}
	frame := frames[int(kb[5])%4%len(frames)]
	first := elementChild(frame, 0)
	target := elementChild(first, 1)
	if target == nil {
		return nil
	}
	d, ok := attrOK(target, "d")
	if !ok {
		return nil
	}
	if len(d) > 9 {
		d = d[9:]
	} else {
		d = ""
	}
	nonDigits := regexp.MustCompile(`[^\d]+`)
	var out [][]int
	for _, item := range strings.Split(d, "C") {
		cleaned := strings.TrimSpace(nonDigits.ReplaceAllString(item, " "))
		row := []int{}
		if cleaned != "" {
			for _, p := range strings.Fields(cleaned) {
				n, _ := strconv.Atoi(p)
				row = append(row, n)
			}
		}
		out = append(out, row)
	}
	return out
}

// ---- animation math (mirrors cubic.js / interpolate.js / rotation.js / transaction.js) ----

func solve(value, minVal, maxVal float64, rounding bool) float64 {
	r := value*(maxVal-minVal)/255 + minVal
	if rounding {
		return math.Floor(r)
	}
	return jsRound(r*100) / 100
}

func isOdd(n int) float64 {
	if n%2 != 0 {
		return -1.0
	}
	return 0.0
}

func animate(frames []int, targetTime float64) string {
	f := func(i int) float64 {
		if i < len(frames) {
			return float64(frames[i])
		}
		return math.NaN()
	}
	fromColor := []float64{f(0), f(1), f(2), 1}
	toColor := []float64{f(3), f(4), f(5), 1}
	toRotation := solve(f(6), 60.0, 360.0, true)
	var curves []float64
	for i := 7; i < len(frames); i++ {
		curves = append(curves, solve(float64(frames[i]), isOdd(i-7), 1.0, false))
	}
	val := cubicValue(curves, targetTime)

	color := make([]float64, len(fromColor))
	for i := range fromColor {
		c := fromColor[i]*(1-val) + toColor[i]*val
		if !(c > 0) {
			c = 0
		}
		color[i] = c
	}
	rotation := 0.0*(1-val) + toRotation*val
	rad := rotation * math.Pi / 180
	matrix := []float64{math.Cos(rad), -math.Sin(rad), math.Sin(rad), math.Cos(rad)}

	var parts []string
	for _, c := range color[:len(color)-1] {
		parts = append(parts, strconv.FormatInt(int64(jsRound(c)), 16))
	}
	for _, v := range matrix {
		r := jsRound(v*100) / 100
		if r < 0 {
			r = -r
		}
		h := floatToHex(r)
		if strings.HasPrefix(h, ".") {
			parts = append(parts, strings.ToLower("0"+h))
		} else if h == "" {
			parts = append(parts, "0")
		} else {
			parts = append(parts, h)
		}
	}
	parts = append(parts, "0", "0")
	return strings.NewReplacer(".", "", "-", "").Replace(strings.Join(parts, ""))
}

func cubicCalc(a, b, m float64) float64 {
	return 3.0*a*(1-m)*(1-m)*m + 3.0*b*(1-m)*m*m + m*m*m
}

func cubicValue(c []float64, t float64) float64 {
	at := func(i int) float64 {
		if i < len(c) {
			return c[i]
		}
		return math.NaN()
	}
	if t <= 0.0 {
		g := 0.0
		if at(0) > 0.0 {
			g = at(1) / at(0)
		} else if at(1) == 0.0 && at(2) > 0.0 {
			g = at(3) / at(2)
		}
		return g * t
	}
	if t >= 1.0 {
		g := 0.0
		if at(2) < 1.0 {
			g = (at(3) - 1.0) / (at(2) - 1.0)
		} else if at(2) == 1.0 && at(0) < 1.0 {
			g = (at(1) - 1.0) / (at(0) - 1.0)
		}
		return 1.0 + g*(t-1.0)
	}
	start, mid, end := 0.0, 0.0, 1.0
	for start < end {
		mid = (start + end) / 2
		x := cubicCalc(at(0), at(2), mid)
		if math.Abs(t-x) < 0.00001 {
			return cubicCalc(at(1), at(3), mid)
		}
		if x < t {
			start = mid
		} else {
			end = mid
		}
	}
	return cubicCalc(at(1), at(3), mid)
}

// floatToHex mirrors utils.js floatToHex (uppercase digits, fractional part after ".").
func floatToHex(x float64) string {
	var result []string
	quotient := math.Floor(x)
	fraction := x - quotient
	for quotient > 0 {
		quotient = math.Floor(x / 16)
		rem := int(math.Floor(x - quotient*16))
		result = append([]string{hexDigit(rem)}, result...)
		x = quotient
	}
	if fraction == 0 {
		return strings.Join(result, "")
	}
	result = append(result, ".")
	for fraction > 0 {
		fraction *= 16
		integer := math.Floor(fraction)
		fraction -= integer
		result = append(result, hexDigit(int(integer)))
	}
	return strings.Join(result, "")
}

func hexDigit(n int) string {
	if n > 9 {
		return string(rune(n + 55))
	}
	return strconv.Itoa(n)
}

// jsRound is JavaScript's Math.round: halves round toward +Infinity.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

func decodeBase64(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

// ---- tiny DOM helpers ----

func walk(n *html.Node, fn func(*html.Node)) {
	fn(n)
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walk(c, fn)
	}
}

func find(n *html.Node, pred func(*html.Node) bool) *html.Node {
	var hit *html.Node
	walk(n, func(x *html.Node) {
		if hit == nil && x.Type == html.ElementNode && pred(x) {
			hit = x
		}
	})
	return hit
}

func attrOK(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}

func attr(n *html.Node, key string) string {
	v, _ := attrOK(n, key)
	return v
}

func elementChild(n *html.Node, i int) *html.Node {
	if n == nil {
		return nil
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode {
			if i == 0 {
				return c
			}
			i--
		}
	}
	return nil
}

func textContent(n *html.Node) string {
	var b strings.Builder
	walk(n, func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
	})
	return b.String()
}
