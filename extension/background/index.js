import { Storage, StorageKeys, cacheKeyForProfessor } from "../shared/storage.js";
import { normalizeNameForKey, splitName } from "../shared/nameMatcher.js";

// Default to UMass Amherst — ensures data is always filtered to this school
const UMASS_AMHERST_SCHOOL_ID = "U2Nob29sLTE1MTM";
// RMP sometimes uses alternate encodings/IDs for the same school; keep a small allow‑list.
const UMASS_SCHOOL_IDS = new Set(["U2Nob29sLTE1MTM", "U2Nob29sOjE1MTM", "1513"]);

// Extension icon click toggles the floating panel on the active tab
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOATING_PANEL" });
    } catch (_) {}
  }
});

const snapshotByTab = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RMP_DATA_UPDATE") {
    const tabId = sender.tab?.id;
    const payload = msg.payload || { courses: [] };
    if (tabId != null) snapshotByTab.set(tabId, payload);
    // Persist to storage when real courses are present
    if (payload.courses?.length > 0) {
      Storage.setJSON(StorageKeys.persistedCourses, payload.courses).catch(() => {});
      Storage.set(StorageKeys.persistedAt, Date.now()).catch(() => {});
    }
    // Broadcast to extension pages (popup, sidepanel)
    chrome.runtime.sendMessage({ type: "RMP_DATA_UPDATE", payload }).catch(() => {});
    // Relay to content scripts in the same tab so the floating panel gets live updates
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "RMP_DATA_UPDATE", payload }).catch(() => {});
    }
    return false;
  }
  if (msg.type === "OPEN_RECOMMENDATIONS") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOATING_PANEL" });
        }
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "RMP_REQUEST_SNAPSHOT") {
    (async () => {
      // Helper: load persisted courses from storage and respond
      const respondFromStorage = async () => {
        const savedCourses = await Storage.getJSON(StorageKeys.persistedCourses);
        if (savedCourses?.length > 0) {
          sendResponse({ courses: savedCourses, _fromCache: true });
        } else {
          sendResponse({ courses: [] });
        }
      };

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        await respondFromStorage();
        return;
      }

      const cached = snapshotByTab.get(tab.id);
      try {
        const snap = await chrome.tabs.sendMessage(tab.id, { type: "RMP_REQUEST_SNAPSHOT" }, { frameId: 0 });
        if (snap?.courses) snapshotByTab.set(tab.id, snap);
        // Live data is good - respond with it
        sendResponse(snap || cached || { courses: [] });
      } catch (e) {
        // Tab is not the schedule page - use in-memory cache then fall back to storage
        if (cached?.courses?.length > 0) {
          sendResponse(cached);
        } else {
          await respondFromStorage();
        }
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
  let res;
  try {
    res = await fetch("https://www.ratemyprofessors.com/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "*/*",
        "Authorization": "Basic dGVzdDp0ZXN0",
        "Referer": "https://www.ratemyprofessors.com/"
      },
      body: JSON.stringify({
        query,
        variables
      }),
      credentials: "omit",
      redirect: "follow"
    });
  } catch (e) {
    console.warn("RMP GraphQL network error:", e);
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn("RMP GraphQL HTTP error", res.status, text.slice(0, 200));
    throw new Error(`RMP GraphQL HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.errors) {
    console.warn("RMP GraphQL errors:", data.errors);
    throw new Error("RMP GraphQL errors");
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
            wouldTakeAgainPercent
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
  // When a school is configured, prefer professors from that school / known UMass IDs,
  // but gracefully fall back if RMP changes the internal ID format.
  let pool;
  if (schoolId) {
    pool = candidates.filter((c) => c.school?.id === schoolId);
    if (pool.length === 0 && UMASS_SCHOOL_IDS.has(schoolId)) {
      pool = candidates.filter((c) => UMASS_SCHOOL_IDS.has(c.school?.id));
    }
  } else {
    pool = candidates;
  }
  // Use a shorter TTL for notFound so failed lookups are retried sooner
  const notFoundTtlMs = 60 * 60 * 1000; // 1 hour
  if (pool.length === 0) {
    await Storage.setWithTTL(cacheKey, { notFound: true }, notFoundTtlMs);
    return { notFound: true };
  }
  const best = pickBestCandidate(scheduleName, pool);
  if (!best) {
    await Storage.setWithTTL(cacheKey, { notFound: true }, notFoundTtlMs);
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

const API_MESSAGE_TYPES = new Set([
  "RMP_FETCH_BATCH", "RMP_FETCH_TEACHER", "CFG_GET", "CFG_SET",
  "CACHE_CLEAR", "RMP_FETCH_ALTERNATIVES", "RMP_FETCH_ALL_FOR_SUBJECT",
  "RMP_SEARCH_TEACHERS"
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!API_MESSAGE_TYPES.has(msg.type)) return; // Let other listeners handle it
  const handler = async () => {
    if (msg.type === "RMP_FETCH_BATCH") {
      const { names, options } = msg.payload || {};
      // Always default to UMass Amherst to ensure we only get UMass professors
      const schoolId = (options && "schoolId" in options && options.schoolId)
        ? options.schoolId
        : (await Storage.get(StorageKeys.rmpSchoolId)) || UMASS_AMHERST_SCHOOL_ID;
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
      const schoolId = sid || (await Storage.get(StorageKeys.rmpSchoolId)) || UMASS_AMHERST_SCHOOL_ID;
      return fetchAlternativesForCourse(course, currentProfessorName, currentRating, schoolId);
    }
    if (msg.type === "RMP_FETCH_ALL_FOR_SUBJECT") {
      const { subject, schoolId: sid } = msg.payload || {};
      const schoolId = sid || (await Storage.get(StorageKeys.rmpSchoolId)) || UMASS_AMHERST_SCHOOL_ID;
      return fetchAllProfessorsForSubject(subject, schoolId);
    }
    if (msg.type === "RMP_SEARCH_TEACHERS") {
      const { text, schoolId: sid } = msg.payload || {};
      const schoolId = sid || (await Storage.get(StorageKeys.rmpSchoolId)) || UMASS_AMHERST_SCHOOL_ID;
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
        avgDifficulty: n.avgDifficulty,
        wouldTakeAgainPercent: n.wouldTakeAgainPercent
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

