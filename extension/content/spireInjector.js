/**
 * SPIRE Schedule Builder Injection System
 * Injects "Liquid Glass" rating badges and "Vibe Check" tooltips next to professor names.
 * All UI lives inside Shadow DOM roots for complete style isolation.
 */

import { searchProfessors } from "../shared/rmpClient.js";

const CACHE_KEY_PREFIX = "spire.prof.";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INJECTED_ATTR = "data-zooreview-injected";
const OBSERVER_DEBOUNCE_MS = 500;

let tooltipHost = null;
let tooltipShadow = null;
let activeTooltip = null;
let hideTooltipTimer = null;

// ─── Professor tags based on rating & difficulty ───────────────────────
function generateTags(rating) {
  const tags = [];
  const diff = rating.avgDifficulty || 0;
  const score = rating.avgRating || 0;
  const wta = rating.wouldTakeAgainPercent;

  if (diff >= 4.0) tags.push("Heavy Workload");
  else if (diff >= 3.0) tags.push("Moderate Workload");
  else tags.push("Light Workload");

  if (score >= 4.0) tags.push("Clear Lectures");
  else if (score < 2.5) tags.push("Unclear Lectures");

  if (diff >= 3.5) tags.push("Tough Grading");
  else if (diff < 2.5) tags.push("Easy Grading");
  else tags.push("Fair Grading");

  if (wta != null && wta >= 80) tags.push("Highly Recommended");
  if (wta != null && wta < 40) tags.push("Low Approval");

  return tags.slice(0, 3);
}

// ─── Cache helpers (24h TTL via chrome.storage.local) ──────────────────
async function getCachedRating(name) {
  try {
    const key = CACHE_KEY_PREFIX + name.toLowerCase().replace(/\s+/g, "_");
    const result = await chrome.storage.local.get([key]);
    const entry = result[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      await chrome.storage.local.remove([key]);
      return null;
    }
    return entry.value;
  } catch { return null; }
}

async function setCachedRating(name, value) {
  try {
    const key = CACHE_KEY_PREFIX + name.toLowerCase().replace(/\s+/g, "_");
    await chrome.storage.local.set({
      [key]: { value, expiresAt: Date.now() + CACHE_TTL_MS }
    });
  } catch {}
}

// ─── Fetch rating for a professor name ─────────────────────────────────
async function fetchRating(name) {
  const cached = await getCachedRating(name);
  if (cached) return cached;

  try {
    const results = await searchProfessors(name);
    if (!results || results.length === 0) {
      const notFound = { notFound: true };
      await setCachedRating(name, notFound);
      return notFound;
    }
    // Pick best match
    const best = results[0];
    const rating = {
      name: best.name,
      avgRating: best.avgRating,
      avgDifficulty: best.avgDifficulty,
      numRatings: best.numRatings,
      department: best.department,
      legacyId: best.legacyId,
      wouldTakeAgainPercent: best.wouldTakeAgainPercent || null
    };
    await setCachedRating(name, rating);
    return rating;
  } catch (e) {
    console.warn("[ZooReviews] Rating fetch failed:", e);
    return { notFound: true };
  }
}

// ─── Color logic: Emerald / Amber / Ruby ───────────────────────────────
function ratingTier(score) {
  if (score == null) return "na";
  if (score >= 3.5) return "emerald";
  if (score >= 2.5) return "amber";
  return "ruby";
}

function scoreColor(score) {
  if (score == null) return "#78716c";
  if (score >= 3.5) return "#10b981";
  if (score >= 2.5) return "#f59e0b";
  return "#ef4444";
}

