import { fetchTeacherForNameBatch } from "../shared/rmpClient.js";
import { normalizeWhitespace } from "../shared/nameMatcher.js";
import {
  detectPageContext,
  parseGeneratedSchedules,
  extractInstructorFromSectionBlock,
  DEBUG as PARSER_DEBUG
} from "./scheduleParser.js";

const STATE = {
  ratingsByName: {},
  weights: { overallWeight: 0.7, difficultyWeight: 0.3 },
  initialized: false,
  lastSnapshot: null,
  rmpIdCounter: 0,
  debounceTimer: null,
  debounceMs: 400
};

const NAME_RE = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}$/;
const NON_NAME_WORDS = new Set([
  "Campus", "Amherst", "Main", "North", "South", "East", "West",
  "Online", "Remote", "Virtual", "Honors", "Spring", "Fall", "Summer",
  "Hybrid", "Center", "Building", "Hall", "Lab", "Room", "Floor",
  "Diff", "Systems", "Principles", "Computation",
  "Thursday", "Tuesday", "Monday", "Wednesday", "Friday",
  "Potential", "Schedule", "Programming", "Web", "Search", "Engines",
  "Click", "lock", "class"
]);

function isPersonName(text) {
  if (!NAME_RE.test(text)) return false;
  return !text.split(/\s+/).some((w) => NON_NAME_WORDS.has(w));
}

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

function assignOrGetRmpId(el) {
  let id = el.getAttribute?.("data-rmp-id");
  if (!id) {
    id = "rmp-" + (++STATE.rmpIdCounter);
    el.setAttribute?.("data-rmp-id", id);
  }
  return id;
}

function extractCourseKeyFromRow(el) {
  const row = el.closest?.("tr");
  const table = row?.closest?.("table");
  if (!row || !table) return null;
  const headers = [...(table.querySelectorAll("th") || [])];
  const subjIdx = headers.findIndex((th) => normalizeWhitespace(th.textContent || "") === "Subject");
  const courseIdx = headers.findIndex((th) => normalizeWhitespace(th.textContent || "") === "Course");
  if (subjIdx >= 0 && courseIdx >= 0 && row.cells) {
    const subj = normalizeWhitespace(row.cells[subjIdx]?.textContent || "");
    const course = normalizeWhitespace(row.cells[courseIdx]?.textContent || "");
    if (subj && course) return `${subj} ${course}`;
  }
  const courseRe = /\b([A-Za-z]{2,12})\s+(\d{3,4}[A-Z]?)\b/;
  const m = (row.textContent || "").match(courseRe);
  return m ? `${m[1]} ${m[2]}` : null;
}

function extractCourseKeyFromBlockText(text) {
  const m = (text || "").match(/\b([A-Za-z]{2,6})\s*-?\s*(\d{3,4}[A-Z]?)\b/);
  return m ? `${m[1]} ${m[2]}` : null;
}

const INVALID_COURSE_SUBJECTS = new Set([
  "since", "principles", "systems", "computer", "and", "the", "for", "from",
  "potential", "schedule", "spring", "fall", "click", "lock"
]);

function isValidCourseKey(key) {
  if (!key || key === "Other") return false;
  const subject = (key.split(/\s+/)[0] || "").toLowerCase();
  if (INVALID_COURSE_SUBJECTS.has(subject)) return false;
  if (!/^[A-Za-z]{2,12}\s+\d{3,4}[A-Z]?$/i.test(key.trim())) return false;
  return true;
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
  return "";
}

function computeCompositeScore(rating, weights) {
  if (!rating || rating.notFound) return null;
  const o = Number(rating.avgRating || 0);
  const d = Number(rating.avgDifficulty || 0);
  const { overallWeight, difficultyWeight } = weights;
  return overallWeight * o - difficultyWeight * d;
}

// --- Instructor column detection (unchanged) ---
const SELECTORS = [
  "[data-professor]", "[data-instructor]", ".instructor", ".professor",
  ".Professor", ".section .instructor", ".result-row .prof",
  "td[headers*=instructor]", "td.instructor", "div.instructor",
  "span.instructor", ".section-instructors", ".meeting .instructor",
  "[class*='instructor']", "[class*='Instructor']", "[class*='professor']",
  "[class*='Professor']", "[class*='teacher']",
  "[class*='event'][class*='title']", "[class*='schedule'][class*='event']",
  "[class*='course'][class*='block']", "[class*='course'][class*='card']",
  "[class*='section'][class*='info']"
];

