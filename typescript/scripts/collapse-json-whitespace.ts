const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

export function collapseJsonWhitespace(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const character of source) {
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
      result += character;
    } else if (!JSON_WHITESPACE.has(character)) {
      result += character;
    }
  }

  return result;
}

async function main(patterns: string[]): Promise<void> {
  if (patterns.length === 0) {
    throw new Error("usage: collapse-json-whitespace.ts <glob>...");
  }

  const paths = new Set<string>();
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({
      absolute: true,
      cwd: process.cwd(),
      onlyFiles: true,
    })) {
      paths.add(path);
    }
  }

  await Promise.all(
    [...paths].sort().map(async (path) => {
      const source = await Bun.file(path).text();
      const collapsed = collapseJsonWhitespace(source);
      if (collapsed !== source) await Bun.write(path, collapsed);
    }),
  );
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
