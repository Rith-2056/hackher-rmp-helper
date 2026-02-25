/**
 * Omni-Search Engine — "Google-style" professor search with Cmd+K / Ctrl+K.
 * Renders inside a Shadow DOM to isolate from host page styles.
 */

import Fuse from "../lib/fuse.min.mjs";
import { searchProfessors } from "../shared/rmpClient.js";

const RECENTLY_VIEWED_KEY = "omni.recentlyViewed";
const MAX_RECENT = 8;
const MAX_RESULTS = 10;

let fuse = null;
let professors = [];
let shadowRoot = null;
let hostEl = null;
let isOpen = false;
let activeIndex = -1;
let resultItems = [];
let searchToken = 0;

// ─── Load professor data & init Fuse ───────────────────────────────────
function buildFuseIndex(data) {
  return new Fuse(data, {
    keys: [
      { name: "name", weight: 0.7 },
      { name: "department", weight: 0.3 }
    ],
    threshold: 0.4,
    includeMatches: true,
    minMatchCharLength: 2,
    ignoreLocation: true
  });
}

async function loadProfessors() {
  try {
    const url = chrome.runtime.getURL("data/professors.json");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    professors = await resp.json();
    fuse = buildFuseIndex(professors);
  } catch (e) {
    console.warn("[ZooReviews] Failed to load professors.json:", e);
    // Initialize with empty data so search shows "no results" instead of "Loading..." forever
    if (!fuse) {
      professors = [];
      fuse = buildFuseIndex(professors);
    }
  }
}

// ─── Recently Viewed ───────────────────────────────────────────────────
async function getRecentlyViewed() {
  try {
    const result = await chrome.storage.local.get([RECENTLY_VIEWED_KEY]);
    return result[RECENTLY_VIEWED_KEY] || [];
  } catch { return []; }
}

async function addRecentlyViewed(prof) {
  const recent = await getRecentlyViewed();
  const filtered = recent.filter(r => r.name !== prof.name);
  filtered.unshift({
    name: prof.name,
    department: prof.department,
    rmp_score: prof.rmp_score,
    difficulty: prof.difficulty,
    num_ratings: prof.num_ratings,
    legacyId: prof.legacyId
  });
  await chrome.storage.local.set({
    [RECENTLY_VIEWED_KEY]: filtered.slice(0, MAX_RECENT)
  });
}

// ─── Score color class ─────────────────────────────────────────────────
function scoreClass(score) {
  if (score == null) return "lg-score-amber";
  if (score >= 3.5) return "lg-score-emerald";
  if (score >= 2.5) return "lg-score-amber";
  return "lg-score-ruby";
}

function badgeColor(score) {
  if (score == null) return "#78716c";
  if (score >= 3.5) return "#10b981";
  if (score >= 2.5) return "#f59e0b";
  return "#ef4444";
}

