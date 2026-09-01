// src/lib/patternRange.js
const METACHARS = new Set(["[", "(", ".", "\\", "*", "+", "?", "{", "|", ")"]);

const MAX_WIDTH = 4;

function extractPrefix(body) {
  let i = 0;
  while (i < body.length && !METACHARS.has(body[i])) {
    i++;
  }
  return { prefix: body.slice(0, i), rest: body.slice(i) };
}

function findGroupEnd(str, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < str.length; i++) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelAlternation(inner) {
  const branches = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "|" && depth === 0) {
      branches.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(inner.slice(start));
  return branches;
}

// Tokenize a regex tail (the part after the literal prefix) into a
// sequence of positional atoms — a literal digit, a [..] character class,
// or a (A|B|...) / (?:A|B|...) group whose branches all resolve to the
// same width (capturing and non-capturing groups are treated the same —
// we only ever test/match, never read a captured value, so the capture
// itself is irrelevant). Returns the total width, or null if the tail
// contains anything this narrow tokenizer doesn't recognize (quantifiers,
// backreferences, non-digit literals, unequal-width alternation, etc.).
function tokenizeWidth(rest) {
  let width = 0;
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "[") {
      const end = rest.indexOf("]", i);
      if (end === -1) return null;
      width += 1;
      i = end + 1;
    } else if (ch === "(") {
      const isNonCapturing = rest.slice(i, i + 3) === "(?:";
      const groupStart = isNonCapturing ? i + 3 : i + 1;
      const end = findGroupEnd(rest, i);
      if (end === -1) return null;
      const inner = rest.slice(groupStart, end);
      const branches = splitTopLevelAlternation(inner);
      if (branches.length === 0) return null;
      const branchWidths = branches.map((b) => tokenizeWidth(b));
      if (branchWidths.some((w) => w === null)) return null;
      const first = branchWidths[0];
      if (!branchWidths.every((w) => w === first)) return null;
      width += first;
      i = end + 1;
    } else if (/[0-9]/.test(ch)) {
      width += 1;
      i += 1;
    } else {
      return null;
    }
  }
  return width;
}

// Resolve an anchored regex pattern to { prefix, width } if it describes a
// fixed-width digit sequence: an all-digit literal prefix (possibly empty
// — e.g. "^(911|112|999)$" has no literal prefix at all, but still
// resolves to a small fixed-width alternation) followed by a bounded
// number of variable digit positions (<= MAX_WIDTH). Returns null
// otherwise — including when the prefix contains a non-digit character,
// which matters beyond correctness: this prefix later gets embedded in an
// AXL SQL query, so rejecting non-digit prefixes here is also what
// prevents a crafted pattern from injecting into that query. An empty
// prefix is trivially safe for that same reason — it contributes nothing
// to the query string.
function resolvePatternRange(pattern) {
  if (typeof pattern !== "string") return null;
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return null;
  const body = pattern.slice(1, -1);

  const { prefix, rest } = extractPrefix(body);
  if (!/^[0-9]*$/.test(prefix)) return null;

  const width = tokenizeWidth(rest);
  if (width === null || width === 0 || width > MAX_WIDTH) return null;

  return { prefix, width };
}

// Enumerate every number matching `pattern` under a resolved
// { prefix, width }. Brute-forces only the `width`-digit tail (<= 10,000
// iterations by construction), re-verifying every candidate against the
// real pattern via regex.test — so correctness never depends on
// resolvePatternRange's width detection being structurally perfect, only
// on the width being a safe upper bound.
function enumerateMatches(pattern, prefix, width) {
  const re = new RegExp(pattern);
  const matches = [];
  const max = 10 ** width;
  for (let i = 0; i < max; i++) {
    const candidate = prefix + String(i).padStart(width, "0");
    if (re.test(candidate)) {
      matches.push(candidate);
    }
  }
  return matches;
}

module.exports = { resolvePatternRange, enumerateMatches, MAX_WIDTH };
