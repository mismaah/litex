// Package x talks to X's web API and normalizes responses into the compact shapes the
// litex frontend uses (mirrors shared/types.ts; JSON field names and omission rules match).
package x

import "encoding/json"

type Seg struct {
	T    string `json:"t"`
	V    string `json:"v"`
	U    string `json:"u,omitempty"`
	Href string `json:"href,omitempty"`
}

type Link struct {
	V    string `json:"v"`
	Href string `json:"href"`
}

type User struct {
	ID         string `json:"id"`
	Sn         string `json:"sn"`
	Name       string `json:"name"`
	Avatar     string `json:"avatar"`
	Verified   string `json:"verified,omitempty"`
	Protected  bool   `json:"protected,omitempty"`
	Following  bool   `json:"following,omitempty"`
	FollowedBy bool   `json:"followedBy,omitempty"`
	// Full profiles only
	Bio            *[]Seg `json:"bio,omitempty"`
	Banner         string `json:"banner,omitempty"`
	Location       string `json:"location,omitempty"`
	URL            *Link  `json:"url,omitempty"`
	Joined         string `json:"joined,omitempty"`
	Followers      *int64 `json:"followers,omitempty"`
	FollowingCount *int64 `json:"followingCount,omitempty"`
	Tweets         *int64 `json:"tweets,omitempty"`
}

type Media struct {
	Type string  `json:"type"`
	URL  string  `json:"url"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
	Alt  string  `json:"alt,omitempty"`
	Src  string  `json:"src,omitempty"`
	Dur  float64 `json:"dur,omitempty"`
}

type Choice struct {
	Label string  `json:"label"`
	Count float64 `json:"count"`
}

// Pointer fields mirror JS: set-but-empty values ("" / false) are still emitted.
type Card struct {
	Kind    string   `json:"kind"`
	URL     *string  `json:"url,omitempty"`
	Title   *string  `json:"title,omitempty"`
	Desc    *string  `json:"desc,omitempty"`
	Domain  *string  `json:"domain,omitempty"`
	Image   *string  `json:"image,omitempty"`
	Large   *bool    `json:"large,omitempty"`
	Choices []Choice `json:"choices,omitempty"`
	Ends    *string  `json:"ends,omitempty"`
	Closed  *bool    `json:"closed,omitempty"`
}

type Tweet struct {
	ID         string   `json:"id"`
	User       *User    `json:"user"`
	Text       []Seg    `json:"text"`
	Time       string   `json:"time"`
	Media      []Media  `json:"media,omitempty"`
	Card       *Card    `json:"card,omitempty"`
	ReplyTo    string   `json:"replyTo,omitempty"`
	ReplyToID  string   `json:"replyToId,omitempty"`
	ConvID     string   `json:"convId,omitempty"`
	Replies    float64  `json:"replies"`
	Rts        float64  `json:"rts"`
	Likes      float64  `json:"likes"`
	Quotes     float64  `json:"quotes"`
	Bookmarks  float64  `json:"bookmarks"`
	Views      *float64 `json:"views,omitempty"`
	Liked      bool     `json:"liked,omitempty"`
	Rted       bool     `json:"rted,omitempty"`
	Bookmarked bool     `json:"bookmarked,omitempty"`
	Lang       string   `json:"lang,omitempty"`

	// Quote is three-state: not a quote (absent), quote unavailable (null), or the quoted post.
	Quote   *Tweet `json:"-"`
	IsQuote bool   `json:"-"`
}

func (t Tweet) MarshalJSON() ([]byte, error) {
	type plain Tweet
	if !t.IsQuote {
		return json.Marshal(plain(t))
	}
	return json.Marshal(struct {
		plain
		Quote *Tweet `json:"quote"`
	}{plain(t), t.Quote})
}

type List struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Desc        string   `json:"desc,omitempty"`
	Banner      string   `json:"banner,omitempty"`
	Members     *float64 `json:"members,omitempty"`
	Subscribers *float64 `json:"subscribers,omitempty"`
	Owner       *User    `json:"owner,omitempty"`
	Private     bool     `json:"private,omitempty"`
}

// Item is one timeline entry; which fields are emitted depends on Type (see MarshalJSON).
type Item struct {
	K    string
	Type string // tweet | tombstone | user | trend | list | notif | more

	Tweet  *Tweet
	RtBy   *User
	Pinned bool
	Line   bool
	Focal  bool

	TombText string // tombstone
	User     *User  // user
	Name     string // trend
	Ctx      *string
	Meta     *string
	Q        string
	List     *List  // list
	Icon     string // notif
	Text     []Seg
	Users    []User
	URL      string
	Snippet  *string
	Time     string
	Cursor   string // more
	Label    string
	Href     string
}

func (it Item) MarshalJSON() ([]byte, error) {
	m := map[string]any{"k": it.K, "type": it.Type}
	opt := func(k, v string) {
		if v != "" {
			m[k] = v
		}
	}
	flag := func(k string, v bool) {
		if v {
			m[k] = true
		}
	}
	switch it.Type {
	case "tweet":
		m["tweet"] = it.Tweet
		if it.RtBy != nil {
			m["rtBy"] = it.RtBy
		}
		flag("pinned", it.Pinned)
		flag("line", it.Line)
		flag("focal", it.Focal)
	case "tombstone":
		m["text"] = it.TombText
		flag("line", it.Line)
	case "user":
		m["user"] = it.User
	case "trend":
		m["name"] = it.Name
		if it.Ctx != nil {
			m["ctx"] = *it.Ctx
		}
		if it.Meta != nil {
			m["meta"] = *it.Meta
		}
		m["q"] = it.Q
	case "list":
		m["list"] = it.List
	case "notif":
		m["icon"] = it.Icon
		m["text"] = nonNil(it.Text)
		users := it.Users
		if users == nil {
			users = []User{}
		}
		m["users"] = users
		opt("url", it.URL)
		if it.Snippet != nil {
			m["snippet"] = *it.Snippet
		}
		opt("time", it.Time)
	case "more":
		m["cursor"] = it.Cursor
		m["label"] = it.Label
		opt("href", it.Href)
	}
	return json.Marshal(m)
}

type Page struct {
	Items  []Item `json:"items"`
	Top    string `json:"top,omitempty"`
	Bottom string `json:"bottom,omitempty"`
}

func (p Page) MarshalJSON() ([]byte, error) {
	type plain Page
	if p.Items == nil {
		p.Items = []Item{}
	}
	return json.Marshal(plain(p))
}

func nonNil(s []Seg) []Seg {
	if s == nil {
		return []Seg{}
	}
	return s
}