// ─── Highlight matched characters ──────────────────────────────────────
function highlightMatches(text, indices) {
  if (!indices || indices.length === 0) return escapeHtml(text);
  const chars = text.split("");
  const highlighted = new Set();
  for (const [start, end] of indices) {
    for (let i = start; i <= end; i++) highlighted.add(i);
  }
  let result = "";
  let inMark = false;
  for (let i = 0; i < chars.length; i++) {
    const escaped = escapeHtml(chars[i]);
    if (highlighted.has(i) && !inMark) {
      result += "<mark>" + escaped;
      inMark = true;
    } else if (!highlighted.has(i) && inMark) {
      result += "</mark>" + escaped;
      inMark = false;
    } else {
      result += escaped;
    }
  }
  if (inMark) result += "</mark>";
  return result;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Get trending professors (highest rated) ──────────────────────────
function getTrendingProfessors() {
  return [...professors]
    .sort((a, b) => (b.rmp_score || 0) - (a.rmp_score || 0))
    .slice(0, 6);
}

function isUMassProfessor(r) {
  const name = (r?.school?.name || "").toLowerCase();
  return name.includes("massachusetts") || name.includes("umass") || name.includes("amherst");
}

function mapRmpToOmniProf(r) {
  return {
    name: r.name || `${r.firstName || ""} ${r.lastName || ""}`.trim(),
    department: r.department || "",
    rmp_score: r.avgRating ?? null,
    difficulty: r.avgDifficulty ?? null,
    num_ratings: r.numRatings ?? 0,
    legacyId: r.legacyId || null
  };
}

// ─── Build the Shadow DOM ──────────────────────────────────────────────
function createShadowHost() {
  if (hostEl) return;
  hostEl = document.createElement("div");
  hostEl.id = "zooreview-omnisearch-host";
  hostEl.style.cssText = "all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;";
  document.documentElement.appendChild(hostEl);
  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  // Load Liquid Glass CSS
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/liquidGlass.css");
  shadowRoot.appendChild(link);
}

// ─── Render search results ─────────────────────────────────────────────
async function renderResults(query) {
  const token = ++searchToken;
  const container = shadowRoot.querySelector(".lg-results");
  if (!container) return;

  container.innerHTML = "";
  activeIndex = -1;
  resultItems = [];

  const trimmed = (query || "").trim();
  if (!trimmed) {
    await renderEmptyState(container);
    return;
  }

  if (!fuse) {
    container.innerHTML = `<div class="lg-no-results"><div class="lg-no-results-icon">...</div>Loading...</div>`;
    return;
  }

  const fuseResults = fuse.search(trimmed);
  const combined = [];
  const seenNames = new Set();

  fuseResults.forEach((result) => {
    const prof = result.item;
    const nameKey = (prof.name || "").toLowerCase();
    if (nameKey && !seenNames.has(nameKey)) {
      seenNames.add(nameKey);
      combined.push({
        prof,
        nameMatch: result.matches?.find(m => m.key === "name")
      });
    }
  });

  // If we still have room, augment with live RMP search results
  if (combined.length < MAX_RESULTS) {
    try {
      const live = await searchProfessors(trimmed);
      if (token !== searchToken) return; // stale response
      const filtered = (live || [])
        .filter(isUMassProfessor)
        .map(mapRmpToOmniProf)
        .filter((p) => {
          const key = (p.name || "").toLowerCase();
          return key && !seenNames.has(key);
        });
      filtered.slice(0, MAX_RESULTS - combined.length).forEach((prof) => {
        const key = (prof.name || "").toLowerCase();
        seenNames.add(key);
        combined.push({ prof, nameMatch: null });
      });
    } catch (e) {
      console.warn("[ZooReviews] Omni-Search live lookup failed:", e);
    }
  }

  if (combined.length === 0) {
    container.innerHTML = `<div class="lg-no-results"><div class="lg-no-results-icon">&#128269;</div>No professors found for &ldquo;${escapeHtml(trimmed)}&rdquo;</div>`;
    return;
  }

  const label = document.createElement("div");
  label.className = "lg-section-label";
  label.textContent = "Professors";
  container.appendChild(label);

  combined.slice(0, MAX_RESULTS).forEach(({ prof, nameMatch }, idx) => {
    const item = document.createElement("div");
    item.className = "lg-result-item";
    item.dataset.index = idx;

    const nameHtml = nameMatch
      ? highlightMatches(prof.name, nameMatch.indices)
      : escapeHtml(prof.name);

    item.innerHTML = `
      <div class="lg-result-info">
        <div class="lg-result-name">${nameHtml}</div>
        <div class="lg-result-dept">${escapeHtml(prof.department || "")}</div>
      </div>
      <div class="lg-result-score">
        <span class="lg-score-pill ${scoreClass(prof.rmp_score)}">${prof.rmp_score != null ? prof.rmp_score.toFixed(1) : "N/A"}</span>
        <span class="lg-diff-pill">Diff ${prof.difficulty != null ? prof.difficulty.toFixed(1) : "?"}</span>
        <span class="lg-ratings-count">${prof.num_ratings || 0}</span>
      </div>
    `;

    item.addEventListener("click", () => selectProfessor(prof));
    item.addEventListener("mouseenter", () => setActive(idx));
    container.appendChild(item);
    resultItems.push(item);
  });
}

async function renderEmptyState(container) {
  const recent = await getRecentlyViewed();

  if (recent.length > 0) {
    const label = document.createElement("div");
    label.className = "lg-section-label";
    label.textContent = "Recently Viewed";
    container.appendChild(label);

    recent.forEach((prof, idx) => {
      const item = document.createElement("div");
      item.className = "lg-result-item";
      item.dataset.index = idx;
      item.innerHTML = `
        <div class="lg-result-info">
          <div class="lg-result-name">${escapeHtml(prof.name)}</div>
          <div class="lg-result-dept">${escapeHtml(prof.department || "")}</div>
        </div>
        <div class="lg-result-score">
          <span class="lg-score-pill ${scoreClass(prof.rmp_score)}">${prof.rmp_score != null ? prof.rmp_score.toFixed(1) : "N/A"}</span>
        </div>
      `;
      item.addEventListener("click", () => selectProfessor(prof));
      item.addEventListener("mouseenter", () => setActive(idx));
      container.appendChild(item);
      resultItems.push(item);
    });
  }

  // Trending
  const trending = getTrendingProfessors();
  if (trending.length > 0) {
    const trendLabel = document.createElement("div");
    trendLabel.className = "lg-section-label";
    trendLabel.textContent = recent.length > 0 ? "Trending Professors" : "Trending at UMass";
    container.appendChild(trendLabel);

    trending.forEach((prof, rawIdx) => {
      const idx = resultItems.length;
      const item = document.createElement("div");
      item.className = "lg-result-item";
      item.dataset.index = idx;
      item.innerHTML = `
        <div class="lg-result-info">
          <div class="lg-result-name">${escapeHtml(prof.name)}</div>
          <div class="lg-result-dept">${escapeHtml(prof.department || "")}</div>
        </div>
        <div class="lg-result-score">
          <span class="lg-score-pill ${scoreClass(prof.rmp_score)}">${prof.rmp_score.toFixed(1)}</span>
        </div>
      `;
      item.addEventListener("click", () => selectProfessor(prof));
      item.addEventListener("mouseenter", () => setActive(idx));
      container.appendChild(item);
      resultItems.push(item);
    });
  }
}

// ─── Navigation ────────────────────────────────────────────────────────
function setActive(idx) {
  resultItems.forEach(el => el.classList.remove("lg-active"));
  activeIndex = idx;
  if (idx >= 0 && idx < resultItems.length) {
    resultItems[idx].classList.add("lg-active");
    resultItems[idx].scrollIntoView({ block: "nearest" });
  }
}

function selectProfessor(prof) {
  addRecentlyViewed(prof);
  const legacyId = prof.legacyId;
  if (legacyId) {
    window.open(`https://www.ratemyprofessors.com/professor/${legacyId}`, "_blank");
  } else {
    const query = encodeURIComponent(prof.name + " UMass Amherst");
    window.open(`https://www.ratemyprofessors.com/search/professors?q=${query}`, "_blank");
  }
  closeSearch();
}

// ─── Open / Close ──────────────────────────────────────────────────────
function openSearch() {
  if (isOpen) return;
  isOpen = true;
  createShadowHost();

  // If professors haven't loaded yet, try loading them now
  if (professors.length === 0) {
    loadProfessors();
  }

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const kbdHint = isMac ? "&#8984;K" : "Ctrl+K";

  const overlay = document.createElement("div");
  overlay.className = "lg-overlay";
  overlay.innerHTML = `
    <div class="lg-modal">
      <div class="lg-search-bar">
        <svg class="lg-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="lg-search-input" type="text" placeholder="Search professors, departments..." autofocus spellcheck="false" autocomplete="off" />
        <span class="lg-search-kbd">${kbdHint}</span>
      </div>
      <div class="lg-results"></div>
      <div class="lg-footer">
        <span><kbd>&#8593;</kbd><kbd>&#8595;</kbd> navigate</span>
        <span><kbd>&#9166;</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeSearch();
  });

  shadowRoot.appendChild(overlay);

  // Trigger reflow for animation
  requestAnimationFrame(() => {
    overlay.classList.add("lg-visible");
  });

  const input = overlay.querySelector(".lg-search-input");
  input.addEventListener("input", () => renderResults(input.value));
  input.addEventListener("keydown", handleKeyDown);

  // Render empty state
  renderResults("");

  // Focus input
  setTimeout(() => input.focus(), 50);
}

function closeSearch() {
  if (!isOpen) return;
  isOpen = false;
  const overlay = shadowRoot?.querySelector(".lg-overlay");
  if (overlay) {
    overlay.classList.remove("lg-visible");
    setTimeout(() => overlay.remove(), 300);
  }
  activeIndex = -1;
  resultItems = [];
}

function handleKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActive(Math.min(activeIndex + 1, resultItems.length - 1));
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    setActive(Math.max(activeIndex - 1, 0));
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (activeIndex >= 0 && activeIndex < resultItems.length) {
      resultItems[activeIndex].click();
    }
    return;
  }
}

// ─── Global Keyboard Shortcut ──────────────────────────────────────────
function initKeyboardShortcut() {
  document.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const trigger = isMac ? e.metaKey && e.key === "k" : e.ctrlKey && e.key === "k";
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) {
        closeSearch();
      } else {
        openSearch();
      }
    }
  }, true);
}

// ─── Initialize ────────────────────────────────────────────────────────
export async function initOmniSearch() {
  // Register keyboard shortcut immediately so it's always available
  initKeyboardShortcut();
  // Load professor data in background (don't block shortcut registration)
  await loadProfessors();
  console.log("[ZooReviews] Omni-Search ready (Cmd/Ctrl+K)");
}