// ─── Create global tooltip host (Shadow DOM) ───────────────────────────
function ensureTooltipHost() {
  if (tooltipHost) return;
  tooltipHost = document.createElement("div");
  tooltipHost.id = "zooreview-tooltip-host";
  tooltipHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;pointer-events:none;";
  document.documentElement.appendChild(tooltipHost);
  tooltipShadow = tooltipHost.attachShadow({ mode: "closed" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/liquidGlass.css");
  tooltipShadow.appendChild(link);
}

// ─── Show "Vibe Check" tooltip ─────────────────────────────────────────
function showTooltip(badge, rating) {
  if (!rating || rating.notFound) return;
  ensureTooltipHost();
  tooltipHost.style.pointerEvents = "auto";

  if (hideTooltipTimer) {
    clearTimeout(hideTooltipTimer);
    hideTooltipTimer = null;
  }

  // Remove old tooltip
  if (activeTooltip) activeTooltip.remove();

  const rect = badge.getBoundingClientRect();
  const tooltip = document.createElement("div");
  tooltip.className = "lg-tooltip";

  const wta = rating.wouldTakeAgainPercent;
  const wtaDisplay = wta != null && wta >= 0 ? Math.round(wta) + "%" : "N/A";
  const tags = generateTags(rating);
  const tier = ratingTier(rating.avgRating);
  const color = scoreColor(rating.avgRating);

  const profName = escapeHtml(rating.name || "Unknown");
  const redditQuery = encodeURIComponent(rating.name + " UMass");

  tooltip.innerHTML = `
    <div class="lg-tooltip-header">
      <span class="lg-tooltip-name">${profName}</span>
      <span class="lg-tooltip-score-lg" style="color:${color}">${rating.avgRating != null ? rating.avgRating.toFixed(1) : "?"}</span>
    </div>
    <div class="lg-tooltip-body">
      <div class="lg-tooltip-wta">
        <div class="lg-tooltip-wta-pct" style="color:${wta != null && wta >= 50 ? '#10b981' : '#ef4444'}">${wtaDisplay}</div>
        <div class="lg-tooltip-wta-label">Would Take Again</div>
      </div>
      <div class="lg-tooltip-tags">
        ${tags.map(t => `<span class="lg-tooltip-tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      <div class="lg-tooltip-stats">
        <div class="lg-tooltip-stat">
          <div class="lg-tooltip-stat-val" style="color:${color}">${rating.avgRating != null ? rating.avgRating.toFixed(1) : "?"}</div>
          <div class="lg-tooltip-stat-label">Quality</div>
        </div>
        <div class="lg-tooltip-stat">
          <div class="lg-tooltip-stat-val">${rating.avgDifficulty != null ? rating.avgDifficulty.toFixed(1) : "?"}</div>
          <div class="lg-tooltip-stat-label">Difficulty</div>
        </div>
        <div class="lg-tooltip-stat">
          <div class="lg-tooltip-stat-val">${rating.numRatings || 0}</div>
          <div class="lg-tooltip-stat-label">Ratings</div>
        </div>
      </div>
    </div>
    <div class="lg-tooltip-links">
      <a class="lg-tooltip-link" href="https://www.ratemyprofessors.com/professor/${rating.legacyId || ""}" target="_blank" rel="noopener">
        View on RMP
      </a>
      <a class="lg-tooltip-link" href="https://www.reddit.com/r/umass/search/?q=${redditQuery}" target="_blank" rel="noopener">
        r/umass
      </a>
    </div>
  `;

  tooltipShadow.appendChild(tooltip);
  activeTooltip = tooltip;

  // Position tooltip
  const tooltipRect = tooltip.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - 160;

  // Keep within viewport
  if (left < 8) left = 8;
  if (left + 320 > window.innerWidth - 8) left = window.innerWidth - 328;
  if (top + tooltipRect.height > window.innerHeight - 8) {
    top = rect.top - tooltipRect.height - 8;
  }

  tooltip.style.position = "fixed";
  tooltip.style.top = top + "px";
  tooltip.style.left = left + "px";

  // Animate in
  requestAnimationFrame(() => {
    tooltip.classList.add("lg-tooltip-visible");
  });

  // Keep tooltip alive when hovering over it
  tooltip.addEventListener("mouseenter", () => {
    if (hideTooltipTimer) {
      clearTimeout(hideTooltipTimer);
      hideTooltipTimer = null;
    }
  });
  tooltip.addEventListener("mouseleave", () => {
    scheduleHideTooltip();
  });
}

function scheduleHideTooltip() {
  if (hideTooltipTimer) clearTimeout(hideTooltipTimer);
  hideTooltipTimer = setTimeout(() => {
    hideTooltip();
  }, 250);
}

function hideTooltip() {
  if (activeTooltip) {
    activeTooltip.classList.remove("lg-tooltip-visible");
    const el = activeTooltip;
    setTimeout(() => el.remove(), 350);
    activeTooltip = null;
  }
  if (tooltipHost) {
    tooltipHost.style.pointerEvents = "none";
  }
}

function escapeHtml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Create inline badge (Shadow DOM isolated) ─────────────────────────
function createBadge(rating) {
  // Create a shadow host for this badge
  const host = document.createElement("span");
  host.style.cssText = "all:initial;display:inline;vertical-align:middle;position:relative;";
  host.setAttribute(INJECTED_ATTR, "true");
  const shadow = host.attachShadow({ mode: "closed" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/liquidGlass.css");
  shadow.appendChild(link);

  const tier = rating.notFound ? "na" : ratingTier(rating.avgRating);
  const scoreText = rating.notFound
    ? "N/A"
    : (rating.avgRating != null ? rating.avgRating.toFixed(1) : "?");

  const badge = document.createElement("span");
  badge.className = `lg-badge lg-badge-${tier}`;
  badge.innerHTML = `<span class="lg-badge-star">&#9733;</span> ${scoreText}`;
  shadow.appendChild(badge);

  // Tooltip on hover
  badge.addEventListener("mouseenter", () => showTooltip(host, rating));
  badge.addEventListener("mouseleave", () => scheduleHideTooltip());

  // Click to open RMP
  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (rating.legacyId) {
      window.open(`https://www.ratemyprofessors.com/professor/${rating.legacyId}`, "_blank");
    }
  });

  return host;
}

// ─── DOM Scanning for professor names on SPIRE ─────────────────────────
const NAME_RE = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}$/;
const SKIP_WORDS = new Set([
  "Campus", "Amherst", "Main", "North", "South", "East", "West",
  "Online", "Remote", "Virtual", "Honors", "Spring", "Fall", "Summer",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
  "Schedule", "Builder", "Search", "Class", "Click"
]);

