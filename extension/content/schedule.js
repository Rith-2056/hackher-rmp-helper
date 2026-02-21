import { fetchTeacherForNameBatch, fetchAlternativesForCourse } from "../shared/rmpClient.js";
import { getWeights } from "../shared/storage.js";
import { normalizeWhitespace, normalizeNameForKey } from "../shared/nameMatcher.js";

const STATE = {
  ratingsByName: {},
  weights: { overallWeight: 0.7, difficultyWeight: 0.3 },
  initialized: false,
  badgedNames: new Set(), // persists across scans so each name is only badged once (list view)
  calendarBadgedNames: new Set() // first occurrence only per professor in calendar grid
};

// Module-level name helpers used in both findProfessorElements and findInstructorColumnCells
const NAME_RE = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}$/;
const NON_NAME_WORDS = new Set([
  "Campus", "Amherst", "Main", "North", "South", "East", "West",
  "Online", "Remote", "Virtual", "Honors", "Spring", "Fall", "Summer",
  "Hybrid", "Center", "Building", "Hall", "Lab", "Room", "Floor",
  "Diff", "Systems", "Principles", "Computation"
]);
function isPersonName(text) {
  if (!NAME_RE.test(text)) return false;
  return !text.split(/\s+/).some((w) => NON_NAME_WORDS.has(w));
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Find instructor-name TDs in any schedule table.
// Matches each TD's visual x-position against the "Instructor" or "Professor" column header.
// Excludes left-side cells (status squares, info buttons, class IDs) that have
// hidden accessibility text containing professor names.
function findInstructorColumnCells(doc) {
  const cells = new Map();
  const headerLabels = ["Instructor", "Professor"];
  try {
    doc.querySelectorAll("table").forEach((table) => {
      const instructorTh = [...table.querySelectorAll("th")].find(
        (th) => headerLabels.includes(normalizeWhitespace(th.textContent))
      );
      if (!instructorTh) return;
      const thRect = instructorTh.getBoundingClientRect();
      if (thRect.width === 0) return; // table not visible yet
      table.querySelectorAll("tbody tr").forEach((tr) => {
        [...tr.cells].forEach((td) => {
          // Skip cells with buttons/links (info icons) or very narrow (colored squares)
          if (td.querySelector("button, a")) return;
          const tdRect = td.getBoundingClientRect();
          if (tdRect.width < 40) return; // status indicator column
          // Cell center must fall inside the Instructor header (stricter than overlap)
          const centerX = tdRect.left + tdRect.width / 2;
          if (centerX < thRect.left || centerX > thRect.right) return;
          let raw = normalizeWhitespace(td.textContent || "");
          // Strip injected badge text (e.g. "3.6 · Diff 2.3 (58)" or "RMP n/a") so we get the professor name only
          raw = raw.replace(/\s*\d+\.\d+\s*·\s*Diff\s*[\d.]+\s*\(\d+\)\s*$/i, "").replace(/\s*RMP\s*n\/a\s*$/i, "").trim();
          if (raw && isPersonName(raw) && !cells.has(td)) cells.set(td, raw);
        });
      });
    });
  } catch (_) {}
  return cells;
}

const SELECTORS = [
  "[data-professor]",
  "[data-instructor]",
  ".instructor",
  ".professor",
  ".Professor",
  ".section .instructor",
  ".result-row .prof",
  "td[headers*=instructor]",
  "td.instructor",
  "div.instructor",
  "span.instructor",
  ".section-instructors",
  ".meeting .instructor",
  // Partial matches for varied schedule UIs (College Scheduler, etc.)
  "[class*='instructor']",
  "[class*='Instructor']",
  "[class*='professor']",
  "[class*='Professor']",
  "[class*='teacher']",
  // Common schedule/calendar block classes
  "[class*='event'][class*='title']",
  "[class*='schedule'][class*='event']",
  "[class*='course'][class*='block']",
  "[class*='course'][class*='card']",
  "[class*='section'][class*='info']",
];

function hostMatchesConfiguredDomain(cfgDomain) {
  if (!cfgDomain) return true;
  const raw = String(cfgDomain).trim();
  let host = raw;
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      host = new URL(raw).hostname;
    } else {
      host = new URL(`https://${raw}`).hostname;
    }
  } catch {
    host = raw.replace(/^https?:\/\//, "").split("/")[0];
  }
  return location.hostname === host || location.hostname.endsWith("." + host);
}

