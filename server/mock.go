package main

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"

	"litex/x"
)

// Fake data in the normalized shapes, for UI work and scroll-performance testing (X_MOCK=1).
// Same generator and seed as the Node mock, so the content looks the same.

var (
	mockMu sync.Mutex
	seed   int64 = 7
	words        = strings.Split("the quick brown fox jumps over lazy dog shipping today small fast web phone scroll build compile render frame budget layout paint latency cache network coffee morning thread reply idea", " ")
	idc          = new(big.Int).SetUint64(1_900_000_000_000_000_000)
	mUsers []x.User
	meUser x.User
	mLists []x.List
)

func rnd() float64 {
	seed = (seed * 16807) % 2147483647
	return float64(seed) / 2147483647
}
func pickIdx(n int) int         { return int(math.Floor(rnd() * float64(n))) }
func pickStr(a []string) string { return a[pickIdx(len(a))] }
func rint(n int) int            { return int(math.Floor(rnd() * float64(n))) }
func nowISO(ms int64) string    { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }
func pickUser() x.User          { return mUsers[pickIdx(len(mUsers))] }

func init() {
	surnames := []string{"Lovelace", "Hopper", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson", "Perlman", "Turing", "Allen"}
	for i, n := range []string{"Ada", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Radia", "Alan", "Frances", "Tim", "Hedy"} {
		sn := strings.ToLower(n)
		if i%3 != 0 {
			sn += "_dev"
		}
		u := x.User{ID: strconv.Itoa(1000 + i), Sn: sn, Name: n + " " + pickStr(surnames), Avatar: fmt.Sprintf("https://i.pravatar.cc/96?img=%d", i+3), Following: i%2 == 0}
		if i%4 == 0 {
			u.Verified = "blue"
		} else if i == 5 {
			u.Verified = "gold"
		}
		mUsers = append(mUsers, u)
	}
	meUser = mUsers[0]
	bio := []x.Seg{{T: "text", V: "Mock account for litex. "}, {T: "hash", V: "#webperf"}}
	f, fg, tw := int64(1234), int64(321), int64(4567)
	meUser.Bio, meUser.Followers, meUser.FollowingCount, meUser.Tweets = &bio, &f, &fg, &tw
	meUser.Joined = time.Date(2012, 3, 1, 0, 0, 0, 0, time.Local).UTC().Format("2006-01-02T15:04:05.000Z")
	meUser.Location = "Localhost"
	meUser.URL = &x.Link{V: "example.com", Href: "https://example.com"}
	for i, name := range []string{"Web perf", "Friends", "News"} {
		m, s := float64(10+rint(200)), float64(rint(50))
		owner := meUser
		mLists = append(mLists, x.List{ID: strconv.Itoa(500 + i), Name: name, Desc: name + " people", Members: &m, Subscribers: &s, Owner: &owner, Private: i == 1})
	}
}

func mockText() []x.Seg {
	n := 4 + rint(45)
	var s strings.Builder
	for i := 0; i < n; i++ {
		s.WriteString(pickStr(words))
		if rnd() < 0.08 {
			s.WriteString(".\n")
		} else {
			s.WriteString(" ")
		}
	}
	segs := []x.Seg{{T: "text", V: strings.TrimSpace(s.String()) + " "}}
	if rnd() < 0.3 {
		a, b := pickUser(), pickUser()
		segs = append(segs, x.Seg{T: "mention", V: "@" + a.Sn, U: b.Sn}, x.Seg{T: "text", V: " "})
	}
	if rnd() < 0.3 {
		segs = append(segs, x.Seg{T: "hash", V: "#" + pickStr(words)})
	}
	if rnd() < 0.15 {
		segs = append(segs, x.Seg{T: "text", V: " "}, x.Seg{T: "url", V: "example.com/article/" + strconv.Itoa(rint(999)), Href: "https://example.com/article"})
	}
	return segs
}

func mockTweet(depth int, at int64) *x.Tweet {
	id := idc.String()
	idc.Add(idc, big.NewInt(1))
	u := pickUser()
	t := &x.Tweet{ID: id, User: &u, Text: mockText(), Time: nowISO(at), Replies: float64(rint(300)), Rts: float64(rint(2000)), Likes: float64(rint(20000)), Quotes: float64(rint(100)), Bookmarks: float64(rint(500))}
	v := float64(rint(900000))
	t.Views = &v
	t.Liked = rnd() < 0.1
	heights := []float64{675, 900, 1200, 1500}
	switch r := rnd(); {
	case r < 0.25:
		n := 1 + rint(4)
		for i := 0; i < n; i++ {
			h1 := heights[pickIdx(4)]
			h2 := heights[pickIdx(4)]
			t.Media = append(t.Media, x.Media{Type: "photo", URL: fmt.Sprintf("https://picsum.photos/seed/%s%d/1200/%v.jpg", id, i, h1), W: 1200, H: h2})
		}
	case r < 0.32:
		typ := []string{"video", "gif"}[pickIdx(2)]
		t.Media = []x.Media{{Type: typ, URL: "https://picsum.photos/seed/" + id + "v/1280/720.jpg", W: 1280, H: 720, Dur: float64(5000 + rint(200000)), Src: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"}}
	case r < 0.37:
		str := func(s string) *string { return &s }
		large := true
		t.Card = &x.Card{Kind: "link", URL: str("https://example.com/post"), Title: str("An example link preview title"), Desc: str("Some description of the linked page."), Domain: str("example.com"), Image: str("https://picsum.photos/seed/" + id + "c/800/418.jpg"), Large: &large}
	case r < 0.39:
		ends := nowISO(time.Now().UnixMilli() + 3600e3)
		t.Card = &x.Card{Kind: "poll", Choices: []x.Choice{{Label: "Yes", Count: float64(rint(500))}, {Label: "No", Count: float64(rint(500))}, {Label: "Maybe", Count: float64(rint(200))}}, Ends: &ends}
	}
	if depth == 0 && rnd() < 0.08 {
		t.IsQuote, t.Quote = true, mockTweet(1, time.Now().UnixMilli()-int64(rint(86400000*3)))
	}
	return t
}

func mockTweets(n int, prefix string) []x.Item {
	var out []x.Item
	at := time.Now().UnixMilli() - int64(rint(600000))
	for i := 0; i < n; i++ {
		at -= int64(rint(3600000))
		tw := mockTweet(0, at)
		it := x.Item{K: prefix + "-" + tw.ID, Type: "tweet", Tweet: tw}
		if rnd() < 0.1 {
			u := pickUser()
			it.RtBy = &u
		}
		out = append(out, it)
	}
	return out
}

func mockPage(items []x.Item, cursor string) x.Page {
	n, _ := strconv.Atoi(cursor)
	return x.Page{Items: items, Bottom: strconv.Itoa(n + 1), Top: "top"}
}

func delay() { time.Sleep(time.Duration(150+rint(250)) * time.Millisecond) }

func mockBackend() backend {
	lock := func() func() { mockMu.Lock(); return mockMu.Unlock }
	home := func(_, cursor string) (x.Page, error) {
		defer lock()()
		delay()
		return mockPage(mockTweets(20, "home"), cursor), nil
	}
	userTimeline := func(_, tab, cursor string) (x.Page, error) {
		defer lock()()
		delay()
		if tab == "media" {
			items := mockTweets(30, "m")
			for i := range items {
				if items[i].Tweet.Media == nil {
					items[i].Tweet.Media = []x.Media{{Type: "photo", URL: "https://picsum.photos/seed/" + items[i].Tweet.ID + "/600/600.jpg", W: 600, H: 600}}
				}
			}
			return mockPage(items, cursor), nil
		}
		items := mockTweets(20, tab)
		if cursor == "" && tab == "posts" && len(items) > 0 {
			items[0].Pinned = true
		}
		return mockPage(items, cursor), nil
	}
	follows := func(_, _, cursor string) (x.Page, error) {
		defer lock()()
		delay()
		var items []x.Item
		for i := 0; i < 20; i++ {
			u := pickUser()
			bio := []x.Seg{{T: "text", V: "Building things on the web."}}
			u.Bio = &bio
			items = append(items, x.Item{K: fmt.Sprintf("u%s-%d", cursorOrUndef(cursor), i), Type: "user", User: &u})
		}
		return mockPage(items, cursor), nil
	}
	return backend{
		Me:   func() (*x.User, error) { u := meUser; return &u, nil },
		Home: home,
		TweetDetail: func(id, cursor string) (x.Page, error) {
			defer lock()()
			delay()
			if cursor != "" {
				return mockPage(mockTweets(15, "reply"), cursor), nil
			}
			focal := mockTweet(0, time.Now().UnixMilli()-int64(rint(86400000*3)))
			focal.ID = id
			anc := mockTweets(2, "anc")
			for i := range anc {
				anc[i].Line = true
			}
			items := append(anc, x.Item{K: "focal", Type: "tweet", Tweet: focal, Focal: true})
			for i := 0; i < 12; i++ {
				thread := mockTweets(1+rint(3), "r"+strconv.Itoa(i))
				for j := range thread {
					if j < len(thread)-1 {
						thread[j].Line = true
					}
				}
				items = append(items, thread...)
			}
			return mockPage(items, cursor), nil
		},
		Quotes: func(_, cursor string) (x.Page, error) { return home("", cursor) },
		UserByScreenName: func(sn string) (*x.User, error) {
			mockMu.Lock()
			defer mockMu.Unlock()
			delay()
			u := mUsers[1]
			for _, c := range mUsers {
				if c.Sn == sn {
					u = c
				}
			}
			out := meUser
			out.ID, out.Sn, out.Name, out.Avatar, out.Verified, out.Following = u.ID, u.Sn, u.Name, u.Avatar, u.Verified, u.Following
			out.Banner = "https://picsum.photos/seed/" + sn + "/1500/500.jpg"
			return &out, nil
		},
		UserTimeline: userTimeline,
		Follows:      follows,
		Search: func(q, tab, cursor string) (x.Page, error) {
			if tab == "people" {
				return follows("", "", cursor)
			}
			t := "posts"
			if tab == "media" {
				t = "media"
			}
			p, err := userTimeline("", t, cursor)
			for i := range p.Items {
				p.Items[i].Tweet.Text = append([]x.Seg{{T: "text", V: q + " "}}, p.Items[i].Tweet.Text...)
			}
			return p, err
		},
		Explore: func(tab, cursor string) (x.Page, error) {
			defer lock()()
			delay()
			if n, _ := strconv.Atoi(cursor); cursor != "" && n > 2 {
				return x.Page{}, nil
			}
			var items []x.Item
			for i := 0; i < 20; i++ {
				name := pickStr(words) + " " + pickStr(words)
				if i%3 != 0 {
					name = "#" + pickStr(words) + pickStr(words)
				}
				label := tab
				if tab == "for_you" {
					label = "Trending"
				}
				ctx := label + " · Technology"
				meta := strconv.Itoa(rint(90)+1) + "K posts"
				items = append(items, x.Item{K: fmt.Sprintf("t%s-%d", cursorOrUndef(cursor), i), Type: "trend", Name: name, Ctx: &ctx, Meta: &meta, Q: pickStr(words)})
			}
			return mockPage(items, cursor), nil
		},
		Notifications: func(tab, cursor string) (x.Page, error) {
			if tab == "mentions" {
				return home("", cursor)
			}
			defer lock()()
			delay()
			icons := []string{"heart", "retweet", "person", "bell"}
			var items []x.Item
			for i := 0; i < 20; i++ {
				if i%4 == 3 {
					items = append(items, mockTweets(1, "nt"+cursorOrUndef(cursor)+strconv.Itoa(i))...)
					continue
				}
				icon := pickStr(icons)
				var us []x.User
				for j, n := 0, 1+rint(5); j < n; j++ {
					us = append(us, pickUser())
				}
				others := " "
				if len(us) > 1 {
					others = fmt.Sprintf(" and %d others ", len(us)-1)
				}
				verb := map[string]string{"heart": "liked your post", "retweet": "reposted your post", "person": "followed you", "bell": "posted for the first time in a while"}[icon]
				it := x.Item{K: fmt.Sprintf("n%s-%d", cursorOrUndef(cursor), i), Type: "notif", Icon: icon, Users: us, Text: []x.Seg{{T: "mention", V: us[0].Name, U: us[0].Sn}, {T: "text", V: others}, {T: "text", V: verb}}, Time: nowISO(time.Now().UnixMilli() - int64(rint(86400000)))}
				if icon == "person" {
					it.URL = "/" + us[0].Sn
				} else {
					var b strings.Builder
					for _, s := range mockText() {
						b.WriteString(s.V)
					}
					snip := b.String()
					it.Snippet = &snip
					it.URL = "/" + meUser.Sn + "/status/123"
				}
				items = append(items, it)
			}
			return mockPage(items, cursor), nil
		},
		Bookmarks: func(cursor string) (x.Page, error) { return home("", cursor) },
		Lists: func() (x.Page, error) {
			defer lock()()
			delay()
			var items []x.Item
			for i := range mLists {
				items = append(items, x.Item{K: "l" + mLists[i].ID, Type: "list", List: &mLists[i]})
			}
			return x.Page{Items: items}, nil
		},
		ListInfo: func(id string) (*x.List, error) {
			for i := range mLists {
				if mLists[i].ID == id {
					return &mLists[i], nil
				}
			}
			return &mLists[0], nil
		},
		ListTweets: func(_, cursor string) (x.Page, error) { return home("", cursor) },
		Act:        func(_, _ string) error { defer lock()(); delay(); return nil },
		Follow:     func(_ string, _ bool) error { defer lock()(); delay(); return nil },
		CreateTweet: func(o x.ComposeOpts) (*x.Tweet, error) {
			defer lock()()
			delay()
			t := mockTweet(0, time.Now().UnixMilli())
			u := meUser
			t.User, t.Text, t.Time = &u, []x.Seg{{T: "text", V: o.Text}}, nowISO(time.Now().UnixMilli())
			return t, nil
		},
		UploadImage: func(_ []byte, _ string) (string, error) { defer lock()(); delay(); return strconv.Itoa(rint(1e9)), nil },
	}
}

// JS template literals print a missing cursor as "undefined".
func cursorOrUndef(c string) string {
	if c == "" {
		return "undefined"
	}
	return c
}
