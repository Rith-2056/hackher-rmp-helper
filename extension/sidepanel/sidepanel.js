import { searchProfessors, fetchTeacherForNameBatch } from "../shared/rmpClient.js";
import { Storage, StorageKeys } from "../shared/storage.js";

/** UMass Amherst RMP School IDs – try multiple formats (GraphQL format varies) */
const UMAS_SCHOOL_IDS = ["U2Nob29sLTE1MTM", "U2Nob29sOjE1MTM", "1513"];

const STATE = {
  snapshot: null,
  addedProfessors: []
};

async function getSchoolId() {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: "CFG_GET" });
    if (cfg?.rmpSchoolId) return cfg.rmpSchoolId;
  } catch (_) {}
  return UMAS_SCHOOL_IDS[0];
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getRatingClass(avgRating) {
  if (avgRating == null || avgRating === undefined || Number.isNaN(avgRating)) return "pill-rating-na";
  const r = Number(avgRating);
  if (r < 2.5) return "pill-rating-red";
  if (r < 3) return "pill-rating-red-yellow";
  if (r < 3.5) return "pill-rating-yellow";
  if (r < 4) return "pill-rating-yellow-green"; /* 3.5–4.0: blend of yellow + green */
  if (r < 4.5) return "pill-rating-light-green";
  return "pill-rating-bold-green";
}

function renderPill(content, className = "") {
  return `<span class="pill pill-hover ${className}">${escapeHtml(content)}</span>`;
}

function renderCourseBlock(course, options = {}) {
  const { courseKey, sections } = course;
  const { showRemoveButton = false } = options;
  if (!sections?.length) return "";
  const rows = sections.map((s) => {
    const ratingStr = s.avgRating != null ? s.avgRating.toFixed(1) : "n/a";
    const diffStr = s.avgDifficulty != null ? s.avgDifficulty.toFixed(1) : "n/a";
    const countStr = `(${s.numRatings || 0})`;
    const ratingClass = getRatingClass(s.avgRating);
    const pills = [
      renderPill(`⭐ ${ratingStr}`, `pill-rating ${ratingClass}`),
      renderPill(`Diff ${diffStr}`, "pill-diff pill-hover"),
      renderPill(countStr, "pill-count pill-hover")
    ].join(" ");
    const sectionLabel = s.sectionId ? ` <span class="prof-section">Sec ${escapeHtml(s.sectionId)}</span>` : "";
    const rmpHref = s.rmpUrl || `https://www.ratemyprofessors.com/search/professors?q=${encodeURIComponent(s.professorName || "")}`;
    const removeBtn = showRemoveButton
      ? `<button type="button" class="btn-remove-prof" data-prof-name="${escapeHtml(s.professorName || "")}" title="Remove from schedule">−</button>`
      : "";
    const rowClass = showRemoveButton ? "prof-row glass-card prof-row-with-remove" : "prof-row glass-card";
    return `
      <div class="${rowClass}" data-id="${escapeHtml(s.elementFingerprint)}" data-prof-name="${escapeHtml(s.professorName || "")}">
        <div class="prof-main">
          <span class="prof-name">${escapeHtml(s.professorName)}${sectionLabel}</span>
          <div class="prof-pills">${pills}</div>
          ${s.timeText ? `<span class="prof-time">${escapeHtml(s.timeText)}</span>` : ""}
        </div>
        ${removeBtn}
        <a href="${escapeHtml(rmpHref)}" target="_blank" rel="noopener noreferrer" class="btn-find glass-btn">View on RMP</a>
      </div>
    `;
  }).join("");
  return `
    <div class="course-card glass-card">
      <h2 class="course-title">${escapeHtml(courseKey)}</h2>
      <div class="prof-rows">${rows}</div>
    </div>
  `;
}

function groupSectionsByCourse(sections) {
  const byCourse = new Map();
  for (const s of sections || []) {
    const key = s.courseKey || `${s.subject || ""} ${s.course || ""}`.trim() || "Other";
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key).push(s);
  }
  return [...byCourse.entries()].map(([courseKey, secs]) => ({ courseKey, sections: secs }));
}

