// Thin wrapper over chrome.storage.local with JSON + TTL helpers
export const Storage = {
  async get(key) {
    const result = await chrome.storage.local.get([key]);
    return result[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove([key]);
  },
  async getJSON(key, defaultValue = null) {
    const raw = await this.get(key);
    if (raw == null) return defaultValue;
    try {
      return JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  },
  async setJSON(key, obj) {
    await this.set(key, JSON.stringify(obj));
  },
  async getWithTTL(key, nowMs = Date.now()) {
    const entry = await this.getJSON(key);
    if (!entry) return null;
    if (entry.expiresAt && nowMs > entry.expiresAt) {
      await this.remove(key);
      return null;
    }
    return entry.value;
  },
  async setWithTTL(key, value, ttlMs) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    await this.setJSON(key, { value, expiresAt });
  }
};

// Keys
export const StorageKeys = {
  scheduleDomain: "cfg.scheduleDomain",
  rmpSchoolId: "cfg.rmpSchoolId",
  weights: "cfg.weights",
  badgeColor: "cfg.badgeColor", // hex, e.g. #1f6feb
  geminiApiKey: "cfg.geminiApiKey",
  manualMappings: "cfg.manualMappings", // { normalizedScheduleName: rmpTeacherId }
  ratingsCachePrefix: "cache.prof.",    // + composite key
  cacheTTLms: "cfg.cacheTTLms"
};

export async function getWeights() {
  const weights = await Storage.getJSON(StorageKeys.weights);
  return weights ?? { overallWeight: 0.7, difficultyWeight: 0.3 };
}

export function cacheKeyForProfessor(schoolId, firstName, lastName) {
  const key = `${(schoolId ?? "unknown").toUpperCase()}|${(lastName ?? "").toUpperCase()}|${(firstName ?? "").toUpperCase()}`;
  return StorageKeys.ratingsCachePrefix + key;
}

export async function getManualMappings() {
  return (await Storage.getJSON(StorageKeys.manualMappings)) ?? {};
}

export async function setManualMapping(normalizedName, teacherId) {
  const mappings = await getManualMappings();
  mappings[normalizedName] = teacherId;
  await Storage.setJSON(StorageKeys.manualMappings, mappings);
}

