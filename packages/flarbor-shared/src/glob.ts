/**
 * Convert a glob pattern to a RegExp.
 *
 * Supports:
 * - `**`  any path including `/`
 * - `*`   anything except `/`
 * - `?`   any single character except `/`
 *
 * `** /` at a segment boundary is treated as an optional prefix so
 * `** /foo` matches both `foo` and `bar/foo`.
 *
 * Regex metacharacters in literal parts are escaped.
 */
export function globToRegex(pattern: string): RegExp {
  let source = "^";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "*" && next === "*") {
      const after = pattern[i + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }

  source += "$";
  return new RegExp(source);
}

export function matchesGlob(filepath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(filepath));
}

function escapeRegex(char: string): string {
  return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
