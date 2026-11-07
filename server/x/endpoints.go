package x

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"net/url"
	"sync"
	"time"
)

// One function per X operation; each returns normalized data (port of endpoints.ts).

func withCursor(v Vars, cursor string) Vars {
	if cursor != "" {
		v["cursor"] = cursor
	}
	return v
}

func timeline(op string, v Vars, method string) (Page, error) {
	data, err := GQL(op, v, method)
	if err != nil {
		return Page{}, err
	}
	return ParseTimeline(data), nil
}

// ---------- Home ----------

// HomeOpts carries what x.com's web client tells the For you ranker about the session.
type HomeOpts struct {
	// Seen lists post IDs the user already saw, newest first; X uses it to avoid serving them again.
	Seen []string
	// Ctx is the requestContext for a first page: "launch" (default) or "ptr" (pull to refresh).
	Ctx string
}

func homeVars(cursor string, o HomeOpts) Vars {
	v := Vars{"count": 20, "includePromotedContent": false, "latestControlAvailable": true, "withCommunity": false}
	if cursor == "" {
		ctx := o.Ctx
		if ctx != "ptr" {
			ctx = "launch"
		}
		v["requestContext"] = ctx
	}
	if len(o.Seen) > 0 {
		v["seenTweetIds"] = o.Seen
	}
	return withCursor(v, cursor)
}

func Home(tab, cursor string, o HomeOpts) (Page, error) {
	name := "HomeTimeline"
	if tab == "following" {
		name = "HomeLatestTimeline"
	}
	return timeline(name, homeVars(cursor, o), "POST")
}

// ---------- Tweets ----------

func TweetDetail(id, cursor string) (Page, error) {
	page, err := timeline("TweetDetail", withCursor(Vars{
		"focalTweetId":                           id,
		"referrer":                               "tweet",
		"with_rux_injections":                    false,
		"rankingMode":                            "Relevance",
		"includePromotedContent":                 false,
		"withCommunity":                          false,
		"withQuickPromoteEligibilityTweetFields": false,
		"withBirdwatchNotes":                     true,
		"withVoice":                              true,
	}, cursor), "GET")
	if err != nil {
		return page, err
	}
	items := page.Items
	if cursor == "" {
		fi := -1
		for i, it := range items {
			if it.Type == "tweet" && it.Tweet.ID == id {
				fi = i
				break
			}
		}
		if fi >= 0 {
			items[fi].Focal = true
			items[fi].Line = false
			for i := 0; i < fi; i++ {
				if items[i].Type == "tweet" || items[i].Type == "tombstone" {
					items[i].Line = true
				}
			}
			// Direct replies under the focal post don't need "Replying to @...".
			for i := fi + 1; i < len(items); i++ {
				if items[i].Type == "tweet" && items[i].Tweet.ReplyToID == id {
					t := *items[i].Tweet
					t.ReplyTo = ""
					items[i].Tweet = &t
				}
			}
		}
	}
	// In-thread "show more" cursors link to the last reply shown above them.
	for i := range items {
		if items[i].Type != "more" || i == 0 {
			continue
		}
		if prev := &items[i-1]; prev.Type == "tweet" {
			items[i].Href = "/" + prev.Tweet.User.Sn + "/status/" + prev.Tweet.ID
			prev.Line = true
		}
	}
	return page, nil
}

// Quotes lists posts quoting a tweet (what X's "View quotes" shows).
func Quotes(id, cursor string) (Page, error) {
	return timeline("SearchTimeline", withCursor(Vars{"rawQuery": "quoted_tweet_id:" + id, "count": 20, "querySource": "tdqt", "product": "Top", "withGrokTranslatedBio": false}, cursor), "GET")
}

// ---------- Users ----------

func UserByScreenName(sn string) (*User, error) {
	data, err := GQL("UserByScreenName", Vars{"screen_name": sn, "withGrokTranslatedBio": false}, "GET")
	if err != nil {
		return nil, err
	}
	u := ParseUser(g(data, "data", "user", "result"), true)
	if u == nil {
		return nil, xerr("User not found", 404)
	}
	return u, nil
}

var ProfileOps = map[string]string{"posts": "UserTweets", "replies": "UserTweetsAndReplies", "media": "UserMedia", "likes": "Likes"}

func UserTimeline(userID, tab, cursor string) (Page, error) {
	return timeline(ProfileOps[tab], withCursor(Vars{
		"userId":                                 userID,
		"count":                                  20,
		"includePromotedContent":                 false,
		"withQuickPromoteEligibilityTweetFields": false,
		"withCommunity":                          true,
		"withClientEventToken":                   false,
		"withBirdwatchNotes":                     false,
		"withVoice":                              true,
	}, cursor), "GET")
}

func Follows(userID, kind, cursor string) (Page, error) {
	op := "Following"
	if kind == "followers" {
		op = "Followers"
	}
	return timeline(op, withCursor(Vars{"userId": userID, "count": 20, "includePromotedContent": false, "withGrokTranslatedBio": false}, cursor), "GET")
}

var (
	meMu    sync.Mutex
	meCache *User
	meAt    time.Time
)

func Me() (*User, error) {
	meMu.Lock()
	if meCache != nil && time.Since(meAt) < 30*time.Minute {
		u := meCache
		meMu.Unlock()
		return u, nil
	}
	meMu.Unlock()
	s, err := RestGet("account/settings.json", map[string]string{})
	if err != nil {
		return nil, err
	}
	u, err := UserByScreenName(sv(s, "screen_name"))
	if err != nil {
		return nil, err
	}
	meMu.Lock()
	meCache, meAt = u, time.Now()
	meMu.Unlock()
	return u, nil
}

