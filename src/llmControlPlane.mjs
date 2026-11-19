import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceFactCitations } from './engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_INSIGHT_DISK_CACHE = path.resolve(__dirname, '..', '.cache', 'claude-insight-cache.json');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 2000;

export const ALLOWED_INTENTS = new Set(['general', 'company', 'investor', 'industry', 'why_not']);
export const ALLOWED_REGIONS = new Set(['all', 'Nordics', 'DACH', 'UK', 'Western Europe', 'Europe']);
export const ALLOWED_STAGES = new Set(['all', 'pre_seed_seed', 'seed_series_a', 'series_a_plus']);
export const ALLOWED_ENTITY_SCOPES = new Set(['startups', 'all']);
export const ALLOWED_SECTORS = new Set([
  'AI & ML',
  'DeepTech',
  'HealthTech',
  'Fintech',
  'Climate Tech',
  'B2B SaaS'
]);

const queryCompilerCache = new Map();
const briefNarratorCache = new Map();
const connectionInsightCache = new Map();
const loadedDiskCaches = new Map();

function loadDiskInsightStore(diskCachePath) {
  if (!diskCachePath) return {};
  if (loadedDiskCaches.has(diskCachePath)) return loadedDiskCaches.get(diskCachePath);
  let store = {};
  try {
    if (fs.existsSync(diskCachePath)) {
      const parsed = JSON.parse(fs.readFileSync(diskCachePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) store = parsed;
    }
  } catch {
    store = {};
  }
  loadedDiskCaches.set(diskCachePath, store);
  return store;
}

function saveDiskInsightEntry(diskCachePath, hashKey, value) {
  if (!diskCachePath || !hashKey || !value) return;
  try {
    const store = loadDiskInsightStore(diskCachePath);
    const keys = Object.keys(store);
    if (keys.length >= 200) {
      delete store[keys[0]];
    }
    store[hashKey] = { cachedAt: new Date().toISOString(), value };
    fs.mkdirSync(path.dirname(diskCachePath), { recursive: true });
    fs.writeFileSync(diskCachePath, JSON.stringify(store), 'utf8');
  } catch {
    // Non-fatal in read-only test scenarios
  }
}

function sanitizeShortText(value, maxLen = 80) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f<>`{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

function stripJsonCodeFences(rawText) {
  const s = String(rawText || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  const objMatch = s.match(/\{[\s\S]*\}/);
  return objMatch ? objMatch[0] : s;
}

const FACTOR_VERDICTS = ['Strong signal', 'Positive signal', 'Mixed signal', 'Weak signal', 'No evidence', 'Red flag', 'Watch item', 'No flags found'];
const OVERALL_STANCES = ['Pursue', 'Pursue with caution', 'Monitor', 'Insufficient evidence'];

const citedTextSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    sourceIds: { type: 'array', items: { type: 'string' } }
  },
  required: ['text', 'sourceIds'],
  additionalProperties: false
};

const factorAnalysisOutputSchema = {
  type: 'object',
  properties: {
    overallStance: { type: 'string', enum: OVERALL_STANCES },
    executiveTakeaway: citedTextSchema,
    factorAnalyses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string', enum: ['access', 'lineage', 'timing', 'caution'] },
          verdict: { type: 'string', enum: FACTOR_VERDICTS },
          headline: { type: 'string' },
          decisionEffect: citedTextSchema,
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                connection: { type: 'string' },
                meaning: { type: 'string' },
                sourceIds: { type: 'array', items: { type: 'string' } }
              },
              required: ['connection', 'meaning', 'sourceIds'],
              additionalProperties: false
            }
          },
          limitation: { type: 'string' },
          nextCheck: { type: 'string' }
        },
        required: ['group', 'verdict', 'headline', 'decisionEffect', 'findings', 'limitation', 'nextCheck'],
        additionalProperties: false
      }
    },
    insights: { type: 'array', items: citedTextSchema }
  },
  required: ['overallStance', 'executiveTakeaway', 'factorAnalyses', 'insights'],
  additionalProperties: false
};

function parseFactorAnalysisJson(rawText, expectedGroups) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonCodeFences(rawText));
  } catch {
    const error = new Error('Claude returned malformed structured analysis.');
    error.analysisCode = 'invalid_structured_response';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.factorAnalyses) || !Array.isArray(parsed.insights)) {
    const error = new Error('Claude returned an incomplete structured analysis.');
    error.analysisCode = 'invalid_structured_response';
    throw error;
  }
  const returnedGroups = new Set(parsed.factorAnalyses.map((item) => item?.group));
  if (expectedGroups.some((group) => !returnedGroups.has(group))) {
    const error = new Error('Claude omitted one or more requested factor analyses.');
    error.analysisCode = 'invalid_structured_response';
    throw error;
  }
  return parsed;
}

export function validateCompiledFilters(rawFilters) {
  if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
    return null;
  }

  const rawIntent = ALLOWED_INTENTS.has(rawFilters.intent) ? rawFilters.intent : 'general';
  const region = ALLOWED_REGIONS.has(rawFilters.region) ? rawFilters.region : 'all';
  const stageFilter = ALLOWED_STAGES.has(rawFilters.stageFilter) ? rawFilters.stageFilter : 'all';

  const sectors = Array.isArray(rawFilters.sectors)
    ? [...new Set(rawFilters.sectors.filter((s) => typeof s === 'string' && ALLOWED_SECTORS.has(s)))]
    : [];

  const excludeSector = ALLOWED_SECTORS.has(rawFilters.excludeSector) ? rawFilters.excludeSector : 'none';

  const raisingSoonOnly = rawFilters.raisingSoonOnly === true;
  const untappedOnly = rawFilters.untappedOnly === true;
  const slushOnly = rawFilters.slushOnly === true;
  const alumniStr =
    typeof rawFilters.requireAlumniFounder === 'string' && rawFilters.requireAlumniFounder.trim()
      ? rawFilters.requireAlumniFounder.toLowerCase().replace(/[^a-z0-9._-]/g, '').trim()
      : null;
  const requireAlumniFounder =
    rawFilters.requireAlumniFounder === true ||
    (Boolean(alumniStr) && alumniStr !== 'false' && alumniStr !== 'no');

  let minHeadcountGrowthPct = null;
  if (rawFilters.minHeadcountGrowthPct !== null && rawFilters.minHeadcountGrowthPct !== undefined && rawFilters.minHeadcountGrowthPct !== '') {
    const num = Number(rawFilters.minHeadcountGrowthPct);
    if (Number.isFinite(num) && num >= 0 && num <= 500) {
      minHeadcountGrowthPct = Math.round(num);
    }
  }

  const investorQuery = sanitizeShortText(rawFilters.investorQuery);
  const companyQuery = sanitizeShortText(rawFilters.companyQuery);
  const whyNotCompany = sanitizeShortText(rawFilters.whyNotCompany);
  const countryHint = sanitizeShortText(rawFilters.countryHint, 40);
  const entityScope = ALLOWED_ENTITY_SCOPES.has(rawFilters.entityScope) ? rawFilters.entityScope : 'startups';
  const intent =
    (rawIntent === 'company' && !companyQuery) ||
    (rawIntent === 'investor' && !investorQuery) ||
    (rawIntent === 'why_not' && !whyNotCompany)
      ? 'general'
      : rawIntent;

  const kwTokens = [];
  if (Array.isArray(rawFilters.expandedKeywords)) {
    for (const rawKw of rawFilters.expandedKeywords) {
      if (typeof rawKw !== 'string') continue;
      const parts = rawKw
        .toLowerCase()
        .split(/[\s,/]+/)
        .map((p) => p.replace(/[^a-z0-9._-]/g, '').trim())
        .filter((p) => p.length >= 2 && p.length <= 32 && !/^(startup|startups|company|companies|founder|founders|alumni|former|2025|2026)$/i.test(p));
      for (const p of parts) kwTokens.push(p);
    }
  }
  if (alumniStr && alumniStr.length >= 2 && !/^(true|false|yes|no)$/i.test(alumniStr)) {
    kwTokens.push(alumniStr);
  }
  const expandedKeywords = [...new Set(kwTokens)].slice(0, 8);

  return {
    intent,
    entityScope,
    countryHint,
    region,
    stageFilter,
    sectors,
    excludeSector,
    raisingSoonOnly,
    untappedOnly,
    slushOnly,
    minHeadcountGrowthPct,
    requireAlumniFounder,
    investorQuery,
    companyQuery,
    whyNotCompany,
    expandedKeywords
  };
}

async function callAnthropicMessages({ apiKey, model, systemPrompt, userContent, maxTokens = 400, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = globalThis.fetch, outputConfig, returnMetadata = false }) {
  const controller = new AbortController();
  const externalTimeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;
  const timer = setTimeout(() => controller.abort(new Error('Anthropic request timed out')), timeoutMs);

  let signal = controller.signal;
  if (externalTimeout && typeof AbortSignal?.any === 'function') {
    signal = AbortSignal.any([controller.signal, externalTimeout]);
  }

  try {
    const isClaude5 = /^claude-(?:haiku|sonnet|opus|fable)-5/i.test(model);
    const sendAttempt = async (includeTemperature) => {
      const payloadBody = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      };
      if (outputConfig) payloadBody.output_config = outputConfig;
      if (isClaude5) {
        payloadBody.thinking = { type: 'disabled' };
      } else if (includeTemperature) {
        payloadBody.temperature = 0;
      }
      const fetchPromise = fetchFn(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payloadBody),
        signal
      });
      const timeoutGuard = new Promise((_, reject) => {
        const id = setTimeout(() => reject(new Error(`Anthropic API timeout after ${timeoutMs}ms`)), timeoutMs + 15);
        fetchPromise.finally(() => clearTimeout(id)).catch(() => {});
      });
      return Promise.race([fetchPromise, timeoutGuard]);
    };

    let res = await sendAttempt(true);
    if (res && !res.ok && res.status === 400 && typeof res.text === 'function') {
      const errText = await res.text().catch(() => '');
      if (/temperature/i.test(errText)) {
        res = await sendAttempt(false);
      } else {
        const err = new Error(`Anthropic API returned HTTP 400`);
        err.statusCode = 400;
        throw err;
      }
    }
    if (!res || !res.ok) {
      const status = res ? res.status : 500;
      const err = new Error(`Anthropic API returned HTTP ${status}`);
      err.statusCode = status;
      throw err;
    }
    const payload = await res.json();
    const textBlock = (payload?.content || []).find((c) => c?.type === 'text' && typeof c.text === 'string');
    if (!textBlock) {
      throw new Error('Anthropic API response contained no text content.');
    }
    return returnMetadata
      ? { text: textBlock.text, stopReason: payload?.stop_reason || null }
      : textBlock.text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Control Plane Query Compiler: translates natural-language search queries
 * into strict whitelisted filter JSON. Never invents entities or scores.
 * Falls back silently to deterministic parsing on missing key, 401, error, or timeout.
 */
export async function compileSearchQuery(rawQuery, context = {}, options = {}) {
  const queryText = String(rawQuery || '').trim();
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? '';
  if (!queryText || !apiKey) {
    return {
      controlPlaneMode: 'deterministic-parser',
      filters: null,
      fromCache: false
    };
  }

  const cache = options.cache || queryCompilerCache;
  const cacheKey = JSON.stringify({ q: queryText.toLowerCase(), fundId: context.fundId || '' });
  if (cache.has(cacheKey)) {
    return {
      ...cache.get(cacheKey),
      fromCache: true
    };
  }

  const systemPrompt = [
    'Strict VC & company query compiler. Output ONE compact single-line JSON object only (no markdown fences, omit null/false keys unless helpful):',
    'Keys: intent ("general"|"company"|"investor"|"industry"|"why_not"), entityScope ("startups"|"all"), countryHint (string|null), region ("all"|"Nordics"|"DACH"|"UK"|"Western Europe"), stageFilter ("all"|"pre_seed_seed"|"seed_series_a"|"series_a_plus"), sectors (array from ["AI & ML","DeepTech","HealthTech","Fintech","Climate Tech","B2B SaaS"]), excludeSector, raisingSoonOnly (bool), untappedOnly (bool), slushOnly (bool), minHeadcountGrowthPct (int|null), requireAlumniFounder (bool), investorQuery, companyQuery, whyNotCompany, expandedKeywords (up to 5 single lowercase words like ["aiven","grid","storage","battery"]).',
    'Rules: Set entityScope:"all" for public/non-startup chains (e.g. KFC, McDonald\'s, retail) or "all companies"/"registry". For "ex-<Company>", set requireAlumniFounder:true and put "<company>" in expandedKeywords (never companyQuery). Keep sectors [] for cross-sector terms like grid storage. Never guess countryHint or region from a person\'s name unless explicitly stated in query.'
  ].join('\n');

  const userContent = JSON.stringify({
    query: queryText,
    fundName: context.fundName || null,
    knownInvestorsSample: Array.isArray(context.knownInvestors) ? context.knownInvestors.slice(0, 20) : []
  });

  try {
    const rawText = await callAnthropicMessages({
      apiKey,
      model: options.model || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      systemPrompt,
      userContent,
      maxTokens: 200,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchFn: options.fetchFn || globalThis.fetch
    });
    const parsedJson = JSON.parse(stripJsonCodeFences(rawText));
    const validated = validateCompiledFilters(parsedJson);
    if (!validated) {
      return {
        controlPlaneMode: 'deterministic-parser',
        filters: null,
        fromCache: false,
        fallbackReason: 'invalid-schema'
      };
    }
    const result = {
      controlPlaneMode: 'anthropic-query-compiler',
      filters: validated,
      fromCache: false
    };
    if (cache.size > 200) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return {
      controlPlaneMode: 'deterministic-parser',
      filters: null,
      fromCache: false,
      fallbackReason: err?.statusCode ? `http-${err.statusCode}` : 'error-or-timeout'
    };
  }
}

export function extractAllowedNumbers(str = '') {
  const numbers = new Set();
  const matches = String(str || '').matchAll(/(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)(?!\.\d)(?=[MBKmbk%]?(?:[^A-Za-z0-9_]|$))/g);
  for (const m of matches) {
    const num = Number(m[1]);
    if (Number.isFinite(num)) numbers.add(num);
  }
  return numbers;
}

export function extractAllowedGroundings(briefPacket) {
  const groundedPayload = {
    id: briefPacket?.id || null,
    name: briefPacket?.name || null,
    sector: briefPacket?.sector || null,
    hqCity: briefPacket?.hqCity || null,
    country: briefPacket?.country || null,
    foundingDate: briefPacket?.foundingDate || null,
    companiesHouseNumber: briefPacket?.companiesHouseNumber || null,
    employeeCount: briefPacket?.employeeCount ?? null,
    headcountAtLastRound: briefPacket?.headcountAtLastRound ?? null,
    headcountGrowthPct: briefPacket?.headcountGrowthPct ?? null,
    rounds: (briefPacket?.rounds || []).map((r) => ({
      type: r.type,
      date: r.date,
      amountEurM: r.amountEurM,
      leadInvestorName: r.leadInvestorName,
      investorNames: r.investorNames,
      sourceIds: (r.sources || []).map((s) => s.id)
    })),
    employeeCountSeries: (briefPacket?.employeeCountSeries || []).map((obs) => ({
      date: obs.date,
      value: obs.value,
      sourceRank: obs.sourceRank,
      sourceId: obs.sourceId || null
    })),
    financialMetrics: (briefPacket?.financialMetrics || []).map((m) => ({
      year: m.year || (m.periodEnd ? Number(m.periodEnd.slice(0, 4)) : null),
      periodEnd: m.periodEnd,
      cashEurM: m.cashEurM,
      netAssetsEurM: m.netAssetsEurM,
      creditorsEurM: m.creditorsEurM,
      runwayMonthsEst: m.runwayMonthsEst,
      sourceRank: m.sourceRank || 'FILING',
      sourceId: m.sourceId || null
    })),
    corporateEvents: (briefPacket?.corporateEvents || []).map((ev) => ({
      type: ev.type,
      name: ev.name,
      eventDate: ev.eventDate,
      amountEurM: ev.amountEurM ?? null,
      sourceRank: ev.sourceRank,
      sourceId: ev.sourceId || null
    })),
    alumniSpinout: briefPacket?.alumniSpinout || null,
    sources: (briefPacket?.sources || []).map((s) => ({
      id: s.id,
      title: s.title,
      publisher: s.publisher,
      date: s.date,
      sourceRank: s.sourceRank
    })),
    notFoundInCala: briefPacket?.notFoundInCala || []
  };

  const jsonStr = JSON.stringify(groundedPayload);
  const allowedYears = new Set(jsonStr.match(/\b(?:19|20)\d{2}\b/g) || []);
  const allowedNumbers = extractAllowedNumbers(jsonStr);
  const allowedSourceIds = new Set(
    [
      ...(groundedPayload.sources || []).map((s) => s.id),
      ...(groundedPayload.rounds || []).flatMap((r) => r.sourceIds || []),
      ...(groundedPayload.financialMetrics || []).map((m) => m.sourceId),
      ...(groundedPayload.corporateEvents || []).map((e) => e.sourceId),
      ...(groundedPayload.employeeCountSeries || []).map((o) => o.sourceId),
      groundedPayload.alumniSpinout?.sourceId
    ].filter(Boolean)
  );

  return { groundedPayload, allowedYears, allowedNumbers, allowedSourceIds };
}

/**
 * Enforces both `enforceFactCitations()` (exact Cala source IDs) and strict
 * numeric + 4-digit year grounding against pre-retrieved Cala JSON facts.
 */
function filterVerifiedBullets(rawBullets = [], { allowedYears, allowedNumbers, allowedSourceIds, useRegistryCheck = true }) {
  const preFiltered = (Array.isArray(rawBullets) ? rawBullets : [])
    .filter((b) => b && typeof b.text === 'string' && b.text.trim())
    .map((b) => ({
      text: b.text.trim(),
      sourceIds: [...new Set((b.sourceIds || []).filter((id) => allowedSourceIds.has(id)))]
    }));

  const cited = useRegistryCheck
    ? enforceFactCitations(preFiltered)
    : preFiltered.filter((b) => b.sourceIds.length > 0);
  let droppedCount = (Array.isArray(rawBullets) ? rawBullets.length : 0) - cited.length;

  const verified = [];
  for (const item of cited) {
    const bulletYears = item.text.match(/\b(?:19|20)\d{2}\b/g) || [];
    if (bulletYears.some((y) => !allowedYears.has(y))) {
      droppedCount += 1;
      continue;
    }

    const currencyValues = [];
    const currencyRe = /(?:€|EUR|£|GBP|\$|USD)\s*(\d+(?:[.,]\d+)?)\s*(?:[MBKmbk]|million|billion)?\b|(?<![A-Za-z0-9_.])(\d+(?:[.,]\d+)?)\s*(?:[MB]\b|million\b|billion\b)/g;
    let m;
    while ((m = currencyRe.exec(item.text)) !== null) {
      const rawNum = (m[1] || m[2] || '').replace(',', '.');
      if (rawNum) currencyValues.push(Number(rawNum));
    }
    if (currencyValues.some((num) => !Number.isFinite(num) || !allowedNumbers.has(num))) {
      droppedCount += 1;
      continue;
    }

    verified.push(item);
  }

  return {
    bullets: verified,
    droppedUnverifiedCount: droppedCount
  };
}

const restrictedClaimTerms = new Set([
  'board', 'governance', 'right', 'rights', 'information', 'lp', 'lps', 'limited', 'ownership',
  'cap', 'table', 'fund', 'funds', 'portfolio', 'vintage', 'follow', 'capacity', 'deployment',
  'velocity', 'dispute', 'disputes', 'sanction', 'sanctions', 'sec', 'finra', 'exit', 'window',
  'traction', 'customer', 'customers', 'revenue', 'arr', 'valuation', 'fundraising', 'raise',
  'term', 'terms', 'deal', 'market', 'product', 'allocation', 'commitment', 'passed', 'early', 'stage',
  'validation', 'validated', 'institutional', 'primary', 'maker', 'authority', 'authorized', 'performance',
  'runway', 'burn', 'cash', 'liquidity', 'financial', 'financials', 'margin', 'debt', 'experience', 'experienced', 'track'
]);

const ACRONYM_EQUIVALENTS = {
  ceo: ['chief executive', 'is_ceo_of', 'ceo'],
  cto: ['chief technology', 'is_cto_of', 'cto'],
  coo: ['chief operating', 'is_coo_of', 'coo'],
  cfo: ['chief financial', 'is_cfo_of', 'cfo'],
  cso: ['chief scientific', 'chief strategy', 'is_cso_of', 'cso'],
  cmo: ['chief marketing', 'is_cmo_of', 'cmo'],
  cro: ['chief revenue', 'chief research', 'is_cro_of', 'cro'],
  vp: ['vice president', 'is_vicepresident_of', 'vp'],
  ai: ['artificial intelligence', 'openai', 'anthropic', 'software', 'ai'],
  ml: ['machine learning', 'ai', 'ml'],
  us: ['united states', 'usd', 'us'],
  uk: ['united kingdom', 'gbp', 'uk'],
  eu: ['european', 'eur', 'eu'],
  hq: ['headquarters', 'hq'],
  ip: ['intellectual property', 'non-compete', 'ip'],
  ma: ['mna', 'merger', 'acquisition', 'acquired'],
  mna: ['mna', 'merger', 'acquisition', 'acquired']
};

function splitSentencesPreservingAbbreviations(text = '') {
  const DOT_TOKEN = '\u0000';
  let masked = String(text || '');
  masked = masked.replace(/(\d)\.(\d)/g, `$1${DOT_TOKEN}$2`);
  masked = masked.replace(/\b(Inc|Ltd|Corp|Co|Dr|Mr|Ms|Mrs|Prof|vs|etc|e\.g|i\.e|U\.S|U\.K)\./gi, (m) => m.replace(/\./g, DOT_TOKEN));
  masked = masked.replace(/\b([a-z0-9-]+)\.(ai|io|sh|com|org|net|vc|eu|co|gov|uk)\b/gi, `$1${DOT_TOKEN}$2`);
  const parts = masked.match(/[^.!?]+[.!?]?/g) || [];
  return parts.map((p) => p.replaceAll(DOT_TOKEN, '.').trim()).filter(Boolean);
}

function filterUnsupportedFactorClaims(text, factor, citedIds, maxLength = 520, { isLimitation = false } = {}) {
  const effectiveCited = Array.isArray(citedIds) && citedIds.length ? citedIds : (factor.sourceIds || []);
  const referencedRecords = (factor.records || []).filter((record) =>
    (record.sourceIds || []).some((id) => effectiveCited.includes(id))
  );
  const evidenceText = [factor.label, factor.effect, factor.impact, factor.evidence, ...referencedRecords.flatMap((record) => [
    record.id, record.type, record.path, record.relation, record.detail, record.date, record.sourceRank,
    ...(record.structuralRole ? [record.structuralRole] : []),
    ...(record.timingRecency ? [record.timingRecency] : []),
    ...(Array.isArray(record.perspectiveChain) ? record.perspectiveChain : [])
  ])].filter(Boolean).join(' ');
  const evidenceLower = evidenceText.toLowerCase();
  const evidenceWords = new Set(evidenceLower.match(/[a-z0-9]+/g) || []);
  const evidenceAcronyms = new Set((evidenceText.match(/[A-Z]{2,}/g) || []).map((word) => word.toLowerCase()));
  for (const [acro, cues] of Object.entries(ACRONYM_EQUIVALENTS)) {
    if (cues.some((cue) => evidenceLower.includes(cue))) evidenceAcronyms.add(acro);
  }
  const sentences = splitSentencesPreservingAbbreviations(text);
  const accepted = sentences.filter((sentence) => {
    const words = sentence.toLowerCase().match(/[a-z0-9]+/g) || [];
    const isNegatedLimitation =
      isLimitation &&
      /\b(?:do(?:es)? not|cannot|can't|couldn't|won't|without|lack|lacks|unverified|unknown|unclear|neither|nor|missing|only show|insufficient|never|no )\b/i.test(sentence);
    const unsupportedHighRiskTerm =
      !isNegatedLimitation && words.some((word) => restrictedClaimTerms.has(word) && !evidenceWords.has(word));
    const acronyms = sentence.match(/[A-Z]{2,}/g) || [];
    const unsupportedAcronym = acronyms.some((word) => !evidenceAcronyms.has(word.toLowerCase()));
    const hasEvidenceAnchor =
      words.some((word) => word.length > 2 && evidenceWords.has(word)) ||
      (isNegatedLimitation && words.length >= 4);
    return hasEvidenceAnchor && !unsupportedHighRiskTerm && !unsupportedAcronym;
  });
  return sanitizeShortText(accepted.join(' '), maxLength) || '';
}


export function applyCitationAndNumericGate(rawBullets = [], briefPacket) {
  return filterVerifiedBullets(rawBullets, extractAllowedGroundings(briefPacket));
}

function buildDeterministicBriefBullets(briefPacket) {
  const candidates = [];
  const rounds = briefPacket?.rounds || [];
  const latest = rounds[rounds.length - 1];
  if (latest) {
    candidates.push({
      text: `${briefPacket.name} closed a €${latest.amountEurM}M ${latest.type} round on ${latest.date}${latest.leadInvestorName ? ` led by ${latest.leadInvestorName}` : ''}.`,
      sourceIds: (latest.sources || []).map((s) => s.id)
    });
  }
  const fins = briefPacket?.financialMetrics || [];
  const latestFin = fins[fins.length - 1];
  if (latestFin && briefPacket.companiesHouseNumber) {
    candidates.push({
      text: `UK Companies House #${briefPacket.companiesHouseNumber} (${latestFin.year || latestFin.periodEnd?.slice(0, 4)}) reported €${latestFin.cashEurM}M cash and €${latestFin.netAssetsEurM}M net assets.`,
      sourceIds: [latestFin.sourceId].filter(Boolean)
    });
  }
  if (briefPacket?.alumniSpinout?.priorCompany && briefPacket.alumniSpinout.sourceId) {
    candidates.push({
      text: `${briefPacket.alumniSpinout.name} (${briefPacket.alumniSpinout.role}) previously worked at ${briefPacket.alumniSpinout.priorCompany} until ${briefPacket.alumniSpinout.priorValidUntil}.`,
      sourceIds: [briefPacket.alumniSpinout.sourceId]
    });
  }
  return applyCitationAndNumericGate(candidates, briefPacket).bullets;
}

