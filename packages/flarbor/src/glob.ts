/**
 * Convert a simple glob pattern to a RegExp.
 *
 * Supports `**` (any path including `/`), `*` (anything except `/`).
 * Regex metacharacters in literal parts are escaped.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/\*\*/g, "\0GLOBSTAR\0")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\0GLOBSTAR\0/g, ".*");

  return new RegExp(`^${escaped}$`);
}

export function matchesGlob(filepath: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(filepath));
}
