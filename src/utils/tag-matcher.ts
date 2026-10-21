/**
 * Utilities for wildcard matching and hierarchical cascading of cache tags.
 */

const globRegexCache = new Map<string, RegExp>();

/**
 * Returns true if the given tag contains glob wildcard characters ('*' or '?').
 */
export function isWildcardTag(tag: string): boolean {
  return tag.includes('*') || tag.includes('?');
}

/**
 * Matches a tag name against a pattern supporting '*' (0 or more chars) and '?' (single char).
 * Optimized with fast-paths for exact match, universal wildcard, and single prefix/suffix wildcards.
 */
export function matchesTagPattern(pattern: string, tag: string): boolean {
  if (pattern === '*' || pattern === tag) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === tag;

  // Fast path: trailing single '*' (e.g. "org:123:*")
  if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*') && !pattern.includes('?')) {
    const prefix = pattern.slice(0, -1);
    return tag.startsWith(prefix);
  }

  // Fast path: leading single '*' (e.g. "*:settings")
  if (pattern.startsWith('*') && !pattern.slice(1).includes('*') && !pattern.includes('?')) {
    const suffix = pattern.slice(1);
    return tag.endsWith(suffix);
  }

  // General glob with bounded RegExp cache
  let re = globRegexCache.get(pattern);
  if (!re) {
    if (globRegexCache.size >= 1000) globRegexCache.clear();
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    re = new RegExp(`^${escaped}$`);
    globRegexCache.set(pattern, re);
  }
  return re.test(tag);
}

/**
 * Determines whether `candidateTag` is either identical to `parentTag`
 * or a child descendant in the hierarchy separated by `delimiter`.
 *
 * Example:
 *   isChildTag('org:123', 'org:123', ':') -> true
 *   isChildTag('org:123', 'org:123:dept', ':') -> true
 *   isChildTag('org:123', 'org:1234', ':') -> false (must match delimiter boundary)
 */
export function isChildTag(parentTag: string, candidateTag: string, delimiter = ':'): boolean {
  if (candidateTag === parentTag) return true;
  const prefix = parentTag.endsWith(delimiter) ? parentTag : `${parentTag}${delimiter}`;
  return candidateTag.startsWith(prefix);
}

/**
 * Expands hierarchical tags into all ancestor namespace levels.
 *
 * Example:
 *   expandHierarchicalTags(['org:123:dept:456', 'role:admin'], ':')
 *   => ['org', 'org:123', 'org:123:dept', 'org:123:dept:456', 'role', 'role:admin']
 */
export function expandHierarchicalTags(tags: string[], delimiter = ':'): string[] {
  if (!tags.length) return [];
  const result = new Set<string>();

  for (const tag of tags) {
    if (!tag) continue;
    const parts = tag.split(delimiter).filter(p => p.length > 0);
    if (parts.length <= 1) {
      result.add(tag);
      continue;
    }

    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      accumulated = i === 0 ? parts[i] : `${accumulated}${delimiter}${parts[i]}`;
      result.add(accumulated);
    }
  }

  return Array.from(result);
}