function render(state) {
  const container = document.getElementById("courseList");
  const emptyEl = document.getElementById("emptyMsg");
  const headerEl = document.getElementById("scheduleHeader");
  const cacheBadge = document.getElementById("cacheBadge");

  // Show/hide the "saved from last schedule visit" badge
  if (cacheBadge) {
    cacheBadge.style.display = state?._fromCache ? "block" : "none";
  }

  const isManual = state?.viewMode === "manual";
  const hasScrapedSchedules = state?.viewMode === "generated" && state?.schedules?.length > 0;
  const hasScrapedCourses = !isManual && state?.courses?.length > 0;
  const hasAdded = STATE.addedProfessors.length > 0;

  if (isManual) {
    STATE.snapshot = state;
    if (!hasAdded) {
      container.innerHTML = "";
      emptyEl.style.display = "block";
      headerEl.style.display = "none";
      return;
    }
    emptyEl.style.display = "none";
    headerEl.style.display = "flex";
    const sections = STATE.addedProfessors.map((p) => ({
      professorName: p.name,
      avgRating: p.avgRating,
      avgDifficulty: p.avgDifficulty,
      numRatings: p.numRatings,
      department: p.department,
      rmpUrl: p.legacyId ? `https://www.ratemyprofessors.com/professor/${p.legacyId}` : null,
      courseKey: "My Schedule",
      sectionId: null,
      timeText: null,
      elementFingerprint: null
    }));
    const manualCourse = { courseKey: "My Schedule", sections };
    container.innerHTML = renderCourseBlock(manualCourse, { showRemoveButton: true });
    container.querySelectorAll(".btn-remove-prof").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeProfessorFromSchedule(btn.dataset.profName);
      });
    });
    return;
  }

  const hasSchedules = hasScrapedSchedules;
  const hasCourses = hasScrapedCourses || hasAdded;

  if (!hasSchedules && !hasCourses) {
    container.innerHTML = "";
    emptyEl.style.display = "block";
    headerEl.style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  headerEl.style.display = "none";

  if (hasSchedules) {
    container.innerHTML = state.schedules.map((sch, idx) => {
      const groups = groupSectionsByCourse(sch.sections);
      const scheduleTitle = state.schedules.length > 1 ? `Schedule ${idx + 1}` : "Schedule";
      const blocks = groups.map((g) => renderCourseBlock(g)).join("");
      return `
        <details class="schedule-group glass-card" ${idx === 0 ? "open" : ""}>
          <summary class="schedule-summary">${scheduleTitle}</summary>
          <div class="schedule-sections">${blocks}</div>
        </details>
      `;
    }).join("");
  } else {
    container.innerHTML = state.courses.map(renderCourseBlock).join("");
  }
}

async function scrollToElement(elementId) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "RMP_SCROLL_TO",
      payload: { elementId }
    });
  } catch (e) {
    console.warn("[RMP Helper]", e.message);
  }
}

async function requestSnapshot() {
  try {
    return await chrome.runtime.sendMessage({ type: "RMP_REQUEST_SNAPSHOT" });
  } catch (e) {
    console.warn("[RMP Helper]", e.message);
    return { courses: [] };
  }
}

function isUMassProfessor(r) {
  const name = (r?.school?.name || "").toLowerCase();
  return name.includes("massachusetts") || name.includes("umass") || name.includes("amherst");
}

function renderSearchResultCard(prof, showAddButton) {
  const name = prof.name || "";
  const ratingStr = prof.avgRating != null ? prof.avgRating.toFixed(1) : "n/a";
  const diffStr = prof.avgDifficulty != null ? prof.avgDifficulty.toFixed(1) : "n/a";
  const countStr = `(${prof.numRatings || 0})`;
  const ratingClass = getRatingClass(prof.avgRating);
  const pills = [
    renderPill(`⭐ ${ratingStr}`, `pill-rating ${ratingClass}`),
    renderPill(`Diff ${diffStr}`, "pill-diff pill-hover"),
    renderPill(countStr, "pill-count pill-hover")
  ].join(" ");
  const rmpHref = prof.legacyId
    ? `https://www.ratemyprofessors.com/professor/${prof.legacyId}`
    : `https://www.ratemyprofessors.com/search/professors?q=${encodeURIComponent(name)}`;
  const schoolName = prof.school?.name || "UMass Amherst";
  const addBtn = showAddButton
    ? `<button type="button" class="btn-add-prof" data-prof-id="${escapeHtml(prof.id || "")}" data-prof-name="${escapeHtml(name)}" title="Add to schedule">+</button>`
    : "";
  return `
    <div class="search-result-card prof-card-with-add">
      ${addBtn}
      <div class="prof-row glass-card">
        <div class="prof-main">
          <span class="prof-name">${escapeHtml(name)}</span>
          <span class="prof-school">${escapeHtml(schoolName)}</span>
          ${prof.department ? `<span class="prof-time">${escapeHtml(prof.department)}</span>` : ""}
          <div class="prof-pills" style="margin-top:8px;">${pills}</div>
        </div>
        <a href="${escapeHtml(rmpHref)}" target="_blank" rel="noopener noreferrer" class="btn-find glass-btn">View on RMP</a>
      </div>
    </div>
  `;
}

