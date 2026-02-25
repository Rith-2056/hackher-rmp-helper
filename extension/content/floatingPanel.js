/**
 * ZooReviews Floating Panel — iOS 26 Liquid Glass
 * Injected into the page via Shadow DOM. Draggable, with all sidepanel features.
 * Triggered by clicking the extension icon or via message from background.
 */

const UMAS_SCHOOL_IDS = ["U2Nob29sLTE1MTM", "U2Nob29sOjE1MTM", "1513"];

let hostEl = null;
let shadowRoot = null;
let panelVisible = false;
let panelEl = null;

const STATE = {
  snapshot: null,
  addedProfessors: []
};

// ─── Storage helpers (content script can access chrome.storage directly) ──
async function storageGet(key) {
  const result = await chrome.storage.local.get([key]);
  return result[key] ?? null;
}

async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function storageGetJSON(key) {
  const raw = await storageGet(key);
  if (raw == null) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

async function storageSetJSON(key, value) {
  await storageSet(key, value);
}

// Storage keys (must match shared/storage.js)
const SK = {
  persistedCourses: "rmp.persistedCourses",
  persistedAt: "rmp.persistedAt",
  persistedAddedProfessors: "rmp.persistedAddedProfessors"
};

// ─── Helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function getSchoolId() {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: "CFG_GET" });
    if (cfg?.rmpSchoolId) return cfg.rmpSchoolId;
  } catch (_) {}
  return UMAS_SCHOOL_IDS[0];
}

function isUMassProfessor(r) {
  const name = (r?.school?.name || "").toLowerCase();
  return name.includes("massachusetts") || name.includes("umass") || name.includes("amherst");
}

function getRatingClass(avgRating) {
  if (avgRating == null || Number.isNaN(avgRating)) return "fp-pill-na";
  const r = Number(avgRating);
  if (r < 2.5) return "fp-pill-red";
  if (r < 3) return "fp-pill-red-yellow";
  if (r < 3.5) return "fp-pill-yellow";
  if (r < 4) return "fp-pill-yellow-green";
  if (r < 4.5) return "fp-pill-light-green";
  return "fp-pill-bold-green";
}

function renderPill(content, className = "") {
  return `<span class="fp-pill ${className}">${escapeHtml(content)}</span>`;
}

// ─── RMP Client (via background) ────────────────────────────────────────
async function fetchTeacherForNameBatch(names, options) {
  return chrome.runtime.sendMessage({
    type: "RMP_FETCH_BATCH",
    payload: { names, options }
  });
}

async function searchProfessorsRMP(text, schoolId) {
  return chrome.runtime.sendMessage({
    type: "RMP_SEARCH_TEACHERS",
    payload: { text, schoolId }
  });
}

// ─── Create Shadow DOM Host ─────────────────────────────────────────────
function createShadowHost() {
  if (hostEl) return;
  hostEl = document.createElement("div");
  hostEl.id = "zooreview-floating-panel-host";
  hostEl.style.cssText = "all:initial;position:fixed;z-index:2147483645;top:0;left:0;width:0;height:0;";
  document.documentElement.appendChild(hostEl);
  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/floatingPanel.css");
  shadowRoot.appendChild(link);
}

