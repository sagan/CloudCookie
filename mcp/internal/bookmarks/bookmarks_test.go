package bookmarks

import (
	"strings"
	"testing"

	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
)

func samplePayload() *cloudcookie.BookmarkSlotPayload {
	return &cloudcookie.BookmarkSlotPayload{
		SchemaVersion: 1,
		Slot:          42,
		UpdatedAt:     1795692095000,
		BookmarkCount: 3,
		FolderCount:   3,
		Roots: []cloudcookie.BookmarkNode{
			{
				Title: "Bookmarks bar",
				Children: []cloudcookie.BookmarkNode{
					{Title: "GitHub", URL: "https://github.com", DateAdded: 1000},
					{
						Title: "Dev",
						Children: []cloudcookie.BookmarkNode{
							{Title: "Go Docs", URL: "https://go.dev/doc", DateAdded: 2000},
						},
					},
				},
			},
			{
				Title: "Other bookmarks",
				Children: []cloudcookie.BookmarkNode{
					{Title: "CloudCookie", URL: "https://github.com/sagan/CloudCookie"},
				},
			},
		},
	}
}

func TestFilterBookmarksAndFormatMarkdown(t *testing.T) {
	p := samplePayload()

	all, total := FilterBookmarks(p, FilterOptions{})
	if total != 3 || len(all) != 3 {
		t.Fatalf("expected 3 bookmarks, got total=%d len=%d", total, len(all))
	}
	if all[1].FolderPath != "Bookmarks bar/Dev" {
		t.Fatalf("unexpected folder path: %q", all[1].FolderPath)
	}

	byQuery, qTotal := FilterBookmarks(p, FilterOptions{Query: "github"})
	if qTotal != 2 || len(byQuery) != 2 {
		t.Fatalf("expected 2 github matches, got total=%d len=%d", qTotal, len(byQuery))
	}

	byFolder, fTotal := FilterBookmarks(p, FilterOptions{Folder: "dev"})
	if fTotal != 1 || len(byFolder) != 1 || byFolder[0].Title != "Go Docs" {
		t.Fatalf("unexpected folder filter result: %+v", byFolder)
	}

	limited, lTotal := FilterBookmarks(p, FilterOptions{Limit: 1})
	if lTotal != 3 || len(limited) != 1 {
		t.Fatalf("expected total=3 limited=1, got total=%d len=%d", lTotal, len(limited))
	}

	md := FormatMarkdown(byFolder)
	if !strings.Contains(md, "- [Go Docs](https://go.dev/doc)") {
		t.Fatalf("unexpected markdown output: %q", md)
	}
}
