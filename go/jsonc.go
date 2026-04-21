package jsonfn

import (
	"regexp"
	"strings"
)

// StripJSONC removes // comments and trailing commas to convert JSONC to JSON.
func StripJSONC(src []byte) []byte {
	s := string(src)
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		inString := false
		escaped := false
		for j := 0; j < len(line); j++ {
			ch := line[j]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' && inString {
				escaped = true
				continue
			}
			if ch == '"' {
				inString = !inString
				continue
			}
			if !inString && ch == '/' && j+1 < len(line) && line[j+1] == '/' {
				line = line[:j]
				break
			}
		}
		lines[i] = line
	}
	s = strings.Join(lines, "\n")

	re := regexp.MustCompile(`,(\s*[}\]])`)
	s = re.ReplaceAllString(s, "$1")

	return []byte(s)
}