/**
 * Citation-Locked Brief Narrator: summarizes ONLY pre-retrieved Cala JSON facts
 * and coverage gaps, passing every output sentence through `enforceFactCitations()`
 * plus numeric and 4-digit year grounding guards.
 */
export async function narrateBriefWithCitationGate(briefPacket, options = {}) {
  if (!briefPacket) {
    return {
      controlPlaneMode: 'deterministic-fallback',
      bullets: [],
      droppedUnverifiedCount: 0,
      coverageGaps: []
    };
  }

  const { groundedPayload } = extractAllowedGroundings(briefPacket);
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? '';
  if (!apiKey) {
    return {
      controlPlaneMode: 'deterministic-fallback',
      bullets: buildDeterministicBriefBullets(briefPacket),
      droppedUnverifiedCount: 0,
      coverageGaps: briefPacket.notFoundInCala || []
    };
  }

  const cache = options.cache || briefNarratorCache;
  const cacheKey = `${briefPacket.id}:${briefPacket.matchContext?.suitabilityScore ?? 'standalone'}:${groundedPayload.sources.length}`;
  if (cache.has(cacheKey)) {
    return { ...cache.get(cacheKey), fromCache: true };
  }

  const systemPrompt = [
    'Strict citation-locked narrator. Summarize ONLY facts in input JSON. Never invent numbers, years, revenue, ARR, or investors.',
    'Output ONE compact single-line JSON only (no fences): {"bullets":[{"text":"short 1-sentence fact","sourceIds":["exact-id"]}]}. Max 3 short bullets.',
    'Every bullet MUST include exact sourceIds from input.sources and ONLY currency amounts/years from input JSON.'
  ].join('\n');

  try {
    const rawText = await callAnthropicMessages({
      apiKey,
      model: options.model || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      systemPrompt,
      userContent: JSON.stringify(groundedPayload),
      maxTokens: 280,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchFn: options.fetchFn || globalThis.fetch
    });
    const parsed = JSON.parse(stripJsonCodeFences(rawText));
    const gated = applyCitationAndNumericGate(parsed?.bullets || [], briefPacket);
    if (!gated.bullets.length) {
      return {
        controlPlaneMode: 'deterministic-fallback',
        bullets: buildDeterministicBriefBullets(briefPacket),
        droppedUnverifiedCount: gated.droppedUnverifiedCount,
        coverageGaps: briefPacket.notFoundInCala || []
      };
    }
    const result = {
      controlPlaneMode: 'anthropic-citation-narrator',
      bullets: gated.bullets,
      droppedUnverifiedCount: gated.droppedUnverifiedCount,
      coverageGaps: briefPacket.notFoundInCala || []
    };
    if (cache.size > 100) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(cacheKey, result);
    return result;
  } catch {
    return {
      controlPlaneMode: 'deterministic-fallback',
      bullets: buildDeterministicBriefBullets(briefPacket),
      droppedUnverifiedCount: 0,
      coverageGaps: briefPacket.notFoundInCala || []
    };
  }
}

