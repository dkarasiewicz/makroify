/**
 * Lightweight text matching for product lookup: fold Polish diacritics, score a
 * query against a product name, and rank candidates by relevance then price.
 * Deliberately dependency-free — Makro's own search is the heavy lifter; this
 * just adds a little fuzziness and a sensible "best match, cheapest first" order.
 */
import type { Product } from "./types";

const DIACRITICS: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z",
};

/** Lowercase + strip Polish diacritics. */
export function foldDiacritics(s: string): string {
  return s.toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => DIACRITICS[c] ?? c);
}

/** Normalize for comparison: fold diacritics, drop punctuation, collapse spaces. */
export function normalize(s: string): string {
  return foldDiacritics(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter((t) => t.length > 1);
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether two tokens are "the same word" allowing for Polish declension/typos:
 * equal, or sharing a long-enough stem (≥4 chars, within 2 of the shorter). The
 * 4-char floor stops short fragments like "ml" (millilitres) matching "mleko".
 */
function tokenSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const cp = commonPrefixLen(a, b);
  return cp >= 4 && cp >= Math.min(a.length, b.length) - 2;
}

/**
 * Ordered list of progressively looser query variants, used to retry a search
 * that returned nothing: exact → diacritic-folded → per-word → prefix of the
 * longest word (catches Polish declension and small typos).
 */
export function fuzzyQueries(raw: string): string[] {
  const q = raw.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return [];
  out.add(q);
  out.add(foldDiacritics(q));

  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    out.add(words[0]!);
    out.add(words[words.length - 1]!);
  }

  const longest = [...words].sort((a, b) => b.length - a.length)[0] ?? q;
  if (longest.length >= 6) {
    const prefix = longest.slice(0, longest.length - 2);
    out.add(prefix);
    out.add(foldDiacritics(prefix));
  }
  return [...out];
}

/**
 * Score how well a product name matches a query (higher = better, 0 = no match).
 * Rewards whole-phrase containment and token overlap, with a small bonus for a
 * name that starts with the query.
 */
export function scoreNameMatch(query: string, name: string): number {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;

  let score = 0;
  if (q.length >= 3 && n.includes(q)) score += 100;
  if (n.startsWith(q)) score += 25;

  const qt = tokens(query);
  const nt = tokens(name);
  if (qt.length) {
    // Per token, take the closest similar name word (prefix ratio), so a tighter
    // form ("truskawka") outranks a looser one ("truskawkowym") for "truskawki".
    let sum = 0;
    for (const t of qt) {
      let best = 0;
      for (const w of nt) {
        if (tokenSimilar(t, w)) best = Math.max(best, commonPrefixLen(t, w) / Math.max(t.length, w.length));
      }
      sum += best;
    }
    score += (sum / qt.length) * 60;
  }
  return Math.round(score);
}

/** True if a product/name is a plausible match for the query at all. */
export function matches(query: string, name: string | undefined): boolean {
  return Boolean(name) && scoreNameMatch(query, name!) > 0;
}

/**
 * Stricter than {@link matches}: every word of the query must have a similar
 * word in the name. Used to filter the cart / recently-bought list, where a
 * loose single-token hit (e.g. "mleko" → brand "MLEKOVITA") is a false positive.
 */
export function strongMatch(query: string, name: string | undefined): boolean {
  if (!name) return false;
  const qt = tokens(query);
  if (!qt.length) return false;
  const nt = tokens(name);
  return qt.every((t) => nt.some((w) => tokenSimilar(t, w)));
}

/** Stable de-dup of products by bundleId, preserving order. */
export function uniqueByBundle(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((p) => (seen.has(p.bundleId) ? false : seen.add(p.bundleId)));
}

const priceOf = (p: Product): number => (p.price == null ? Number.POSITIVE_INFINITY : p.price);
const available = (p: Product): boolean => p.availability === "AVAILABLE" || (p.stock ?? 0) > 0;

/**
 * Rank products: best name match first, then in-stock before out-of-stock, then
 * cheapest. Mirrors "closest match, then cheapest" from the shopping flow.
 */
export function rankByMatchThenPrice(query: string, products: Product[]): Product[] {
  return [...products].sort((a, b) => {
    const byMatch = scoreNameMatch(query, b.name) - scoreNameMatch(query, a.name);
    if (byMatch) return byMatch;
    const byStock = Number(available(b)) - Number(available(a));
    if (byStock) return byStock;
    return priceOf(a) - priceOf(b);
  });
}
