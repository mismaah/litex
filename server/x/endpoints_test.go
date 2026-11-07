package x

import (
	"reflect"
	"testing"
)

// Home requests must match what x.com's web client sends, so the For you ranker can skip
// posts the user already saw and treat pull to refresh as a refresh.
func TestHomeVars(t *testing.T) {
	seen := []string{"1900000000000000002", "1900000000000000001"}

	v := homeVars("", HomeOpts{})
	if v["requestContext"] != "launch" {
		t.Errorf("first page requestContext = %v, want launch", v["requestContext"])
	}
	if _, ok := v["seenTweetIds"]; ok {
		t.Error("seenTweetIds should be omitted when nothing was seen")
	}

	v = homeVars("", HomeOpts{Seen: seen, Ctx: "ptr"})
	if v["requestContext"] != "ptr" {
		t.Errorf("pull to refresh requestContext = %v, want ptr", v["requestContext"])
	}
	if !reflect.DeepEqual(v["seenTweetIds"], seen) {
		t.Errorf("seenTweetIds = %v, want %v", v["seenTweetIds"], seen)
	}

	if v = homeVars("", HomeOpts{Ctx: "bogus"}); v["requestContext"] != "launch" {
		t.Errorf("unknown ctx should fall back to launch, got %v", v["requestContext"])
	}

	v = homeVars("CURSOR", HomeOpts{Seen: seen, Ctx: "ptr"})
	if _, ok := v["requestContext"]; ok {
		t.Error("later pages must not send requestContext")
	}
	if v["cursor"] != "CURSOR" || !reflect.DeepEqual(v["seenTweetIds"], seen) {
		t.Errorf("later page vars = %v", v)
	}
}
