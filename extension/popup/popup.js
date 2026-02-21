import { Storage, StorageKeys } from "../shared/storage.js";

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function openRecommendations() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    document.getElementById("status").textContent = "No active tab";
    setTimeout(() => (document.getElementById("status").textContent = ""), 2000);
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OPEN_RECOMMENDATIONS" });
  } catch (e) {
    document.getElementById("status").textContent = "Open a schedule page first, then try again.";
    setTimeout(() => (document.getElementById("status").textContent = ""), 3000);
    console.warn("[RMP Helper]", e.message);
  }
}

async function init() {
  const weights = await Storage.getJSON(StorageKeys.weights);
  if (weights) {
    document.getElementById("overall").value = weights.overallWeight ?? 0.7;
    document.getElementById("difficulty").value = weights.difficultyWeight ?? 0.3;
  }
  document.getElementById("btn-reco").addEventListener("click", openRecommendations);
  document.getElementById("save").addEventListener("click", async () => {
    const overallWeight = Number(document.getElementById("overall").value);
    const difficultyWeight = Number(document.getElementById("difficulty").value);
    await chrome.runtime.sendMessage({
      type: "CFG_SET",
      payload: { weights: { overallWeight, difficultyWeight } }
    });
    document.getElementById("status").textContent = "Saved";
    setTimeout(() => (document.getElementById("status").textContent = ""), 1200);
  });
}

init();