const COURSE_CODE_RE = /\b([A-Za-z]{2,6})\s*-?\s*(\d{3,4}[A-Z]?)\b/;
const CALENDAR_BLOCK_SEL = "[class*='fc-event'],[class*='rbc-event'],[class*='event'][class*='title'],[class*='Event'][class*='Title'],[class*='course'][class*='block'],[class*='Course'][class*='Block'],[class*='slot'],[class*='Slot'],[class*='meeting'],[class*='Meeting'],[class*='event'],[class*='Event']";

function isCourseListTable(table) {
  return [...(table.querySelectorAll?.("th") || [])].some(
    (th) => ["Instructor", "Professor"].includes(normalizeWhitespace(th.textContent || ""))
  );
}

function extractProfessorFromCourseBlock(text) {
  const t = normalizeWhitespace(text || "");
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const nameLike = /^[A-Z][a-z]+(-[A-Za-z]+)*$/;
  const nameWords = [];
  for (let i = words.length - 1; i >= 0 && nameWords.length < 3; i--) {
    if (nameLike.test(words[i])) nameWords.unshift(words[i]);
    else if (nameWords.length >= 2) break;
  }
  return nameWords.length >= 2 ? nameWords.join(" ") : null;
}

/** Professor is the last line of the block (or last line that looks like a name). */
function extractProfessorAsLastLine(text) {
  const lines = (text || "").split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length < 4) continue;
    if (line.length > 40) continue;
    if (/\d{1,2}:\d{2}\s*(am|pm)/i.test(line)) continue;
    if (/click|lock|class|for\s+comp/i.test(line.toLowerCase())) continue;
    if (isPersonName(line)) return line;
  }
  return null;
}

/** Course code like CompSci 446. Excludes room codes (HASA 124, AEBN 119). */
function extractCourseCodeFromBlock(text) {
  const t = text || "";
  const match = t.match(/\b([A-Za-z]{2,10})[-\s](\d{3,4}[A-Z]?)\b/);
  if (!match) return null;
  const subject = match[1];
  const num = match[2];
  if (/^[A-Z]{4}$/i.test(subject) && /^\d{2,4}$/.test(num)) return null;
  if (INVALID_COURSE_SUBJECTS.has(subject.toLowerCase())) return null;
  return `${subject} ${num}`;
}

