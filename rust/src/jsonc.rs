/// Strips `// ...` line comments and trailing commas, converting JSONC to
/// strict JSON. Mirrors Go's `StripJSONC`.
pub fn strip_jsonc(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for (li, line) in src.split('\n').enumerate() {
        if li > 0 {
            out.push('\n');
        }
        let bytes = line.as_bytes();
        let mut in_string = false;
        let mut escaped = false;
        let mut end = bytes.len();
        let mut j = 0;
        while j < bytes.len() {
            let ch = bytes[j];
            if escaped {
                escaped = false;
                j += 1;
                continue;
            }
            if ch == b'\\' && in_string {
                escaped = true;
                j += 1;
                continue;
            }
            if ch == b'"' {
                in_string = !in_string;
                j += 1;
                continue;
            }
            if !in_string && ch == b'/' && j + 1 < bytes.len() && bytes[j + 1] == b'/' {
                end = j;
                break;
            }
            j += 1;
        }
        out.push_str(&line[..end]);
    }

    strip_trailing_commas(&out)
}

fn strip_trailing_commas(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        if escaped {
            out.push(ch as char);
            escaped = false;
            i += 1;
            continue;
        }
        if in_string {
            if ch == b'\\' {
                escaped = true;
            } else if ch == b'"' {
                in_string = false;
            }
            out.push(ch as char);
            i += 1;
            continue;
        }
        if ch == b'"' {
            in_string = true;
            out.push(ch as char);
            i += 1;
            continue;
        }
        if ch == b',' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                i += 1;
                continue;
            }
        }
        out.push(ch as char);
        i += 1;
    }
    out
}
