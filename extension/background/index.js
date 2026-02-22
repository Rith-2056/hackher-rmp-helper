import { Storage, StorageKeys, cacheKeyForProfessor } from "../shared/storage.js";
import { normalizeNameForKey, splitName } from "../shared/nameMatcher.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const snapshotByTab = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RMP_DATA_UPDATE") {
    const tabId = sender.tab?.id;
    const payload = msg.payload || { courses: [] };
    if (tabId != null) snapshotByTab.set(tabId, payload);
    chrome.runtime.sendMessage({ type: "RMP_DATA_UPDATE", payload }).catch(() => {});
    return false;
  }
  if (msg.type === "OPEN_RECOMMENDATIONS") {
    (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        if (win?.id) await chrome.sidePanel.open({ windowId: win.id });
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "RMP_REQUEST_SNAPSHOT") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ courses: [] });
        return;
      }
      const cached = snapshotByTab.get(tab.id);
      try {
        const snap = await chrome.tabs.sendMessage(tab.id, { type: "RMP_REQUEST_SNAPSHOT" }, { frameId: 0 });
        if (snap?.courses) snapshotByTab.set(tab.id, snap);
        sendResponse(snap || cached || { courses: [] });
      } catch (e) {
        sendResponse(cached || { courses: [] });
      }
    })();
    return true;
  }
  return undefined;
});

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
        legacyId
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

// Subject code -> RMP search terms (RMP often indexes by department name)
const SUBJECT_SEARCH_TERMS = {
  STAT: "Statistics",
  STATS: "Statistics",
  MATH: "Mathematics",
  CS: "Computer Science",
  CMPSCI: "Computer Science",
  COMPSCI: "Computer Science",
  ECON: "Economics",
  PSYCH: "Psychology",
  HIST: "History",
  CHEM: "Chemistry",
  PHYS: "Physics",
  BIO: "Biology",
  BIOL: "Biology",
  ENGL: "English",
  POLI: "Political Science",
  SOC: "Sociology"
};

function getSearchTermForSubject(subject) {
  const key = (subject || "").toUpperCase().replace(/\s+/g, "");
  return SUBJECT_SEARCH_TERMS[key] || subject || "";
}

// Get ALL professors for a subject at UMass (no rating filter). Sorted by rating.
async function fetchAllProfessorsForSubject(subject, schoolId) {
  if (!schoolId) return [];
  const rawSubject = (subject || "").split(/\s+/)[0] || "";
  if (!rawSubject || rawSubject.length < 2) return [];
  const searchTerm = getSearchTermForSubject(rawSubject) || rawSubject;

  const candidates = await searchTeachersByName(searchTerm, schoolId);
  const pool = candidates
    .filter((c) => c.school?.id === schoolId)
    .filter((c) => (c.numRatings || 0) >= 1)
    .sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));

  return pool.map((c) => ({
    name: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    avgRating: c.avgRating,
    avgDifficulty: c.avgDifficulty,
    numRatings: c.numRatings,
    department: c.department
  }));
}

// Get alternative professors from UMass (same dept/subject) with higher ratings than current.
// Used when current professor has a low rating and we want to suggest others not on the schedule.
async function fetchAlternativesForCourse(course, currentProfessorName, currentRating, schoolId) {
  if (!schoolId) return [];
  const subject = (course || "").split(/\s+/)[0] || "";
  if (!subject || subject.length < 2) return [];
  const minRating = Math.max(2.5, (currentRating || 0) + 0.5);
  const currentKey = normalizeNameForKey(currentProfessorName || "");
  const searchTerm = getSearchTermForSubject(subject) || subject;

  const candidates = await searchTeachersByName(searchTerm, schoolId);
  const pool = candidates
    .filter((c) => c.school?.id === schoolId)
    .filter((c) => {
      const key = normalizeNameForKey(`${c.firstName || ""} ${c.lastName || ""}`);
      return key !== currentKey;
    })
    .filter((c) => (c.avgRating || 0) >= minRating && (c.numRatings || 0) >= 1)
    .sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));

  return pool.slice(0, 5).map((c) => ({
    name: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    avgRating: c.avgRating,
    avgDifficulty: c.avgDifficulty,
    numRatings: c.numRatings,
    department: c.department
  }));
}