function getBlockBackgroundColor(el) {
  if (!el) return "";
  const doc = el.ownerDocument || document;
  const style = doc.defaultView?.getComputedStyle?.(el) || window.getComputedStyle?.(el);
  if (!style) return "";
  let bg = style.backgroundColor || style.background;
  if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") {
    const parent = el.parentElement;
    if (parent && parent !== doc.body) return getBlockBackgroundColor(parent);
    return "";
  }
  const rgb = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
  if (rgb) return `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
  const hex = bg.match(/#([0-9A-Fa-f]{6})/);
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return `rgb(${r},${g},${b})`;
  }
  return bg;
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

function* walkElementsIncludingShadow(root) {
  if (!root || root.nodeType !== 1) return;
  yield root;
  if (root.shadowRoot) yield* walkElementsIncludingShadow(root.shadowRoot);
  for (const child of root.children || []) {
    yield* walkElementsIncludingShadow(child);
  }
}

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
      if (thRect.width === 0) return;
      table.querySelectorAll("tbody tr").forEach((tr) => {
        [...tr.cells].forEach((td) => {
          if (td.querySelector("button, a")) return;
          const tdRect = td.getBoundingClientRect();
          if (tdRect.width < 40) return;
          const centerX = tdRect.left + tdRect.width / 2;
          if (centerX < thRect.left || centerX > thRect.right) return;
          let raw = normalizeWhitespace(td.textContent || "");
          raw = raw.replace(/\s*\d+\.\d+\s*·\s*Diff\s*[\d.]+\s*\(\d+\)\s*$/i, "").replace(/\s*RMP\s*n\/a\s*$/i, "").trim();
          if (!raw || !isPersonName(raw)) return;
          if (/\d{1,2}:\d{2}\s*(am|pm)|(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d/i.test(raw)) return;
          if (/^[A-Z]{2,6}\s+\d{2,4}[A-Z]?$/i.test(raw)) return;
          if (!cells.has(td)) cells.set(td, raw);
        });
      });
    });
  } catch (_) {}
  return cells;
}

function findProfessorElements() {
  const found = new Map();
  for (const doc of getSearchRoots()) {
    findInstructorColumnCells(doc).forEach((name, el) => found.set(el, name));
  }
  const processElement = (el) => {
    const explicit = el.getAttribute("data-professor") || el.getAttribute("data-instructor");
    if (explicit) {
      const n = normalizeWhitespace(explicit);
      if (n && !found.has(el)) found.set(el, n);
      return;
    }
    const text = normalizeWhitespace(el.textContent || "");
    if (!text) return;
    if (isPersonName(text)) {
      if (!found.has(el)) found.set(el, text);
    }
  };
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
          if (!COURSE_CODE_RE.test(text) || text.length < 15 || text.length > 350) return;
          const prof = extractProfessorFromCourseBlock(text);
          if (prof && prof.length >= 4 && !found.has(el)) found.set(el, prof);
        });
        for (const el of walkElementsIncludingShadow(doc.body || doc.documentElement)) {
          if (el.shadowRoot) {
            try {
              el.shadowRoot.querySelectorAll(classFallbackSel).forEach((n) => {
                const text = (n.textContent || "").trim();
                if (!COURSE_CODE_RE.test(text) || text.length < 15 || text.length > 350) return;
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
  if (found.size === 0) {
    const candidates = [];
    for (const doc of getSearchRoots()) {
      const body = doc.body || doc.documentElement;
      if (!body) continue;
      for (const el of walkElementsIncludingShadow(body)) {
        if (el.nodeName !== "SCRIPT" && el.nodeName !== "STYLE" && !el.closest?.("script, style")) {
          const text = (el.textContent || "").trim();
          if (COURSE_CODE_RE.test(text) && text.length >= 15 && text.length <= 400) {
            const prof = extractProfessorFromCourseBlock(text);
            if (prof && prof.length >= 4) candidates.push({ el, prof, textLen: text.length });
          }
        }
      }
    }
    candidates.sort((a, b) => a.textLen - b.textLen);
    for (const { el, prof } of candidates) {
      const hasDescendant = [...found.keys()].some((f) => el.contains?.(f) && el !== f);
      if (!hasDescendant && !found.has(el)) found.set(el, prof);
    }
  }
  return Array.from(found.entries()).map(([el, name]) => ({ el, name }));
}

function findCalendarBlockProfessorElements() {
  const results = [];
  for (const doc of getSearchRoots()) {
    try {
      doc.querySelectorAll(CALENDAR_BLOCK_SEL).forEach((block) => {
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
        results.push({ blockEl: block, name, anchorEl: anchor, text });
      });
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
              results.push({ blockEl: block, name, anchorEl: anchor, text });
            });
          } catch (_) {}
        }
      }
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
            if (el.children.length > 12) continue;
            seen.add(el);
            let anchor = el;
            for (const child of el.querySelectorAll?.("*") || []) {
              const ct = normalizeWhitespace(child.textContent || "");
              if (ct === name) {
                anchor = child;
                break;
              }
            }
            results.push({ blockEl: el, name, anchorEl: anchor, text });
          }
        }
      }
      if (results.length === 0) {
        const candidates = [];
        const walk = (root) => {
          if (!root || root.nodeType !== 1) return;
          if (root.closest?.("script, style, noscript")) return;
          const table = root.closest?.("table");
          if (table && isCourseListTable(table)) return;
          const text = (root.textContent || "").trim();
          if (COURSE_CODE_RE.test(text) && text.length >= 15 && text.length <= 400) {
            const name = extractProfessorFromCourseBlock(text);
            if (name && name.length >= 4) {
              const rect = root.getBoundingClientRect?.();
              if (rect && rect.width > 30 && rect.height > 20) candidates.push({ el: root, name, len: text.length });
            }
          }
          for (const c of root.children || []) walk(c);
          if (root.shadowRoot) for (const c of root.shadowRoot.children || []) walk(c);
        };
        walk(doc.body || doc.documentElement);
        candidates.sort((a, b) => a.len - b.len);
        const used = new Set();
        for (const { el, name } of candidates) {
          if (used.has(el)) continue;
          if ([...used].some((u) => u.contains?.(el) && u !== el)) continue;
          used.add(el);
          results.push({ blockEl: el, name, anchorEl: el, text: (el.textContent || "").trim() });
        }
      }
    } catch (_) {}
  }
  return results;
}

/** Find schedule blocks for slider: course code as title, professor (last line), dedupe by color. */
function findScheduleBlocksForSlider() {
  const seenColors = new Set();
  const results = [];
  for (const doc of getSearchRoots()) {
    try {
      const blocks = doc.querySelectorAll(CALENDAR_BLOCK_SEL);
      blocks.forEach((block) => {
        const table = block.closest?.("table");
        if (table && isCourseListTable(table)) return;
        const text = (block.textContent || "").trim();
        if (!text || text.length < 20 || text.length > 400) return;
        const courseKey = extractCourseCodeFromBlock(text);
        if (!courseKey || !isValidCourseKey(courseKey)) return;
        const professorName = extractProfessorAsLastLine(text);
        if (!professorName) return;
        const color = getBlockBackgroundColor(block);
        if (color && seenColors.has(color)) return;
        if (color) seenColors.add(color);
        results.push({ blockEl: block, courseKey, professorName });
      });
      for (const el of walkElementsIncludingShadow(doc.body || doc.documentElement)) {
        if (el.shadowRoot) {
          try {
            el.shadowRoot.querySelectorAll(CALENDAR_BLOCK_SEL).forEach((block) => {
              const table = block.closest?.("table");
              if (table && isCourseListTable(table)) return;
              const text = (block.textContent || "").trim();
              if (!text || text.length < 20 || text.length > 400) return;
              const courseKey = extractCourseCodeFromBlock(text);
              if (!courseKey || !isValidCourseKey(courseKey)) return;
              const professorName = extractProfessorAsLastLine(text);
              if (!professorName) return;
              const color = getBlockBackgroundColor(block);
              if (color && seenColors.has(color)) return;
              if (color) seenColors.add(color);
              results.push({ blockEl: block, courseKey, professorName });
            });
          } catch (_) {}
        }
      }
      if (results.length === 0) {
        const candidates = [];
        const walk = (root) => {
          if (!root || root.nodeType !== 1) return;
          if (root.closest?.("script, style, noscript")) return;
          const table = root.closest?.("table");
          if (table && isCourseListTable(table)) return;
          const rect = root.getBoundingClientRect?.();
          if (rect && rect.width > 40 && rect.height > 25) {
            const text = (root.textContent || "").trim();
            if (text.length >= 20 && text.length <= 400) {
              const courseKey = extractCourseCodeFromBlock(text);
              if (courseKey && isValidCourseKey(courseKey)) {
                const professorName = extractProfessorAsLastLine(text);
                if (professorName) {
                  candidates.push({ blockEl: root, courseKey, professorName, len: text.length });
                }
              }
            }
          }
          for (const c of root.children || []) walk(c);
          if (root.shadowRoot) for (const c of root.shadowRoot.children || []) walk(c);
        };
        walk(doc.body || doc.documentElement);
        candidates.sort((a, b) => a.len - b.len);
        for (const { blockEl, courseKey, professorName } of candidates) {
          const color = getBlockBackgroundColor(blockEl);
          if (color && seenColors.has(color)) continue;
          const hasAncestor = results.some((r) => blockEl.contains?.(r.blockEl) && blockEl !== r.blockEl);
          if (hasAncestor) continue;
          if (color) seenColors.add(color);
          results.push({ blockEl, courseKey, professorName });
        }
      }
    } catch (_) {}
  }
  return results;
}

function runScanGeneratedSchedules() {
  const roots = getSearchRoots();
  for (const doc of roots) {
    const ctx = detectPageContext(doc, location.href);
    if (ctx !== "generatedSchedules" && ctx !== "buildSchedule") continue;
    // Do NOT scrape schedule page - user will manually add professors via sidepanel search.
    const payload = { viewMode: "manual", schedules: [], courses: [] };
    STATE.lastSnapshot = payload;
    chrome.runtime.sendMessage({ type: "RMP_DATA_UPDATE", payload }).catch(() => {});
    return Promise.resolve(payload);
  }
  return null;
}

function runScanAndNotify(immediate = false) {
  const run = () => doRunScanAndNotify();
  if (immediate) {
    if (STATE.debounceTimer) clearTimeout(STATE.debounceTimer);
    STATE.debounceTimer = null;
    return run();
  }
  if (STATE.debounceTimer) clearTimeout(STATE.debounceTimer);
  return new Promise((resolve) => {
    STATE.debounceTimer = setTimeout(() => {
      STATE.debounceTimer = null;
      run().then(resolve).catch(() => resolve(STATE.lastSnapshot));
    }, STATE.debounceMs);
  });
}

function doRunScanAndNotify() {
  const genResult = runScanGeneratedSchedules();
  if (genResult) {
    if (typeof genResult.then === "function") return genResult;
    return Promise.resolve(genResult);
  }

  const groups = new Map();
  const addSection = (el, name, courseKey, timeText, rating) => {
    if (!courseKey) courseKey = "Other";
    if (!groups.has(courseKey)) groups.set(courseKey, []);
    const fp = assignOrGetRmpId(el);
    const r = rating && !rating.notFound ? rating : null;
    const rmpUrl = r?.legacyId
      ? `https://www.ratemyprofessors.com/professor/${r.legacyId}`
      : null;
    groups.get(courseKey).push({
      professorName: name,
      avgRating: r ? Number(r.avgRating) : null,
      avgDifficulty: r ? Number(r.avgDifficulty) : null,
      numRatings: r ? (r.numRatings || 0) : 0,
      department: r?.department || null,
      timeText: timeText || "",
      elementFingerprint: fp,
      rmpUrl
    });
  };

  const sliderBlocks = findScheduleBlocksForSlider();
  if (sliderBlocks.length > 0) {
    const allNames = [...new Set(sliderBlocks.map((b) => b.professorName))];
    return fetchTeacherForNameBatch(allNames, {}).then((ratings) => {
      STATE.ratingsByName = ratings || {};
      sliderBlocks.forEach(({ blockEl, courseKey, professorName }) => {
        addSection(blockEl, professorName, courseKey, "", STATE.ratingsByName[professorName]);
      });
      return buildAndEmitCourses(groups);
    });
  }

  const profs = findProfessorElements();
  const allNames = [...new Set(profs.map((p) => p.name))];
  if (allNames.length === 0) {
    STATE.lastSnapshot = { courses: [] };
    chrome.runtime.sendMessage({ type: "RMP_DATA_UPDATE", payload: STATE.lastSnapshot }).catch(() => {});
    return Promise.resolve(STATE.lastSnapshot);
  }

  return fetchTeacherForNameBatch(allNames, {}).then((ratings) => {
    STATE.ratingsByName = ratings || {};
    profs.forEach(({ el, name }) => {
      const courseKey = extractCourseKeyFromRow(el) || extractCourseKeyFromBlockText(el.textContent || "") || "Other";
      if (!isValidCourseKey(courseKey)) return;
      addSection(el, name, courseKey, findNearbyTimeText(el), STATE.ratingsByName[name]);
    });
    return buildAndEmitCourses(groups);
  });
}

