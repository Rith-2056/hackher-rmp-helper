// Loader for ES module content scripts. Content scripts must use dynamic import
// because the manifest's "js" array does not support type: "module".
(async () => {
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

  // Load SPIRE Schedule Builder injector
  try {
    const spireSrc = chrome.runtime.getURL("content/spireInjector.js");
    const { initSpireInjector } = await import(spireSrc);
    await initSpireInjector();
  } catch (e) {
    console.error("[RMP Helper] Failed to load SPIRE injector:", e);
  }
})();
