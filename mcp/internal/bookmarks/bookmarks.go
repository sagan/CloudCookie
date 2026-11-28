package bookmarks

import (
	"fmt"
	"strings"

	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
)

// FlatBookmark represents a flattened bookmark with its folder path.
type FlatBookmark struct {
	Title      string `json:"title"`
	URL        string `json:"url"`
	FolderPath string `json:"folder_path"`
	DateAdded  int64  `json:"date_added,omitempty"`
}

// FilterOptions controls bookmark filtering and pagination.
type FilterOptions struct {
	Query  string
	Folder string
	Limit  int
}

// Flatten converts a BookmarkSlotPayload tree into a flat slice of bookmarks.
func Flatten(payload *cloudcookie.BookmarkSlotPayload) []FlatBookmark {
	if payload == nil {
		return nil
	}
	var out []FlatBookmark
	for _, root := range payload.Roots {
		flattenNode(root, "", &out)
	}
	return out
}

func flattenNode(node cloudcookie.BookmarkNode, prefix string, out *[]FlatBookmark) {
	if node.URL != "" {
		folder := prefix
		if folder == "" {
			folder = "Bookmarks"
		}
		title := node.Title
		if title == "" {
			title = node.URL
		}
		*out = append(*out, FlatBookmark{
			Title:      title,
			URL:        node.URL,
			FolderPath: folder,
			DateAdded:  node.DateAdded,
		})
		return
	}

	nextPrefix := node.Title
	if nextPrefix == "" {
		nextPrefix = "Folder"
	}
	if prefix != "" {
		nextPrefix = prefix + "/" + nextPrefix
	}
	for _, child := range node.Children {
		flattenNode(child, nextPrefix, out)
	}
}

// FilterBookmarks flattens and filters bookmarks by query and folder, returning
// the capped list and the total number of matches before the limit was applied.
func FilterBookmarks(payload *cloudcookie.BookmarkSlotPayload, opts FilterOptions) ([]FlatBookmark, int) {
	all := Flatten(payload)
	query := strings.ToLower(strings.TrimSpace(opts.Query))
	folder := strings.ToLower(strings.TrimSpace(opts.Folder))

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}

	var matched []FlatBookmark
	for _, b := range all {
		if folder != "" && !strings.Contains(strings.ToLower(b.FolderPath), folder) {
			continue
		}
		if query != "" {
			if !strings.Contains(strings.ToLower(b.Title), query) &&
				!strings.Contains(strings.ToLower(b.URL), query) &&
				!strings.Contains(strings.ToLower(b.FolderPath), query) {
				continue
			}
		}
		matched = append(matched, b)
	}

	total := len(matched)
	if len(matched) > limit {
		matched = matched[:limit]
	}
	return matched, total
}

// FormatMarkdown renders a slice of FlatBookmark items as a Markdown list.
func FormatMarkdown(items []FlatBookmark) string {
	if len(items) == 0 {
		return "_No matching bookmarks._"
	}
	var sb strings.Builder
	for _, b := range items {
		fmt.Fprintf(&sb, "- [%s](%s) — `%s`\n", b.Title, b.URL, b.FolderPath)
	}
	return strings.TrimRight(sb.String(), "\n")
}
