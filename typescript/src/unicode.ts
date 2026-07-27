/** Return the Unicode code points in a string as one string per point. */
export function codePoints(value: string): string[] {
  return Array.from(value);
}

/** Count Unicode code points rather than UTF-16 code units. */
export function codePointLength(value: string): number {
  let length = 0;
  for (const _point of value) length++;
  return length;
}

/** Read one Unicode code point without materializing the whole string. */
export function codePointAt(value: string, index: number): string | undefined {
  if (index < 0) return undefined;
  let current = 0;
  for (const point of value) {
    if (current === index) return point;
    current++;
  }
  return undefined;
}

/** Slice a string using Unicode code-point offsets. */
export function codePointSlice(value: string, start: number, end?: number): string {
  return codePoints(value).slice(start, end).join("");
}

/** Find a substring and return its Unicode code-point offset. */
export function codePointIndexOf(value: string, search: string): number {
  const haystack = codePoints(value);
  const needle = codePoints(search);
  if (needle.length === 0) return 0;

  const lastStart = haystack.length - needle.length;
  for (let start = 0; start <= lastStart; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}
