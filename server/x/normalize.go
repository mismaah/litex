package x

import (
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// Normalization of X's GraphQL payloads (port of server/x/normalize.ts). Raw JSON is decoded
// into map[string]any; the helpers below give JS-like access (?. ?? ||) to keep the port 1:1.

var (
	junkEntry    = regexp.MustCompile(`(?i)^(promoted|who-to-follow|who-to-subscribe|connect-module|superhero|messageprompt|community|grok|tweetdetailrelatedtweets|related|topics?-|list-to-follow|stories|premium|subscribe|creator|label|ad-|bookmark-folder|pinned-timelines|explore-grok|spaces|events?-)`)
	junkNotifURL = regexp.MustCompile(`/i/(premium|verified|grok|communities|money|subscriptions|monetization|account_analytics|jobs)`)
	junkModule   = regexp.MustCompile(`(?i)who to follow|subscribe|premium|grok|communit`)
	mentionRe    = regexp.MustCompile(`(^|[^\w@])@(\w{1,15})`)
	hashtagRe    = regexp.MustCompile(`(^|[^\w#])#(\w+)`)
	pollRe       = regexp.MustCompile(`^poll(\d)choice`)
	queryRe      = regexp.MustCompile(`[?&]query=([^&]+)`)
	xHostRe      = regexp.MustCompile(`(^|\.)(x|twitter)\.com$`)
	appPathRe    = regexp.MustCompile(`^/(\w{1,15}(/status/\d+)?|i/lists/\d+)/?$`)
	digitsRe     = regexp.MustCompile(`^\d+$`)
)

// ---------- JS-like access helpers ----------

// g walks object keys (like a?.b?.c); missing steps give nil.
func g(v any, keys ...string) any {
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

func gs(v any, keys ...string) (string, bool) {
	s, ok := g(v, keys...).(string)
	return s, ok
}

func sv(v any, keys ...string) string {
	s, _ := gs(v, keys...)
	return s
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

func objOr(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// truthy follows JS truthiness for JSON values.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	default:
		return true
	}
}

// coalesce is JS ?? (first value that is not null/undefined).
func coalesce(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

// or is JS || (first truthy value, else the last one).
func or(vs ...any) any {
	for _, v := range vs {
		if truthy(v) {
			return v
		}
	}
	if len(vs) == 0 {
		return nil
	}
	return vs[len(vs)-1]
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

// strPtr returns v as *string if it is a string (JS: set value, even ""), else nil (undefined).
func strPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func ptr[T any](v T) *T { return &v }

// isJSSpace matches JS \s.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func unescapeHTML(s string) string {
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	return strings.ReplaceAll(s, "&amp;", "&")
}

// utf16Slice is JS String.prototype.slice (UTF-16 code unit indices).
func utf16Slice(s string, a, b int) string {
	u := utf16.Encode([]rune(s))
	a, b = clamp(a, 0, len(u)), clamp(b, 0, len(u))
	if a >= b {
		return ""
	}
	return string(utf16.Decode(u[a:b]))
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func isoString(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// ---------- text ----------

type mark struct {
	a, b int
	seg  *Seg // nil = remove the range (media links)
}

func indices(v any) (int, int, bool) {
	a := arr(g(v, "indices"))
	if len(a) < 2 {
		return 0, 0, false
	}
	return int(num(a[0])), int(num(a[1])), true
}

// Segments splits text using X's entity indices (unicode code points).
func Segments(text string, ent map[string]any, rng []any) []Seg {
	if text == "" {
		return []Seg{}
	}
	cps := []rune(text)
	lo, hi := 0, len(cps)
	if len(rng) >= 2 {
		lo, hi = int(num(rng[0])), int(num(rng[1]))
	}
	slice := func(a, b int) string {
		a, b = clamp(a, 0, len(cps)), clamp(b, 0, len(cps))
		if a >= b {
			return ""
		}
		return string(cps[a:b])
	}
	var marks []mark
	for _, m := range arr(ent["user_mentions"]) {
		a, b, _ := indices(m)
		marks = append(marks, mark{a, b, &Seg{T: "mention", V: slice(a, b), U: sv(m, "screen_name")}})
	}
	for _, h := range arr(ent["hashtags"]) {
		a, b, _ := indices(h)
		marks = append(marks, mark{a, b, &Seg{T: "hash", V: slice(a, b)}})
	}
	for _, s := range arr(ent["symbols"]) {
		a, b, _ := indices(s)
		marks = append(marks, mark{a, b, &Seg{T: "cash", V: slice(a, b)}})
	}
	for _, u := range arr(ent["urls"]) {
		a, b, ok := indices(u)
		if !ok {
			continue
		}
		v, _ := or(g(u, "display_url"), g(u, "expanded_url"), g(u, "url")).(string)
		href, _ := or(g(u, "expanded_url"), g(u, "url")).(string)
		marks = append(marks, mark{a, b, &Seg{T: "url", V: v, Href: href}})
	}
	for _, m := range arr(ent["media"]) {
		if a, b, ok := indices(m); ok {
			marks = append(marks, mark{a, b, nil})
		}
	}
	sort.SliceStable(marks, func(i, j int) bool { return marks[i].a < marks[j].a })

	out := []Seg{}
	pushText := func(s string) {
		if s == "" {
			return
		}
		v := unescapeHTML(s)
		if n := len(out); n > 0 && out[n-1].T == "text" {
			out[n-1].V += v
		} else {
			out = append(out, Seg{T: "text", V: v})
		}
	}
	pos := lo
	for _, m := range marks {
		if m.a < pos || m.b > hi {
			continue
		}
		pushText(slice(pos, m.a))
		if m.seg != nil {
			out = append(out, *m.seg)
		}
		pos = m.b
	}
	pushText(slice(pos, hi))
	if len(out) > 0 && out[0].T == "text" {
		out[0].V = strings.TrimLeftFunc(out[0].V, isJSSpace)
	}
	if n := len(out); n > 0 && out[n-1].T == "text" {
		out[n-1].V = strings.TrimRightFunc(out[n-1].V, isJSSpace)
	}
	kept := out[:0]
	for _, s := range out {
		if s.T != "text" || s.V != "" {
			kept = append(kept, s)
		}
	}
	return kept
}

// bioSegments linkifies mentions/hashtags in plain text (bios), using url entities for links.
func bioSegments(text string, urls []any) []Seg {
	if text == "" {
		return []Seg{}
	}
	toCp := func(i int) int { return len([]rune(text[:i])) }
	ent := map[string]any{"urls": urls}
	if urls == nil {
		ent["urls"] = []any{}
	}
	inURL := func(start int) bool {
		for _, u := range arr(ent["urls"]) {
			if a, b, ok := indices(u); ok && start >= a && start < b {
				return true
			}
		}
		return false
	}
	var mentions, tags []any
	for _, m := range mentionRe.FindAllStringSubmatchIndex(text, -1) {
		a := toCp(m[3]) // end of the prefix group = start of "@"
		name := text[m[4]:m[5]]
		if !inURL(a) {
			mentions = append(mentions, map[string]any{"screen_name": name, "indices": []any{float64(a), float64(a + len(name) + 1)}})
		}
	}
	for _, m := range hashtagRe.FindAllStringSubmatchIndex(text, -1) {
		a := toCp(m[3])
		tag := text[m[4]:m[5]]
		if !inURL(a) {
			tags = append(tags, map[string]any{"indices": []any{float64(a), float64(a + len([]rune(tag)) + 1)}})
		}
	}
	ent["user_mentions"] = mentions
	ent["hashtags"] = tags
	return Segments(text, ent, nil)
}

// ---------- users ----------

func ParseUser(r any, full bool) *User {
	if r == nil || sv(r, "__typename") == "UserUnavailable" {
		return nil
	}
	l := objOr(g(r, "legacy"))
	core := objOr(g(r, "core"))
	sn, _ := coalesce(core["screen_name"], l["screen_name"]).(string)
	if sn == "" {
		return nil
	}
	vt := coalesce(g(r, "verification", "verified_type"), l["verified_type"])
	name, _ := coalesce(core["name"], l["name"], sn).(string)
	avatar, _ := coalesce(g(r, "avatar", "image_url"), l["profile_image_url_https"], "").(string)
	u := &User{ID: sv(r, "rest_id"), Sn: sn, Name: name, Avatar: strings.Replace(avatar, "_normal.", "_bigger.", 1)}
	switch {
	case vt == "Business":
		u.Verified = "gold"
	case vt == "Government":
		u.Verified = "gray"
	case truthy(g(r, "is_blue_verified")) || truthy(g(r, "verification", "verified")) || truthy(l["verified"]):
		u.Verified = "blue"
	}
	if truthy(coalesce(g(r, "privacy", "protected"), l["protected"])) {
		u.Protected = true
	}
	rel := objOr(g(r, "relationship_perspectives"))
	if truthy(coalesce(rel["following"], l["following"])) {
		u.Following = true
	}
	if truthy(coalesce(rel["followed_by"], l["followed_by"])) {
		u.FollowedBy = true
	}
	if full {
		bioEnt := objOr(coalesce(g(r, "profile_bio", "entities"), l["entities"]))
		desc, _ := coalesce(g(r, "profile_bio", "description"), l["description"], "").(string)
		bio := bioSegments(desc, arr(g(bioEnt, "description", "urls")))
		u.Bio = &bio
		if b, _ := coalesce(g(r, "banner", "image_url"), l["profile_banner_url"]).(string); b != "" {
			u.Banner = b
		}
		if loc, _ := coalesce(g(r, "location", "location"), l["location"]).(string); loc != "" {
			u.Location = loc
		}
		if urls := arr(g(bioEnt, "url", "urls")); len(urls) > 0 && truthy(urls[0]) {
			href, _ := or(g(urls[0], "expanded_url"), g(urls[0], "url")).(string)
			u.URL = &Link{V: sv(urls[0], "display_url"), Href: href}
		}
		u.Joined, _ = coalesce(core["created_at"], l["created_at"]).(string)
		u.Followers = ptr(int64(num(coalesce(g(r, "relationship_counts", "followers"), l["followers_count"], 0.0))))
		u.FollowingCount = ptr(int64(num(coalesce(g(r, "relationship_counts", "following"), l["friends_count"], 0.0))))
		u.Tweets = ptr(int64(num(coalesce(g(r, "tweet_counts", "tweets"), l["statuses_count"], 0.0))))
	}
	return u
}

// ---------- tweets ----------

func parseMedia(list []any) []Media {
	if len(list) == 0 {
		return nil
	}
	out := make([]Media, 0, len(list))
	for _, m := range list {
		typ := "photo"
		switch sv(m, "type") {
		case "video":
			typ = "video"
		case "animated_gif":
			typ = "gif"
		}
		md := Media{
			Type: typ,
			URL:  sv(m, "media_url_https"),
			W:    num(or(g(m, "original_info", "width"), g(m, "sizes", "large", "w"), 1.0)),
			H:    num(or(g(m, "original_info", "height"), g(m, "sizes", "large", "h"), 1.0)),
		}
		if alt := sv(m, "ext_alt_text"); alt != "" {
			md.Alt = alt
		}
		if typ != "photo" {
			var mp4 []any
			for _, v := range arr(g(m, "video_info", "variants")) {
				if sv(v, "content_type") == "video/mp4" {
					mp4 = append(mp4, v)
				}
			}
			sort.SliceStable(mp4, func(i, j int) bool { return num(g(mp4[i], "bitrate")) < num(g(mp4[j], "bitrate")) })
			var pick any
			for _, v := range mp4 {
				if num(g(v, "bitrate")) <= 1_400_000 {
					pick = v // last one under the cap
				}
			}
			if pick == nil && len(mp4) > 0 {
				pick = mp4[0]
			}
			if pick != nil {
				md.Src = sv(pick, "url")
			}
			if d := num(g(m, "video_info", "duration_millis")); d != 0 {
				md.Dur = d
			}
		}
		out = append(out, md)
	}
	return out
}

func parseCard(c any, urls []any) *Card {
	if !truthy(g(c, "binding_values")) {
		return nil
	}
	bv := map[string]any{}
	for _, b := range arr(g(c, "binding_values")) {
		if k, ok := gs(b, "key"); ok {
			bv[k] = g(b, "value")
		}
	}
	str := func(k string) any { return g(bv[k], "string_value") }
	name := sv(c, "name")
	if p := pollRe.FindStringSubmatch(name); p != nil {
		n, _ := strconv.Atoi(p[1])
		var choices []Choice
		for i := 1; i <= n; i++ {
			label, _ := or(str("choice"+strconv.Itoa(i)+"_label"), "").(string)
			cnt, _ := or(str("choice"+strconv.Itoa(i)+"_count"), "0").(string)
			f, _ := strconv.ParseFloat(strings.TrimSpace(cnt), 64)
			choices = append(choices, Choice{Label: label, Count: f})
		}
		card := &Card{Kind: "poll", Choices: choices, Ends: strPtr(str("end_datetime_utc"))}
		if b, ok := g(bv["counts_are_final"], "boolean_value").(bool); ok {
			card.Closed = &b
		}
		return card
	}
	if strings.Contains(name, "unified_card") || strings.Contains(name, "promo") || strings.Contains(name, "app") {
		return nil
	}
	img := g(or(bv["summary_photo_image_large"], bv["photo_image_full_size_large"], bv["thumbnail_image_large"], bv["player_image_large"], bv["thumbnail_image"]), "image_value")
	tco := or(str("card_url"), g(c, "url"))
	var ex any
	for _, u := range urls {
		if g(u, "url") == tco && tco != nil {
			ex = u
			break
		}
	}
	title := str("title")
	if !truthy(title) && !truthy(img) {
		return nil
	}
	return &Card{
		Kind:   "link",
		URL:    strPtr(or(g(ex, "expanded_url"), tco)),
		Title:  strPtr(title),
		Desc:   strPtr(str("description")),
		Domain: strPtr(or(str("vanity_url"), str("domain"))),
		Image:  strPtr(g(img, "url")),
		Large:  ptr(name == "summary_large_image" || strings.HasPrefix(name, "player")),
	}
}

func unwrapTweet(r any) any {
	if sv(r, "__typename") == "TweetWithVisibilityResults" {
		return g(r, "tweet")
	}
	return r
}

func parseTime(s string) string {
	for _, layout := range []string{"Mon Jan 02 15:04:05 -0700 2006", time.RFC3339Nano} {
		if t, err := time.Parse(layout, s); err == nil {
			return isoString(t)
		}
	}
	return s
}

func ParseTweet(raw any, depth int) *Tweet {
	r := unwrapTweet(raw)
	l, ok := g(r, "legacy").(map[string]any)
	tn := sv(r, "__typename")
	if r == nil || !ok || tn == "TweetTombstone" || tn == "TweetUnavailable" {
		return nil
	}
	user := ParseUser(g(r, "core", "user_results", "result"), false)
	if user == nil {
		return nil
	}
	note := g(r, "note_tweet", "note_tweet_results", "result")
	urls := arr(or(g(l, "entities", "urls"), []any{}))
	id, _ := or(g(r, "rest_id"), l["id_str"]).(string)
	t := &Tweet{
		ID:        id,
		User:      user,
		Time:      parseTime(sv(l, "created_at")),
		Replies:   num(l["reply_count"]),
		Rts:       num(l["retweet_count"]),
		Likes:     num(l["favorite_count"]),
		Quotes:    num(l["quote_count"]),
		Bookmarks: num(l["bookmark_count"]),
	}
	if truthy(note) {
		ent := map[string]any{}
		for k, v := range objOr(g(note, "entity_set")) {
			ent[k] = v
		}
		ent["media"] = g(l, "entities", "media")
		t.Text = Segments(sv(note, "text"), ent, nil)
	} else {
		t.Text = Segments(sv(l, "full_text"), objOr(l["entities"]), arr(l["display_text_range"]))
	}
	if media := parseMedia(arr(coalesce(g(l, "extended_entities", "media"), g(l, "entities", "media")))); media != nil {
		t.Media = media
	}
	t.Card = parseCard(g(r, "card", "legacy"), urls)
	if s := sv(l, "in_reply_to_screen_name"); s != "" {
		t.ReplyTo = s
	}
	if s := sv(l, "in_reply_to_status_id_str"); s != "" {
		t.ReplyToID = s
	}
	if s := sv(l, "conversation_id_str"); s != "" {
		t.ConvID = s
	}
	if c := g(r, "views", "count"); truthy(c) {
		f, _ := strconv.ParseFloat(strings.TrimSpace(sv(r, "views", "count")), 64)
		t.Views = &f
	}
	t.Liked = truthy(l["favorited"])
	t.Rted = truthy(l["retweeted"])
	t.Bookmarked = truthy(l["bookmarked"])
	if s := sv(l, "lang"); s != "" {
		t.Lang = s
	}
	// is_translatable can be false on posts that do carry a translation; is_available is what counts.
	if tr := g(r, "grok_translated_post_with_availability"); truthy(g(tr, "is_available")) {
		if d := g(tr, "data"); sv(d, "translation") != "" {
			t.Tr = &Translation{Text: Segments(sv(d, "translation"), objOr(g(d, "entities")), nil), Src: sv(d, "source_language")}
		}
	}
	if truthy(l["is_quote_status"]) && depth == 0 {
		q := ParseTweet(g(r, "quoted_status_result", "result"), 1)
		t.IsQuote, t.Quote = true, q
		// Hide the trailing quote permalink from the text.
		if perm := sv(l, "quoted_status_permalink", "expanded"); q != nil && perm != "" {
			kept := []Seg{}
			for _, s := range t.Text {
				if !(s.T == "url" && s.Href == perm) {
					kept = append(kept, s)
				}
			}
			t.Text = kept
		}
	}
	return t
}

func tombstoneText(r any) string {
	if s := sv(r, "tombstone", "text", "text"); s != "" {
		return s
	}
	if s := sv(r, "result", "tombstone", "text", "text"); s != "" {
		return s
	}
	return "This post is unavailable."
}

// internalPath: in-app path for pages litex has; other x.com pages stay absolute x.com links.
func internalPath(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	if !xHostRe.MatchString(u.Hostname()) {
		return ""
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if appPathRe.MatchString(path) && path != "/i" && path != "/i/" {
		return path
	}
	search := ""
	if u.RawQuery != "" {
		search = "?" + u.RawQuery
	}
	return "https://x.com" + path + search
}

// isoTime: X has sent notification times as epoch-ms strings and as ISO strings.
func isoTime(v any) string {
	if v == nil || v == "" {
		return ""
	}
	var s string
	switch t := v.(type) {
	case string:
		s = t
	case float64:
		s = strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return ""
	}
	if digitsRe.MatchString(s) {
		ms, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return ""
		}
		return isoString(time.UnixMilli(ms))
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return isoString(t)
	}
	return ""
}

func parseNotification(k string, ic any) *Item {
	nurl := sv(ic, "notification_url", "url")
	if nurl != "" && junkNotifURL.MatchString(nurl) {
		return nil
	}
	msg := g(ic, "rich_message")
	text := sv(msg, "text")
	segs := []Seg{}
	pos := 0
	refs := append([]any(nil), arr(g(msg, "entities"))...)
	sort.SliceStable(refs, func(i, j int) bool { return num(g(refs[i], "fromIndex")) < num(g(refs[j], "fromIndex")) })
	for _, e := range refs {
		from, to := int(num(g(e, "fromIndex"))), int(num(g(e, "toIndex")))
		if from < pos {
			continue
		}
		if from > pos {
			segs = append(segs, Seg{T: "text", V: utf16Slice(text, pos, from)})
		}
		v := utf16Slice(text, from, to)
		if u := ParseUser(g(e, "ref", "user_results", "result"), false); u != nil {
			segs = append(segs, Seg{T: "mention", V: v, U: u.Sn})
		} else {
			segs = append(segs, Seg{T: "text", V: v})
		}
		pos = to
	}
	if pos < utf16Len(text) {
		segs = append(segs, Seg{T: "text", V: utf16Slice(text, pos, utf16Len(text))})
	}
	tpl := g(ic, "template")
	users := []User{}
	for _, f := range arr(g(tpl, "from_users")) {
		if u := ParseUser(g(f, "user_results", "result"), false); u != nil {
			users = append(users, *u)
		}
	}
	if len(users) > 8 {
		users = users[:8]
	}
	var target any
	if objs := arr(g(tpl, "target_objects")); len(objs) > 0 {
		target = g(objs[0], "tweet_results", "result")
	}
	tt := ParseTweet(target, 1)
	it := &Item{K: k, Type: "notif", Text: segs, Users: users}
	icon, _ := or(g(ic, "notification_icon"), "bell_icon").(string)
	it.Icon = strings.TrimSuffix(icon, "_icon")
	if p := internalPath(nurl); p != "" {
		it.URL = p
	} else if tt != nil {
		it.URL = "/" + tt.User.Sn + "/status/" + tt.ID
	}
	if tt != nil {
		var b strings.Builder
		for _, s := range tt.Text {
			b.WriteString(s.V)
		}
		snip := utf16Slice(b.String(), 0, 280)
		it.Snippet = &snip
	}
	it.Time = isoTime(g(ic, "timestamp_ms"))
	return it
}

func ParseList(l any) *List {
	id := sv(l, "id_str")
	if id == "" {
		return nil
	}
	out := &List{ID: id, Name: sv(l, "name")}
	if d := sv(l, "description"); d != "" {
		out.Desc = d
	}
	out.Banner, _ = coalesce(g(l, "custom_banner_media", "media_info", "original_img_url"), g(l, "default_banner_media", "media_info", "original_img_url")).(string)
	if v, ok := g(l, "member_count").(float64); ok {
		out.Members = &v
	}
	if v, ok := g(l, "subscriber_count").(float64); ok {
		out.Subscribers = &v
	}
	out.Owner = ParseUser(g(l, "user_results", "result"), false)
	out.Private = sv(l, "mode") == "Private"
	return out
}

// findInstructions: BFS for the first `instructions` array; X moves timelines around.
func findInstructions(data any) []any {
	type node struct {
		v any
		d int
	}
	q := []node{{data, 0}}
	for len(q) > 0 {
		n := q[0]
		q = q[1:]
		m, ok := n.v.(map[string]any)
		if !ok || n.d > 8 {
			continue
		}
		if a, ok := m["instructions"].([]any); ok {
			return a
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if child, ok := m[k].(map[string]any); ok {
				q = append(q, node{child, n.d + 1})
			}
		}
	}
	return nil
}

func ParseTimeline(data any) Page {
	page := Page{Items: []Item{}}

	content := func(k string, ic any, wrapper any) *Item {
		if ic == nil {
			return nil
		}
		if truthy(g(ic, "promotedMetadata")) || strings.Contains(sv(wrapper, "clientEventInfo", "component"), "promoted") {
			return nil
		}
		typ, _ := or(g(ic, "itemType"), g(ic, "__typename")).(string)
		switch typ {
		case "TimelineTweet":
			raw := g(ic, "tweet_results", "result")
			r := unwrapTweet(raw)
			if r == nil || !truthy(g(r, "legacy")) {
				return &Item{K: k, Type: "tombstone", TombText: tombstoneText(raw)}
			}
			if rt := g(r, "legacy", "retweeted_status_result", "result"); rt != nil {
				inner := ParseTweet(rt, 0)
				if inner == nil {
					return nil
				}
				return &Item{K: k, Type: "tweet", Tweet: inner, RtBy: ParseUser(g(r, "core", "user_results", "result"), false)}
			}
			if t := ParseTweet(raw, 0); t != nil {
				return &Item{K: k, Type: "tweet", Tweet: t}
			}
			return nil
		case "TimelineUser":
			if u := ParseUser(g(ic, "user_results", "result"), true); u != nil {
				return &Item{K: k, Type: "user", User: u}
			}
			return nil
		case "TimelineTrend":
			name := sv(ic, "name")
			// AI trends are Grok-written "stories"; skip them.
			if name == "" || truthy(g(ic, "is_ai_trend")) {
				return nil
			}
			md := objOr(g(ic, "trend_metadata"))
			src, _ := or(g(ic, "trend_url", "url"), g(md, "url", "url"), "").(string)
			q := name
			if m := queryRe.FindStringSubmatch(src); m != nil {
				if dec, err := url.PathUnescape(strings.ReplaceAll(m[1], "+", " ")); err == nil {
					q = dec
				}
			}
			return &Item{K: k, Type: "trend", Name: name, Ctx: strPtr(md["domain_context"]), Meta: strPtr(or(md["meta_description"], g(ic, "social_context", "text"))), Q: q}
		case "TimelineTwitterList":
			if l := ParseList(g(ic, "list")); l != nil {
				return &Item{K: k, Type: "list", List: l}
			}
			return nil
		case "TimelineNotification":
			return parseNotification(k, ic)
		case "TimelineTimelineCursor":
			ct := sv(ic, "cursorType")
			if ct == "ShowMore" || ct == "ShowMoreThreads" {
				label, _ := or(g(ic, "displayTreatment", "actionText"), "Show more replies").(string)
				return &Item{K: k, Type: "more", Cursor: sv(ic, "value"), Label: label}
			}
			return nil
		}
		return nil
	}

	cursor := func(c any) {
		switch sv(c, "cursorType") {
		case "Top":
			page.Top = sv(c, "value")
		case "Bottom":
			page.Bottom = sv(c, "value")
		case "ShowMoreThreads", "ShowMoreThreadsPrompt":
			if page.Bottom == "" {
				page.Bottom = sv(c, "value")
			}
		}
	}

	entry := func(e any, pinned bool) {
		id := sv(e, "entryId")
		if junkEntry.MatchString(id) {
			return
		}
		c := objOr(g(e, "content"))
		typ, _ := or(c["entryType"], c["__typename"]).(string)
		switch typ {
		case "TimelineTimelineCursor":
			cursor(c)
		case "TimelineTimelineItem":
			if it := content(id, c["itemContent"], c); it != nil {
				if pinned && it.Type == "tweet" {
					it.Pinned = true
				}
				page.Items = append(page.Items, *it)
			}
		case "TimelineTimelineModule":
			if h := sv(c, "header", "text"); h != "" && junkModule.MatchString(h) {
				return
			}
			conv := strings.Contains(sv(c, "displayType"), "Conversation") || strings.Contains(id, "conversation") || strings.Contains(id, "thread")
			var group []Item
			for j, mi := range arr(c["items"]) {
				k, _ := or(g(mi, "entryId"), id+"/"+strconv.Itoa(j)).(string)
				if it := content(k, g(mi, "item", "itemContent"), g(mi, "item")); it != nil {
					group = append(group, *it)
				}
			}
			if conv {
				for j := range group {
					if j < len(group)-1 && (group[j].Type == "tweet" || group[j].Type == "tombstone") {
						group[j].Line = true
					}
				}
			}
			page.Items = append(page.Items, group...)
		}
	}

	for _, ins := range findInstructions(data) {
		switch sv(ins, "type") {
		case "TimelineAddEntries":
			for _, e := range arr(g(ins, "entries")) {
				entry(e, false)
			}
		case "TimelinePinEntry":
			if e := g(ins, "entry"); e != nil {
				entry(e, true)
			}
		case "TimelineReplaceEntry":
			if c := g(ins, "entry", "content"); c != nil {
				cursor(c)
			}
		case "TimelineAddToModule":
			for _, mi := range arr(g(ins, "moduleItems")) {
				if it := content(sv(mi, "entryId"), g(mi, "item", "itemContent"), g(mi, "item")); it != nil {
					page.Items = append(page.Items, *it)
				}
			}
		}
	}
	// Pinned entry comes in a separate instruction; show it first.
	for i, it := range page.Items {
		if it.Type == "tweet" && it.Pinned {
			if i > 0 {
				pin := page.Items[i]
				copy(page.Items[1:i+1], page.Items[:i])
				page.Items[0] = pin
			}
			break
		}
	}
	return page
}
