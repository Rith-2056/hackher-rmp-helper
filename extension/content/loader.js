// Loader for ES module content script. Content scripts must use dynamic import
// because the manifest's "js" array does not support type: "module".
(async () => {
  try {
    const src = chrome.runtime.getURL("content/schedule.js");
    await import(src);
  } catch (e) {
    console.error("[RMP Helper] Failed to load content script:", e);
  }
})();
