// Basic name normalization and matching heuristics

export function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

export function normalizeNameForKey(name) {
  return normalizeWhitespace(name)
    .replace(/\./g, "")
    .replace(/,/g, "")
    .toUpperCase();
}

export function splitName(name) {
  const norm = normalizeWhitespace(name).replace(/,/g, "");
  const parts = norm.split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: "", last: parts[0] };
  // Assume last token is last name, first token is first name; ignore middle names/initials
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function namesLikelyMatch(scheduleName, rmpFirst, rmpLast) {
  const { first, last } = splitName(scheduleName);
  if (!last || !rmpLast) return false;
  if (last.toUpperCase() !== rmpLast.toUpperCase()) return false;
  if (!first || !rmpFirst) return true; // last name match only
  // compare first initial
  return first[0].toUpperCase() === rmpFirst[0].toUpperCase();
}

export function rankCandidatesByCloseness(scheduleName, candidates) {
  const { first, last } = splitName(scheduleName);
  const firstU = (first || "").toUpperCase();
  const lastU = (last || "").toUpperCase();
  return candidates
    .map((c) => {
      let score = 0;
      if (c.lastName?.toUpperCase() === lastU) score += 5;
      if (c.firstName?.toUpperCase() === firstU) score += 3;
      else if (c.firstName?.[0]?.toUpperCase() === firstU[0]) score += 2;
      // Prefer more ratings
      if (typeof c.numRatings === "number") score += Math.min(3, Math.floor(c.numRatings / 20));
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

