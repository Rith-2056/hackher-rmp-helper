import { Storage, StorageKeys } from "../shared/storage.js";
import { normalizeNameForKey } from "../shared/nameMatcher.js";

async function loadCfg() {
  const domain = await Storage.get(StorageKeys.scheduleDomain);
  const schoolId = await Storage.get(StorageKeys.rmpSchoolId);
  document.getElementById("domain").value = domain ?? "";
  document.getElementById("schoolId").value = schoolId ?? "";
}

async function saveCfg() {
  const scheduleDomain = document.getElementById("domain").value.trim();
  const rmpSchoolId = document.getElementById("schoolId").value.trim();
  await chrome.runtime.sendMessage({
    type: "CFG_SET",
    payload: { scheduleDomain, rmpSchoolId }
  });
  const s = document.getElementById("cfgStatus");
  s.textContent = "Saved";
  setTimeout(() => (s.textContent = ""), 1200);
}

async function refreshMappings() {
  const mappings = (await Storage.getJSON(StorageKeys.manualMappings)) ?? {};
  const tbody = document.getElementById("mapTable");
  tbody.innerHTML = "";
  Object.entries(mappings).forEach(([nameKey, teacherId]) => {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    const idTd = document.createElement("td");
    const actTd = document.createElement("td");
    nameTd.textContent = nameKey;
    idTd.textContent = teacherId;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      delete mappings[nameKey];
      await Storage.setJSON(StorageKeys.manualMappings, mappings);
      await refreshMappings();
    });
    actTd.appendChild(del);
    tr.appendChild(nameTd);
    tr.appendChild(idTd);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  });
}

async function addMapping() {
  const name = document.getElementById("mapName").value.trim();
  const id = document.getElementById("mapId").value.trim();
  if (!name || !id) return;
  const key = normalizeNameForKey(name);
  const mappings = (await Storage.getJSON(StorageKeys.manualMappings)) ?? {};
  mappings[key] = id;
  await Storage.setJSON(StorageKeys.manualMappings, mappings);
  document.getElementById("mapName").value = "";
  document.getElementById("mapId").value = "";
  await refreshMappings();
}

async function clearCache() {
  await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
  const s = document.getElementById("cacheStatus");
  s.textContent = "Cleared";
  setTimeout(() => (s.textContent = ""), 1200);
}

document.getElementById("saveCfg").addEventListener("click", saveCfg);
document.getElementById("addMap").addEventListener("click", addMapping);
document.getElementById("clearCache").addEventListener("click", clearCache);

await loadCfg();
await refreshMappings();

