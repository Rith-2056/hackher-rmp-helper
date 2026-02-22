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

export async function fetchAlternativesForCourse(course, currentProfessorName, currentRating, schoolId) {
  return await chrome.runtime.sendMessage({
    type: "RMP_FETCH_ALTERNATIVES",
    payload: { course, currentProfessorName, currentRating, schoolId }
  });
}

export async function fetchAllProfessorsForSubject(subject, schoolId) {
  return await chrome.runtime.sendMessage({
    type: "RMP_FETCH_ALL_FOR_SUBJECT",
    payload: { subject, schoolId }
  });
}

export async function searchProfessors(text, schoolId) {
  return await chrome.runtime.sendMessage({
    type: "RMP_SEARCH_TEACHERS",
    payload: { text, schoolId }
  });
}

