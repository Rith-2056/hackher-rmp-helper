async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
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
    container.innerHTML = `<p class="empty-msg">Open a schedule page to see professor ratings here.</p>`;
    return;
  }
  const seen = new Set();
  const html = professors
    .filter((p) => {
      const key = `${p.course}|${p.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(
      (p) => `
    <div class="prof-row" data-name="${p.name}" data-course="${p.course}">
      <div class="prof-name">${p.name}</div>
      <div class="prof-course">${p.course}</div>
      <div class="prof-rating"><span class="badge">${formatRating(p.rating)}</span></div>
      ${
        p.bestAlternative
          ? `
        <button class="btn-alt" data-alt="${p.bestAlternative.name}" data-rating="${formatRating(p.bestAlternative.rating)}">Better option</button>
        <div class="prof-alt" style="display:none;">→ ${p.bestAlternative.name} (${formatRating(p.bestAlternative.rating)})</div>
      `
          : ""
      }
    </div>
  `
    )
    .join("");
  container.innerHTML = html;
  container.querySelectorAll(".btn-alt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alt = btn.nextElementSibling;
      alt.style.display = alt.style.display === "none" ? "block" : "none";
    });
  });
}

async function openRecommendations() {
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

  document.getElementById("btnReco").addEventListener("click", openRecommendations);
  document.getElementById("promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openRecommendations();
  });
}

init();