// ─── Render Course Block ────────────────────────────────────────────────
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
      renderPill(`\u2B50 ${ratingStr}`, `fp-pill-rating ${ratingClass}`),
      renderPill(`Diff ${diffStr}`, "fp-pill-diff"),
      renderPill(countStr, "fp-pill-count")
    ].join(" ");
    const sectionLabel = s.sectionId ? ` <span class="fp-prof-section">Sec ${escapeHtml(s.sectionId)}</span>` : "";
    const rmpHref = s.rmpUrl || `https://www.ratemyprofessors.com/search/professors?q=${encodeURIComponent(s.professorName || "")}`;
    const removeBtn = showRemoveButton
      ? `<button type="button" class="fp-btn-remove" data-prof-name="${escapeHtml(s.professorName || "")}" title="Remove">\u2212</button>`
      : "";
    const rowClass = showRemoveButton ? "fp-prof-row fp-prof-row-with-remove" : "fp-prof-row";
    return `
      <div class="${rowClass}">
        <div class="fp-prof-main">
          <span class="fp-prof-name">${escapeHtml(s.professorName)}${sectionLabel}</span>
          <div class="fp-prof-pills">${pills}</div>
          ${s.timeText ? `<span class="fp-prof-time">${escapeHtml(s.timeText)}</span>` : ""}
        </div>
        ${removeBtn}
        <a href="${escapeHtml(rmpHref)}" target="_blank" rel="noopener noreferrer" class="fp-btn-rmp">View on RMP</a>
      </div>
    `;
  }).join("");
  return `
    <div class="fp-course-card">
      <h2 class="fp-course-title">${escapeHtml(courseKey)}</h2>
      <div class="fp-prof-rows">${rows}</div>
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

// ─── Render Schedule ────────────────────────────────────────────────────
function render(state) {
  if (!panelEl) return;
  const container = panelEl.querySelector("#fpCourseList");
  const emptyEl = panelEl.querySelector("#fpEmptyMsg");
  const headerEl = panelEl.querySelector("#fpScheduleHeader");
  const cacheBadge = panelEl.querySelector("#fpCacheBadge");

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
      timeText: null
    }));
    const manualCourse = { courseKey: "My Schedule", sections };
    container.innerHTML = renderCourseBlock(manualCourse, { showRemoveButton: true });
    container.querySelectorAll(".fp-btn-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeProfessorFromSchedule(btn.dataset.profName);
      });
    });
    return;
  }

  const hasCourses = hasScrapedCourses || hasAdded;

  if (!hasScrapedSchedules && !hasCourses) {
    container.innerHTML = "";
    emptyEl.style.display = "block";
    headerEl.style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  headerEl.style.display = "none";

  if (hasScrapedSchedules) {
    container.innerHTML = state.schedules.map((sch, idx) => {
      const groups = groupSectionsByCourse(sch.sections);
      const scheduleTitle = state.schedules.length > 1 ? `Schedule ${idx + 1}` : "Schedule";
      const blocks = groups.map((g) => renderCourseBlock(g)).join("");
      return `
        <details class="fp-schedule-group" ${idx === 0 ? "open" : ""}>
          <summary class="fp-schedule-summary">${scheduleTitle}</summary>
          <div>${blocks}</div>
        </details>
      `;
    }).join("");
  } else {
    container.innerHTML = state.courses.map((c) => renderCourseBlock(c)).join("");
  }
}

// ─── Search Result Card ─────────────────────────────────────────────────
function renderSearchResultCard(prof, showAddButton) {
  const name = prof.name || "";
  const ratingStr = prof.avgRating != null ? prof.avgRating.toFixed(1) : "n/a";
  const diffStr = prof.avgDifficulty != null ? prof.avgDifficulty.toFixed(1) : "n/a";
  const countStr = `(${prof.numRatings || 0})`;
  const ratingClass = getRatingClass(prof.avgRating);
  const pills = [
    renderPill(`\u2B50 ${ratingStr}`, `fp-pill-rating ${ratingClass}`),
    renderPill(`Diff ${diffStr}`, "fp-pill-diff"),
    renderPill(countStr, "fp-pill-count")
  ].join(" ");
  const rmpHref = prof.legacyId
    ? `https://www.ratemyprofessors.com/professor/${prof.legacyId}`
    : `https://www.ratemyprofessors.com/search/professors?q=${encodeURIComponent(name)}`;
  const schoolName = prof.school?.name || "UMass Amherst";
  const addBtn = showAddButton
    ? `<button type="button" class="fp-btn-add" data-prof-name="${escapeHtml(name)}" title="Add to schedule">+</button>`
    : "";
  return `
    <div class="fp-result-card">
      ${addBtn}
      <div class="fp-prof-row">
        <div class="fp-prof-main">
          <span class="fp-prof-name">${escapeHtml(name)}</span>
          <span class="fp-prof-school">${escapeHtml(schoolName)}</span>
          ${prof.department ? `<span class="fp-prof-time">${escapeHtml(prof.department)}</span>` : ""}
          <div class="fp-prof-pills" style="margin-top:6px;">${pills}</div>
        </div>
        <a href="${escapeHtml(rmpHref)}" target="_blank" rel="noopener noreferrer" class="fp-btn-rmp">View on RMP</a>
      </div>
    </div>
  `;
}

// ─── Professor Management ───────────────────────────────────────────────
async function addProfessorToSchedule(prof) {
  const existing = STATE.addedProfessors.find((p) =>
    (p.name || "").toLowerCase() === (prof.name || "").toLowerCase()
  );
  if (existing) return;
  STATE.addedProfessors.push({
    id: prof.id,
    legacyId: prof.legacyId,
    name: prof.name || "",
    department: prof.department,
    avgRating: prof.avgRating,
    avgDifficulty: prof.avgDifficulty,
    numRatings: prof.numRatings,
    school: prof.school
  });
  await storageSetJSON(SK.persistedAddedProfessors, STATE.addedProfessors);
  const snap = STATE.snapshot || { viewMode: "manual", schedules: [], courses: [] };
  if (!snap.viewMode) snap.viewMode = "manual";
  render(snap);
}