function buildDeterministicConnectionInsight(packet = {}) {
  const sourceIds = (packet.sources || []).map((s) => s.id).filter(Boolean);
  const topSourceId = sourceIds[0] || null;
  const facts = Array.isArray(packet.facts) ? packet.facts : [];
  const bullets = [];

  for (const f of facts.slice(0, 3)) {
    const text = String(f?.text || '').trim();
    const ids = (f?.sourceIds || []).filter(Boolean);
    const chosen = ids.length ? ids : topSourceId ? [topSourceId] : [];
    if (text && chosen.length) {
      bullets.push({ text, sourceIds: chosen });
    }
  }

  const gapList = Array.isArray(packet.gaps) ? packet.gaps.filter(Boolean) : [];
  const question = gapList.length
    ? `Verify missing Cala coverage (${gapList.slice(0, 2).join(', ')}) during primary diligence.`
    : `Confirm strategic context and recency of ${packet.title || 'this Cala relationship'} directly with founders or co-investors.`;

  return {
    summary: String(packet.whyMatters || facts[0]?.text || `${packet.title || 'Relationship'} verified in Cala Knowledge Graph.`).trim(),
    bullets,
    question
  };
}

/**
 * Citation-Locked Connection & Entity Analyzer: generates grounded investment
 * takeaways strictly from verified Cala graph facts, edges, and source IDs.
 */
