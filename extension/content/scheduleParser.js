/**
 * scheduleParser.js – Parsing for Build Schedule & Generated Schedules pages.
 * Extracts subject, course, section, instructor from top table + section blocks.
 * Testable, isolated from DOM-heavy content script.
 */

/** Set to true to log parsed block samples and page context to console. */
export const DEBUG = false;
const log = (...args) => DEBUG && console.log("[RMP scheduleParser]", ...args);

const COURSE_SIGNATURE_RE = /([A-Z]{2,8})\s*(\d{2,4}[A-Z]?)/gi;
/* Supports hyphenated (Meng-Chieh) and apostrophe (O'Brien) names */
const NAME_RE = /^[A-Z][a-zA-Z]*(?:[-'][A-Za-z]+)*(?:\s+[A-Z][a-zA-Z]*(?:[-'][A-Za-z]+)*){1,3}$/;
const NON_NAME_WORDS = new Set([
  "Campus", "Amherst", "Main", "North", "South", "East", "West",
  "Online", "Remote", "Virtual", "Honors", "Spring", "Fall", "Summer",
  "Hybrid", "Center", "Building", "Hall", "Lab", "Room", "Floor",
  "Diff", "Systems", "Principles", "Computation", "Thursday", "Tuesday",
  "Monday", "Wednesday", "Friday", "Potential", "Schedule", "Programming",
  "Web", "Search", "Engines", "Click", "lock", "class", "Staff", "TBA",
  "Show", "Details", "Section"
]);

const INVALID_SUBJECTS = new Set([
  "since", "principles", "systems", "computer", "and", "the", "for", "from",
  "potential", "schedule", "spring", "fall", "click", "lock"
]);

function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isPersonName(text) {
  if (!text || text.length < 4) return false;
  if (!NAME_RE.test(text)) return false;
  return !text.split(/\s+/).some((w) => NON_NAME_WORDS.has(w));
}

function isTBDInstructor(text) {
  const t = (text || "").toLowerCase().trim();
  return !t || t === "staff" || t === "tba" || t === "tbd" || t === ".";
}

/**
 * Extract course signature (subject + course number) from text.
 * Returns { subject, course, fullKey } or null.
 */
export function extractCourseSignature(text) {
  const t = text || "";
  const match = t.match(/\b([A-Za-z]{2,10})[-\s]?(\d{2,4}[A-Z]?)\b/i);
  if (!match) return null;
  const subject = match[1];
  const course = match[2];
  if (/^[A-Z]{4}$/i.test(subject) && /^\d{2,4}$/.test(course)) return null;
  if (INVALID_SUBJECTS.has(subject.toLowerCase())) return null;
  return { subject, course, fullKey: `${subject} ${course}` };
}

/**
 * Extract instructor from a section block (College Scheduler, Build Schedule, etc.).
 * Tries multiple strategies: label prefix, last line, any line, whole-text regex.
 * Returns string (single name), array (multiple), or null (TBD).
 */