async function addProfessorToSchedule(prof) {
  const existing = STATE.addedProfessors.find((p) =>
    (p.name || "").toLowerCase() === (prof.name || "").toLowerCase()
  );
  if (existing) return;
  const entry = {
    id: prof.id,
    legacyId: prof.legacyId,
    name: prof.name || "",
    department: prof.department,
    avgRating: prof.avgRating,
    avgDifficulty: prof.avgDifficulty,
    numRatings: prof.numRatings,
    school: prof.school
  };
  STATE.addedProfessors.push(entry);
  await persistAddedProfessors();
  const snap = STATE.snapshot || { viewMode: "manual", schedules: [], courses: [] };
  if (!snap.viewMode) snap.viewMode = "manual";
  render(snap);
}

async function removeProfessorFromSchedule(professorName) {
  STATE.addedProfessors = STATE.addedProfessors.filter(
    (p) => (p.name || "").toLowerCase() !== (professorName || "").toLowerCase()
  );
  await persistAddedProfessors();
  const snap = STATE.snapshot || { viewMode: "manual", schedules: [], courses: [] };
  if (!snap.viewMode) snap.viewMode = "manual";
  render(snap);
}

async function persistAddedProfessors() {
  try {
    await Storage.setJSON(StorageKeys.persistedAddedProfessors, STATE.addedProfessors);
  } catch (e) {
    console.warn("[ZooReviews] Could not persist added professors:", e);
  }
}

async function runSearch(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return;
  const resultEl = document.getElementById("searchResult");
  const dropdownEl = document.getElementById("searchDropdown");
  dropdownEl.style.display = "none";

  resultEl.style.display = "block";
  resultEl.innerHTML = '<div class="search-result-loading">Searching…</div>';
  try {
    const schoolId = await getSchoolId();
    let ratings = await fetchTeacherForNameBatch([trimmed], { schoolId });
    let r = ratings?.[trimmed];
    if ((!r || r.notFound) && schoolId) {
      ratings = await fetchTeacherForNameBatch([trimmed], { schoolId: null });
      const rAny = ratings?.[trimmed];
      if (rAny && !rAny.notFound && isUMassProfessor(rAny)) r = rAny;
    }
    if (!r || r.notFound) {
      resultEl.innerHTML = `<div class="search-result-notfound">No UMass professor found for "${escapeHtml(trimmed)}". Try full name (e.g. "Nikko Bovornkeeratiroj").</div>`;
      return;
    }
    const prof = {
      id: r.id,
      legacyId: r.legacyId,
      name: `${r.firstName || ""} ${r.lastName || ""}`.trim() || trimmed,
      department: r.department,
      school: r.school,
      avgRating: r.avgRating,
      numRatings: r.numRatings,
      avgDifficulty: r.avgDifficulty
    };
    resultEl.innerHTML = `
      <div class="search-result-title">UMass professor</div>
      ${renderSearchResultCard(prof, true)}
    `;

    resultEl.querySelector(".btn-add-prof")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addProfessorToSchedule(prof);
    });
  } catch (e) {
    resultEl.innerHTML = `<div class="search-result-notfound">Search failed: ${escapeHtml(e?.message || "Unknown error")}</div>`;
  }
}

let dropdownDebounce = null;
let ddActiveIndex = -1;

// Highlight the matched part of a professor's name in the dropdown
function highlightMatch(text, query) {
  if (!text || !query) return escapeHtml(text);
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return escapeHtml(text);
  const before = escapeHtml(text.substring(0, idx));
  const match = escapeHtml(text.substring(idx, idx + query.length));
  const after = escapeHtml(text.substring(idx + query.length));
  return `${before}<strong>${match}</strong>${after}`;
}

// Update active suggestion styling and scroll into view
function setDropdownActive(items, index) {
  items.forEach((el, i) => {
    el.classList.toggle("search-dropdown-item--active", i === index);
  });
  if (items[index]) {
    items[index].scrollIntoView({ block: "nearest" });
  }
}

