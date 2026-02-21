// Lightweight client for RateMyProfessors GraphQL API via background service worker.
// We proxy through the background for CORS and caching.

export async function fetchTeacherForNameBatch(names, options = {}) {
  return await chrome.runtime.sendMessage({
    type: "RMP_FETCH_BATCH",
    payload: { names, options }
  });
}

export async function fetchTeacherById(teacherId) {
  return await chrome.runtime.sendMessage({
    type: "RMP_FETCH_TEACHER",
    payload: { teacherId }
  });
}

