package x

import (
	"reflect"
	"testing"
)

func TestSegments(t *testing.T) {
	// A mention, an escaped "&", a url and a trailing media link (which is dropped).
	text := "@nasa hi &amp; bye https://t.co/a https://t.co/m"
	ent := map[string]any{
		"user_mentions": []any{map[string]any{"screen_name": "NASA", "indices": []any{0.0, 5.0}}},
		"urls":          []any{map[string]any{"url": "https://t.co/a", "expanded_url": "https://example.com/x", "display_url": "example.com/x", "indices": []any{19.0, 33.0}}},
		"media":         []any{map[string]any{"indices": []any{34.0, 48.0}}},
	}
	want := []Seg{{T: "mention", V: "@nasa", U: "NASA"}, {T: "text", V: " hi & bye "}, {T: "url", V: "example.com/x", Href: "https://example.com/x"}}
	if got := Segments(text, ent, nil); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	// display_text_range hides the leading reply mention; indices are code points, not bytes.
	if got := Segments("@a 😀 ok", map[string]any{}, []any{3.0, 7.0}); !reflect.DeepEqual(got, []Seg{{T: "text", V: "😀 ok"}}) {
		t.Errorf("range: got %+v", got)
	}
}

func TestExploreTimelineID(t *testing.T) {
	// The id X's web client uses for the Trending tab.
	if got := exploreTimelineID("trending"); got != "VGltZWxpbmU6DAC2CwABAAAACHRyZW5kaW5nAAA=" {
		t.Errorf("got %s", got)
	}
}

func TestIsoTime(t *testing.T) {
	for in, want := range map[any]string{"1793783354407": "2026-11-04T09:09:14.407Z", "2026-11-04T09:09:14.406Z": "2026-11-04T09:09:14.406Z", "": "", "nope": ""} {
		if got := isoTime(in); got != want {
			t.Errorf("isoTime(%v) = %q, want %q", in, got, want)
		}
	}
}

// A quoted post's video keeps its playable source, also when the quote is wrapped in
// TweetWithVisibilityResults and only has the media under extended_entities.
func TestQuotedVideoSrc(t *testing.T) {
	user := func(sn string) any {
		return map[string]any{"rest_id": "u-" + sn, "core": map[string]any{"screen_name": sn, "name": sn}}
	}
	video := map[string]any{
		"type":            "video",
		"media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
		"original_info":   map[string]any{"width": 1280.0, "height": 720.0},
		"video_info": map[string]any{
			"duration_millis": 69000.0,
			"variants": []any{
				map[string]any{"content_type": "application/x-mpegURL", "url": "https://video.twimg.com/a.m3u8"},
				map[string]any{"content_type": "video/mp4", "bitrate": 256000.0, "url": "https://video.twimg.com/low.mp4"},
				map[string]any{"content_type": "video/mp4", "bitrate": 832000.0, "url": "https://video.twimg.com/mid.mp4"},
				map[string]any{"content_type": "video/mp4", "bitrate": 2176000.0, "url": "https://video.twimg.com/high.mp4"},
			},
		},
	}
	quoted := map[string]any{
		"__typename": "TweetWithVisibilityResults",
		"tweet": map[string]any{
			"rest_id": "2",
			"core":    map[string]any{"user_results": map[string]any{"result": user("quoted")}},
			"legacy": map[string]any{
				"full_text":         "clip",
				"entities":          map[string]any{},
				"extended_entities": map[string]any{"media": []any{video}},
			},
		},
	}
	outer := map[string]any{
		"rest_id":              "1",
		"core":                 map[string]any{"user_results": map[string]any{"result": user("outer")}},
		"quoted_status_result": map[string]any{"result": quoted},
		"legacy":               map[string]any{"full_text": "look", "entities": map[string]any{}, "is_quote_status": true},
	}
	tw := ParseTweet(outer, 0)
	if tw == nil || tw.Quote == nil {
		t.Fatalf("quote not parsed: %+v", tw)
	}
	if len(tw.Quote.Media) != 1 {
		t.Fatalf("quote media: %+v", tw.Quote.Media)
	}
	m := tw.Quote.Media[0]
	if m.Type != "video" || m.Src != "https://video.twimg.com/mid.mp4" || m.Dur != 69000 {
		t.Errorf("got %+v", m)
	}
}
