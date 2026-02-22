import { fetchAllProfessorsForSubject } from "../shared/rmpClient.js";

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatRating(r) {
  if (!r || r.notFound) return "n/a";
  const avg = Number(r.avgRating || 0).toFixed(1);
  const diff = Number(r.avgDifficulty || 0).toFixed(1);
  const n = r.numRatings || 0;
  return `${avg} · Diff ${diff} (${n})`;
}


async function loadProfessorData() {
  const tabId = await getActiveTabId();
  if (!tabId) return { professors: [] };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_POPUP_DATA" });
  } catch (e) {
    console.warn("[RMP Helper]", e.message);
    return { professors: [] };
  }
}

function renderProfessors(professors) {
  const container = document.getElementById("profList");
  if (!professors?.length) {
    container.innerHTML = `<p class="empty-msg">No instructor names found on this page. Professor ratings (name, rating, difficulty, department) appear here when the schedule shows instructor names.</p>`;
    return;
  }
  const seen = new Set();
  const subjectFromCourse = (c) => (c || "").split(/\s+/)[0] || "";
  const html = professors
    .filter((p) => {
      const key = `${p.course}|${p.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(
      (p) => {
        const currRating = Number(p.rating?.avgRating) || 0;
        const isLowRated = currRating > 0 && currRating < 3.5;
        const subject = subjectFromCourse(p.course);
        return `
    <div class="prof-row" data-name="${p.name}" data-course="${p.course}" data-subject="${subject}">
      <div class="prof-name">${p.name}</div>
      <div class="prof-course">${p.course}</div>
      <div class="prof-rating"><span class="badge">${formatRating(p.rating)}</span></div>
      ${
        p.bestAlternative || (p.rmpAlternatives && p.rmpAlternatives.length)
          ? `
        <button class="btn-alt">Show alternatives</button>
        <div class="prof-alt" style="display:none;">
          ${p.bestAlternative ? `<div>→ ${p.bestAlternative.name} (${formatRating(p.bestAlternative.rating)}) — on your schedule</div>` : ""}
          ${(p.rmpAlternatives || []).map((a) => `<div>→ ${a.name} ⭐ ${Number(a.avgRating).toFixed(1)} · Diff ${Number(a.avgDifficulty || 0).toFixed(1)} (${a.numRatings || 0}) — at UMass</div>`).join("")}
        </div>
      `
          : ""
      }
      ${isLowRated && subject ? `<button class="btn-view-all" data-subject="${subject}">View all ${subject} professors</button>` : ""}
    </div>
  `;
      }
    )
    .join("");
  container.innerHTML = html;
  container.querySelectorAll(".btn-alt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alt = btn.nextElementSibling;
      alt.style.display = alt.style.display === "none" ? "block" : "none";
    });
  });
  container.querySelectorAll(".btn-view-all").forEach((btn) => {
    btn.addEventListener("click", () => showAllProfessorsForSubject(btn.dataset.subject));
  });
}

/**
 * Algorithm-based recommendations using RMP data.
 * Ranks alternatives by: 0.7 * rating - 0.3 * difficulty, tiebreak by numRatings.
 * All recommendations are from UMass (on-schedule or RMP search by subject at school).
 */
function computeRecommendations(professors) {
  const overallWeight = 0.7;
  const difficultyWeight = 0.3;

  const score = (rating, difficulty) =>
    overallWeight * (Number(rating) || 0) - difficultyWeight * (Number(difficulty) || 0);

  const recs = [];
  const seen = new Set();

  for (const p of professors || []) {
    const key = `${p.course}|${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const currRating = Number(p.rating?.avgRating) || 0;
    const alternatives = [];

    // On-schedule: better professor for same course (already at UMass)
    if (p.bestAlternative && p.bestAlternative.name !== p.name) {
      alternatives.push({
        name: p.bestAlternative.name,
        rating: p.bestAlternative.rating?.avgRating,
        difficulty: p.bestAlternative.rating?.avgDifficulty,
        numRatings: p.bestAlternative.rating?.numRatings
      });
    }

    // UMass alternatives from RMP (same subject, higher rating)
    for (const a of p.rmpAlternatives || []) {
      alternatives.push({
        name: a.name,
        rating: a.avgRating,
        difficulty: a.avgDifficulty,
        numRatings: a.numRatings
      });
    }

    if (alternatives.length === 0) continue;

    // Dedupe by name
    const byName = new Map();
    for (const a of alternatives) {
      const existing = byName.get(a.name);
      if (!existing || (a.numRatings || 0) > (existing.numRatings || 0)) {
        byName.set(a.name, a);
      }
    }
    const deduped = [...byName.values()];

    // Rank: higher composite score first, then more ratings
    deduped.sort((a, b) => {
      const sa = score(a.rating, a.difficulty);
      const sb = score(b.rating, b.difficulty);
      if (sb !== sa) return sb - sa;
      return (b.numRatings || 0) - (a.numRatings || 0);
    });

    const top = deduped.slice(0, 3);
    const ratingStr = currRating > 0 ? currRating.toFixed(1) : "n/a";
    const line = `${p.course}: ${p.name} has a ${ratingStr} rating. Consider: ${top.map((a) => `${a.name} (${Number(a.rating).toFixed(1)})`).join(", ")} — all at UMass.`;
    recs.push(line);
  }

  return recs;
}

async function showAllProfessorsForSubject(subject) {
  const responseEl = document.getElementById("recoResponse");
  responseEl.style.display = "block";
  responseEl.className = "reco-response";
  responseEl.textContent = "Loading…";
  try {
    const list = (await fetchAllProfessorsForSubject(subject)) || [];
    if (list.length === 0) {
      responseEl.className = "reco-response empty";
      responseEl.textContent = `No professors found for ${subject} at UMass. Make sure the RMP School ID is set in Options.`;
      return;
    }
    const lines = list.map(
      (p) =>
        `${p.name} — ⭐ ${Number(p.avgRating).toFixed(1)} · Diff ${Number(p.avgDifficulty || 0).toFixed(1)} (${p.numRatings || 0} reviews)`
    );
    responseEl.className = "reco-response";
    responseEl.textContent = `All professors for ${subject} at UMass (sorted by rating):\n\n${lines.join("\n")}`;
  } catch (e) {
    responseEl.className = "reco-response empty";
    responseEl.textContent = e.message || "Failed to load professors.";
  }
}

function showRecommendations(professors) {
  const responseEl = document.getElementById("recoResponse");
  responseEl.style.display = "block";

  if (!professors?.length) {
    responseEl.className = "reco-response empty";
    responseEl.textContent = "Open a schedule page to see professor recommendations.";
    return;
  }

  const recs = computeRecommendations(professors);
  if (recs.length === 0) {
    responseEl.className = "reco-response empty";
    responseEl.textContent = "All your professors have good ratings! No swaps recommended.";
    return;
  }

  responseEl.className = "reco-response";
  responseEl.textContent = recs.join("\n\n");
}

async function openRecommendationsDrawer() {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OPEN_RECOMMENDATIONS" });
  } catch (e) {
    console.warn("[RMP Helper]", e.message);
  }
}

async function init() {
  const { professors } = await loadProfessorData();
  renderProfessors(professors);

  document.getElementById("btnReco").addEventListener("click", () => showRecommendations(professors));
  document.getElementById("btnDrawer").addEventListener("click", openRecommendationsDrawer);
}

init();
