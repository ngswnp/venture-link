import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CACHE_PATH = path.join(ROOT_DIR, '.cache', 'cala-cache.json');
const CALA_BASE_URL = 'https://api.cala.ai';

export function loadEnvFile(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function makeRequestHash(method, apiPath, body) {
  const payload = JSON.stringify({ method, apiPath, body: body ?? null });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function createCalaClient(options = {}) {
  const cachePath = options.cachePath || options.cacheFile || DEFAULT_CACHE_PATH;
  const maxLiveCalls = options.maxLiveCalls ?? 8;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const getApiKey = () => options.apiKey ?? process.env.CALA_API_KEY ?? '';

  let liveCallsUsed = 0;
  let cacheHits = 0;
  let cacheStore = {};

  function loadCache() {
    try {
      if (fs.existsSync(cachePath)) {
        cacheStore = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    } catch {
      cacheStore = {};
    }
  }

  function saveCache() {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cacheStore, null, 2), 'utf8');
    } catch {
      // Ignore disk write failure in read-only test scenarios
    }
  }

  loadCache();

  async function request(method, apiPath, body = null) {
    const key = makeRequestHash(method, apiPath, body);
    if (cacheStore[key]) {
      cacheHits += 1;
      return {
        data: cacheStore[key].data,
        fromCache: true,
        cachedAt: cacheStore[key].cachedAt,
        budget: getBudgetStatus()
      };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      const err = new Error('CALA_API_KEY is not configured in environment or .env file.');
      err.statusCode = 400;
      throw err;
    }

    if (liveCallsUsed >= maxLiveCalls) {
      const err = new Error(
        `Cala live API budget reached (${liveCallsUsed}/${maxLiveCalls} uncached calls used). Cached queries remain free.`
      );
      err.statusCode = 429;
      throw err;
    }

    liveCallsUsed += 1;
    const headers = {
      'X-API-KEY': apiKey,
      'Accept': 'application/json'
    };
    const fetchOpts = { method, headers };
    if (body !== null && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetchFn(`${CALA_BASE_URL}${apiPath}`, fetchOpts);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(
        parsed?.message || parsed?.detail || `Cala API returned HTTP ${res.status} on ${apiPath}`
      );
      err.statusCode = res.status;
      err.calaResponse = parsed;
      throw err;
    }

    const cachedAt = new Date().toISOString();
    cacheStore[key] = { method, apiPath, body, cachedAt, data: parsed };
    saveCache();

    return {
      data: parsed,
      fromCache: false,
      cachedAt,
      budget: getBudgetStatus()
    };
  }

  function getBudgetStatus() {
    return {
      configured: Boolean(getApiKey()),
      liveCallsUsed,
      maxLiveCalls,
      cacheHits,
      cachedEntries: Object.keys(cacheStore).length
    };
  }

  async function calaEntitySearch(name, limit = 5, entityTypes = []) {
    const params = new URLSearchParams({ name: String(name || '').trim(), limit: String(limit) });
    for (const t of entityTypes) params.append('entity_types', t);
    return request('GET', `/v1/entities?${params.toString()}`, null);
  }

  async function calaEntityLookup(params = {}) {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        searchParams.set(k, String(v).trim());
      }
    }
    return request('GET', `/v1/entities/lookup?${searchParams.toString()}`, null);
  }

  async function calaIntrospect(entityId) {
    return request('GET', `/v1/entities/${encodeURIComponent(entityId)}/introspection`, null);
  }

  async function calaRetrieveEntity(entityId, body = {}) {
    return request('POST', `/v1/entities/${encodeURIComponent(entityId)}`, body);
  }

  async function calaKnowledgeSearch(input, options = {}) {
    return request('POST', '/v1/knowledge/search', {
      input,
      explainability: options.explainability ?? true,
      return_entities: options.returnEntities ?? true
    });
  }

  let cachedEntityIndex = null;
  let cachedEntityCount = -1;

  function getCachedEntities() {
    const entries = Object.values(cacheStore || {});
    if (cachedEntityIndex && cachedEntityCount === entries.length) {
      return cachedEntityIndex;
    }
    const byId = new Map();
    const scoreRichness = (entity) => {
      if (!entity || typeof entity !== 'object') return 0;
      const outRels = Object.values(entity.relationships?.outgoing || {}).reduce(
        (s, list) => s + (Array.isArray(list) ? list.length : 0),
        0
      );
      const inRels = Object.values(entity.relationships?.incoming || {}).reduce(
        (s, list) => s + (Array.isArray(list) ? list.length : 0),
        0
      );
      return (entity.relationships ? 10 : 0) + (entity.description ? 2 : 0) + outRels + inRels;
    };
    const consider = (entity) => {
      if (!entity?.id || !entity?.name) return;
      const id = String(entity.id);
      const prev = byId.get(id);
      if (!prev || scoreRichness(entity) >= scoreRichness(prev)) {
        byId.set(id, { ...prev, ...entity, description: entity.description || prev?.description });
      }
    };
    for (const entry of entries) {
      const data = entry?.data;
      if (!data) continue;
      if (data.id && data.name) consider(data);
      if (Array.isArray(data.entities)) {
        for (const item of data.entities) consider(item);
      }
    }
    cachedEntityCount = entries.length;
    cachedEntityIndex = [...byId.values()];
    return cachedEntityIndex;
  }

  return {
    getBudgetStatus,
    getCachedEntities,
    calaEntitySearch,
    calaEntityLookup,
    calaIntrospect,
    calaRetrieveEntity,
    calaKnowledgeSearch
  };
}
