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