async function getTeacherSummary(id) {
  try {
    const data = await enqueue(() => rmpGraphQL(TEACHER_RATINGS_SUMMARY_QUERY, { id }));
    const t = data?.node;
    if (!t) return null;
    return {
      id: t.id,
      legacyId: t.legacyId,
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
  // When a school is configured, only accept professors from that school.
  // Never fall back to another school — that would show the wrong person.
  const pool = schoolId
    ? candidates.filter((c) => c.school?.id === schoolId)
    : candidates;
  if (pool.length === 0) {
    await Storage.setWithTTL(cacheKey, { notFound: true }, ttlMs);
    return { notFound: true };
  }
  const best = pickBestCandidate(scheduleName, pool);
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
  // Prefer exact full-name match; break ties by numRatings
  pool.sort((a, b) => {
    const aExact = a.firstName?.toUpperCase() === firstU && a.lastName?.toUpperCase() === lastU ? 1 : 0;
    const bExact = b.firstName?.toUpperCase() === firstU && b.lastName?.toUpperCase() === lastU ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    return (b.numRatings || 0) - (a.numRatings || 0);
  });
  return simplifyTeacher(pool[0]);
}

function simplifyTeacher(t) {
  return {
    id: t.id,
    legacyId: t.legacyId,
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
      const badgeColor = await Storage.get(StorageKeys.badgeColor);
      return { scheduleDomain, rmpSchoolId, weights, badgeColor };
    }
    if (msg.type === "CFG_SET") {
      const { scheduleDomain, rmpSchoolId, weights, badgeColor } = msg.payload || {};
      if (scheduleDomain !== undefined) await Storage.set(StorageKeys.scheduleDomain, scheduleDomain);
      if (rmpSchoolId !== undefined) await Storage.set(StorageKeys.rmpSchoolId, rmpSchoolId);
      if (weights !== undefined) await Storage.setJSON(StorageKeys.weights, weights);
      if (badgeColor !== undefined) await Storage.set(StorageKeys.badgeColor, badgeColor);
      return { ok: true };
    }
    if (msg.type === "CACHE_CLEAR") {
      await chrome.storage.local.clear();
      return { ok: true };
    }
    if (msg.type === "RMP_FETCH_ALTERNATIVES") {
      const { course, currentProfessorName, currentRating, schoolId: sid } = msg.payload || {};
      const schoolId = sid || (await Storage.get(StorageKeys.rmpSchoolId));
      return fetchAlternativesForCourse(course, currentProfessorName, currentRating, schoolId);
    }
    if (msg.type === "RMP_FETCH_ALL_FOR_SUBJECT") {
      const { subject, schoolId: sid } = msg.payload || {};
      const schoolId = sid || (await Storage.get(StorageKeys.rmpSchoolId));
      return fetchAllProfessorsForSubject(subject, schoolId);
    }
    if (msg.type === "RMP_SEARCH_TEACHERS") {
      const { text, schoolId: sid } = msg.payload || {};
      const schoolId = sid || (await Storage.get(StorageKeys.rmpSchoolId));
      const trimmed = (text || "").trim();
      if (!trimmed || trimmed.length < 2) return [];
      const nodes = await searchTeachersByName(trimmed, schoolId);
      return (nodes || []).map((n) => ({
        id: n.id,
        legacyId: n.legacyId,
        name: `${n.firstName || ""} ${n.lastName || ""}`.trim(),
        firstName: n.firstName,
        lastName: n.lastName,
        department: n.department,
        school: n.school,
        avgRating: n.avgRating,
        numRatings: n.numRatings,
        avgDifficulty: n.avgDifficulty
      }));
    }
    return undefined;
  };
  handler().then(sendResponse).catch((e) => {
    console.error("background handler error", e);
    sendResponse(undefined);
  });
  return true; // keep message channel for async
});