async function removeProfessorFromSchedule(professorName) {
  STATE.addedProfessors = STATE.addedProfessors.filter(
    (p) => (p.name || "").toLowerCase() !== (professorName || "").toLowerCase()
  );
  await storageSetJSON(SK.persistedAddedProfessors, STATE.addedProfessors);
  const snap = STATE.snapshot || { viewMode: "manual", schedules: [], courses: [] };
  if (!snap.viewMode) snap.viewMode = "manual";
  render(snap);
}

// ─── Search ─────────────────────────────────────────────────────────────
async function runSearch(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return;
  const resultEl = panelEl.querySelector("#fpSearchResult");
  const dropdownEl = panelEl.querySelector("#fpSearchDropdown");
  dropdownEl.style.display = "none";

  resultEl.style.display = "block";
  resultEl.innerHTML = '<div class="fp-search-loading">Searching\u2026</div>';
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
      resultEl.innerHTML = `<div class="fp-search-notfound">No UMass professor found for \u201C${escapeHtml(trimmed)}\u201D. Try full name.</div>`;
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
      <div class="fp-search-result-title">UMass professor</div>
      ${renderSearchResultCard(prof, true)}
    `;
    resultEl.querySelector(".fp-btn-add")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addProfessorToSchedule(prof);
    });
  } catch (e) {
    resultEl.innerHTML = `<div class="fp-search-notfound">Search failed: ${escapeHtml(e?.message || "Unknown error")}</div>`;
  }
}

let dropdownDebounce = null;
let ddActiveIndex = -1;

function highlightMatch(text, query) {
  if (!text || !query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = escapeHtml(text.substring(0, idx));
  const match = escapeHtml(text.substring(idx, idx + query.length));
  const after = escapeHtml(text.substring(idx + query.length));
  return `${before}<strong>${match}</strong>${after}`;
}

function setDropdownActive(items, index) {
  items.forEach((el, i) => el.classList.toggle("fp-dd-active", i === index));
  if (items[index]) items[index].scrollIntoView({ block: "nearest" });
}

async function updateDropdown(query) {
  const trimmed = (query || "").trim();
  const dropdownEl = panelEl.querySelector("#fpSearchDropdown");
  ddActiveIndex = -1;

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
      const results = await searchProfessorsRMP(trimmed, schoolId) || [];
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
          const dept = p.department ? `<span class="fp-dd-dept">${escapeHtml(p.department)}</span>` : "";
          const rating = typeof p.avgRating === "number"
            ? `<span class="fp-dd-rating">\u2B50 ${p.avgRating.toFixed(1)}</span>` : "";
          const highlighted = highlightMatch(name, trimmed);
          return `
            <div class="fp-dropdown-item" data-prof-name="${escapeHtml(name)}">
              <span class="fp-dd-name">${highlighted}</span>
              <span class="fp-dd-meta">${dept}${rating}</span>
            </div>`;
        })
        .join("");
      dropdownEl.style.display = "block";

      dropdownEl.querySelectorAll(".fp-dropdown-item").forEach((item) => {
        item.addEventListener("click", () => {
          const name = item.dataset.profName;
          panelEl.querySelector("#fpSearchInput").value = name;
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

// ─── Refresh / Snapshot ─────────────────────────────────────────────────
async function requestSnapshot() {
  try {
    return await chrome.runtime.sendMessage({ type: "RMP_REQUEST_SNAPSHOT" });
  } catch (e) {
    console.warn("[ZooReviews]", e.message);
    return { courses: [] };
  }
}

async function refresh() {
  let snap = await requestSnapshot();
  if ((!snap?.courses?.length) && !snap?._fromCache) {
    try {
      const savedCourses = await storageGetJSON(SK.persistedCourses);
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

// ─── Dragging ───────────────────────────────────────────────────────────
function setupDrag(container, header) {
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  header.addEventListener("mousedown", (e) => {
    // Don't drag on buttons
    if (e.target.closest("button")) return;
    isDragging = true;
    container.classList.add("fp-dragging");
    startX = e.clientX;
    startY = e.clientY;
    const rect = container.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;

    // Keep within viewport
    const w = container.offsetWidth;
    const h = container.offsetHeight;
    newLeft = Math.max(0, Math.min(window.innerWidth - w, newLeft));
    newTop = Math.max(0, Math.min(window.innerHeight - h, newTop));

    container.style.left = newLeft + "px";
    container.style.top = newTop + "px";
    container.style.right = "auto";
    container.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      container.classList.remove("fp-dragging");
    }
  });
}

// ─── Build Panel ────────────────────────────────────────────────────────
function buildPanel() {
  const container = document.createElement("div");
  container.className = "fp-container";

  // Default position: top-right with some margin
  container.style.top = "80px";
  container.style.right = "24px";

  container.innerHTML = `
    <div class="fp-header">
      <div class="fp-drag-indicator"></div>
      <h1 class="fp-title">ZooReviews</h1>
      <div class="fp-header-actions">
        <button class="fp-btn-icon fp-btn-refresh" title="Refresh">\u21BB</button>
        <button class="fp-btn-icon fp-btn-close" title="Close">\u00D7</button>
      </div>
    </div>
    <div class="fp-body">
      <div class="fp-search-wrap">
        <input type="text" id="fpSearchInput" class="fp-search-input" placeholder="Type professor name..." autocomplete="off" />
        <button type="button" class="fp-btn-search" title="Search">\uD83D\uDD0D</button>
        <div id="fpSearchDropdown" class="fp-search-dropdown" style="display:none;"></div>
      </div>
      <div id="fpSearchResult" class="fp-search-result" style="display:none;"></div>
      <div class="fp-schedule-section">
        <div id="fpScheduleHeader" class="fp-schedule-header" style="display:none;">
          <span class="fp-schedule-title">My Schedule</span>
        </div>
        <p id="fpCacheBadge" class="fp-cache-badge" style="display:none;">Saved from last schedule visit</p>
        <div id="fpCourseList"></div>
        <p id="fpEmptyMsg" class="fp-empty-msg" style="display:none;">Search professors above and click + to build your schedule.</p>
      </div>
    </div>
    <div class="fp-footer">
      <a href="${chrome.runtime.getURL("options/options.html")}" target="_blank" class="fp-options-link">Options</a>
      <span class="fp-kbd-hint"><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> Omni-Search</span>
    </div>
  `;

  return container;
}

// ─── Wire up events ─────────────────────────────────────────────────────
function wireEvents(container) {
  const header = container.querySelector(".fp-header");
  const closeBtn = container.querySelector(".fp-btn-close");
  const refreshBtn = container.querySelector(".fp-btn-refresh");
  const searchInput = container.querySelector("#fpSearchInput");
  const btnSearch = container.querySelector(".fp-btn-search");

  // Dragging
  setupDrag(container, header);

  // Close
  closeBtn.addEventListener("click", () => hidePanel());

  // Refresh
  refreshBtn.addEventListener("click", () => refresh());

  // Search button
  btnSearch.addEventListener("click", () => runSearch(searchInput.value));

  // Search input keyboard
  searchInput.addEventListener("keydown", (e) => {
    const dropdown = container.querySelector("#fpSearchDropdown");
    const items = [...dropdown.querySelectorAll(".fp-dropdown-item")];

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

    if (e.key === "Escape") {
      if (dropdown.style.display !== "none") {
        dropdown.style.display = "none";
        ddActiveIndex = -1;
      } else {
        hidePanel();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      runSearch(searchInput.value);
    }
  });

  // Search dropdown
  searchInput.addEventListener("input", () => updateDropdown(searchInput.value));
  searchInput.addEventListener("focus", () => updateDropdown(searchInput.value));

  // Click outside dropdown to close it
  container.addEventListener("click", (e) => {
    const dropdown = container.querySelector("#fpSearchDropdown");
    const wrap = container.querySelector(".fp-search-wrap");
    if (dropdown && wrap && !wrap.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });

  // Prevent click-through to page
  container.addEventListener("mousedown", (e) => e.stopPropagation());
  container.addEventListener("click", (e) => e.stopPropagation());
}

// ─── Show / Hide / Toggle ───────────────────────────────────────────────
async function showPanel() {
  if (panelVisible) return;
  createShadowHost();

  // Load persisted added professors
  try {
    const saved = await storageGetJSON(SK.persistedAddedProfessors);
    if (Array.isArray(saved) && saved.length > 0) {
      STATE.addedProfessors = saved;
    }
  } catch (_) {}

  panelEl = buildPanel();
  shadowRoot.appendChild(panelEl);
  wireEvents(panelEl);

  // Trigger reflow for entry animation
  requestAnimationFrame(() => {
    panelEl.classList.add("fp-visible");
  });

  panelVisible = true;

  // Load data
  await refresh();
}

function hidePanel() {
  if (!panelVisible || !panelEl) return;
  panelEl.classList.remove("fp-visible");
  panelEl.classList.add("fp-closing");
  setTimeout(() => {
    panelEl?.remove();
    panelEl = null;
  }, 450);
  panelVisible = false;
}

export function toggleFloatingPanel() {
  if (panelVisible) {
    hidePanel();
  } else {
    showPanel();
  }
}

// ─── Listen for messages from background ────────────────────────────────
function listenForMessages() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE_FLOATING_PANEL") {
      toggleFloatingPanel();
    }
    if (msg.type === "RMP_DATA_UPDATE" && msg.payload && panelVisible) {
      STATE.snapshot = msg.payload;
      render(msg.payload);
    }
  });
}

// ─── Initialize ─────────────────────────────────────────────────────────
export function initFloatingPanel() {
  listenForMessages();
  console.log("[ZooReviews] Floating panel ready");
}