function isLikelyProfessorName(text) {
  const t = (text || "").trim();
  if (!NAME_RE.test(t)) return false;
  return !t.split(/\s+/).some(w => SKIP_WORDS.has(w));
}

function getSearchRoots() {
  const roots = [document];
  try {
    document.querySelectorAll("iframe").forEach(frame => {
      try {
        if (frame.contentDocument?.body) roots.push(frame.contentDocument);
      } catch (_) {}
    });
  } catch (_) {}
  return roots;
}

// ─── Scan and inject badges ────────────────────────────────────────────
async function scanAndInject() {
  const INSTRUCTOR_SELECTORS = [
    "td[headers*='instructor']",
    "td[headers*='Instructor']",
    "td.instructor",
    "[data-professor]",
    "[data-instructor]",
    ".instructor",
    ".professor",
    "[class*='instructor']",
    "[class*='Instructor']",
    "[class*='professor']",
    "[class*='Professor']"
  ];

  const candidates = new Map();

  for (const doc of getSearchRoots()) {
    // Strategy 1: Look for instructor column cells
    try {
      doc.querySelectorAll("table").forEach(table => {
        const headers = [...(table.querySelectorAll("th") || [])];
        const instrIdx = headers.findIndex(th => {
          const t = (th.textContent || "").trim();
          return t === "Instructor" || t === "Professor";
        });
        if (instrIdx < 0) return;

        table.querySelectorAll("tbody tr").forEach(row => {
          if (!row.cells || row.cells.length <= instrIdx) return;
          const cell = row.cells[instrIdx];
          if (cell.querySelector(`[${INJECTED_ATTR}]`)) return;
          const text = (cell.textContent || "").trim()
            .replace(/\s*\d+\.\d+\s*·\s*Diff\s*[\d.]+\s*\(\d+\)\s*$/i, "")
            .replace(/\s*RMP\s*n\/a\s*$/i, "")
            .trim();
          if (isLikelyProfessorName(text)) {
            candidates.set(cell, text);
          }
        });
      });
    } catch (_) {}

    // Strategy 2: Use known CSS selectors
    try {
      for (const sel of INSTRUCTOR_SELECTORS) {
        doc.querySelectorAll(sel).forEach(el => {
          if (el.querySelector(`[${INJECTED_ATTR}]`)) return;
          const text = (el.textContent || "").trim();
          if (isLikelyProfessorName(text) && !candidates.has(el)) {
            candidates.set(el, text);
          }
        });
      }
    } catch (_) {}

    // Strategy 3: Calendar event blocks (last line = professor name)
    try {
      const calendarSel = "[class*='fc-event'],[class*='rbc-event'],[class*='event'][class*='title'],[class*='course'][class*='block']";
      doc.querySelectorAll(calendarSel).forEach(block => {
        if (block.querySelector(`[${INJECTED_ATTR}]`)) return;
        const lines = (block.textContent || "").split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          if (isLikelyProfessorName(lines[i])) {
            // Find the element containing just this name
            const nameEl = findNameElement(block, lines[i]);
            if (nameEl && !candidates.has(nameEl)) {
              candidates.set(nameEl, lines[i]);
            }
            break;
          }
        }
      });
    } catch (_) {}
  }

  // Fetch ratings and inject badges
  const names = [...new Set(candidates.values())];
  const ratingMap = {};

  await Promise.all(names.map(async name => {
    ratingMap[name] = await fetchRating(name);
  }));

  for (const [el, name] of candidates) {
    if (el.querySelector(`[${INJECTED_ATTR}]`)) continue;
    const rating = ratingMap[name];
    if (rating) {
      const badge = createBadge(rating);
      el.appendChild(badge);
    }
  }
}

function findNameElement(root, name) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const t = (node.textContent || "").trim();
      if (t === name) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    }
  });
  let best = null;
  let bestLen = Infinity;
  let node;
  while ((node = walker.nextNode())) {
    const len = (node.textContent || "").length;
    if (len < bestLen) {
      best = node;
      bestLen = len;
    }
  }
  return best || root;
}

// ─── Mutation Observer (handle dynamic SPIRE content) ──────────────────
let debounceTimer = null;

function observeDOM() {
  const observer = new MutationObserver(mutations => {
    const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
    if (!hasNewNodes) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanAndInject();
    }, OBSERVER_DEBOUNCE_MS);
  });

  // Observe main document
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Also observe iframes when they load
  const observeIframes = () => {
    document.querySelectorAll("iframe").forEach(frame => {
      try {
        if (frame.contentDocument?.body && !frame.dataset.zooreviewObserved) {
          frame.dataset.zooreviewObserved = "true";
          observer.observe(frame.contentDocument.documentElement, {
            childList: true, subtree: true
          });
        }
      } catch (_) {}
    });
  };

  observeIframes();
  // Re-check for new iframes periodically
  setInterval(observeIframes, 3000);
}

// ─── Initialize ────────────────────────────────────────────────────────
export async function initSpireInjector() {
  // Initial scan
  await scanAndInject();
  // Watch for dynamic content
  observeDOM();
  console.log("[ZooReviews] SPIRE injector active");
}