// ---------- Search & explore ----------

var searchProduct = map[string]string{"top": "Top", "latest": "Latest", "people": "People", "media": "Media"}

func Search(q, tab, cursor string) (Page, error) {
	return timeline("SearchTimeline", withCursor(Vars{"rawQuery": q, "count": 20, "querySource": "typed_query", "product": searchProduct[tab], "withGrokTranslatedBio": false}, cursor), "GET")
}

// Explore tab timeline ids are "Timeline:" + a tiny thrift struct holding the tab name.
func exploreTimelineID(tab string) string {
	var b bytes.Buffer
	b.WriteString("Timeline:")
	b.Write([]byte{0x0c, 0x00, 0xb6, 0x0b, 0x00, 0x01})
	_ = binary.Write(&b, binary.BigEndian, uint32(len(tab)))
	b.WriteString(tab)
	b.Write([]byte{0, 0})
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

var ExploreTabs = []string{"for_you", "trending", "news", "sports", "entertainment"}

func Explore(tab, cursor string) (Page, error) {
	return timeline("GenericTimelineById", withCursor(Vars{"timelineId": exploreTimelineID(tab), "count": 20, "withQuickPromoteEligibilityTweetFields": false}, cursor), "GET")
}

// ---------- Notifications / bookmarks / lists ----------

func Notifications(tab, cursor string) (Page, error) {
	tt := "All"
	if tab == "mentions" {
		tt = "Mentions"
	}
	return timeline("NotificationsTimeline", withCursor(Vars{"timeline_type": tt, "count": 20}, cursor), "GET")
}

func Bookmarks(cursor string) (Page, error) {
	return timeline("Bookmarks", withCursor(Vars{"count": 20, "includePromotedContent": false}, cursor), "GET")
}

func Lists() (Page, error) {
	return timeline("ListsManagementPageTimeline", Vars{"count": 100}, "GET")
}

func ListInfo(id string) (*List, error) {
	data, err := GQL("ListByRestId", Vars{"listId": id}, "GET")
	if err != nil {
		return nil, err
	}
	l := ParseList(g(data, "data", "list"))
	if l == nil {
		return nil, xerr("List not found", 404)
	}
	return l, nil
}

func ListTweets(id, cursor string) (Page, error) {
	return timeline("ListLatestTweetsTimeline", withCursor(Vars{"listId": id, "count": 20}, cursor), "GET")
}

// ---------- Actions ----------

func Act(action, tweetID string) error {
	var err error
	switch action {
	case "like":
		_, err = GQL("FavoriteTweet", Vars{"tweet_id": tweetID}, "POST")
	case "unlike":
		_, err = GQL("UnfavoriteTweet", Vars{"tweet_id": tweetID}, "POST")
	case "rt":
		_, err = GQL("CreateRetweet", Vars{"tweet_id": tweetID, "dark_request": false}, "POST")
	case "unrt":
		_, err = GQL("DeleteRetweet", Vars{"source_tweet_id": tweetID, "dark_request": false}, "POST")
	case "bookmark":
		_, err = GQL("CreateBookmark", Vars{"tweet_id": tweetID}, "POST")
	case "unbookmark":
		_, err = GQL("DeleteBookmark", Vars{"tweet_id": tweetID}, "POST")
	}
	return err
}

func Follow(userID string, on bool) error {
	path := "friendships/destroy.json"
	if on {
		path = "friendships/create.json"
	}
	form := url.Values{}
	for _, k := range []string{"include_profile_interstitial_type", "include_blocking", "include_blocked_by", "include_followed_by", "include_want_retweets", "include_mute_edge", "include_can_dm", "include_can_media_tag", "include_ext_is_blue_verified", "skip_status"} {
		form.Set(k, "1")
	}
	form.Set("user_id", userID)
	_, err := RestForm(path, form)
	return err
}

type ComposeOpts struct {
	Text     string   `json:"text"`
	ReplyTo  string   `json:"replyTo"`
	Quote    string   `json:"quote"`
	MediaIDs []string `json:"mediaIds"`
}

func CreateTweet(o ComposeOpts) (*Tweet, error) {
	ents := []any{}
	for _, id := range o.MediaIDs {
		ents = append(ents, map[string]any{"media_id": id, "tagged_users": []any{}})
	}
	v := Vars{
		"tweet_text":               o.Text,
		"dark_request":             false,
		"media":                    map[string]any{"media_entities": ents, "possibly_sensitive": false},
		"semantic_annotation_ids":  []any{},
		"disallowed_reply_options": jsonNull{},
	}
	if o.ReplyTo != "" {
		v["reply"] = map[string]any{"in_reply_to_tweet_id": o.ReplyTo, "exclude_reply_user_ids": []any{}}
	}
	if o.Quote != "" {
		v["attachment_url"] = o.Quote
	}
	data, err := GQL("CreateTweet", v, "POST")
	if err != nil {
		return nil, err
	}
	if errs := arr(g(data, "errors")); len(errs) > 0 {
		msg := sv(errs[0], "message")
		if msg == "" {
			msg = "Could not post"
		}
		e := xerr(msg, 422)
		if c, ok := g(errs[0], "code").(float64); ok {
			e.Code = &c
		}
		return nil, e
	}
	return ParseTweet(g(data, "data", "create_tweet", "tweet_results", "result"), 0), nil
}

// jsonNull marshals as null but isn't dropped by Vars.clean (X expects the explicit null).
type jsonNull struct{}

func (jsonNull) MarshalJSON() ([]byte, error) { return []byte("null"), nil }
