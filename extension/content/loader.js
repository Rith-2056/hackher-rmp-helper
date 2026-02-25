// Loader for ES module content scripts. Content scripts must use dynamic import
// because the manifest's "js" array does not support type: "module".
(async () => {
  // Only run in top frame to avoid duplicate panels in iframes
  if (window !== window.top) {
    // Still load schedule.js in iframes for professor detection
    try {
      const scheduleSrc = chrome.runtime.getURL("content/schedule.js");
      await import(scheduleSrc);
    } catch (e) {
      console.error("[RMP Helper] Failed to load content script:", e);
    }
    return;
  }

  try {
    const scheduleSrc = chrome.runtime.getURL("content/schedule.js");
    await import(scheduleSrc);
  } catch (e) {
    console.error("[RMP Helper] Failed to load content script:", e);
  }

  // Load Omni-Search engine (Cmd/Ctrl+K)
  try {
    const omniSrc = chrome.runtime.getURL("content/omniSearch.js");
    const { initOmniSearch } = await import(omniSrc);
    await initOmniSearch();
  } catch (e) {
    console.error("[RMP Helper] Failed to load Omni-Search:", e);
  }

  // Load Floating Panel (extension icon click opens it)
  try {
    const panelSrc = chrome.runtime.getURL("content/floatingPanel.js");
    const { initFloatingPanel } = await import(panelSrc);
    initFloatingPanel();
  } catch (e) {
    console.error("[RMP Helper] Failed to load Floating Panel:", e);
  }
})();