export function extractInstructorFromSectionBlock(text) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const lines = raw.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);

  /* Strategy 1: Look for "Instructor:" or "Professor:" or "Instructor" label */
  const labelRe = /(?:instructor|professor|instructors?|prof\.?)\s*:?\s*([A-Za-z][A-Za-z\s\-.,]+?)(?:\s*$|\s*\n|\s*[|,]|$)/gi;
  let m;
  while ((m = labelRe.exec(raw)) !== null) {
    const val = normalizeWhitespace(m[1]);
    if (val.length >= 4 && val.length <= 50 && !/\d{1,2}:\d{2}/.test(val)) {
      const names = val.split(",").map((n) => normalizeWhitespace(n)).filter(Boolean);
      const valid = names.filter((n) => isPersonName(n));
      if (valid.length > 0) return valid.length === 1 ? valid[0] : valid;
    }
  }

  /* Strategy 2: Last line (original behavior) */
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length > 60) continue;
    if (/\d{1,2}:\d{2}\s*(am|pm)/i.test(line)) continue;
    if (/click|lock|class|for\s+comp/i.test(line.toLowerCase())) continue;
    if (isTBDInstructor(line)) return null;
    const names = line.split(/[,;|]/).map((n) => normalizeWhitespace(n)).filter(Boolean);
    const valid = names.filter((n) => isPersonName(n));
    if (valid.length > 0) return valid.length === 1 ? valid[0] : valid;
  }

  /* Strategy 3: Any line that looks like a name (skip course codes, times) */
  for (const line of lines) {
    if (!line || line.length < 4 || line.length > 55) continue;
    if (/\d{3,4}[A-Z]?/.test(line) && /^[A-Z]{2,6}\s/.test(line)) continue; /* likely course code */
    if (/\d{1,2}:\d{2}\s*[ap]m/i.test(line)) continue;
    if (/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s/i.test(line.toLowerCase())) continue;
    if (/click|lock|class|section|sec\s*\d/i.test(line.toLowerCase())) continue;
    if (isTBDInstructor(line)) continue;
    const names = line.split(/[,;|]/).map((n) => normalizeWhitespace(n)).filter(Boolean);
    const valid = names.filter((n) => isPersonName(n));
    if (valid.length > 0) return valid.length === 1 ? valid[0] : valid;
  }

  /* Strategy 4: Whole-text regex – find "FirstName LastName" (hyphenated ok) */
  const namePattern = /\b([A-Z][a-zA-Z]*(?:[-'][A-Za-z]+)*(?:\s+[A-Z][a-zA-Z]*(?:[-'][A-Za-z]+)*){1,2})\b/g;
  const candidates = [];
  let match;
  while ((match = namePattern.exec(raw)) !== null) {
    const name = normalizeWhitespace(match[1]);
    if (isPersonName(name) && !candidates.includes(name)) candidates.push(name);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const filtered = candidates.filter((n) => {
      const lower = n.toLowerCase();
      return !NON_NAME_WORDS.has(lower) && !/^\d/.test(n);
    });
    if (filtered.length > 0) return filtered.length === 1 ? filtered[0] : filtered;
  }

  return null;
}

/**
 * Extract instructor from block element (data attrs, child elements, parent, siblings).
 * Used when text-based extraction fails (e.g. College Scheduler nested structure).
 */