export async function analyzeConnectionWithCitationGate(packet = {}, options = {}) {
  if (!packet || typeof packet !== 'object') {
    return {
      controlPlaneMode: 'deterministic-fallback',
      summary: 'No verified Cala packet provided.',
      insights: [],
      question: '',
      droppedUnverifiedCount: 0
    };
  }

  const cleanSources = (Array.isArray(packet.sources) ? packet.sources : [])
    .filter((s) => s && s.id)
    .slice(0, 32)
    .map((s) => ({
      id: String(s.id),
      title: sanitizeShortText(s.title || s.publisher || s.id, 90) || String(s.id),
      publisher: sanitizeShortText(s.publisher || 'Cala Knowledge Graph', 60) || 'Cala Knowledge Graph',
      date: s.date ? String(s.date).slice(0, 10) : null,
      sourceRank: String(s.sourceRank || 'AGGREGATOR')
    }));

  const sourceIdSet = new Set(cleanSources.map((s) => s.id));
  const allowedFactorGroups = new Set(['access', 'lineage', 'timing', 'caution']);
  const decisionFactors = (Array.isArray(packet.decisionFactors) ? packet.decisionFactors : [])
    .filter((factor) => allowedFactorGroups.has(factor?.group))
    .map((factor) => ({
      group: factor.group,
      label: sanitizeShortText(factor.label || factor.group, 24) || factor.group,
      effect: sanitizeShortText(factor.effect || '', 32) || '',
      impact: sanitizeShortText(factor.impact || '', 150) || '',
      evidence: sanitizeShortText(factor.evidence || '', 240) || '',
      sourceIds: [...new Set((Array.isArray(factor.sourceIds) ? factor.sourceIds : []).map(String).filter((id) => sourceIdSet.has(id)))].slice(0, 12),
      metrics: factor.metrics && typeof factor.metrics === 'object' ? {
        signalStrength: Number.isFinite(Number(factor.metrics.signalStrength)) ? Number(factor.metrics.signalStrength) : undefined,
        sharedCount: Number.isFinite(Number(factor.metrics.sharedCount)) ? Number(factor.metrics.sharedCount) : undefined,
        verifiedSharePct: Number.isFinite(Number(factor.metrics.verifiedSharePct)) ? Number(factor.metrics.verifiedSharePct) : undefined
      } : undefined,
      records: (Array.isArray(factor.records) ? factor.records : []).slice(0, 6).map((record, index) => ({
        id: sanitizeShortText(record?.id || `${factor.group}-${index + 1}`, 48) || `${factor.group}-${index + 1}`,
        type: sanitizeShortText(record?.type || '', 60),
        path: sanitizeShortText(record?.path || '', 100),
        relation: sanitizeShortText(record?.relation || '', 100),
        detail: sanitizeShortText(record?.detail || '', 220),
        date: record?.date ? String(record.date).slice(0, 24) : null,
        sourceRank: record?.sourceRank ? sanitizeShortText(String(record.sourceRank), 16) : undefined,
        isSharedBridge: record?.isSharedBridge === true ? true : undefined,
        ...(record?.structuralRole ? { structuralRole: sanitizeShortText(String(record.structuralRole), 24) } : {}),
        ...(record?.timingRecency ? { timingRecency: sanitizeShortText(String(record.timingRecency), 24) } : {}),
        ...(record?.isAcquisition === true ? { isAcquisition: true } : {}),
        ...(Array.isArray(record?.perspectiveChain) && record.perspectiveChain.length
          ? { perspectiveChain: record.perspectiveChain.slice(0, 4).map((p) => sanitizeShortText(String(p || ''), 60)).filter(Boolean) }
          : {}),
        sourceIds: [...new Set((Array.isArray(record?.sourceIds) ? record.sourceIds : []).map(String).filter((id) => sourceIdSet.has(id)))].slice(0, 4)
      }))
    }));

  const allowedAnalysisModes = new Set(['single_teardown', 'perspective_triage', 'ecosystem_compare']);
  const cleanAnalysisMode = allowedAnalysisModes.has(packet.analysisMode) ? packet.analysisMode : undefined;
  const cleanPerspectiveName = packet.perspectiveEntityName ? sanitizeShortText(packet.perspectiveEntityName, 80) : undefined;
  const cleanPrimaryTargetName = packet.primaryTargetName ? sanitizeShortText(packet.primaryTargetName, 80) : undefined;

  const groundedPacket = {
    mode: packet.mode === 'entity' ? 'entity' : 'connection',
    ...(cleanAnalysisMode ? { analysisMode: cleanAnalysisMode } : {}),
    ...(cleanPerspectiveName ? { perspectiveEntityName: cleanPerspectiveName } : {}),
    ...(cleanPrimaryTargetName ? { primaryTargetName: cleanPrimaryTargetName } : {}),
    title: sanitizeShortText(packet.title || '', 120) || 'Cala Relationship',
    hopType: sanitizeShortText(packet.hopType || '', 60),
    relation: sanitizeShortText(packet.relation || '', 60),
    roundSummary: sanitizeShortText(packet.roundSummary || '', 90),
    date: packet.date ? String(packet.date).slice(0, 10) : null,
    whyMatters: sanitizeShortText(packet.whyMatters || '', 220),
    facts: decisionFactors.length ? [] : (Array.isArray(packet.facts) ? packet.facts : []).slice(0, 8).map((f) => ({
      text: String(f?.text || '').slice(0, 220),
      date: f?.date ? String(f.date).slice(0, 10) : null,
      tier: f?.tier || null,
      sourceIds: Array.isArray(f?.sourceIds) ? f.sourceIds.filter((id) => sourceIdSet.has(id)).slice(0, 4) : []
    })),
    decisionFactors,
    anomalies: (Array.isArray(packet.anomalies) ? packet.anomalies : []).slice(0, 4).map((a) => ({
      kind: sanitizeShortText(a?.kind || '', 40),
      path: sanitizeShortText(a?.path || '', 80),
      detail: sanitizeShortText(a?.detail || '', 160)
    })).filter((a) => a.detail),
    syndicatePeers: (Array.isArray(packet.syndicatePeers) ? packet.syndicatePeers : []).slice(0, 8),
    gaps: (Array.isArray(packet.gaps) ? packet.gaps : []).slice(0, 6),
    sources: cleanSources
  };

  const fallback = buildDeterministicConnectionInsight(groundedPacket);
  const fallbackFactorSummaries = decisionFactors.map((factor) => ({
    group: factor.group,
    text: factor.impact || factor.evidence || 'No verified signal in this factor.',
    sourceIds: factor.sourceIds
  }));
  const fallbackFactorAnalyses = decisionFactors.map((factor) => ({
    group: factor.group,
    decisionEffect: fallbackFactorSummaries.find((item) => item.group === factor.group),
    decisionEffectSource: 'map-fallback',
    reasoning: [],
    limitation: factor.records.length
      ? 'The map records show a relationship signal; they do not establish company quality or investment merit.'
      : 'No mapped Cala records were supplied for this factor.'
  }));
  const fallbackReason = !cleanSources.length
    ? 'No mapped citations were available; showing the Cala decision brief.'
    : !options.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_API_KEY
    ? 'Claude is not configured on this server; showing the Cala decision brief.'
    : 'Claude could not be reached; showing the Cala decision brief.';
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? '';
  if (!apiKey || !cleanSources.length) {
    return {
      controlPlaneMode: 'deterministic-fallback',
      summary: fallback.summary,
      insights: fallback.bullets,
      question: fallback.question,
      factorSummaries: fallbackFactorSummaries,
      factorAnalyses: fallbackFactorAnalyses,
      fallbackReason,
      droppedUnverifiedCount: 0
    };
  }

  const cache = options.cache || connectionInsightCache;
  const useDiskCache = !options.cache && !options.disableDiskCache;
  const diskCachePath = options.diskCachePath || DEFAULT_INSIGHT_DISK_CACHE;
  const cacheKey = `v11:${groundedPacket.mode}:${groundedPacket.analysisMode || 'default'}:${JSON.stringify(groundedPacket)}`;
  const diskHash = useDiskCache ? crypto.createHash('sha256').update(cacheKey).digest('hex') : null;
  if (cache.has(cacheKey)) {
    return { ...cache.get(cacheKey), fromCache: true };
  }
  if (useDiskCache && diskHash) {
    const diskStore = loadDiskInsightStore(diskCachePath);
    if (diskStore[diskHash]?.value?.controlPlaneMode === 'anthropic-connection-analyst') {
      cache.set(cacheKey, diskStore[diskHash].value);
      return { ...diskStore[diskHash].value, fromCache: true };
    }
  }

  const realToWireId = new Map();
  const wireToRealId = new Map();
  let aliasSeq = 1;
  for (const s of cleanSources) {
    const wireId = s.id.length > 18 ? `s${aliasSeq++}` : s.id;
    realToWireId.set(s.id, wireId);
    wireToRealId.set(wireId, s.id);
  }
  const toWireIds = (ids = []) => (Array.isArray(ids) ? ids.map((id) => realToWireId.get(id) || id) : []);
  const fromWireIds = (ids = []) => (Array.isArray(ids) ? ids.map((id) => wireToRealId.get(id) || id) : []);
  const wirePacket = {
    ...groundedPacket,
    facts: groundedPacket.facts.map((f) => ({ ...f, sourceIds: toWireIds(f.sourceIds) })),
    decisionFactors: groundedPacket.decisionFactors.map((factor) => ({
      ...factor,
      sourceIds: toWireIds(factor.sourceIds),
      records: factor.records.map((r) => ({ ...r, sourceIds: toWireIds(r.sourceIds) }))
    })),
    sources: groundedPacket.sources.map((s) => ({ ...s, id: realToWireId.get(s.id) || s.id }))
  };
  const wireJsonStr = JSON.stringify(wirePacket);

  const jsonStr = JSON.stringify(groundedPacket);
  const groundings = {
    allowedYears: new Set(jsonStr.match(/\b(?:19|20)\d{2}\b/g) || []),
    allowedNumbers: extractAllowedNumbers(jsonStr),
    allowedSourceIds: new Set(cleanSources.map((s) => s.id)),
    useRegistryCheck: false
  };

  const modeGuidance = groundedPacket.analysisMode === 'single_teardown'
    ? [
        'Context mode: SINGLE-COMPANY TEARDOWN (neutral perspective; NO buyer or investor seat is selected).',
        'Evaluate: (1) Backers vs. commercial supplier/partner ties (NEVER label a commercial supplier a warm-intro route), (2) Founders, leaders, & M&A (ACQUIRED is corporate structure, NEVER call standard acquisitions a caution or risk unless paired with a rival or dispute), (3) Recent catalysts ("active_catalyst" <=18m) vs historical milestones ("historical_milestone" >18m), (4) Competitive threats & disclosure gaps.'
      ]
    : groundedPacket.analysisMode === 'ecosystem_compare'
      ? [
          `Context mode: MULTI-ENTITY ECOSYSTEM & PEER COMPARISON${groundedPacket.primaryTargetName ? ` (Primary Target Focus: ${groundedPacket.primaryTargetName})` : ''}.`,
          'Evaluate: shared supplier/partner bottlenecks, dual-backed conflicts, asymmetric dependencies, talent/leader crossover across mapped peers, direct rivalries, and comparative momentum (<=18m) vs gaps. Do NOT force single-firm warm-intro outreach framing.'
        ]
      : groundedPacket.analysisMode === 'perspective_triage'
        ? [
            `Context mode: ORIGINATION & DEAL TRIAGE from the perspective of "${groundedPacket.perspectiveEntityName || 'My Firm'}".`,
            `Evaluate: concrete intro chains connecting ${groundedPacket.perspectiveEntityName || 'My Firm'} to the target(s) (or explicit cold outreach when none exist), team/spinout lineage, active <=18m catalysts, and overlap with ${groundedPacket.perspectiveEntityName || 'My Firm'}'s backed holdings.`
          ]
        : [];

  const nonFactorModeGuidance = groundedPacket.analysisMode === 'single_teardown'
    ? 'Strict financial research analyst writing a single-company teardown grounded ONLY in input JSON. Treat suppliers/partners as commercial value-chain ties (never warm-intro paths), treat M&A acquisitions as corporate structure unless conflict is cited, and distinguish recent <=18m catalysts from older milestones.'
    : groundedPacket.analysisMode === 'ecosystem_compare'
      ? `Strict financial research analyst evaluating cross-entity peer dependencies${groundedPacket.primaryTargetName ? ` (focused on ${groundedPacket.primaryTargetName})` : ''} grounded ONLY in input JSON. Highlight shared bottlenecks, dual backers, or competitive positioning without forcing VC warm-intro boilerplate.`
      : 'Strict VC investment-diligence analyst grounded ONLY in input JSON. Analyze why the connection or entity graph matters for deal access, operator lineage, timing, or competitive caution.';

  const systemPrompt = decisionFactors.length ? [
    'You are a senior financial and venture analyst writing for a busy partner. Analyze ONLY the supplied Cala records and citations; never infer company quality from network position.',
    ...modeGuidance,
    'Your job: turn each mapped group into a plain-English insight that says what the evidence lets an analyst KNOW or DO (e.g. "Amazon backs both OpenAI and Anthropic, so it can give a side-by-side reference on both teams").',
    'For EACH of the four factors emit:',
    '- verdict: one label. access/lineage/timing use Strong signal | Positive signal | Mixed signal | Weak signal | No evidence. caution uses Red flag | Watch item | No flags found | No evidence.',
    '- headline: 6-14 words, the single so-what for the analyst, naming the key entity. No jargon, no numbers unless verbatim.',
    '- decisionEffect: 14-26 words explaining what this signal changes in the analysis, citing sourceIds.',
    '- findings: up to 3, ranked by analytical value. connection = the entity path verbatim from records (e.g. "Amazon → OpenAI & Anthropic"). meaning = 8-18 words on why an analyst cares about THAT connection. Cite its record sourceIds.',
    '- limitation: 8-16 words on what these records do not prove.',
    '- nextCheck: 8-18 words starting with "Verify whether", "Confirm whether" or "Ask whether", naming only entities verbatim in that factor.',
    'Also emit overallStance (Pursue | Pursue with caution | Monitor | Insufficient evidence) and executiveTakeaway: 14-24 words, the bottom line read first, balancing upside and caution, with sourceIds.',
    'Write short, concrete sentences. Lead with the entity name. Prefer verbs like "backs", "supplies", "founded", "acquired", "led", "links", "overlaps". Avoid filler such as "establishes", "leverage", "signals that", "ecosystem".',
    'NEVER invent numbers, dates, entities, conflicts, or evidence. Never write source IDs (like s1) inside prose; put them only in sourceIds arrays.',
    'For a factor with no records: verdict "No evidence", headline "No mapped evidence in Cala", findings [].',
    'Each citation must belong to the same factor and appear on a record or factor source in input JSON.',
    'Use strictly gate-safe concrete evidence nouns from that factor (investors, backers, suppliers, partners, organizations, founders, leaders, roles, acquisitions, milestones, rivals, backed holdings, corporate structure). Strictly avoid speculative or restricted nouns unless verbatim in THAT factor (avoid: fund, portfolio, deal, stage, early, fundraising, raise, traction, validation, governance, information, window, cap, table, ownership, market, board rights, runway, burn, liquidity, performance, authority, primary, allocation, institutional, disputes, VC, IP, LP).',
    'At most 2 cross-factor insights; cite each with exact source IDs.',
    'Return compact JSON matching the schema, no markdown.'
  ].join('\n') : [
    nonFactorModeGuidance,
    'NEVER invent numbers, round sizes, dates, or entities not present in input JSON. Never write source IDs like s1 inside prose sentences.',
    'Output ONE compact single-line JSON only (no markdown fences):',
    '{"summary":"20-35 word crisp analytical takeaway","summarySourceIds":["exact-source-id"],"insights":[{"text":"1 sharp verified insight","sourceIds":["exact-source-id"]}],"question":"1 concrete next diligence question"}.',
    'Max 3 insights. Both summarySourceIds and every insight MUST cite at least 1 exact sourceId from input.sources.'
  ].join('\n');

  try {
    const model = options.model
      || (decisionFactors.length ? process.env.ANTHROPIC_ANALYSIS_MODEL : '')
      || process.env.ANTHROPIC_MODEL
      || DEFAULT_ANTHROPIC_MODEL;
    const fetchFn = options.fetchFn || globalThis.fetch;
    let parsed;
    if (decisionFactors.length) {
      let lastStructuredError = null;
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        const completion = await callAnthropicMessages({
          apiKey,
          model,
          systemPrompt: attempt === 0
            ? systemPrompt
            : `${systemPrompt}\nReturn the complete required JSON object for every requested factor. Keep the wording concise so it fits the output limit.`,
          userContent: wireJsonStr,
          maxTokens: attempt === 0 ? 2600 : 4200,
          timeoutMs: options.timeoutMs ?? 30000,
          fetchFn,
          outputConfig: { format: { type: 'json_schema', schema: factorAnalysisOutputSchema } },
          returnMetadata: true
        });
        if (completion.stopReason === 'refusal') {
          const error = new Error('Claude declined to return a factor analysis.');
          error.analysisCode = 'refusal';
          throw error;
        }
        if (completion.stopReason === 'max_tokens') {
          lastStructuredError = new Error('Claude response reached its output token limit.');
          lastStructuredError.analysisCode = 'truncated_response';
          continue;
        }
        try {
          parsed = parseFactorAnalysisJson(completion.text, decisionFactors.map((factor) => factor.group));
        } catch (error) {
          lastStructuredError = error;
        }
      }
      if (!parsed) {
        throw lastStructuredError || Object.assign(new Error('Claude returned an incomplete structured analysis.'), {
          analysisCode: 'invalid_structured_response'
        });
      }
      for (const fa of parsed.factorAnalyses || []) {
        if (fa?.decisionEffect?.sourceIds) fa.decisionEffect.sourceIds = fromWireIds(fa.decisionEffect.sourceIds);
        for (const r of fa?.reasoning || []) {
          if (r?.sourceIds) r.sourceIds = fromWireIds(r.sourceIds);
        }
        for (const f of fa?.findings || []) {
          if (f?.sourceIds) f.sourceIds = fromWireIds(f.sourceIds);
        }
      }
      if (parsed?.executiveTakeaway?.sourceIds) {
        parsed.executiveTakeaway.sourceIds = fromWireIds(parsed.executiveTakeaway.sourceIds);
      }
      for (const ins of parsed?.insights || []) {
        if (ins?.sourceIds) ins.sourceIds = fromWireIds(ins.sourceIds);
      }
    } else {
      const rawText = await callAnthropicMessages({
        apiKey,
        model,
        systemPrompt,
        userContent: wireJsonStr,
        maxTokens: 1800,
        timeoutMs: options.timeoutMs ?? 30000,
        fetchFn
      });
      parsed = JSON.parse(stripJsonCodeFences(rawText));
      for (const ins of parsed?.insights || []) {
        if (ins?.sourceIds) ins.sourceIds = fromWireIds(ins.sourceIds);
      }
      if (Array.isArray(parsed?.summarySourceIds)) {
        parsed.summarySourceIds = fromWireIds(parsed.summarySourceIds);
      }
    }
    const gated = filterVerifiedBullets(parsed?.insights || [], { ...groundings, useRegistryCheck: false });
    const rawFactorAnalyses = Array.isArray(parsed?.factorAnalyses) ? parsed.factorAnalyses : [];
    const factorAnalyses = decisionFactors.map((factor) => {
      const groupIds = new Set([
        ...(factor.sourceIds || []),
        ...(factor.records || []).flatMap((record) => record.sourceIds || [])
      ]);
      const rawFactor = rawFactorAnalyses
        .find((item) => item?.group === factor.group);
      const rawEffect = rawFactor?.decisionEffect || (Array.isArray(parsed?.factorSummaries) ? parsed.factorSummaries : [])
        .find((item) => item?.group === factor.group);
      const gatedEffect = filterVerifiedBullets(rawEffect ? [{
        text: typeof rawEffect.text === 'string' ? rawEffect.text.slice(0, 520) : '',
        sourceIds: (Array.isArray(rawEffect.sourceIds) ? rawEffect.sourceIds : []).filter((id) => groupIds.has(id))
      }] : [], { ...groundings, allowedSourceIds: groupIds, useRegistryCheck: false });
      const modelEffect = gatedEffect.bullets[0];
      const groundedEffectText = modelEffect
        ? filterUnsupportedFactorClaims(modelEffect.text, factor, modelEffect.sourceIds, 520)
        : '';
      const rawReasoning = (Array.isArray(rawFactor?.reasoning) ? rawFactor.reasoning : []).slice(0, 3);
      const gatedReasoning = filterVerifiedBullets(rawReasoning.map((item) => ({
        text: typeof item?.text === 'string' ? item.text.slice(0, 260) : '',
        sourceIds: (Array.isArray(item?.sourceIds) ? item.sourceIds : []).filter((id) => groupIds.has(id))
      })), { ...groundings, allowedSourceIds: groupIds, useRegistryCheck: false });
      const groundedReasoning = gatedReasoning.bullets.map((item) => ({
        ...item,
        text: filterUnsupportedFactorClaims(item.text, factor, item.sourceIds, 260)
      })).filter((item) => item.text);
      const fallbackEffect = fallbackFactorSummaries.find((item) => item.group === factor.group);
      const decisionEffect = {
        text: groundedEffectText || fallbackEffect?.text || 'No verified signal in this factor.',
        sourceIds: groundedEffectText ? modelEffect.sourceIds : (fallbackEffect?.sourceIds || [])
      };
      const groupSourceIdList = [...groupIds];
      const rawFindings = (Array.isArray(rawFactor?.findings) ? rawFactor.findings : []).slice(0, 3);
      const groundedFindings = rawFindings.map((item) => {
        const connection = sanitizeShortText(item?.connection || '', 110);
        const meaning = typeof item?.meaning === 'string' ? item.meaning.trim().slice(0, 220) : '';
        const ids = (Array.isArray(item?.sourceIds) ? item.sourceIds : []).filter((id) => groupIds.has(id));
        const gatedFinding = filterVerifiedBullets([{ text: `${connection}. ${meaning}`, sourceIds: ids }], {
          ...groundings, allowedSourceIds: groupIds, useRegistryCheck: false
        }).bullets[0];
        if (!gatedFinding || !connection || !meaning) return null;
        const safeMeaning = filterUnsupportedFactorClaims(meaning, factor, gatedFinding.sourceIds, 220);
        return safeMeaning ? { connection, meaning: safeMeaning, sourceIds: gatedFinding.sourceIds } : null;
      }).filter(Boolean);
      const reasoningOut = groundedReasoning.length
        ? groundedReasoning
        : groundedFindings.map((f) => ({ text: `${f.connection}: ${f.meaning}`, sourceIds: f.sourceIds }));
      const rawHeadline = typeof rawFactor?.headline === 'string' ? rawFactor.headline.trim().slice(0, 140) : '';
      const headlineGate = rawHeadline
        ? filterVerifiedBullets([{ text: rawHeadline, sourceIds: groupSourceIdList }], { ...groundings, allowedSourceIds: groupIds, useRegistryCheck: false }).bullets[0]
        : null;
      const isEmptyHeadline = /^no mapped evidence/i.test(rawHeadline);
      const headline = isEmptyHeadline
        ? rawHeadline
        : headlineGate ? filterUnsupportedFactorClaims(rawHeadline, factor, groupSourceIdList, 140) : '';
      const verdict = FACTOR_VERDICTS.includes(rawFactor?.verdict) ? rawFactor.verdict : '';
      return {
        group: factor.group,
        verdict,
        headline,
        decisionEffect,
        decisionEffectSource: groundedEffectText ? 'anthropic' : 'map-fallback',
        findings: groundedFindings,
        reasoning: reasoningOut,
        limitation: filterUnsupportedFactorClaims(rawFactor?.limitation || '', factor, groupSourceIdList, 220, { isLimitation: true }) || fallbackFactorAnalyses.find((item) => item.group === factor.group)?.limitation || '',
        nextCheck: /^(verify|confirm|ask|check) whether\b/i.test(rawFactor?.nextCheck || '')
          ? filterUnsupportedFactorClaims(rawFactor.nextCheck, factor, groupSourceIdList, 220)
          : ''
      };
    });
    const factorSummaries = factorAnalyses.map(({ group, decisionEffect }) => ({ group, ...decisionEffect }));
    const hasAcceptedFactorContent = decisionFactors.some((factor) => {
      const analysis = factorAnalyses.find((item) => item.group === factor.group);
      const fallbackAnalysis = fallbackFactorAnalyses.find((item) => item.group === factor.group);
      return analysis && (
        analysis.reasoning.length > 0 ||
        analysis.decisionEffect?.text !== [fallbackAnalysis?.decisionEffect?.text, ''].filter(Boolean).join(' ')
      );
    });
    const summarySourceIds = Array.isArray(parsed?.executiveTakeaway?.sourceIds)
      ? parsed.executiveTakeaway.sourceIds
      : Array.isArray(parsed?.summarySourceIds)
        ? parsed.summarySourceIds
        : [];
    const rawSummaryInput = typeof parsed?.executiveTakeaway?.text === 'string'
      ? parsed.executiveTakeaway.text
      : typeof parsed?.summary === 'string'
        ? parsed.summary
        : '';
    const gatedSummary = filterVerifiedBullets([{
      text: sanitizeShortText(rawSummaryInput, 420),
      sourceIds: summarySourceIds
    }], { ...groundings, useRegistryCheck: false }).bullets[0];
    if (
      !gated.bullets.length &&
      !gatedSummary &&
      !hasAcceptedFactorContent
    ) {
      return {
        controlPlaneMode: 'deterministic-fallback',
        summary: fallback.summary,
        insights: fallback.bullets,
        question: fallback.question,
        factorSummaries: fallbackFactorSummaries,
        factorAnalyses: fallbackFactorAnalyses,
        fallbackReason: 'Claude returned no source-grounded analysis; showing the Cala decision brief.',
        droppedUnverifiedCount: gated.droppedUnverifiedCount
      };
    }

    const rawSummary = gatedSummary?.text || '';
    const summaryYears = rawSummary.match(/\b(?:19|20)\d{2}\b/g) || [];
    const safeSummary = rawSummary && !summaryYears.some((y) => !groundings.allowedYears.has(y))
      ? sanitizeShortText(rawSummary, 420)
      : fallback.summary;
    const rawQuestion = typeof parsed?.question === 'string' ? parsed.question.trim() : '';
    const safeQuestion = rawQuestion ? rawQuestion.slice(0, 220) : fallback.question;

    const result = {
      controlPlaneMode: 'anthropic-connection-analyst',
      summary: safeSummary,
      overallStance: OVERALL_STANCES.includes(parsed?.overallStance) ? parsed.overallStance : '',
      factorSummaries,
      factorAnalyses,
      insights: gated.bullets.slice(0, 3),
      question: safeQuestion,
      droppedUnverifiedCount: gated.droppedUnverifiedCount
    };
    if (cache.size > 150) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(cacheKey, result);
    if (useDiskCache && diskHash) {
      saveDiskInsightEntry(diskCachePath, diskHash, result);
    }
    return result;
  } catch (err) {
    const status = Number(err?.statusCode) || 0;
    const fallbackReason = err?.analysisCode === 'truncated_response'
      ? 'Claude output was cut off twice; showing the Cala decision brief. Retry the analysis to try again.'
      : err?.analysisCode === 'invalid_structured_response'
        ? 'Claude returned an invalid factor response twice; showing the Cala decision brief. Retry the analysis to try again.'
        : err?.analysisCode === 'refusal'
          ? 'Claude could not analyze this packet; showing the Cala decision brief.'
        : status === 401
      ? 'Anthropic rejected the configured API key (HTTP 401). Check that the key is active.'
      : status === 403
        ? 'Anthropic denied this request (HTTP 403). Check API access and account status.'
        : status === 402
          ? 'Anthropic declined the request (HTTP 402). Check API credits and billing status.'
        : status === 404
          ? 'Anthropic could not find the configured Claude model (HTTP 404). Check ANTHROPIC_MODEL.'
          : status === 400
            ? 'Anthropic rejected the request (HTTP 400). Check the model and request configuration.'
          : status === 429
            ? 'Anthropic rate limited this request (HTTP 429). Try again after the API limit resets.'
            : status === 529
              ? 'Anthropic is temporarily overloaded (HTTP 529). Try again shortly.'
              : status >= 500
                ? `Anthropic returned a server error (HTTP ${status}). Try again shortly.`
                : /timeout|abort/i.test(String(err?.message || ''))
                  ? 'The Anthropic request timed out before the analysis completed.'
                  : err instanceof SyntaxError
                    ? 'Claude replied, but the analysis response could not be parsed.'
                    : 'Could not connect to Anthropic. Check server network access and retry.';
    return {
      controlPlaneMode: 'deterministic-fallback',
      summary: fallback.summary,
      insights: fallback.bullets,
      question: fallback.question,
      factorSummaries: fallbackFactorSummaries,
      factorAnalyses: fallbackFactorAnalyses,
      fallbackReason,
      providerStatusCode: status || undefined,
      droppedUnverifiedCount: 0
    };
  }
}
