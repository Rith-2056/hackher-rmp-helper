import { fetchTeacherForNameBatch } from "../shared/rmpClient.js";
import { getWeights } from "../shared/storage.js";
import { normalizeWhitespace } from "../shared/nameMatcher.js";

const STATE = {
  ratingsByName: {},
  weights: { overallWeight: 0.7, difficultyWeight: 0.3 },
  initialized: false
};

const SELECTORS = [
  "[data-professor]",
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
  ".meeting .instructor"
];

function hostMatchesConfiguredDomain(cfgDomain) {
  if (!cfgDomain) return true; // allow everywhere if not configured
  try {
    return location.hostname.includes(new URL(`https://${cfgDomain}`).hostname) ||
      location.hostname.includes(cfgDomain);
  } catch {
    return location.hostname.includes(cfgDomain);
  }
}

async function bootstrap() {
  if (STATE.initialized) return;
  const cfg = await chrome.runtime.sendMessage({ type: "CFG_GET" });
  if (!hostMatchesConfiguredDomain(cfg?.scheduleDomain)) return;
  STATE.weights = cfg?.weights || STATE.weights;
  await scanAndAnnotate();
  observeMutations();
  STATE.initialized = true;
}

function observeMutations() {
  const obs = new MutationObserver((mut) => {
    const shouldRescan = mut.some((m) => m.addedNodes && m.addedNodes.length > 0);
    if (shouldRescan) {
      // throttle
      if (observeMutations._timer) clearTimeout(observeMutations._timer);
      observeMutations._timer = setTimeout(() => scanAndAnnotate(), 250);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

function findProfessorElements() {
  const found = new Map(); // element -> name
  for (const sel of SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      const name =
        el.getAttribute("data-professor") ||
        el.textContent;
      const n = normalizeWhitespace(name || "");
      if (!n) return;
      // Avoid duplicates if already processed
      if (!found.has(el)) found.set(el, n);
    });
  }
  return Array.from(found.entries()).map(([el, name]) => ({ el, name }));
}

async function scanAndAnnotate() {
  const profs = findProfessorElements();
  const uniqueNames = Array.from(new Set(profs.map((p) => p.name)));
  if (uniqueNames.length === 0) return;
  const res = await fetchTeacherForNameBatch(uniqueNames, {});
  STATE.ratingsByName = res || {};
  for (const { el, name } of profs) {
    annotateElement(el, name, STATE.ratingsByName[name]);
  }
}

function annotateElement(el, name, rating) {
  // idempotent: avoid duplicate badges
  if (el.querySelector?.(".rmp-badge")) return;
  const badge = document.createElement("span");
  badge.className = "rmp-badge";
  let text = "RMP n/a";
  let title = "No RMP profile found";
  if (rating && !rating.notFound) {
    const r = Number(rating.avgRating || 0).toFixed(1);
    const d = Number(rating.avgDifficulty || 0).toFixed(1);
    const n = rating.numRatings || 0;
    text = `⭐ ${r} · Diff ${d} (${n})`;
    title = `${name}\nOverall: ${r}\nDifficulty: ${d}\nRatings: ${n}${rating.department ? `\nDept: ${rating.department}` : ""}`;
  }
  badge.textContent = text;
  badge.title = title;
  el.appendChild(badge);
}

// Recommendations
function computeCompositeScore(rating, weights) {
  if (!rating || rating.notFound) return null;
  const o = Number(rating.avgRating || 0);
  const d = Number(rating.avgDifficulty || 0);
  const { overallWeight, difficultyWeight } = weights;
  return overallWeight * o - difficultyWeight * d;
}

function extractCourseKeyFromRow(el) {
  // Walk up a few ancestors to find text that looks like a course code
  let node = el;
  for (let i = 0; i < 4 && node; i++) {
    const text = node.textContent || "";
    const m = text.match(/\b([A-Z]{2,5})\s*-?\s*(\d{3,4}[A-Z]?)\b/);
    if (m) return `${m[1]} ${m[2]}`;
    node = node.parentElement;
  }
  return null;
}

function collectSections() {
  // Group elements by course key and attach rating info
  const profs = findProfessorElements();
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

function openRecommendationsDrawer() {
  const existing = document.getElementById("rmp-drawer");
  if (existing) {
    existing.remove();
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
          <span class="rmp-stat">⭐ ${r} · Diff ${d}${s.rating?.numRatings ? ` (${s.rating.numRatings})` : ""}</span>
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
      note.textContent = `Best option: ${best.name}`;
      courseBlock.appendChild(note);
    }
    courseBlock.appendChild(list);
    body.appendChild(courseBlock);
  }

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);
}

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.type === "OPEN_RECOMMENDATIONS") {
    openRecommendationsDrawer();
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