function extractInstructorFromBlockElement(el) {
  if (!el) return null;
  const elementsToCheck = [el];
  if (el.parentElement) elementsToCheck.push(el.parentElement);
  if (el.previousElementSibling) elementsToCheck.push(el.previousElementSibling);
  if (el.nextElementSibling) elementsToCheck.push(el.nextElementSibling);

  for (const candidateEl of elementsToCheck) {
    if (!candidateEl?.getAttribute && !candidateEl?.querySelector) continue;
    const attr = candidateEl.getAttribute?.("data-instructor") || candidateEl.getAttribute?.("data-professor");
    if (attr) {
      const val = normalizeWhitespace(attr);
      if (val && isPersonName(val)) return val;
    }
    const sel = "[data-instructor], [data-professor], [class*='instructor'], [class*='Professor']";
    try {
      const child = candidateEl.querySelector?.(sel);
      const txt = child?.textContent?.trim();
      if (txt) {
        const afterColon = txt.replace(/^[^:]*:\s*/, "").trim();
        const candidate = afterColon || txt;
        if (isPersonName(candidate)) return candidate;
      }
    } catch (_) {}
  }

  /* Try parent/sibling textContent for professor name (e.g. instructor in sibling div) */
  for (const candidateEl of elementsToCheck) {
    if (candidateEl === el) continue;
    const txt = (candidateEl?.textContent || "").trim();
    if (txt.length > 10 && txt.length < 300) {
      const found = extractInstructorFromSectionBlock(txt);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract all tokens from block text for matching.
 */
export function getBlockTokens(text) {
  const t = (text || "").toLowerCase();
  const tokens = t.split(/[\s,\-]+/).filter((x) => x.length >= 2);
  return [...new Set(tokens)];
}

/**
 * Parse top table on Build Schedule / Generated Schedules page (no Instructor column).
 * Returns rows: { subject, course, section, classNumber, componentType, meetingTime }.
 */
export function parseTopTableBuildSchedule(tableEl) {
  if (!tableEl?.querySelectorAll) return [];
  const headers = [...(tableEl.querySelectorAll("th") || [])];
  const getIdx = (labels) => {
    const i = headers.findIndex((th) =>
      labels.some((l) => normalizeWhitespace(th.textContent || "").toLowerCase().includes(l))
    );
    return i >= 0 ? i : -1;
  };
  const subjIdx = getIdx(["subject"]);
  const courseIdx = getIdx(["course"]);
  const sectionIdx = getIdx(["section"]);
  const classIdx = getIdx(["class", "#"]);
  const compIdx = getIdx(["component", "type"]);
  const timeIdx = getIdx(["day", "time", "meeting"]);
  const rows = [];
  (tableEl.querySelectorAll("tbody tr") || []).forEach((tr) => {
    const cells = [...(tr.cells || [])];
    const get = (i) => (i >= 0 && cells[i] ? normalizeWhitespace(cells[i].textContent || "") : "");
    const subject = get(subjIdx);
    const course = get(courseIdx);
    if (!subject && !course) {
      const sig = extractCourseSignature(tr.textContent || "");
      if (sig) {
        rows.push({
          subject: sig.subject,
          course: sig.course,
          section: get(sectionIdx) || "",
          classNumber: get(classIdx) || "",
          componentType: get(compIdx) || "",
          meetingTime: get(timeIdx) || ""
        });
      }
      return;
    }
    if (subject || course) {
      rows.push({
        subject: subject || extractCourseSignature(tr.textContent || "")?.subject || "",
        course: course || extractCourseSignature(tr.textContent || "")?.course || "",
        section: get(sectionIdx) || "",
        classNumber: get(classIdx) || "",
        componentType: get(compIdx) || "",
        meetingTime: get(timeIdx) || ""
      });
    }
  });
  log("parseTopTableBuildSchedule", rows.length, "rows", rows.slice(0, 2));
  return rows;
}

/**
 * Find schedule block elements (calendar-style blocks in generated schedules).
 */
const BLOCK_SELECTORS = [
  /* College Scheduler, FullCalendar, React Big Calendar */
  "[class*='fc-event']", "[class*='rbc-event']", "[class*='event'][class*='title']",
  "[class*='Event'][class*='Title']", "[class*='course'][class*='block']",
  "[class*='Course'][class*='Block']", "[class*='slot']", "[class*='Slot']",
  "[class*='meeting']", "[class*='Meeting']", "[class*='event']", "[class*='Event']",
  "[class*='scheduler']", "[class*='Scheduler']", "[class*='schedule-event']",
  "[class*='ScheduleEvent']", "[class*='course-event']", "[class*='CourseEvent']",
  "[data-event]", "[class*='calendar-event']"
];

export function findSectionBlocks(doc) {
  const blocks = [];
  const tried = new Set();
  for (const sel of BLOCK_SELECTORS) {
    try {
      doc.querySelectorAll(sel).forEach((el) => {
        if (tried.has(el)) return;
        const text = (el.textContent || "").trim();
        if (text.length < 15 || text.length > 800) return;
        if (!extractCourseSignature(text)) return;
        tried.add(el);
        blocks.push({ el, text });
      });
    } catch (_) {}
  }
  if (blocks.length === 0) {
    const walk = (root) => {
      if (!root || root.nodeType !== 1) return;
      if (root.closest?.("script, style, noscript")) return;
      const rect = root.getBoundingClientRect?.();
      if (rect && rect.width > 30 && rect.height > 20) {
        const text = (root.textContent || "").trim();
        if (text.length >= 15 && text.length <= 800 && extractCourseSignature(text)) {
          if (!tried.has(root)) {
            tried.add(root);
            blocks.push({ el: root, text });
          }
        }
      }
      for (const c of root.children || []) walk(c);
      if (root.shadowRoot) for (const c of root.shadowRoot.children || []) walk(c);
    };
    walk(doc.body || doc.documentElement);
  }
  return blocks;
}

/**
 * Parse all generated schedules on the page.
 * Returns { schedules: [{ scheduleIndex, sections: [...] }] }.
 */
export function parseGeneratedSchedules(doc) {
  const tableRows = [];
  doc.querySelectorAll("table").forEach((table) => {
    const hasInstructor = [...(table.querySelectorAll("th") || [])].some(
      (th) => ["Instructor", "Professor"].some((l) =>
        normalizeWhitespace(th.textContent || "").toLowerCase().includes(l.toLowerCase()))
    );
    if (!hasInstructor) {
      tableRows.push(...parseTopTableBuildSchedule(table));
    }
  });

  const blocks = findSectionBlocks(doc);
  if (blocks.length === 0) {
    log("parseGeneratedSchedules: no blocks found");
    return { schedules: [], tableRows };
  }

  const sectionMap = new Map();

  blocks.forEach(({ el, text }) => {
    const sig = extractCourseSignature(text);
    if (!sig) return;
    let instructor = extractInstructorFromSectionBlock(text);
    if (!instructor) instructor = extractInstructorFromBlockElement(el);

    const tokens = getBlockTokens(text);
    const sectionMatch = text.match(/\b(?:section|sec\.?)\s*([A-Z]?\d+)/i);
    const sectionId = sectionMatch ? sectionMatch[1] : "";
    const meetingMatch = text.match(/(\d{1,2}:\d{2}\s*[ap]m\s*-\s*\d{1,2}:\d{2}\s*[ap]m)/i);
    const meetingTime = meetingMatch ? meetingMatch[1] : "";

    const key = `${sig.fullKey}|${sectionId}|${meetingTime}`;
    const existing = sectionMap.get(key);
    const hasInstructor = instructor != null;
    const existingHasInstructor = existing?.instructor != null;
    if (!existing || (hasInstructor && !existingHasInstructor)) {
      sectionMap.set(key, {
        subject: sig.subject,
        course: sig.course,
        courseKey: sig.fullKey,
        sectionId,
        meetingTime,
        instructor: instructor,
        instructors: Array.isArray(instructor) ? instructor : (instructor ? [instructor] : []),
        blockEl: el,
        blockText: text,
        tokens
      });
    }
  });

  const sections = [...sectionMap.values()];
  log("parseGeneratedSchedules", sections.length, "sections");
  if (DEBUG && sections[0]) {
    log("Sample block text:", sections[0].blockText?.slice(0, 200));
    log("Sample parsed:", { ...sections[0], blockEl: undefined, blockText: undefined });
  }

  return {
    schedules: [{ scheduleIndex: 0, sections }],
    tableRows
  };
}

/**
 * Detect page context: "classList" | "buildSchedule" | "generatedSchedules"
 */
export function detectPageContext(doc, url = "") {
  const u = (url || (typeof location !== "undefined" ? location.href : "")).toLowerCase();
  const hasTopTable = doc.querySelector?.("table");
  const hasInstructorCol = hasTopTable && [...(doc.querySelectorAll("table th") || [])].some(
    (th) => ["Instructor", "Professor"].includes(normalizeWhitespace(th.textContent || ""))
  );
  const blocks = findSectionBlocks(doc);

  if (blocks.length > 0 && !hasInstructorCol) {
    if (/generate|potential|schedule\s*\d/i.test(u) || blocks.length >= 2) {
      return "generatedSchedules";
    }
    return "buildSchedule";
  }
  if (hasInstructorCol) return "classList";
  return "unknown";
}