async function updateDropdown(query) {
  const trimmed = (query || "").trim();
  const dropdownEl = document.getElementById("searchDropdown");
  ddActiveIndex = -1;  // Reset active index on every new search

  if (trimmed.length < 2) {
    dropdownEl.style.display = "none";
    dropdownEl.innerHTML = "";
    return;
  }
  if (dropdownDebounce) clearTimeout(dropdownDebounce);
  dropdownDebounce = setTimeout(async () => {
    dropdownDebounce = null;
    try {
      const schoolId = await getSchoolId();
      const results = await searchProfessors(trimmed, schoolId) || [];
      const umassOnly = results.filter((r) => isUMassProfessor(r));
      const list = (umassOnly.length > 0 ? umassOnly : results).slice(0, 8);

      if (list.length === 0) {
        dropdownEl.style.display = "none";
        dropdownEl.innerHTML = "";
        return;
      }
      dropdownEl.innerHTML = list
        .map((p) => {
          const name = p.name || "";
          const dept = p.department ? `<span class="dd-dept">${escapeHtml(p.department)}</span>` : "";
          const rating = typeof p.avgRating === "number"
            ? `<span class="dd-rating">⭐ ${p.avgRating.toFixed(1)}</span>` : "";
          const highlighted = highlightMatch(name, trimmed);
          return `
            <div class="search-dropdown-item" data-prof-name="${escapeHtml(name)}" tabindex="-1">
              <span class="dd-name">${highlighted}</span>
              <span class="dd-meta">${dept}${rating}</span>
            </div>`;
        })
        .join("");
      dropdownEl.style.display = "block";

      dropdownEl.querySelectorAll(".search-dropdown-item").forEach((item) => {
        item.addEventListener("click", () => {
          const name = item.dataset.profName;
          document.getElementById("searchInput").value = name;
          dropdownEl.style.display = "none";
          runSearch(name);
        });
      });
    } catch (_) {
      dropdownEl.style.display = "none";
      dropdownEl.innerHTML = "";
    }
  }, 200);
}

async function refresh() {
  let snap = await requestSnapshot();
  // If background returned no live courses and no stored courses via the background fallback,
  // try loading persisted courses directly from storage (sidepanel direct access)
  if ((!snap?.courses?.length) && !snap?._fromCache) {
    try {
      const savedCourses = await Storage.getJSON(StorageKeys.persistedCourses);
      if (savedCourses?.length > 0) {
        snap = { courses: savedCourses, _fromCache: true };
      }
    } catch (e) {
      console.warn("[ZooReviews] Could not load persisted courses:", e);
    }
  }
  STATE.snapshot = snap;
  render(snap);
}

async function init() {
  // Load persisted added professors from storage before first render
  try {
    const saved = await Storage.getJSON(StorageKeys.persistedAddedProfessors);
    if (Array.isArray(saved) && saved.length > 0) {
      STATE.addedProfessors = saved;
    }
  } catch (e) {
    console.warn("[ZooReviews] Could not load persisted added professors:", e);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "RMP_DATA_UPDATE" && msg.payload) {
      STATE.snapshot = msg.payload;
      render(msg.payload);
    }
  });

  document.getElementById("btnRefresh").addEventListener("click", refresh);

  const searchInput = document.getElementById("searchInput");
  const btnSearch = document.getElementById("btnSearch");

  btnSearch.addEventListener("click", () => runSearch(searchInput.value));

  searchInput.addEventListener("keydown", (e) => {
    const dropdown = document.getElementById("searchDropdown");
    const items = [...dropdown.querySelectorAll(".search-dropdown-item")];

    // Handle arrow keys and enter only when dropdown is open
    if (dropdown.style.display !== "none" && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        ddActiveIndex = (ddActiveIndex + 1) % items.length;
        setDropdownActive(items, ddActiveIndex);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        ddActiveIndex = (ddActiveIndex - 1 + items.length) % items.length;
        setDropdownActive(items, ddActiveIndex);
        return;
      }
      if (e.key === "Enter" && ddActiveIndex >= 0) {
        e.preventDefault();
        const name = items[ddActiveIndex].dataset.profName;
        searchInput.value = name;
        dropdown.style.display = "none";
        runSearch(name);
        return;
      }
    }

    // Handle escape key to close dropdown
    if (e.key === "Escape") {
      dropdown.style.display = "none";
      ddActiveIndex = -1;
      return;
    }

    // Handle enter when no item is selected
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch(searchInput.value);
    }
  });

  searchInput.addEventListener("input", () => updateDropdown(searchInput.value));
  searchInput.addEventListener("focus", () => updateDropdown(searchInput.value));

  document.addEventListener("click", (e) => {
    const dropdown = document.getElementById("searchDropdown");
    const wrap = document.querySelector(".search-wrap");
    if (dropdown && wrap && !wrap.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });

  await refresh();
}

init();
