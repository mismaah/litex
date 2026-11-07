package main

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestSeenIDs(t *testing.T) {
	got := seenIDs("123,abc,,123,456,1;drop,99999999999999999999999999")
	if want := []string{"123", "456"}; !reflect.DeepEqual(got, want) {
		t.Errorf("seenIDs = %v, want %v", got, want)
	}
	if got := seenIDs(""); got != nil {
		t.Errorf("empty input = %v, want nil", got)
	}
	var many []string
	for i := range 300 {
		many = append(many, strconv.Itoa(i+1))
	}
	if got := seenIDs(strings.Join(many, ",")); len(got) != maxSeen || got[0] != "1" {
		t.Errorf("cap: got %d ids starting %v", len(got), got[:1])
	}
}
