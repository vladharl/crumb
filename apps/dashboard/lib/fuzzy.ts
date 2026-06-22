// Fuzzy, multi-term matching for the inbox search box.
//
// The haystack is the server-built, already-lowercased blob of everything
// searchable about an item — title, body, AI summary, account, people,
// initiative, type, status, and every comment/reply (see loadItems'
// `search_text`). Search is a boolean FILTER, not a ranking: the inbox keeps
// its own tab/sort order, we just decide which rows survive the query.
//
// Each whitespace-separated term must match (AND). A term matches as a
// substring — the fast path that now covers most real queries since the
// haystack spans bodies and comments — or, for terms of 4+ characters, within a
// small edit distance of some word in the haystack, so typos still find things
// ("datepkcer" → "datepicker").

/** Normalize + split a raw query into the terms that must all match. */
export function splitTerms(query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? q.split(/\s+/) : [];
}

/** True when every term matches the (pre-lowercased) haystack. */
export function matchesTerms(terms: string[], haystack: string): boolean {
  for (const term of terms) if (!termMatches(term, haystack)) return false;
  return true;
}

/** Convenience wrapper: split `query` and match against `haystack`. */
export function fuzzyMatch(query: string, haystack: string): boolean {
  const terms = splitTerms(query);
  return terms.length === 0 || matchesTerms(terms, haystack);
}

function termMatches(term: string, haystack: string): boolean {
  if (haystack.includes(term)) return true; // exact substring — most matches
  if (term.length < 4) return false; // too short to fuzz without noise
  const maxDist = term.length <= 6 ? 1 : 2; // allow 1–2 typos by length
  // Walk the haystack's words in place (it's whitespace-collapsed) and only fuzz
  // the length-compatible ones, so a long blob full of comments stays cheap.
  let start = -1;
  for (let i = 0, len = haystack.length; i <= len; i++) {
    const sep = i === len || haystack.charCodeAt(i) === 32; // 32 = space
    if (!sep) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const wordLen = i - start;
      if (Math.abs(wordLen - term.length) <= maxDist) {
        const word = haystack.slice(start, i);
        if (boundedDamerau(term, word, maxDist) <= maxDist) return true;
      }
      start = -1;
    }
  }
  return false;
}

// Damerau–Levenshtein (optimal string alignment) distance with an early exit.
// Like Levenshtein but an adjacent transposition ("cohrot" → "cohort") costs 1,
// not 2 — the most common typo class, so it belongs under a tight budget. Once
// an entire DP row exceeds `max`, no completion can come back under budget, so
// we bail with max+1. Three rolling rows (i-2, i-1, i) keep it O(min(a,b)) space
// — the i-2 row is what the transposition case needs.
function boundedDamerau(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev2 = new Array<number>(bl + 1);
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const bc = b.charCodeAt(j - 1);
      const cost = ac === bc ? 0 : 1;
      let d = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && ac === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bc) {
        d = Math.min(d, prev2[j - 2] + 1); // adjacent transposition
      }
      curr[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev2;
    prev2 = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bl];
}