function buildAndEmitCourses(groups) {
  const courses = [];
  for (const [courseKey, sections] of groups.entries()) {
    if (!isValidCourseKey(courseKey)) continue;
    const sorted = [...sections].sort((a, b) => {
      const sa = computeCompositeScore({ avgRating: a.avgRating, avgDifficulty: a.avgDifficulty, notFound: a.avgRating == null }, STATE.weights) ?? -Infinity;
      const sb = computeCompositeScore({ avgRating: b.avgRating, avgDifficulty: b.avgDifficulty, notFound: b.avgRating == null }, STATE.weights) ?? -Infinity;
      if (sb !== sa) return sb - sa;
      return (b.avgRating || 0) - (a.avgRating || 0);
    });
    courses.push({ courseKey, sections: sorted.slice(0, 3) });
  }
  const payload = { courses };
  STATE.lastSnapshot = payload;
  chrome.runtime.sendMessage({ type: "RMP_DATA_UPDATE", payload }).catch(() => {});
  return payload;
}

function scrollToAndHighlight(elementId) {
  for (const doc of getSearchRoots()) {
    const el = doc.querySelector?.(`[data-rmp-id="${elementId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("rmp-highlight");
      setTimeout(() => el.classList.remove("rmp-highlight"), 1500);
      return;
    }
  }
}

async function bootstrap() {
  if (STATE.initialized) return;
  const cfg = await chrome.runtime.sendMessage({ type: "CFG_GET" });
  if (!hostMatchesConfiguredDomain(cfg?.scheduleDomain)) return;
  STATE.weights = cfg?.weights || STATE.weights;
  runScanAndNotify(true);
  observeMutations();
  STATE.initialized = true;
}

function observeMutations() {
  const obs = new MutationObserver((mut) => {
    const shouldRescan = mut.some((m) => m.addedNodes && m.addedNodes.length > 0);
    if (shouldRescan) {
      if (observeMutations._timer) clearTimeout(observeMutations._timer);
      observeMutations._timer = setTimeout(runScanAndNotify, 250);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "RMP_REQUEST_SNAPSHOT") {
    const p = runScanAndNotify(true);
    if (p && typeof p.then === "function") {
      p.then((snap) => sendResponse(snap || STATE.lastSnapshot || { courses: [] }))
        .catch(() => sendResponse(STATE.lastSnapshot || { courses: [] }));
    } else {
      sendResponse(STATE.lastSnapshot || { courses: [] });
    }
    return true;
  }
  if (msg?.type === "RMP_SCROLL_TO") {
    const { elementId } = msg.payload || {};
    if (elementId) scrollToAndHighlight(elementId);
    sendResponse({ ok: true });
    return false;
  }
});

window.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "r" || e.key === "R")) {
    runScanAndNotify();
    chrome.runtime.sendMessage({ type: "OPEN_RECOMMENDATIONS" }).catch(() => {});
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
