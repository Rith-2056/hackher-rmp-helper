import { Storage, StorageKeys, cacheKeyForProfessor } from "../shared/storage.js";
import { normalizeNameForKey, splitName } from "../shared/nameMatcher.js";

// Simple in-memory rate limiter queue for service worker lifetime
const requestQueue = [];
let queueRunning = false;
const minIntervalMs = 350; // ~3 req/sec

async function enqueue(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    runQueue();
  });
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  let lastTime = 0;
  while (requestQueue.length > 0) {
    const { task, resolve, reject } = requestQueue.shift();
    const now = Date.now();
    const elapsed = now - lastTime;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    try {
      const result = await task();
      resolve(result);
    } catch (e) {
      reject(e);
    }
    lastTime = Date.now();
  }
  queueRunning = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rmpGraphQL(query, variables = {}) {
  const res = await fetch("https://www.ratemyprofessors.com/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "*/*"
    },
    body: JSON.stringify({
      query,
      variables
    }),
    credentials: "omit",
    redirect: "follow"
  });
  if (!res.ok) {
    throw new Error(`RMP GraphQL HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.errors) {
    throw new Error(`RMP GraphQL errors: ${JSON.stringify(data.errors).slice(0, 300)}`);
  }
  return data.data;
}

// Known-ish RMP queries (may change; handle gracefully)
const SEARCH_TEACHERS_QUERY = `
  query NewSearchTeachers($text: String!, $schoolID: ID) {
    newSearch {
      teachers(query: { text: $text, schoolID: $schoolID }) {
        edges {
          node {
            id
            legacyId
            firstName
            lastName
            department
            school { id name }
            avgRating
            numRatings
            avgDifficulty
          }
        }
      }
    }
  }
`;

const TEACHER_RATINGS_SUMMARY_QUERY = `
  query TeacherSummary($id: ID!) {
    node(id: $id) {
      ... on Teacher {
        id
        firstName
        lastName
        department
        school { id name }
        avgRating
        numRatings
        avgDifficulty
        wouldTakeAgainPercent
      }
    }
  }
`;

async function searchTeachersByName(text, schoolId) {
  try {
    const data = await enqueue(() =>
      rmpGraphQL(SEARCH_TEACHERS_QUERY, { text, schoolID: schoolId || null })
    );
    const edges = data?.newSearch?.teachers?.edges ?? [];
    return edges.map((e) => e.node);
  } catch (e) {
    console.warn("RMP search failed:", e);
    return [];
  }
}

async function getTeacherSummary(id) {
  try {
    const data = await enqueue(() => rmpGraphQL(TEACHER_RATINGS_SUMMARY_QUERY, { id }));
    const t = data?.node;
    if (!t) return null;
    return {
      id: t.id,
      firstName: t.firstName,
      lastName: t.lastName,
      department: t.department,
      school: t.school,
      avgRating: t.avgRating,
      numRatings: t.numRatings,
      avgDifficulty: t.avgDifficulty,
      wouldTakeAgainPercent: t.wouldTakeAgainPercent
    };
  } catch (e) {
    console.warn("RMP teacher summary failed:", e);
    return null;
  }
}

async function getCachedOrFetchRating(schoolId, scheduleName) {
  const { first, last } = splitName(scheduleName);
  const cacheKey = cacheKeyForProfessor(schoolId, first, last);
  const ttlMs = (await Storage.get(StorageKeys.cacheTTLms)) ?? 7 * 24 * 3600 * 1000;
  const cached = await Storage.getWithTTL(cacheKey);
  if (cached) return cached;

  // Manual mapping override
  const nm = normalizeNameForKey(scheduleName);
  const mappings = (await Storage.getJSON(StorageKeys.manualMappings)) ?? {};
  const overrideId = mappings[nm];
  if (overrideId) {
    const summary = await getTeacherSummary(overrideId);
    if (summary) {
      await Storage.setWithTTL(cacheKey, summary, ttlMs);
      return summary;
    }
  }

  const candidates = await searchTeachersByName(scheduleName, schoolId);
  // Pick best candidate by last/first match and rating count
  const best = pickBestCandidate(scheduleName, candidates);
  if (!best) {
    await Storage.setWithTTL(cacheKey, { notFound: true }, ttlMs);
    return { notFound: true };
  }
  await Storage.setWithTTL(cacheKey, best, ttlMs);
  return best;
}

function pickBestCandidate(scheduleName, candidates) {
  // Heuristic: exact last name match and first initial, prefer higher numRatings
  const { first, last } = splitName(scheduleName);
  const lastU = (last || "").toUpperCase();
  const firstU = (first || "").toUpperCase();
  const filtered = candidates.filter((c) => (c.lastName || "").toUpperCase() === lastU);
  const withFirst = filtered.filter(
    (c) => (c.firstName || "").toUpperCase().startsWith(firstU ? firstU[0] : "")
  );
  const pool = withFirst.length > 0 ? withFirst : filtered.length > 0 ? filtered : candidates;
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    const nr = (b.numRatings || 0) - (a.numRatings || 0);
    if (nr !== 0) return nr;
    const r = (b.avgRating || 0) - (a.avgRating || 0);
    return r;
  });
  return simplifyTeacher(pool[0]);
}

function simplifyTeacher(t) {
  return {
    id: t.id,
    firstName: t.firstName,
    lastName: t.lastName,
    department: t.department,
    school: t.school,
    avgRating: t.avgRating,
    numRatings: t.numRatings,
    avgDifficulty: t.avgDifficulty
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = async () => {
    if (msg.type === "RMP_FETCH_BATCH") {
      const { names, options } = msg.payload || {};
      const schoolId =
        options?.schoolId || (await Storage.get(StorageKeys.rmpSchoolId)) || null;
      const out = {};
      for (const name of names || []) {
        out[name] = await getCachedOrFetchRating(schoolId, name);
      }
      return out;
    }
    if (msg.type === "RMP_FETCH_TEACHER") {
      const { teacherId } = msg.payload || {};
      if (!teacherId) return null;
      return await getTeacherSummary(teacherId);
    }
    if (msg.type === "CFG_GET") {
      const scheduleDomain = await Storage.get(StorageKeys.scheduleDomain);
      const rmpSchoolId = await Storage.get(StorageKeys.rmpSchoolId);
      const weights = await Storage.getJSON(StorageKeys.weights);
      return { scheduleDomain, rmpSchoolId, weights };
    }
    if (msg.type === "CFG_SET") {
      const { scheduleDomain, rmpSchoolId, weights } = msg.payload || {};
      if (scheduleDomain !== undefined) await Storage.set(StorageKeys.scheduleDomain, scheduleDomain);
      if (rmpSchoolId !== undefined) await Storage.set(StorageKeys.rmpSchoolId, rmpSchoolId);
      if (weights !== undefined) await Storage.setJSON(StorageKeys.weights, weights);
      return { ok: true };
    }
    if (msg.type === "CACHE_CLEAR") {
      // naive: clear all local storage
      await chrome.storage.local.clear();
      return { ok: true };
    }
    return undefined;
  };
  handler().then(sendResponse).catch((e) => {
    console.error("background handler error", e);
    sendResponse(undefined);
  });
  return true; // keep message channel for async
});