// Parse hex (#1f6feb) to { r, g, b }
function hexToRgb(hex) {
  const m = (hex || "").replace(/^#/, "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// Apply user's badge color via CSS variables. Keeps liquid glass style.
function applyBadgeColor(badgeColor) {
  const rgb = hexToRgb(badgeColor);
  if (!rgb) return;
  const bg = `rgba(${rgb.r},${rgb.g},${rgb.b},0.92)`;
  const shadow = `rgba(${rgb.r},${rgb.g},${rgb.b},0.3)`;
  const dr = Math.round(rgb.r * 0.4);
  const dg = Math.round(rgb.g * 0.4);
  const db = Math.round(rgb.b * 0.4);
  const calendarBg = `rgba(${dr},${dg},${db},0.85)`;
  let el = document.getElementById("rmp-badge-theme");
  if (!el) {
    el = document.createElement("style");
    el.id = "rmp-badge-theme";
    document.head.appendChild(el);
  }
  el.textContent = `:root{--rmp-badge-bg:${bg};--rmp-badge-shadow:${shadow};--rmp-badge-calendar-bg:${calendarBg};}`;
}

// Rating → badge background (override at render time; config badge color is unchanged).
// Palette: red #DC2626, yellow #FACC15, green #22C55E, bold green #15803D, gray #9CA3AF
function getBadgeBackgroundForRating(avgRating) {
  const R = { r: 220, g: 38, b: 38 };
  const Y = { r: 250, g: 204, b: 21 };
  const G = { r: 34, g: 197, b: 94 };
  const BG = { r: 21, g: 128, b: 61 };
  const Gray = { r: 156, g: 163, b: 175 };
  const o = (c, a = 0.92) => `rgba(${c.r},${c.g},${c.b},${a})`;
  if (avgRating == null || avgRating === undefined || Number.isNaN(Number(avgRating))) return o(Gray);
  const r = Number(avgRating);
  if (r <= 2.5) return o(R);
  if (r < 3.0) return `linear-gradient(135deg, ${o(R)} 0%, ${o(Y)} 100%)`;
  if (r < 3.5) return `linear-gradient(135deg, ${o(Y, 0.85)} 0%, ${o(Y)} 100%)`;
  if (r < 3.9) return `linear-gradient(135deg, ${o(Y)} 0%, ${o(G)} 100%)`;
  if (r < 4.5) return o(G);
  return o(BG);
}

async function bootstrap() {
  if (STATE.initialized) return;
  const cfg = await chrome.runtime.sendMessage({ type: "CFG_GET" });
  if (!hostMatchesConfiguredDomain(cfg?.scheduleDomain)) return;
  STATE.weights = cfg?.weights || STATE.weights;
  if (cfg?.badgeColor) applyBadgeColor(cfg.badgeColor);
  await scanAndAnnotate();
  await scanAndAnnotateCalendarBlocks();
  observeMutations();
  STATE.initialized = true;
}

function observeMutations() {
  const obs = new MutationObserver((mut) => {
    const shouldRescan = mut.some((m) => m.addedNodes && m.addedNodes.length > 0);
    if (shouldRescan) {
      if (observeMutations._timer) clearTimeout(observeMutations._timer);
      observeMutations._timer = setTimeout(async () => {
        await scanAndAnnotate();
        await scanAndAnnotateCalendarBlocks();
      }, 250);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

function extractProfessorFromCourseBlock(text) {
  const t = normalizeWhitespace(text || "");
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const nameLike = /^[A-Z][a-z]+$/;
  const nameWords = [];
  for (let i = words.length - 1; i >= 0 && nameWords.length < 3; i--) {
    if (nameLike.test(words[i])) nameWords.unshift(words[i]);
    else if (nameWords.length >= 2) break;
  }
  return nameWords.length >= 2 ? nameWords.join(" ") : null;
}

function* walkElementsIncludingShadow(root) {
  if (!root || root.nodeType !== 1) return;
  yield root;
  if (root.shadowRoot) yield* walkElementsIncludingShadow(root.shadowRoot);
  for (const child of root.children || []) {
    yield* walkElementsIncludingShadow(child);
  }
}

function getSearchRoots() {
  const roots = [document];
  try {
    document.querySelectorAll("iframe").forEach((frame) => {
      try {
        if (frame.contentDocument?.body) roots.push(frame.contentDocument);
      } catch (_) {}
    });
  } catch (_) {}
  return roots;
}

function findProfessorElements() {
  const found = new Map();

  // --- Primary: "Instructor" column in a table (College Scheduler table view) ---
  for (const doc of getSearchRoots()) {
    findInstructorColumnCells(doc).forEach((name, el) => found.set(el, name));
  }

  const processElement = (el) => {
    const explicit =
      el.getAttribute("data-professor") ||
      el.getAttribute("data-instructor");
    if (explicit) {
      const n = normalizeWhitespace(explicit);
      if (n && !found.has(el)) found.set(el, n);
      return;
    }
    const text = normalizeWhitespace(el.textContent || "");
    if (!text) return;
    // Only accept text that is directly a person name.
    // Do NOT call extractProfessorFromCourseBlock here — that would match
    // accessibility text like "View section details for Nikko Bovornkeeratiroj"
    // on info buttons and badge the wrong element.
    if (isPersonName(text)) {
      if (!found.has(el)) found.set(el, text);
    }
  };

  const courseCodeRe = /\b([A-Za-z]{2,6})\s*-?\s*(\d{3,4}[A-Z]?)\b/;
  const classFallbackSel = "[class*='event'],[class*='Event'],[class*='course'],[class*='Course'],[class*='section'],[class*='Section'],[class*='block'],[class*='Block'],[class*='card'],[class*='Card'],[class*='fc-'],[class*='rbc']";

  const searchIn = (doc) => {
    try {
      for (const sel of SELECTORS) {
        doc.querySelectorAll(sel).forEach(processElement);
      }
      doc.querySelectorAll("*").forEach((root) => {
        if (root.shadowRoot) {
          try {
            for (const sel of SELECTORS) {
              root.shadowRoot.querySelectorAll(sel).forEach(processElement);
            }
          } catch (_) {}
        }
      });
    } catch (_) {}
  };

  if (found.size === 0) {
    for (const doc of getSearchRoots()) searchIn(doc);
  }

  if (found.size === 0) {
    const classSearch = (doc) => {
      try {
        doc.querySelectorAll(classFallbackSel).forEach((el) => {
          const text = (el.textContent || "").trim();
          if (!courseCodeRe.test(text) || text.length < 15 || text.length > 350) return;
          const prof = extractProfessorFromCourseBlock(text);
          if (prof && prof.length >= 4 && !found.has(el)) found.set(el, prof);
        });
        for (const el of walkElementsIncludingShadow(doc.body || doc.documentElement)) {
          if (el.shadowRoot) {
            try {
              el.shadowRoot.querySelectorAll(classFallbackSel).forEach((n) => {
                const text = (n.textContent || "").trim();
                if (!courseCodeRe.test(text) || text.length < 15 || text.length > 350) return;
                const prof = extractProfessorFromCourseBlock(text);
                if (prof && prof.length >= 4 && !found.has(n)) found.set(n, prof);
              });
            } catch (_) {}
          }
        }
      } catch (_) {}
    };
    for (const doc of getSearchRoots()) classSearch(doc);
  }

  // Last resort: scan ALL elements for course block pattern (College Scheduler, etc.)
  if (found.size === 0) {
    const candidates = [];
    for (const doc of getSearchRoots()) {
      const body = doc.body || doc.documentElement;
      if (!body) continue;
      for (const el of walkElementsIncludingShadow(body)) {
        if (el.nodeName !== "SCRIPT" && el.nodeName !== "STYLE" && !el.closest?.("script, style")) {
          const text = (el.textContent || "").trim();
          if (courseCodeRe.test(text) && text.length >= 15 && text.length <= 400) {
            const prof = extractProfessorFromCourseBlock(text);
            if (prof && prof.length >= 4) candidates.push({ el, prof, textLen: text.length });
          }
        }
      }
    }
    // Prefer smallest (most specific) elements; skip if we already have a descendant
    candidates.sort((a, b) => a.textLen - b.textLen);
    for (const { el, prof } of candidates) {
      const hasDescendant = [...found.keys()].some((f) => el.contains?.(f) && el !== f);
      if (!hasDescendant && !found.has(el)) found.set(el, prof);
    }
  }

  return Array.from(found.entries()).map(([el, name]) => ({ el, name }));
}

// Calendar block selectors: FullCalendar, React Big Calendar, College Scheduler, generic.
const CALENDAR_BLOCK_SEL = "[class*='fc-event'],[class*='rbc-event'],[class*='event'][class*='title'],[class*='Event'][class*='Title'],[class*='course'][class*='block'],[class*='Course'][class*='Block'],[class*='event'],[class*='Event']";
const COURSE_CODE_RE = /\b([A-Za-z]{2,6})\s*-?\s*(\d{3,4}[A-Z]?)\b/;

// True if table is the course list (has Professor/Instructor column), not the calendar grid.
function isCourseListTable(table) {
  return [...(table.querySelectorAll?.("th") || [])].some(
    (th) => ["Instructor", "Professor"].includes(normalizeWhitespace(th.textContent || ""))
  );
}

// Find calendar blocks (colored schedule grid blocks) and extract professor name from each.
// Returns { blockEl, name, anchorEl }[] in DOM order. anchorEl = best place to append badge (under name).
function findCalendarBlockProfessorElements() {
  const results = [];
  for (const doc of getSearchRoots()) {
    try {
      doc.querySelectorAll(CALENDAR_BLOCK_SEL).forEach((block) => {
        // Exclude blocks inside the course list table (handled by findInstructorColumnCells)
        const table = block.closest?.("table");
        if (table && isCourseListTable(table)) return;
        const text = (block.textContent || "").trim();
        if (!COURSE_CODE_RE.test(text) || text.length < 15 || text.length > 400) return;
        const name = extractProfessorFromCourseBlock(text);
        if (!name || name.length < 4) return;
        // Prefer a child that contains only the professor name (anchor for badge)
        let anchor = block;
        for (const child of block.querySelectorAll?.("*") || []) {
          const ct = normalizeWhitespace(child.textContent || "");
          if (ct === name) {
            anchor = child;
            break;
          }
        }
        results.push({ blockEl: block, name, anchorEl: anchor });
      });
      // Shadow DOM
      for (const el of walkElementsIncludingShadow(doc.body || doc.documentElement)) {
        if (el.shadowRoot) {
          try {
            el.shadowRoot.querySelectorAll(CALENDAR_BLOCK_SEL).forEach((block) => {
              const table = block.closest?.("table");
              if (table && isCourseListTable(table)) return;
              const text = (block.textContent || "").trim();
              if (!COURSE_CODE_RE.test(text) || text.length < 15 || text.length > 400) return;
              const name = extractProfessorFromCourseBlock(text);
              if (!name || name.length < 4) return;
              let anchor = block;
              for (const child of block.querySelectorAll?.("*") || []) {
                const ct = normalizeWhitespace(child.textContent || "");
                if (ct === name) {
                  anchor = child;
                  break;
                }
              }
              results.push({ blockEl: block, name, anchorEl: anchor });
            });
          } catch (_) {}
        }
      }
      // Fallback: College Scheduler may use custom classes. Scan elements inside calendar-like containers.
      if (results.length === 0) {
        const calendarSel = "[class*='calendar'],[class*='Calendar'],[class*='schedule'],[class*='Schedule'],[class*='week'],[class*='Week']";
        const seen = new Set();
        for (const root of doc.querySelectorAll(calendarSel)) {
          for (const el of root.querySelectorAll?.("*") || []) {
            if (seen.has(el)) continue;
            const table = el.closest?.("table");
            if (table && isCourseListTable(table)) continue;
            const text = (el.textContent || "").trim();
            if (!COURSE_CODE_RE.test(text) || text.length < 15 || text.length > 400) continue;
            const name = extractProfessorFromCourseBlock(text);
            if (!name || name.length < 4) continue;
            if (el.children.length > 3) continue; // prefer leaf-like blocks
            seen.add(el);
            let anchor = el;
            for (const child of el.querySelectorAll?.("*") || []) {
              const ct = normalizeWhitespace(child.textContent || "");
              if (ct === name) {
                anchor = child;
                break;
              }
            }
            results.push({ blockEl: el, name, anchorEl: anchor });
          }
        }
      }
    } catch (_) {}
  }
  return results;
}

async function scanAndAnnotate() {
  const profs = findProfessorElements();
  const uniqueNames = Array.from(new Set(profs.map((p) => p.name)));
  if (uniqueNames.length === 0) return;
  // If DOM was replaced (e.g. SPA nav), badges are gone but badgedNames persists — reset so we re-badge
  const badgeCount = document.querySelectorAll(".rmp-badge").length;
  if (badgeCount === 0 && STATE.badgedNames.size > 0) {
    STATE.badgedNames.clear();
  }
  const res = await fetchTeacherForNameBatch(uniqueNames, {});
  STATE.ratingsByName = res || {};
  for (const { el, name } of profs) {
    const key = normalizeNameForKey(name);
    if (STATE.badgedNames.has(key)) continue; // badge each professor only once, ever
    annotateElement(el, name, STATE.ratingsByName[name]);
    STATE.badgedNames.add(key);
  }
}

function showFloatingTooltip(badgeEl, html, badgeBg) {
  const doc = badgeEl.ownerDocument || document;
  const tip = doc.createElement("div");
  tip.className = "rmp-badge-tooltip rmp-floating-tooltip";
  tip.innerHTML = html;
  if (badgeBg) tip.style.background = badgeBg;
  doc.body.appendChild(tip);
  const updatePos = () => {
    const r = badgeEl.getBoundingClientRect();
    /* Place tooltip on the bubble: bottom edge meets top of badge for stacked symmetry */
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top}px`;
  };
  updatePos();
  const hide = () => {
    tip.remove();
    badgeEl.removeEventListener("mouseleave", hide);
  };
  badgeEl.addEventListener("mouseleave", hide);
  requestAnimationFrame(() => tip.classList.add("rmp-tooltip-visible"));
}

function annotateElement(el, name, rating) {
  // idempotent: avoid duplicate badges
  if (el.querySelector?.(".rmp-badge")) return;
  const wrapper = document.createElement("span");
  wrapper.className = "rmp-badge-wrapper";
  const badge = document.createElement("span");
  badge.className = "rmp-badge";
  const avgRating = rating && !rating.notFound ? rating.avgRating : null;
  const badgeBg = getBadgeBackgroundForRating(avgRating);
  badge.style.background = badgeBg;
  let text = "RMP n/a";
  let tooltipHtml = "No RMP profile found";
  if (rating && !rating.notFound) {
    const r = Number(rating.avgRating || 0).toFixed(1);
    const d = Number(rating.avgDifficulty || 0).toFixed(1);
    const n = rating.numRatings || 0;
    text = `${r} · Diff ${d} (${n})`;
    tooltipHtml = `Name: ${escapeHtml(name)}<br>Rating: ${r}<br>Difficulty: ${d}<br>Ratings: ${n} reviews<br>Department: ${escapeHtml(rating.department || "—")}`;
  }
  badge.textContent = text;
  badge.addEventListener("mouseenter", () => showFloatingTooltip(badge, tooltipHtml, badgeBg));
  wrapper.appendChild(badge);
  el.appendChild(wrapper);
}

// Calendar block badge: compact, readable on colored backgrounds. Idempotent.
function annotateCalendarBlock(anchorEl, name, rating) {
  if (!anchorEl) return;
  const doc = anchorEl.ownerDocument || document;
  if (anchorEl.querySelector?.(".rmp-calendar-badge")) return;
  const wrapper = doc.createElement("span");
  wrapper.className = "rmp-badge-wrapper rmp-calendar-wrapper";
  const badge = doc.createElement("span");
  badge.className = "rmp-calendar-badge";
  const avgRating = rating && !rating.notFound ? rating.avgRating : null;
  const badgeBg = getBadgeBackgroundForRating(avgRating);
  badge.style.background = badgeBg;
  let text = "No RMP";
  let tooltipHtml = "No RMP profile found";
  if (rating && !rating.notFound) {
    const r = Number(rating.avgRating || 0).toFixed(1);
    const d = Number(rating.avgDifficulty || 0).toFixed(1);
    const n = rating.numRatings || 0;
    text = `${r} · Diff ${d} (${n})`;
    tooltipHtml = `Name: ${escapeHtml(name)}<br>Rating: ${r}<br>Difficulty: ${d}<br>Ratings: ${n} reviews<br>Department: ${escapeHtml(rating.department || "—")}`;
  }
  badge.textContent = text;
  badge.addEventListener("mouseenter", () => showFloatingTooltip(badge, tooltipHtml, badgeBg));
  wrapper.appendChild(badge);
  anchorEl.appendChild(wrapper);
}

// Scan calendar grid, badge first occurrence of each professor only.
async function scanAndAnnotateCalendarBlocks() {
  const blocks = findCalendarBlockProfessorElements();
  const toFetch = new Set();
  for (const { name } of blocks) {
    const key = normalizeNameForKey(name);
    if (!STATE.calendarBadgedNames.has(key)) toFetch.add(name);
  }
  // If DOM was replaced, calendar badges are gone — reset so we re-badge
  const calBadgeCount = document.querySelectorAll(".rmp-calendar-badge").length;
  if (calBadgeCount === 0 && STATE.calendarBadgedNames.size > 0) {
    STATE.calendarBadgedNames.clear();
    for (const { name } of blocks) toFetch.add(name); // re-fetch all
  }
  if (toFetch.size === 0) return;
  const ratings = (await fetchTeacherForNameBatch([...toFetch], {})) || {};
  for (const { name, anchorEl } of blocks) {
    const key = normalizeNameForKey(name);
    if (STATE.calendarBadgedNames.has(key)) continue;
    annotateCalendarBlock(anchorEl, name, ratings[name]);
    STATE.calendarBadgedNames.add(key);
  }
}

// Recommendations
function computeCompositeScore(rating, weights) {
  if (!rating || rating.notFound) return null;
  const o = Number(rating.avgRating || 0);
  const d = Number(rating.avgDifficulty || 0);
  const { overallWeight, difficultyWeight } = weights;
  return overallWeight * o - difficultyWeight * d;
}

// Get Subject + Course from the same table row as the instructor cell.
// SPIRE/College Scheduler tables have Subject and Course columns.
function extractCourseKeyFromRow(el) {
  const row = el.closest?.("tr");
  const table = row?.closest?.("table");
  if (!row || !table) return null;
  const headers = [...(table.querySelectorAll("th") || [])];
  const subjIdx = headers.findIndex(
    (th) => normalizeWhitespace(th.textContent || "") === "Subject"
  );
  const courseIdx = headers.findIndex(
    (th) => normalizeWhitespace(th.textContent || "") === "Course"
  );
  if (subjIdx >= 0 && courseIdx >= 0 && row.cells) {
    const subj = normalizeWhitespace(row.cells[subjIdx]?.textContent || "");
    const course = normalizeWhitespace(row.cells[courseIdx]?.textContent || "");
    if (subj && course) return `${subj} ${course}`;
  }
  // Fallback: look for Subject-Course pattern in row text
  const courseRe = /\b([A-Za-z]{2,12})\s+(\d{3,4}[A-Z]?)\b/;
  const m = (row.textContent || "").match(courseRe);
  return m ? `${m[1]} ${m[2]}` : null;
}

function collectSections(opts = {}) {
  const instructorOnly = opts.instructorOnly === true;
  let profs;
  if (instructorOnly) {
    profs = [];
    for (const doc of getSearchRoots()) {
      findInstructorColumnCells(doc).forEach((name, el) => profs.push({ el, name }));
    }
  } else {
    profs = findProfessorElements();
  }
  const groups = new Map();
  for (const { el, name } of profs) {
    const key = extractCourseKeyFromRow(el) || "UNKNOWN";
    if (!groups.has(key)) groups.set(key, []);
    const rating = STATE.ratingsByName[name] || null;
    const score = computeCompositeScore(rating, STATE.weights);
    const section = {
      el,
      name,
      rating,
      score,
      timeText: findNearbyTimeText(el)
    };
    groups.get(key).push(section);
  }
  return groups;
}

function findNearbyTimeText(el) {
  let node = el.closest("tr") || el.parentElement;
  if (node) {
    const timeEl =
      node.querySelector?.("[class*='time'], .time, .meeting-time, td.time") ||
      node.querySelector?.("td:nth-child(3)");
    const txt = timeEl?.textContent;
    if (txt) return normalizeWhitespace(txt);
  }
  // fallback
  return "";
}

async function openRecommendationsDrawer() {
  const existing = document.getElementById("rmp-drawer");
  if (existing) existing.remove();

  try {
    await scanAndAnnotate();
  } catch (e) {
    console.warn("[RMP Helper] rating fetch failed, showing drawer anyway:", e);
  }
  const groups = collectSections();
  const panel = document.createElement("div");
  panel.id = "rmp-drawer";
  const header = document.createElement("div");
  header.className = "rmp-drawer-header";
  header.innerHTML = `<strong>RMP Recommendations</strong><button class="rmp-close">✕</button>`;
  header.querySelector(".rmp-close").addEventListener("click", () => panel.remove());

  const body = document.createElement("div");
  body.className = "rmp-drawer-body";

  if (groups.size === 0) {
    body.innerHTML = `<p class="rmp-empty-msg">No professors found on this page. Make sure you're on a schedule page with course sections visible.</p>`;
  }

  for (const [course, sections] of groups.entries()) {
    if (!sections || sections.length === 0) continue;
    // Rank by score, fall back to rating if null
    const ranked = [...sections].sort((a, b) => {
      const as = a.score ?? -Infinity;
      const bs = b.score ?? -Infinity;
      if (bs !== as) return bs - as;
      const ar = (a.rating?.avgRating || 0);
      const br = (b.rating?.avgRating || 0);
      return br - ar;
    });
    const best = ranked[0];
    const curr = sections[0]; // naive 'current' pick; on many pages, the first is selected/visible
    const courseBlock = document.createElement("div");
    courseBlock.className = "rmp-course-block";
    const header = document.createElement("div");
    header.className = "rmp-course-title";
    header.textContent = course;
    const list = document.createElement("ul");
    list.className = "rmp-reco-list";
    ranked.slice(0, 3).forEach((s, idx) => {
      const li = document.createElement("li");
      const r = s.rating && !s.rating.notFound ? Number(s.rating.avgRating).toFixed(1) : "n/a";
      const d = s.rating && !s.rating.notFound ? Number(s.rating.avgDifficulty).toFixed(1) : "n/a";
      li.innerHTML = `
        <div class="rmp-reco-row ${idx === 0 ? "best" : ""}">
          <span class="rmp-name">${s.name}</span>
          <span class="rmp-stat">${r} · Diff ${d}${s.rating?.numRatings ? ` (${s.rating.numRatings})` : ""}</span>
          <span class="rmp-time">${s.timeText || ""}</span>
          <button class="rmp-jump">Find on page</button>
        </div>`;
      li.querySelector(".rmp-jump").addEventListener("click", () => {
        s.el.scrollIntoView({ behavior: "smooth", block: "center" });
        s.el.classList.add("rmp-highlight");
        setTimeout(() => s.el.classList.remove("rmp-highlight"), 1500);
      });
      list.appendChild(li);
    });
    courseBlock.appendChild(header);
    if (best && curr && best !== curr) {
      const note = document.createElement("div");
      note.className = "rmp-swap-note";
      note.textContent = `Best on schedule: ${best.name}`;
      courseBlock.appendChild(note);
    }
    const lowRated = sections.filter((s) => (s.rating?.avgRating ?? 0) > 0 && (s.rating?.avgRating ?? 0) < 3.5);
    if (lowRated.length > 0) {
      (async () => {
        for (const s of lowRated) {
          try {
            const alts = await fetchAlternativesForCourse(course, s.name, s.rating?.avgRating ?? 0);
            if (alts?.length) {
              const div = document.createElement("div");
              div.className = "rmp-umass-alts";
              div.innerHTML = `<strong>Other UMass professors for ${course.split(/\s+/)[0]}:</strong><ul>${alts.map((a) => `<li>${a.name} — ⭐ ${Number(a.avgRating).toFixed(1)} · Diff ${Number(a.avgDifficulty || 0).toFixed(1)} (${a.numRatings || 0})</li>`).join("")}</ul>`;
              courseBlock.appendChild(div);
              break;
            }
          } catch (_) {}
        }
      })();
    }
    courseBlock.appendChild(list);
    body.appendChild(courseBlock);
  }

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);
}

// Build popup data: professors with ratings and best alternative per course
async function getPopupData() {
  try {
    await scanAndAnnotate();
  } catch (e) {
    console.warn("[RMP Helper] scan failed:", e);
  }
  const groups = collectSections({ instructorOnly: true });
  const professors = [];
  for (const [course, sections] of groups.entries()) {
    if (!sections?.length) continue;
    const ranked = [...sections].sort((a, b) => {
      const as = a.score ?? -Infinity;
      const bs = b.score ?? -Infinity;
      if (bs !== as) return bs - as;
      return (b.rating?.avgRating || 0) - (a.rating?.avgRating || 0);
    });
    const best = ranked[0];
    for (const s of sections) {
      if (!isPersonName(s.name)) continue;
      const alt = best && best.name !== s.name ? { name: best.name, rating: best.rating } : null;
      const currRating = s.rating?.avgRating ?? 0;
      let rmpAlternatives = [];
      if (currRating > 0 && currRating < 3.5) {
        try {
          rmpAlternatives = (await fetchAlternativesForCourse(course, s.name, currRating)) || [];
        } catch (_) {}
      }
      professors.push({
        name: s.name,
        course,
        rating: s.rating,
        timeText: s.timeText,
        bestAlternative: alt,
        rmpAlternatives
      });
    }
  }
  return { professors };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_RECOMMENDATIONS") {
    openRecommendationsDrawer().catch((e) => console.error("[RMP Helper]", e));
    return;
  }
  if (msg?.type === "GET_POPUP_DATA") {
    getPopupData().then(sendResponse).catch((e) => {
      console.warn("[RMP Helper]", e);
      sendResponse({ professors: [] });
    });
    return true; // async response
  }
});

// Keyboard shortcut alternative: Alt+R
window.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "r" || e.key === "R")) {
    openRecommendationsDrawer();
  }
});

// Initialize once DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}

