function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getRatingClass(avgRating) {
  if (avgRating == null || Number.isNaN(avgRating)) return "pp-pill-na";
  const r = Number(avgRating);
  if (r < 2.5) return "pp-pill-red";
  if (r < 3) return "pp-pill-red-yellow";
  if (r < 3.5) return "pp-pill-yellow";
  if (r < 4) return "pp-pill-yellow-green";
  if (r < 4.5) return "pp-pill-light-green";
  return "pp-pill-bold-green";
}

function renderPill(content, className = "") {
  return `<span class="pp-pill ${className}">${escapeHtml(content)}</span>`;
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function loadCourseData() {
  try {
    return await chrome.runtime.sendMessage({ type: "RMP_REQUEST_SNAPSHOT" });
  } catch (e) {
    console.warn("[ZooReviews popup]", e.message);
    return { courses: [] };
  }
}

function renderCourses(snapshot) {
  const body = document.getElementById("ppBody");
  const courses = snapshot?.courses || [];

  if (courses.length === 0) {
    body.innerHTML = `
      <div class="pp-empty-msg">
        <div class="pp-empty-icon">&#x1F50D;</div>
        No professor ratings found yet.<br/>
        Open a schedule page to see ratings here, or use the floating panel to search.
      </div>`;
    return;
  }

  let html = "";

  if (snapshot._fromCache) {
    html += `<div class="pp-cache-badge">Saved from last schedule visit</div>`;
  }

  for (const course of courses) {
    const { courseKey, sections } = course;
    if (!sections?.length) continue;

    const rows = sections.map((s) => {
      const ratingStr = s.avgRating != null ? Number(s.avgRating).toFixed(1) : "n/a";
      const diffStr = s.avgDifficulty != null ? Number(s.avgDifficulty).toFixed(1) : "n/a";
      const countStr = `(${s.numRatings || 0})`;
      const ratingClass = getRatingClass(s.avgRating);
      const pills = [
        renderPill(`\u2B50 ${ratingStr}`, `pp-pill-rating ${ratingClass}`),
        renderPill(`Diff ${diffStr}`, "pp-pill-diff"),
        renderPill(countStr, "pp-pill-count")
      ].join(" ");
      const rmpHref = s.rmpUrl || `https://www.ratemyprofessors.com/search/professors?q=${encodeURIComponent(s.professorName || "")}`;
      const timeHtml = s.timeText ? `<span class="pp-prof-time">${escapeHtml(s.timeText)}</span>` : "";

      return `
        <div class="pp-prof-row">
          <div class="pp-prof-main">
            <span class="pp-prof-name">${escapeHtml(s.professorName)}</span>
            <div class="pp-prof-pills">${pills}</div>
            ${timeHtml}
          </div>
          <a href="${escapeHtml(rmpHref)}" target="_blank" rel="noopener noreferrer" class="pp-btn-rmp">RMP</a>
        </div>`;
    }).join("");

    html += `
      <div class="pp-course-card">
        <div class="pp-course-title">${escapeHtml(courseKey)}</div>
        ${rows}
      </div>`;
  }

  body.innerHTML = html;
}

function computeRecommendations(courses) {
  const overallWeight = 0.7;
  const difficultyWeight = 0.3;
  const score = (rating, difficulty) =>
    overallWeight * (Number(rating) || 0) - difficultyWeight * (Number(difficulty) || 0);

  const recs = [];
  for (const course of courses || []) {
    const { courseKey, sections } = course;
    if (!sections?.length) continue;

    const sorted = [...sections].sort((a, b) => {
      const sa = score(a.avgRating, a.avgDifficulty);
      const sb = score(b.avgRating, b.avgDifficulty);
      if (sb !== sa) return sb - sa;
      return (b.numRatings || 0) - (a.numRatings || 0);
    });

    if (sorted.length > 1) {
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      if (score(best.avgRating, best.avgDifficulty) > score(worst.avgRating, worst.avgDifficulty) + 0.3) {
        const bestRating = best.avgRating != null ? Number(best.avgRating).toFixed(1) : "n/a";
        const worstRating = worst.avgRating != null ? Number(worst.avgRating).toFixed(1) : "n/a";
        recs.push(`${courseKey}: Consider ${best.professorName} (${bestRating}) over ${worst.professorName} (${worstRating})`);
      }
    }
  }
  return recs;
}

function showRecommendations(snapshot) {
  const responseEl = document.getElementById("recoResponse");
  responseEl.style.display = "block";
  const courses = snapshot?.courses || [];

  if (courses.length === 0) {
    responseEl.className = "pp-reco-response pp-empty";
    responseEl.textContent = "Open a schedule page to see recommendations.";
    return;
  }

  const recs = computeRecommendations(courses);
  if (recs.length === 0) {
    responseEl.className = "pp-reco-response pp-empty";
    responseEl.textContent = "All professors look good! No swaps recommended.";
    return;
  }

  responseEl.className = "pp-reco-response";
  responseEl.textContent = recs.join("\n\n");
}

async function openFloatingPanel() {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_FLOATING_PANEL" });
    window.close();
  } catch (e) {
    console.warn("[ZooReviews popup]", e.message);
  }
}

async function init() {
  const snapshot = await loadCourseData();
  renderCourses(snapshot);

  document.getElementById("btnReco").addEventListener("click", () => showRecommendations(snapshot));
  document.getElementById("btnPanel").addEventListener("click", openFloatingPanel);
  document.getElementById("btnRefresh").addEventListener("click", async () => {
    const body = document.getElementById("ppBody");
    body.innerHTML = '<div class="pp-loading">Refreshing...</div>';
    const snap = await loadCourseData();
    renderCourses(snap);
  });
}

init();
