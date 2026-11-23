import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { COMPANIES, FUNDS, PEER_INVESTORS, REFERENCE_DATE, SOURCES } from './src/data.mjs';
import { createCalaClient, loadEnvFile } from './src/calaClient.mjs';
import { createRegistryClient, extractRegistryLookupTerm } from './src/registryClient.mjs';
import { analyzeConnectionWithCitationGate, compileSearchQuery, narrateBriefWithCitationGate } from './src/llmControlPlane.mjs';
import {
  buildStartupBrief,
  ingestLiveCalaEntities,
  ingestRegistryEntities,
  refineShortlist,
  resolveSources,
  runFullAnalysis,
  searchEntities
} from './src/engine.mjs';

loadEnvFile();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, '.cache');
const DEMO_CACHE_DIR = path.join(__dirname, 'src', 'demo-cache');
const CALA_CACHE_FILE = path.join(CACHE_DIR, 'cala-cache.json');
const CLAUDE_CACHE_FILE = path.join(CACHE_DIR, 'claude-insight-cache.json');

function hydrateDemoSeedCaches() {
  try {
    fsSync.mkdirSync(CACHE_DIR, { recursive: true });
    const seeds = [
      [path.join(DEMO_CACHE_DIR, 'cala-seed-cache.json.gz'), CALA_CACHE_FILE],
      [path.join(DEMO_CACHE_DIR, 'claude-seed-cache.json.gz'), CLAUDE_CACHE_FILE]
    ];
    for (const [gzPath, outPath] of seeds) {
      if (!fsSync.existsSync(gzPath)) continue;
      const needsHydrate = !fsSync.existsSync(outPath) || fsSync.statSync(outPath).size < 16;
      if (!needsHydrate) continue;
      const inflated = zlib.gunzipSync(fsSync.readFileSync(gzPath));
      fsSync.writeFileSync(outPath, inflated);
    }
  } catch (err) {
    console.warn('[demo-cache] Could not hydrate seed cache:', err?.message || err);
  }
}

hydrateDemoSeedCaches();
const SLUSH_2026_ENTITY_ID = 'bc844d56-6ab4-452b-96bf-2661e86e592b';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const analysisCache = new Map();

const ENTITY_LEGAL_SUFFIX_RE = /\b(?:oyj|oy|ab|aps|a\/s|as|ltd|limited|plc|inc|corp|corporation|gmbh|ag|s\.a\.s|sas|sarl|b\.v\.|bv|llc|oü)\b\.?/gi;

function normalizeEntityCoreName(name = '') {
  return String(name || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(ENTITY_LEGAL_SUFFIX_RE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStrongEntityNameMatch(queryName = '', candName = '') {
  const qCore = normalizeEntityCoreName(queryName);
  const cCore = normalizeEntityCoreName(candName);
  if (!qCore || !cCore) return false;
  if (qCore === cCore) return true;
  const qTokens = qCore.split(' ').filter((t) => t.length >= 2);
  const cTokens = cCore.split(' ').filter((t) => t.length >= 2);
  if (!qTokens.length || !cTokens.length) return false;
  if (qTokens.length === 1) {
    return cTokens[0] === qTokens[0] || (cTokens.includes(qTokens[0]) && cTokens.length <= 2);
  }
  return qTokens.every((t) => cTokens.includes(t));
}

function pickBestCalaEntity(entities = [], preferredType = 'Organization', queryName = '') {
  if (!entities.length) return null;
  const pool = queryName
    ? entities.filter((e) => isStrongEntityNameMatch(queryName, e?.name || ''))
    : entities;
  if (!pool.length) return null;
  const exactType = pool.find((e) => e.entity_type === preferredType);
  return exactType || pool[0];
}

function summarizeLiveCalaEntity(entityData) {
  if (!entityData) return null;
  const props = entityData.properties || {};
  const outgoing = entityData.relationships?.outgoing || {};
  const incoming = entityData.relationships?.incoming || {};
  const peopleEvidence = (person, relation, role) => {
    const firstSource = person?.properties?.sources?.[0] || {};
    return {
      id: person?.id || null,
      name: person?.name || 'Unnamed Cala person',
      relation,
      role,
      validSince: person?.properties?.valid_since || person?.properties?.start_date || null,
      validUntil: person?.properties?.valid_until || person?.properties?.end_date || null,
      // This is deliberately read only from Cala relationship evidence.  Do not
      // infer a prior employer from a title, name, or other display field.
      priorCompany: person?.properties?.prior_company || null,
      priorRole: person?.properties?.prior_role || null,
      priorValidUntil: person?.properties?.prior_valid_until || null,
      sourceId: person?.properties?.source_id || person?.properties?.sourceId || firstSource.id || firstSource.source_id || firstSource.sourceId || null,
      sourceRank: sourceTierFor(firstSource, null),
      sources: (person?.properties?.sources || []).slice(0, 3)
    };
  };

  const investedIn = (outgoing.INVESTED_IN || []).map((c) => ({
    id: c.id,
    name: c.name,
    entityType: c.entity_type,
    sources: (c.properties?.sources || []).slice(0, 2)
  }));

  const rawPartRounds = outgoing.PARTICIPATES_IN_FUNDING_ROUND || [];
  const issuerRounds = rawPartRounds
    .filter((r) => !r.properties?.role || r.properties.role === 'ISSUER')
    .map((r) => ({
      id: r.id,
      roundType: r.name,
      role: r.properties?.role || 'ISSUER',
      isLead: Boolean(r.properties?.is_lead),
      eventDate: r.properties?.event_date || null,
      transactionValue: r.properties?.transaction_value ?? null,
      transactionValueUnits: r.properties?.transaction_value_units || null,
      sources: (r.properties?.sources || []).slice(0, 2)
    }));

  const fundingRounds = rawPartRounds.map((r) => ({
    id: r.id,
    roundType: r.name,
    role: r.properties?.role || 'INVESTOR',
    isLead: Boolean(r.properties?.is_lead),
    eventDate: r.properties?.event_date || null,
    sources: (r.properties?.sources || []).slice(0, 2)
  }));

  const raisedRounds = (incoming.PARTICIPATES_IN_FUNDING_ROUND || outgoing.HAS_FUNDING_ROUND || []).map((r) => ({
    id: r.id,
    roundType: r.name,
    role: r.properties?.role || 'ISSUER',
    eventDate: r.properties?.event_date || null,
    sources: (r.properties?.sources || []).slice(0, 2)
  }));

  const corpEvents = (outgoing.PARTICIPATES_IN_CORPORATE_EVENT || []).map((ev) => {
    const evDate = ev.properties?.event_date || null;
    const matchedIssuer = issuerRounds.some((r) => r.eventDate && evDate && r.eventDate.slice(0, 7) === evDate.slice(0, 7));
    return {
      id: ev.id,
      name: ev.name,
      role: ev.properties?.role || null,
      eventDate: evDate,
      deduplicatedAgainstRound: matchedIssuer,
      sources: (ev.properties?.sources || []).slice(0, 2)
    };
  });

  const eventsAttended = [
    ...(outgoing.PARTICIPATES_IN_EVENT || []).map((ev) => ({
      id: ev.id,
      name: ev.name,
      role: ev.properties?.role || 'ATTENDEE',
      sources: (ev.properties?.sources || []).slice(0, 2)
    })),
    ...(incoming.PARTICIPATES_IN_EVENT || []).map((co) => ({
      id: co.id,
      name: co.name,
      entityType: co.entity_type,
      role: co.properties?.role || 'ATTENDEE',
      sources: (co.properties?.sources || []).slice(0, 2)
    }))
  ];

  const leadership = [
    ...(incoming.FOUNDED || []).map((p) => peopleEvidence(p, 'FOUNDED', 'Founder')),
    ...(incoming.IS_CEO_OF || []).map((p) => peopleEvidence(p, 'IS_CEO_OF', 'CEO')),
    ...(incoming.IS_CTO_OF || []).map((p) => peopleEvidence(p, 'IS_CTO_OF', 'CTO')),
    ...(incoming.IS_BOARD_MEMBER_OF || []).map((p) => peopleEvidence(p, 'IS_BOARD_MEMBER_OF', 'Board Member')),
    ...(incoming.IS_CONTROL_PERSON_OF || []).map((p) => peopleEvidence(p, 'IS_CONTROL_PERSON_OF', 'Control Person')),
    ...(incoming.IS_BENEFICIARY_OWNER_OF || []).map((p) => peopleEvidence(p, 'IS_BENEFICIARY_OWNER_OF', 'Beneficial Owner'))
  ];

  const worksAt = (incoming.WORKS_AT || []).map((p) => peopleEvidence(p, 'WORKS_AT', p.properties?.role || 'Team member'));

  const numericalObservations = Array.isArray(entityData.numerical_observations)
    ? entityData.numerical_observations.slice(0, 12)
    : [];

  return {
    id: entityData.id,
    name: entityData.name,
    legalName: props.legal_name?.value || null,
    legalNameSources: (props.legal_name?.sources || []).slice(0, 2),
    entityType: entityData.entity_type,
    description: entityData.description,
    website: props.website?.value || null,
    address: props.registered_address?.value || props.headquarters_address?.value || null,
    operationalStatus: props.operational_status?.value || null,
    ownershipStatus: props.company_ownership_status?.value || null,
    fundingStage: props.funding_stage?.value || null,
    foundingDate: props.founding_date?.value || null,
    foundingDatePrecision: props.founding_date?.sources?.[0]?.date_precision || null,
    employeeCountRange: props.employee_count_range?.value || null,
    totalFunding: props.total_funding?.value ?? null,
    totalFundingUnits: props.total_funding_units?.value || null,
    totalFundingExcludingDebt: props.total_funding_excluding_debt?.value ?? null,
    investedInCount: investedIn.length,
    investedIn: investedIn.slice(0, 12),
    fundingRoundsCount: fundingRounds.length,
    issuerRoundsCount: issuerRounds.length,
    leadRoundsCount: fundingRounds.filter((r) => r.isLead).length,
    issuerRounds: issuerRounds.slice(0, 10),
    fundingRounds: fundingRounds.slice(0, 12),
    raisedRounds: raisedRounds.slice(0, 10),
    corporateEvents: corpEvents.slice(0, 8),
    eventsAttended: eventsAttended.slice(0, 25),
    leadership: leadership.slice(0, 10),
    worksAt: worksAt.slice(0, 8),
    numericalObservations
  };
}

function toLiveSearchEntity(entity) {
  const entityId = String(entity?.id || '').trim();
  const name = String(entity?.name || '').trim();
  if (!entityId || !name) return null;
  const entityType = entity.entity_type || entity.entityType || 'Entity';
  const indexed = COMPANIES.find((company) => company.calaEntityId === entityId || normalizeEntityCoreName(company.name) === normalizeEntityCoreName(name));
  const isFund = FUNDS.some((fund) => fund.calaEntityId === entityId || normalizeEntityCoreName(fund.name) === normalizeEntityCoreName(name));
  return {
    id: entityId,
    calaEntityId: entityId,
    name,
    entityType,
    entityCategory: indexed?.entityCategory || (isFund ? 'fund' : entityType === 'Organization' ? 'organization' : 'entity'),
    isLiveCalaDiscovered: true,
    sector: indexed?.sector || null,
    country: indexed?.country || null,
    hqCity: indexed?.hqCity || null,
    description: entity.description || entity.properties?.description?.value || null
  };
}

function hasKnownNumericValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
}

function localCompanyAsEntity(company) {
  if (!company) return null;
  return {
    id: company.calaEntityId || company.id,
    name: company.name,
    entity_type: company.entityCategory === 'established_corp' ? 'Organization' : 'Company',
    description: company.description || company.oneLiner || null,
    properties: {
      website: company.website ? { value: company.website } : undefined,
      founding_date: company.foundingDate ? { value: company.foundingDate } : undefined,
      employee_count_range: hasKnownNumericValue(company.employeeCount) ? { value: Number(company.employeeCount) } : undefined
    },
    relationships: { outgoing: {}, incoming: {} }
  };
}

const SOURCE_TIER_PRIORITY = { FILING: 4, PRIMARY: 3, PRESS: 2, AGGREGATOR: 1 };

function sourceTierFor(rawSource = {}, fallback = null) {
  const explicit = String(rawSource?.source_rank || rawSource?.sourceRank || '').toUpperCase();
  if (SOURCE_TIER_PRIORITY[explicit]) return explicit;
  const haystack = `${rawSource?.source || ''} ${rawSource?.publisher || ''} ${rawSource?.name || ''} ${rawSource?.url || ''}`.toLowerCase();
  if (/(sec|edgar|companies[ _-]?house|prh|ytj|filing|registry|registrar|gleif|official)/.test(haystack)) return 'FILING';
  if (/(press release|official|company|investor|portfolio|announcement|disclosure)/.test(haystack)) return 'PRIMARY';
  if (/(techcrunch|sifted|financial times|venturebeat|press|news)/.test(haystack)) return 'PRESS';
  return fallback;
}

function normalizeRawRelationshipGroups(entity = {}) {
  const groups = { outgoing: {}, incoming: {} };
  const relations = entity.relationships || {};
  for (const direction of ['outgoing', 'incoming']) {
    for (const [relation, targets] of Object.entries(relations[direction] || {})) {
      groups[direction][relation] = (targets || [])
        .filter((target) => target?.id || target?.name)
        .map((target) => ({
          id: target.id || null,
          name: target.name || 'Unnamed Cala entity',
          entityType: target.entity_type || target.entityType || 'Entity',
          role: target.properties?.role || null,
          validSince: target.properties?.valid_since || target.properties?.start_date || null,
          validUntil: target.properties?.valid_until || target.properties?.end_date || null,
          eventDate: target.properties?.event_date || target.properties?.valid_since || target.properties?.valid_until || null,
          // Prior employment is shown only when it is carried by the verified
          // Cala edge itself; no name/title based fallback is permitted here.
          priorCompany: target.properties?.prior_company || null,
          priorRole: target.properties?.prior_role || null,
          priorValidUntil: target.properties?.prior_valid_until || null,
          sourceId: target.properties?.source_id || target.properties?.sourceId || target.properties?.sources?.[0]?.id || target.properties?.sources?.[0]?.source_id || target.properties?.sources?.[0]?.sourceId || null,
          sourceTier: sourceTierFor(target.properties?.sources?.[0], null)
        }));
    }
  }
  return groups;
}

function collectDossierSources(entity, indexedCompany = null) {
  const sourceMap = new Map();
  const addRaw = (source, fallbackTitle = 'Cala relationship record') => {
    if (!source) return;
    const key = source.url || source.document || source.name || source.source || fallbackTitle;
    if (sourceMap.has(key)) return;
    sourceMap.set(key, {
      id: source.id || null,
      title: source.name || fallbackTitle,
      publisher: source.source || source.publisher || 'Cala AI Knowledge Graph',
      url: source.url || source.document || null,
      date: source.published_time || source.date || null,
      sourceRank: sourceTierFor(source, null)
    });
  };
  for (const prop of Object.values(entity.properties || {})) {
    for (const source of prop?.sources || []) addRaw(source, `${entity.name || 'Cala entity'} property record`);
  }
  for (const direction of ['outgoing', 'incoming']) {
    for (const targets of Object.values(entity.relationships?.[direction] || {})) {
      for (const target of targets || []) {
        for (const source of target?.properties?.sources || []) addRaw(source, `${entity.name || 'Cala entity'} relationship record`);
      }
    }
  }
  const indexedSourceIds = [
    ...(indexedCompany?.rounds || []).flatMap((round) => round.sourceIds || []),
    ...(indexedCompany?.employeeCountSeries || []).map((item) => item.sourceId),
    ...(indexedCompany?.financialMetrics || []).map((item) => item.sourceId),
    ...(indexedCompany?.corporateEvents || []).map((item) => item.sourceId),
    ...(indexedCompany?.peopleCoverage?.roles || []).map((item) => item.sourceId)
  ].filter(Boolean);
  for (const sourceId of indexedSourceIds) {
    const source = SOURCES[sourceId];
    if (source) addRaw({ ...source, id: sourceId, sourceRank: source.sourceRank }, source.title);
  }
  return [...sourceMap.values()].sort(
    (a, b) => (SOURCE_TIER_PRIORITY[b.sourceRank] || 0) - (SOURCE_TIER_PRIORITY[a.sourceRank] || 0) || String(a.title).localeCompare(String(b.title))
  );
}

function getCachedAnalysis(payload) {
  const entityScope = payload.entityScope === 'all' ? 'all' : 'startups';
  const hideMegaHubs = payload.hideMegaHubs !== undefined ? Boolean(payload.hideMegaHubs) : true;
  const bridgeFamily = String(payload.bridgeFamily || 'all').trim().toLowerCase() || 'all';
  const contributionGroup = String(payload.contributionGroup || 'all').trim().toLowerCase() || 'all';
  const includeCompanyNames = Array.isArray(payload.includeCompanyNames)
    ? [...payload.includeCompanyNames].sort()
    : [];
  const key = JSON.stringify({
    mode: payload.mode || 'fund',
    fundId: payload.fundId || null,
    companyIds: Array.isArray(payload.companyIds) ? [...payload.companyIds].sort() : [],
    rankingMode: payload.rankingMode || 'balanced',
    statedThesisOverride: payload.statedThesisOverride || '',
    seenCompanyNames: Array.isArray(payload.seenCompanyNames) ? [...payload.seenCompanyNames].sort() : [],
    entityScope,
    includeCompanyNames,
    hideMegaHubs,
    bridgeFamily,
    contributionGroup
  });

  if (analysisCache.has(key)) {
    return { ...analysisCache.get(key), cacheHit: true };
  }
  const result = runFullAnalysis(
    {
      mode: payload.mode || 'fund',
      fundId: payload.fundId,
      companyIds: payload.companyIds
    },
    {
      rankingMode: payload.rankingMode || 'balanced',
      statedThesisOverride: payload.statedThesisOverride || '',
      seenCompanyNames: payload.seenCompanyNames || [],
      entityScope,
      includeCompanyNames,
      hideMegaHubs,
      bridgeFamily,
      contributionGroup
    }
  );
  if (analysisCache.size > 60) {
    const firstKey = analysisCache.keys().next().value;
    analysisCache.delete(firstKey);
  }
  analysisCache.set(key, result);
  return { ...result, cacheHit: false };
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store'
  });
  res.end(json);
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > 512 * 1024) {
      const err = new Error('Request payload exceeds 512KB limit.');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON payload.');
    err.statusCode = 400;
    throw err;
  }
}

async function serveStatic(res, reqPathname) {
  const safePath = reqPathname === '/' ? '/index.html' : reqPathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden path.' });
    return;
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const content = await fs.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-store'
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Resource not found.' });
  }
}

export function hydrateEntitiesFromDiskCache(cacheFile = CALA_CACHE_FILE) {
  try {
    if (!fsSync.existsSync(cacheFile)) return { ingestedCount: 0, enrichedCount: 0 };
    const store = JSON.parse(fsSync.readFileSync(cacheFile, 'utf8'));
    let totalIngested = 0;
    let totalEnriched = 0;

    for (const entry of Object.values(store || {})) {
      const data = entry?.data;
      if (!data) continue;
      const apiPath = String(entry.apiPath || '');
      const isSlush = apiPath.includes(SLUSH_2026_ENTITY_ID);
      if (data.id && data.entity_type === 'Company') {
        const r = ingestLiveCalaEntities([data], { slush2026: isSlush });
        totalIngested += r.ingestedCount;
        totalEnriched += r.enrichedCount;
      }
      if (apiPath === '/v1/knowledge/search' && Array.isArray(data.entities)) {
        const r = ingestLiveCalaEntities(data.entities, { slush2026: isSlush });
        totalIngested += r.ingestedCount;
        totalEnriched += r.enrichedCount;
      }
      const invested = data.relationships?.outgoing?.INVESTED_IN || [];
      if (invested.length) {
        const matchedFund = FUNDS.find((f) => f.name.toLowerCase() === String(data.name || '').toLowerCase());
        const r = ingestLiveCalaEntities(invested, matchedFund ? { investorId: matchedFund.id } : {});
        totalIngested += r.ingestedCount;
        totalEnriched += r.enrichedCount;
      }
      const eventCompanies = data.relationships?.incoming?.PARTICIPATES_IN_EVENT || [];
      if (eventCompanies.length) {
        const r = ingestLiveCalaEntities(eventCompanies, { slush2026: isSlush });
        totalIngested += r.ingestedCount;
        totalEnriched += r.enrichedCount;
      }
    }
    return { ingestedCount: totalIngested, enrichedCount: totalEnriched };
  } catch {
    return { ingestedCount: 0, enrichedCount: 0 };
  }
}

async function retrieveEntityWithIntrospection(calaClient, entityId, incomingEventLimit = 20) {
  const introRes = await calaClient.calaIntrospect(entityId);
  const outgoingMap = {};
  for (const rel of introRes.data?.relationships?.outgoing || []) {
    outgoingMap[rel] = { limit: 20, offset: 0 };
  }
  const incomingMap = {};
  for (const rel of introRes.data?.relationships?.incoming || []) {
    incomingMap[rel] = { limit: rel === 'PARTICIPATES_IN_EVENT' ? incomingEventLimit : 20, offset: 0 };
  }
  const retrieveBody = {
    properties: introRes.data?.properties || ['name', 'description'],
    relationships: { outgoing: outgoingMap, incoming: incomingMap }
  };
  const rawNumObs = introRes.data?.numerical_observations;
  if (Array.isArray(rawNumObs) && rawNumObs.length > 0) {
    retrieveBody.numerical_observations = rawNumObs;
  } else if (rawNumObs && typeof rawNumObs === 'object') {
    const mappedNumObs = {};
    for (const [obsType, entries] of Object.entries(rawNumObs)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const ids = entries.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean);
      if (ids.length > 0) mappedNumObs[obsType] = ids;
    }
    if (Object.keys(mappedNumObs).length > 0) {
      retrieveBody.numerical_observations = mappedNumObs;
    }
  }
  const entityRes = await calaClient.calaRetrieveEntity(entityId, retrieveBody);
  return { introRes, entityRes };
}

function extractCleanCalaSearchQuery(rawQuery) {
  const cleaned = String(rawQuery || '')
    .replace(/^(company|investor|person|founder|similar to):\s*/i, '')
    .replace(/\b(find|show|give|list|recommend|which|what|who|startups?|companies?|raising|soon|in|under|below|employees|staff|people|headcount|fast|growth|velocity|feeder|syndicate|filing|signal|alumni|founder|only|warm|warmest|intro|bridge|slush|2026)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 2 ? cleaned : String(rawQuery || '').trim();
}

const PERSON_CONNECTED_REL_LABELS = {
  FOUNDED: 'Founder',
  IS_CEO_OF: 'Chief Executive Officer',
  IS_CTO_OF: 'Chief Technology Officer',
  IS_CFO_OF: 'Chief Financial Officer',
  IS_COO_OF: 'Chief Operating Officer',
  IS_VICEPRESIDENT_OF: 'Vice President',
  IS_BOARD_MEMBER_OF: 'Board Member',
  WORKS_AT: 'Executive / Operator',
  INVESTED_IN: 'Angel / Individual Investor',
  INVESTOR: 'Angel / Individual Investor',
  PARTICIPATES_IN_FUNDING_ROUND: 'Round Participant',
  IS_CONTROL_PERSON_OF: 'Control Person',
  IS_BENEFICIARY_OWNER_OF: 'Beneficial Owner',
  IS_MEMBER_OF: 'Member / Advisor'
};

async function deepHydrateCalaEntities(calaClient, entityIds = [], context = {}) {
  let discoveredCount = 0;
  let enrichedCount = 0;
  const hydratedEntities = [];
  const companies = [];
  const seen = new Set();
  const maxEntities = Math.max(1, Number(context.maxEntities ?? 8));
  const queue = (entityIds || [])
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, maxEntities);

  const batchSize = 4;
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((id) => retrieveEntityWithIntrospection(calaClient, id, context.incomingEventLimit ?? 20))
    );
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      const entityData = outcome.value?.entityRes?.data;
      if (!entityData) continue;
      hydratedEntities.push(entityData);
      const entityContext = typeof context.resolveEntityContext === 'function'
        ? { ...context, ...context.resolveEntityContext(entityData) }
        : context;
      const deepIng = ingestLiveCalaEntities([entityData], entityContext);
      discoveredCount += deepIng.ingestedCount;
      enrichedCount += deepIng.enrichedCount;
      companies.push(...(deepIng.companies || []));
    }
  }
  return { discoveredCount, enrichedCount, hydratedEntities, companies };
}

function collectConnectedTargetsFromPerson(personEntity) {
  const outRels = personEntity?.relationships?.outgoing || {};
  const inRels = personEntity?.relationships?.incoming || {};
  const personName = String(personEntity?.name || '').trim();
  const rolesByCompanyId = new Map();
  const investorNamesByCompanyId = new Map();
  const connectedTargets = [];

  const priorWork = [...(outRels.WORKS_AT || []), ...(inRels.WORKS_AT || [])].find(
    (t) => t?.name && (t?.properties?.valid_until || t?.properties?.end_date)
  );
  const studiedAt = (outRels.STUDIED_AT || []).find((t) => t?.name);
  const fallbackPriorName = priorWork?.name || studiedAt?.name || null;
  const fallbackPriorRole = priorWork
    ? priorWork.properties?.role || 'Operator'
    : studiedAt
      ? 'Alumni'
      : null;
  const fallbackPriorUntil = priorWork?.properties?.valid_until || priorWork?.properties?.end_date || null;

  const isTargetCompanyOrOrg = (t) =>
    t?.id &&
    t?.name &&
    (!t.entity_type || t.entity_type === 'Company' || t.entity_type === 'Organization');

  for (const relName of Object.keys(PERSON_CONNECTED_REL_LABELS)) {
    const edges = [...(outRels[relName] || []), ...(inRels[relName] || [])];
    for (const target of edges) {
      if (!isTargetCompanyOrOrg(target)) continue;
      const tId = String(target.id);
      if (!connectedTargets.some((x) => x.id === tId)) {
        connectedTargets.push(target);
      }
      const isLeadershipOrFounder = ['FOUNDED', 'IS_CEO_OF', 'IS_CTO_OF'].includes(relName);
      const distinctPrior =
        isLeadershipOrFounder &&
        fallbackPriorName &&
        normalizeEntityCoreName(fallbackPriorName) !== normalizeEntityCoreName(target.name)
          ? fallbackPriorName
          : null;
      const roleEntry = {
        relation: relName,
        name: personName,
        role: target.properties?.role || PERSON_CONNECTED_REL_LABELS[relName] || 'Principal',
        validSince: target.properties?.valid_since || target.properties?.start_date || null,
        validUntil: target.properties?.valid_until || target.properties?.end_date || null,
        priorCompany: target.properties?.prior_company || distinctPrior,
        priorRole: target.properties?.prior_role || (distinctPrior ? fallbackPriorRole : null),
        priorValidUntil: target.properties?.prior_valid_until || (distinctPrior ? fallbackPriorUntil : null),
        isMatchedPersonBridge: true,
        sourceId: target.properties?.source_id || target.properties?.sourceId || target.properties?.sources?.[0]?.id || target.properties?.sources?.[0]?.source_id || target.properties?.sources?.[0]?.sourceId || null,
        sourceRank: sourceTierFor(
          target.properties?.sources?.[0],
          relName === 'IS_CONTROL_PERSON_OF' || relName === 'IS_BENEFICIARY_OWNER_OF' ? 'FILING' : null
        )
      };
      const prevList = rolesByCompanyId.get(tId) || [];
      prevList.push(roleEntry);
      rolesByCompanyId.set(tId, prevList);

      if (relName === 'INVESTED_IN' || relName === 'INVESTOR') {
        const invList = investorNamesByCompanyId.get(tId) || [];
        if (personName && !invList.includes(personName)) invList.push(personName);
        investorNamesByCompanyId.set(tId, invList);
      }
    }
  }

  return { connectedTargets, rolesByCompanyId, investorNamesByCompanyId };
}

async function discoverStartupsFromCala(
  calaClient,
  { queryText = '', mode = 'ecosystem', cachedEntities = [], includeCachedPrefixMatches = false } = {}
) {
  let discoveredCount = 0;
  let enrichedCount = 0;
  let knowledgeAnswer = null;
  const cleanQ = String(queryText || '').trim();
  const hydratedById = new Map();
  const linkedCompanyNames = new Set();
  const matchedCompanyNames = new Set();
  const matchedPersons = [];
  const matchedOrganizations = [];
  const matchedEntitiesById = new Map();
  let sortMatchedEntities = () => [...matchedEntitiesById.values()];

  if (mode === 'ecosystem' || /slush/i.test(cleanQ)) {
    try {
      const eventRes = await calaClient.calaRetrieveEntity(SLUSH_2026_ENTITY_ID, {
        properties: ['name', 'description'],
        relationships: { incoming: { PARTICIPATES_IN_EVENT: { limit: 100, offset: 0 } } }
      });
      const attendees = (eventRes.data?.relationships?.incoming?.PARTICIPATES_IN_EVENT || [])
        .filter((e) => !e.entity_type || e.entity_type === 'Company')
        .slice(0, 60);
      const ing = ingestLiveCalaEntities(attendees, { slush2026: true, allowUnfundedLive: true });
      discoveredCount += ing.ingestedCount;
      enrichedCount += ing.enrichedCount;

      const deep = await deepHydrateCalaEntities(
        calaClient,
        ing.companies.slice(0, 8).map((c) => c.calaEntityId),
        { slush2026: true, allowUnfundedLive: true, maxEntities: 8 }
      );
      discoveredCount += deep.discoveredCount;
      enrichedCount += deep.enrichedCount;
      for (const h of deep.hydratedEntities) hydratedById.set(h.id, h);
    } catch {
      // Non-fatal in offline/budget-restricted runs
    }
  }

  if (cleanQ) {
    const searchTerm = extractCleanCalaSearchQuery(cleanQ) || cleanQ;
    const isGenericEventWord = /^(slush|2026)$/i.test(searchTerm);
    let directHits = [];
    let ksEntities = [];

    const entitySearchPromise =
      searchTerm.length >= 2 && !isGenericEventWord
        ? calaClient.calaEntitySearch(searchTerm, 12, ['Company', 'Organization', 'Person'])
        : Promise.resolve(null);
    const ksSearchPromise =
      cleanQ.length >= 3 && !isGenericEventWord && typeof calaClient.calaKnowledgeSearch === 'function'
        ? calaClient.calaKnowledgeSearch(cleanQ, { explainability: true, returnEntities: true })
        : Promise.resolve(null);

    const [entitySearchOutcome, ksSearchOutcome] = await Promise.allSettled([entitySearchPromise, ksSearchPromise]);
    if (entitySearchOutcome.status === 'fulfilled' && entitySearchOutcome.value?.data?.entities) {
      directHits = entitySearchOutcome.value.data.entities;
    }
    if (ksSearchOutcome.status === 'fulfilled' && ksSearchOutcome.value?.data) {
      knowledgeAnswer = ksSearchOutcome.value.data;
      ksEntities = Array.isArray(knowledgeAnswer?.entities) ? knowledgeAnswer.entities : [];
    }

    // Combine unique entities from directHits, knowledgeAnswer.entities, and warm local/Cala cache
    // so short prefixes like "Anth" still surface high-signal cached hubs above obscure legal shells.
    const combinedById = new Map();
    const queryNorm = normalizeEntityCoreName(searchTerm || cleanQ);
    const cacheHitsForPrefix = [];
    if (includeCachedPrefixMatches && queryNorm.length >= 2) {
      const cachePool = [
        ...(Array.isArray(cachedEntities) ? cachedEntities : []),
        ...(typeof calaClient.getCachedEntities === 'function' ? calaClient.getCachedEntities() : [])
      ];
      for (const cached of cachePool) {
        if (!cached?.id || !cached?.name) continue;
        if (cached.entity_type && !['Company', 'Organization', 'Person'].includes(cached.entity_type)) continue;
        const candNorm = normalizeEntityCoreName(cached.name);
        if (!candNorm) continue;
        const words = candNorm.split(' ');
        const isPrefix = candNorm === queryNorm || candNorm.startsWith(queryNorm) || words.some((w) => w.startsWith(queryNorm));
        if (isPrefix) cacheHitsForPrefix.push(cached);
      }
    }

    for (const hit of [...directHits, ...ksEntities, ...cacheHitsForPrefix]) {
      if (!hit?.id || !hit?.name) continue;
      if (!combinedById.has(hit.id)) {
        combinedById.set(hit.id, hit);
      } else {
        const prev = combinedById.get(hit.id);
        combinedById.set(hit.id, {
          ...prev,
          ...hit,
          description: prev.description || hit.description,
          relationships: prev.relationships || hit.relationships,
          properties: prev.properties || hit.properties
        });
      }
    }
    const wantsProgram = /\b(program|accelerator|incubator|network|fund\b|hub)\b/i.test(`${searchTerm} ${cleanQ}`);
    const matchRankScore = (entity = {}) => {
      const candNorm = normalizeEntityCoreName(entity.name || '');
      const candWords = candNorm ? candNorm.split(' ') : [];
      let score = 0;
      if (candNorm === queryNorm) score += 80;
      else if (candNorm.startsWith(`${queryNorm} `)) score += 55;
      else if (queryNorm.length >= 3 && candNorm.startsWith(queryNorm)) score += 45;
      else if (queryNorm.length >= 3 && candWords.some((w) => w.startsWith(queryNorm))) score += 24;
      else if (isStrongEntityNameMatch(searchTerm, entity.name) || isStrongEntityNameMatch(cleanQ, entity.name)) score += 16;
      if (!wantsProgram && /\b(inception program|partner network|accelerator|incubator|fellowship)\b/i.test(entity.name || '')) {
        score -= 22;
      }
      if (candNorm !== queryNorm && /\b(llc|ltd|inc|gmbh|corp|lp|llp|plc)\b/i.test(entity.name || '')) {
        score -= 8;
      }
      if (entity.entity_type === 'Company' || entity.entity_type === 'Organization') score += 4;
      if (entity.description) score += String(entity.description).length > 40 ? 6 : 3;
      const relCount =
        Object.values(entity.relationships?.outgoing || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0) +
        Object.values(entity.relationships?.incoming || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
      score += Math.min(28, relCount * 2);
      return score;
    };
    const allMatched = [...combinedById.values()].sort(
      (a, b) => matchRankScore(b) - matchRankScore(a) || String(a.name || '').localeCompare(String(b.name || ''))
    );
    sortMatchedEntities = () =>
      [...matchedEntitiesById.values()].sort(
        (a, b) => matchRankScore(b) - matchRankScore(a) || String(a.name || '').localeCompare(String(b.name || ''))
      );
    for (const entity of allMatched) matchedEntitiesById.set(entity.id, entity);

    const companyOrgHits = allMatched.filter((e) => !e.entity_type || e.entity_type === 'Company' || e.entity_type === 'Organization');
    const personHits = allMatched.filter((e) => e.entity_type === 'Person');

    if (companyOrgHits.length > 0) {
      for (const hit of companyOrgHits) {
        const strongMatch = isStrongEntityNameMatch(searchTerm, hit.name) || isStrongEntityNameMatch(cleanQ, hit.name);
        if (strongMatch && (!hit.entity_type || hit.entity_type === 'Company')) {
          matchedCompanyNames.add(hit.name);
        }
        const preIng = ingestLiveCalaEntities([hit], {
          allowOrganizations: true,
          allowGeneralCompanies: strongMatch,
          allowUnfundedLive: true
        });
        discoveredCount += preIng.ingestedCount;
        enrichedCount += preIng.enrichedCount;
      }

      // Hydrate the top six direct matches so search results become useful
      // entity anchors without over-consuming the live Cala budget.
      const topCompanyOrgIds = companyOrgHits.slice(0, 6).map((e) => e.id);
      const deep = await deepHydrateCalaEntities(calaClient, topCompanyOrgIds, {
        maxEntities: 6,
        allowOrganizations: true,
        allowUnfundedLive: true,
        resolveEntityContext: (entityData) => ({
          allowGeneralCompanies:
            isStrongEntityNameMatch(searchTerm, entityData.name) || isStrongEntityNameMatch(cleanQ, entityData.name)
        })
      });
      discoveredCount += deep.discoveredCount;
      enrichedCount += deep.enrichedCount;
      for (const h of deep.hydratedEntities) {
        hydratedById.set(h.id, h);
        matchedEntitiesById.set(h.id, h);
      }
      for (const co of deep.companies) {
        if (isStrongEntityNameMatch(searchTerm, co.name) || isStrongEntityNameMatch(cleanQ, co.name)) {
          matchedCompanyNames.add(co.name);
        }
      }

      // Expand matched Organizations (e.g. VC funds, accelerators, research institutes) via INVESTED_IN portfolio startups
      const hydratedOrgs = deep.hydratedEntities.filter((e) => e.entity_type === 'Organization');
      for (const org of hydratedOrgs.slice(0, 3)) {
        matchedOrganizations.push(org.name);
        const outInv = org.relationships?.outgoing?.INVESTED_IN || [];
        const inInv = org.relationships?.incoming?.INVESTED_IN || [];
        const invTargets = [...outInv, ...inInv]
          .filter((t) => t?.id && t?.name && (!t.entity_type || t.entity_type === 'Company' || t.entity_type === 'Organization'));
        if (invTargets.length === 0) continue;

        const targetIdsToHydrate = [];
        for (const t of invTargets.slice(0, 5)) {
          linkedCompanyNames.add(t.name);
          if (hydratedById.has(t.id)) {
            const reIng = ingestLiveCalaEntities([hydratedById.get(t.id)], {
              investorName: org.name,
              allowOrganizations: true,
              allowGeneralCompanies: true,
              allowUnfundedLive: true
            });
            discoveredCount += reIng.ingestedCount;
            enrichedCount += reIng.enrichedCount;
          } else {
            targetIdsToHydrate.push(t.id);
          }
        }
        if (targetIdsToHydrate.length > 0) {
          const orgDeep = await deepHydrateCalaEntities(calaClient, targetIdsToHydrate, {
            maxEntities: 5,
            investorName: org.name,
            allowOrganizations: true,
            allowGeneralCompanies: true,
            allowUnfundedLive: true
          });
          discoveredCount += orgDeep.discoveredCount;
          enrichedCount += orgDeep.enrichedCount;
          for (const h of orgDeep.hydratedEntities) hydratedById.set(h.id, h);
          for (const co of orgDeep.companies) linkedCompanyNames.add(co.name);
        }
      }
    }

    // Expand Person / Founder / Angel entities into their full role history & connected Companies/Organizations
    if (personHits.length > 0) {
      const personToHydrate = personHits.slice(0, 3);
      const personSettled = await Promise.allSettled(
        personToHydrate.map((p) => retrieveEntityWithIntrospection(calaClient, p.id))
      );

      const mergedRolesByCompanyId = new Map();
      const mergedInvestorNamesByCompanyId = new Map();
      const unhydratedPersonCompanyIds = [];
      const alreadyHydratedTargets = [];

      for (const outcome of personSettled) {
        if (outcome.status !== 'fulfilled') continue;
        const personData = outcome.value?.entityRes?.data;
        if (!personData?.id) continue;
        hydratedById.set(personData.id, personData);
        matchedEntitiesById.set(personData.id, personData);
        matchedPersons.push(personData.name);

        const { connectedTargets, rolesByCompanyId, investorNamesByCompanyId } = collectConnectedTargetsFromPerson(personData);
        for (const [compId, roles] of rolesByCompanyId.entries()) {
          const existingList = mergedRolesByCompanyId.get(compId) || [];
          existingList.push(...roles);
          mergedRolesByCompanyId.set(compId, existingList);
        }
        for (const [compId, invNames] of investorNamesByCompanyId.entries()) {
          const existingInv = mergedInvestorNamesByCompanyId.get(compId) || [];
          for (const invName of invNames) {
            if (!existingInv.includes(invName)) existingInv.push(invName);
          }
          mergedInvestorNamesByCompanyId.set(compId, existingInv);
        }

        for (const target of connectedTargets.slice(0, 5)) {
          linkedCompanyNames.add(target.name);
          if (hydratedById.has(target.id)) {
            alreadyHydratedTargets.push(hydratedById.get(target.id));
          } else if (!unhydratedPersonCompanyIds.includes(target.id)) {
            unhydratedPersonCompanyIds.push(target.id);
          }
        }
      }

      if (alreadyHydratedTargets.length > 0) {
        const reIng = ingestLiveCalaEntities(alreadyHydratedTargets, {
          allowOrganizations: true,
          allowGeneralCompanies: true,
          allowUnfundedLive: true,
          personRolesByCompanyId: mergedRolesByCompanyId,
          personInvestorNamesByCompanyId: mergedInvestorNamesByCompanyId
        });
        discoveredCount += reIng.ingestedCount;
        enrichedCount += reIng.enrichedCount;
        for (const co of reIng.companies) linkedCompanyNames.add(co.name);
      }

      if (unhydratedPersonCompanyIds.length > 0) {
        const personCompDeep = await deepHydrateCalaEntities(
          calaClient,
          unhydratedPersonCompanyIds.slice(0, 6),
          {
            maxEntities: 6,
            allowOrganizations: true,
            allowGeneralCompanies: true,
            allowUnfundedLive: true,
            personRolesByCompanyId: mergedRolesByCompanyId,
            personInvestorNamesByCompanyId: mergedInvestorNamesByCompanyId
          }
        );
        discoveredCount += personCompDeep.discoveredCount;
        enrichedCount += personCompDeep.enrichedCount;
        for (const h of personCompDeep.hydratedEntities) hydratedById.set(h.id, h);
        for (const co of personCompDeep.companies) linkedCompanyNames.add(co.name);
      }
    }
  }

  if (discoveredCount > 0 || enrichedCount > 0) {
    analysisCache.clear();
  }

  return {
    discoveredCount,
    enrichedCount,
    knowledgeAnswer,
    linkedCompanyNames: [...linkedCompanyNames],
    matchedCompanyNames: [...matchedCompanyNames],
    matchedPersons: [...new Set(matchedPersons)],
    matchedOrganizations: [...new Set(matchedOrganizations)],
    hydratedEntityCount: hydratedById.size,
    entities: sortMatchedEntities()
  };
}

export function createAppServer(options = {}) {
  const calaClient = options.calaClient || createCalaClient({ maxLiveCalls: options.maxLiveCalls ?? 250 });
  const registryClient = options.registryClient || createRegistryClient();
  const liveEntitiesById = new Map();
  const rememberLiveEntities = (entities = []) => {
    for (const entity of entities || []) {
      if (!entity?.id || !entity?.name) continue;
      const key = String(entity.id);
      const prev = liveEntitiesById.get(key);
      liveEntitiesById.set(key, {
        ...prev,
        ...entity,
        description: entity.description || prev?.description,
        relationships: entity.relationships || prev?.relationships,
        properties: entity.properties || prev?.properties
      });
    }
  };
  if (typeof calaClient.getCachedEntities === 'function') {
    rememberLiveEntities(calaClient.getCachedEntities());
  }
  const cachedReg = registryClient.getCachedCompanies();
  if (cachedReg.length > 0) {
    ingestRegistryEntities(cachedReg);
  }

  const hydrateLiveEntity = async (entityId) => {
    const id = String(entityId || '').trim();
    if (!id) return null;
    const cached = liveEntitiesById.get(id);
    if (cached?.relationships) return cached;
    const retrieved = await retrieveEntityWithIntrospection(calaClient, id);
    const entity = retrieved?.entityRes?.data || null;
    if (entity?.id) rememberLiveEntities([entity]);
    return entity;
  };

  const resolveEntityReference = async (rawReference) => {
    if (rawReference && typeof rawReference === 'object' && rawReference.id && rawReference.name) {
      const hasGraphPayload = Boolean(rawReference.relationships && typeof rawReference.relationships === 'object');
      if (hasGraphPayload) {
        rememberLiveEntities([rawReference]);
        return rawReference;
      }
      rawReference = rawReference.calaEntityId || rawReference.id;
    }
    const raw = String(rawReference || '').trim();
    if (!raw) return null;
    const separator = raw.indexOf(':');
    const id = separator >= 0 ? raw.slice(separator + 1).trim() : raw;
    if (!id) return null;

    let entity = liveEntitiesById.get(id) || null;
    if (!entity) {
      const targetNorm = normalizeEntityCoreName(id);
      if (targetNorm) {
        for (const cached of liveEntitiesById.values()) {
          if (normalizeEntityCoreName(cached?.name) === targetNorm) {
            entity = cached;
            break;
          }
        }
      }
    }
    if (!entity) {
      const localFund = FUNDS.find((fund) => fund.id === id || fund.calaEntityId === id || normalizeEntityCoreName(fund.name) === normalizeEntityCoreName(id));
      if (localFund?.calaEntityId) {
        try {
          entity = await hydrateLiveEntity(localFund.calaEntityId);
        } catch {
          entity = null;
        }
      }
    }
    if (!entity) {
      try {
        entity = await hydrateLiveEntity(id);
      } catch {
        entity = null;
      }
    }
    if (!entity) {
      const targetNorm = normalizeEntityCoreName(id);
      const local = COMPANIES.find((company) => company.id === id || company.calaEntityId === id || (targetNorm && normalizeEntityCoreName(company.name) === targetNorm));
      if (local) entity = localCompanyAsEntity(local);
    }
    if (!entity?.id || !entity?.name) return null;
    rememberLiveEntities([entity]);
    return entity;
  };

  const resolveEntityMapRequest = async (body = {}) => {
    const rawReferences = [
      ...(Array.isArray(body.activeEntityRefs) ? body.activeEntityRefs : []),
      ...(typeof body.activeEntityRefs === 'string' ? [body.activeEntityRefs] : []),
      ...(Array.isArray(body.entityRefs) ? body.entityRefs : []),
      ...(typeof body.entityRefs === 'string' ? [body.entityRefs] : []),
      ...(Array.isArray(body.refs) ? body.refs : []),
      ...(typeof body.refs === 'string' ? [body.refs] : []),
      ...(Array.isArray(body.entities) ? body.entities : []),
      ...(typeof body.entities === 'string' ? [body.entities] : []),
      ...(body.entities && !Array.isArray(body.entities) && typeof body.entities === 'object' ? [body.entities] : []),
      ...(body.entity && typeof body.entity === 'object' ? [body.entity] : []),
      ...(Array.isArray(body.relatedEntities) ? body.relatedEntities : []),
      ...(Array.isArray(body.relatedEntityIds) ? body.relatedEntityIds : []),
      ...(Array.isArray(body.compareEntityIds) ? body.compareEntityIds : []),
      ...(body.entityId || body.calaEntityId ? [body.entityId || body.calaEntityId] : [])
    ];
    const entitiesById = new Map();
    for (const reference of rawReferences) {
      if (entitiesById.size >= 20) break;
      const entity = await resolveEntityReference(reference);
      if (entity?.id && entity?.name) entitiesById.set(String(entity.id), entity);
    }

    if (entitiesById.size === 0) {
      const entityName = String(body.entityName || body.query || '').trim();
      if (entityName) {
        let entity = [...liveEntitiesById.values()].find((candidate) => isStrongEntityNameMatch(entityName, candidate.name)) || null;
        if (!entity) {
          const local = COMPANIES.find((company) => isStrongEntityNameMatch(entityName, company.name));
          if (local) entity = localCompanyAsEntity(local);
        }
        if (!entity) {
          try {
            const search = await calaClient.calaEntitySearch(entityName, 12, ['Company', 'Organization', 'Person']);
            const matched = pickBestCalaEntity(search.data?.entities || [], 'Company', entityName);
            if (matched) entity = await hydrateLiveEntity(matched.id);
          } catch {
            entity = null;
          }
        }
        if (entity?.id && entity?.name) entitiesById.set(String(entity.id), entity);
      }
    }

    const entities = [...entitiesById.values()];
    if (!entities.length) {
      const err = new Error('Entity mode requires at least one searchable Cala entity.');
      err.statusCode = 404;
      throw err;
    }
    rememberLiveEntities(entities);

    const rawPerspectiveRef =
      body.perspectiveEntity ||
      body.perspectiveEntityRef ||
      body.perspectiveEntityId ||
      body.perspectiveEntityName ||
      null;
    let perspectiveEntity = rawPerspectiveRef ? await resolveEntityReference(rawPerspectiveRef) : null;
    if (!perspectiveEntity && rawPerspectiveRef) {
      const pName =
        typeof rawPerspectiveRef === 'object'
          ? String(rawPerspectiveRef.name || rawPerspectiveRef.label || '').trim()
          : String(rawPerspectiveRef || '').trim();
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(pName);
      if (pName && !looksLikeUuid) {
        perspectiveEntity =
          [...liveEntitiesById.values()].find((candidate) => isStrongEntityNameMatch(pName, candidate?.name)) || null;
        if (!perspectiveEntity) {
          try {
            const pSearch = await calaClient.calaEntitySearch(pName, 10, ['Company', 'Organization', 'Person']);
            const matchedP = pickBestCalaEntity(pSearch.data?.entities || [], 'Organization', pName)
              || pickBestCalaEntity(pSearch.data?.entities || [], 'Company', pName);
            if (matchedP?.id) perspectiveEntity = await hydrateLiveEntity(matchedP.id);
          } catch {
            perspectiveEntity = null;
          }
        }
      }
    }
    if (perspectiveEntity?.id) rememberLiveEntities([perspectiveEntity]);

    // 2-hop enrichment: hydrate FundingRound / PrivateCompanyFundingRound nodes and
    // top Person / Company / Organization neighbors so co-investors, round issuers,
    // cross-company founders/executives, and perspective bridges resolve onto the map.
    const hydrationRoots = perspectiveEntity && !entities.some((e) => String(e.id) === String(perspectiveEntity.id))
      ? [...entities, perspectiveEntity]
      : entities;
    const hydratedNeighbors = await hydratePriorityNeighborsForMap(hydrationRoots, body);
    return {
      entities,
      anchor: entities[0],
      relatedEntities: entities.slice(1),
      perspectiveEntity: perspectiveEntity || null,
      primaryTargetId: body.primaryTargetId ? String(body.primaryTargetId) : null,
      hydratedNeighbors
    };
  };

  const STATIC_SKIP_RELS = new Set([
    'HAS_HEADQUARTERS_IN',
    'HAS_PRESENCE_IN',
    'IS_REGISTERED_IN',
    'OPERATES_IN_INDUSTRY',
    'HAS_NATIONALITY',
    'STUDIED_AT',
    'SPOKE_AT',
    'FEATURED_IN',
    'RECEIVED_AWARD',
    'PUBLISHED_BY',
    'DESIGNED_BY',
    'CREATED_BY',
    'MANUFACTURED_BY',
    'OPERATED_BY',
    'TRADED_ON',
    'LISTED_ON'
  ]);

  const ROUND_RELS = new Set([
    'PARTICIPATES_IN_FUNDING_ROUND',
    'HAS_FUNDING_ROUND',
    'PARTICIPATES_IN_CORPORATE_EVENT'
  ]);

  const PERSON_RELS = new Set([
    'FOUNDED',
    'IS_CEO_OF',
    'IS_CTO_OF',
    'IS_VICEPRESIDENT_OF',
    'IS_BOARD_MEMBER_OF',
    'IS_COO_OF',
    'IS_CFO_OF',
    'IS_CSO_OF',
    'IS_MEMBER_OF',
    'WORKS_AT'
  ]);

  const isFundingRoundCandidate = (target, rel) => {
    const tType = String(target?.entity_type || target?.entityType || '').toLowerCase();
    const tName = String(target?.name || '').toUpperCase();
    if (tType.includes('fundinground')) return true;
    if (rel === 'HAS_FUNDING_ROUND' || rel === 'PARTICIPATES_IN_FUNDING_ROUND') return true;
    if (rel === 'PARTICIPATES_IN_CORPORATE_EVENT' && tName.includes('FINANCING_RAISED')) return true;
    return false;
  };

  const hydratePriorityNeighborsForMap = async (focalEntities, body = {}) => {
    if (!focalEntities.length || body.skipNeighborHydration) return [];
    const focalIds = new Set(focalEntities.map((e) => String(e.id)));
    const mentionCountByKey = new Map();
    for (const focal of focalEntities) {
      const seenForFocal = new Set();
      for (const dir of ['outgoing', 'incoming']) {
        for (const [rel, list] of Object.entries(focal.relationships?.[dir] || {})) {
          if (STATIC_SKIP_RELS.has(rel)) continue;
          for (const t of list || []) {
            if (!t?.id || !t?.name || focalIds.has(String(t.id))) continue;
            const k = `${String(t.entity_type || '').toLowerCase()}:${normalizeEntityCoreName(t.name) || t.id}`;
            if (seenForFocal.has(k)) continue;
            seenForFocal.add(k);
            mentionCountByKey.set(k, (mentionCountByKey.get(k) || 0) + 1);
          }
        }
      }
    }

    const roundDateOf = (t) =>
      String(
        t?.properties?.event_date ||
        t?.properties?.close_date ||
        t?.properties?.valid_since ||
        t?.properties?.sources?.[0]?.date ||
        ''
      );

    const priorityQueue = [];
    const queuedIds = new Set();
    const enqueueCandidate = (target, tierScore) => {
      const tid = String(target?.id || '').trim();
      if (!tid || focalIds.has(tid) || queuedIds.has(tid)) return;
      queuedIds.add(tid);
      priorityQueue.push({ id: tid, score: tierScore });
    };

    for (const focal of focalEntities) {
      const roundCandidates = [];
      const personCandidates = [];
      const orgCandidates = [];

      for (const dir of ['outgoing', 'incoming']) {
        for (const [rel, list] of Object.entries(focal.relationships?.[dir] || {})) {
          if (STATIC_SKIP_RELS.has(rel)) continue;
          for (const t of list || []) {
            if (!t?.id || !t?.name || focalIds.has(String(t.id))) continue;
            const tType = String(t.entity_type || t.entityType || '');
            const k = `${tType.toLowerCase()}:${normalizeEntityCoreName(t.name) || t.id}`;
            const crossMentions = mentionCountByKey.get(k) || 1;

            if (isFundingRoundCandidate(t, rel)) {
              const dt = roundDateOf(t);
              const isPrivateRound = tType === 'PrivateCompanyFundingRound';
              roundCandidates.push({
                target: t,
                score: (isPrivateRound ? 200 : 140) + (crossMentions > 1 ? 50 : 0) + (dt ? Number(dt.replace(/\D/g, '').slice(0, 8)) / 1e8 : 0)
              });
            } else if (ROUND_RELS.has(rel)) {
              // Skip generic CorporateEvent blobs such as RESULTS_OR_TRADING_UPDATE / OTHER_MATERIAL_EVENT
              continue;
            } else if (tType === 'Person' || PERSON_RELS.has(rel)) {
              const rawName = String(t.name || '').trim();
              if (/^(?:mr|ms|mrs|dr)\.?\s+[a-z-]+$/i.test(rawName)) continue;
              const roleScore =
                rel === 'FOUNDED' ? 95 :
                rel === 'IS_CEO_OF' ? 92 :
                rel === 'IS_CTO_OF' || rel === 'IS_VICEPRESIDENT_OF' ? 88 :
                rel === 'IS_BOARD_MEMBER_OF' ? 82 :
                65;
              personCandidates.push({
                target: t,
                score: roleScore + (crossMentions > 1 ? 80 : 0)
              });
            } else if (tType === 'Company' || tType === 'Organization' || tType === 'Fund' || !tType) {
              const relBoost = rel === 'INVESTED_IN' ? 78 : rel === 'PARTNERED_WITH' ? 76 : rel === 'COMPETES_WITH' || rel === 'ACQUIRED' ? 74 : 62;
              orgCandidates.push({
                target: t,
                score: relBoost + (crossMentions > 1 ? 90 : 0)
              });
            }
          }
        }
      }

      roundCandidates.sort((a, b) => b.score - a.score).slice(0, 5).forEach((c) => enqueueCandidate(c.target, c.score));
      personCandidates.sort((a, b) => b.score - a.score).slice(0, 5).forEach((c) => enqueueCandidate(c.target, c.score));
      orgCandidates.sort((a, b) => b.score - a.score).slice(0, 3).forEach((c) => enqueueCandidate(c.target, c.score));
    }

    priorityQueue.sort((a, b) => b.score - a.score);
    const maxCandidates = Math.min(priorityQueue.length, Math.max(12, focalEntities.length * 10));
    const selectedIds = priorityQueue.slice(0, maxCandidates).map((item) => item.id);
    const budgetBefore = calaClient.getBudgetStatus?.() || { liveCallsUsed: 0, maxLiveCalls: 250 };
    const startLiveCalls = budgetBefore.liveCallsUsed || 0;
    const hydrated = [];

    for (let i = 0; i < selectedIds.length; i += 6) {
      const budgetNow = calaClient.getBudgetStatus?.() || { liveCallsUsed: 0, maxLiveCalls: 250 };
      const remaining = (budgetNow.maxLiveCalls ?? 250) - (budgetNow.liveCallsUsed ?? 0);
      const spentThisRequest = (budgetNow.liveCallsUsed ?? 0) - startLiveCalls;
      // Keep cached hydrations free (liveEntitiesById or disk cache), while capping
      // uncached live network expansion cleanly per request so budget stays healthy.
      const batch = selectedIds.slice(i, i + 6).filter((id) => {
        if (liveEntitiesById.get(id)?.relationships) return true;
        return remaining > 8 && spentThisRequest < 28;
      });
      if (!batch.length) continue;
      const settled = await Promise.allSettled(batch.map((id) => hydrateLiveEntity(id)));
      for (const res of settled) {
        if (res.status === 'fulfilled' && res.value?.id) {
          hydrated.push(res.value);
        }
      }
    }

    return hydrated;
  };

  const buildEntityDossier = (entity, activeEntities = []) => {
    const entityType = entity.entity_type || entity.entityType || 'Entity';
    if (entityType === 'Company' || entityType === 'Organization') {
      ingestLiveCalaEntities([entity], {
        allowOrganizations: true,
        allowGeneralCompanies: true,
        allowUnfundedLive: true
      });
    }
    const indexedCompany = COMPANIES.find((company) => company.calaEntityId === entity.id || normalizeEntityCoreName(company.name) === normalizeEntityCoreName(entity.name)) || null;
    const profile = summarizeLiveCalaEntity(entity);
    const relationshipGroups = normalizeRawRelationshipGroups(entity);
    const allRelations = [
      ...Object.entries(relationshipGroups.outgoing).flatMap(([relation, values]) => values.map((value) => ({ ...value, relation, direction: 'outgoing' }))),
      ...Object.entries(relationshipGroups.incoming).flatMap(([relation, values]) => values.map((value) => ({ ...value, relation, direction: 'incoming' })))
    ];
    const entityKey = (value = {}) => {
      if (value.id) return `id:${String(value.id)}`;
      const name = normalizeEntityCoreName(value.name || '');
      return name ? `name:${String(value.entityType || value.entity_type || 'Entity')}:${name}` : null;
    };
    const sameEntity = (a, b) => {
      const aKey = entityKey(a);
      const bKey = entityKey(b);
      return Boolean(aKey && bKey && aKey === bKey);
    };
    const bestSourceTier = (...tiers) => tiers
      .filter(Boolean)
      .sort((a, b) => (SOURCE_TIER_PRIORITY[b] || 0) - (SOURCE_TIER_PRIORITY[a] || 0))[0] || null;
    const mergeSources = (...sourceLists) => {
      const byKey = new Map();
      for (const source of sourceLists.flat().filter(Boolean)) {
        const key = source.id || source.url || source.document || source.name || source.source;
        if (key && !byKey.has(key)) byKey.set(key, source);
      }
      return [...byKey.values()].slice(0, 6);
    };
    const activeById = new Map((activeEntities || []).filter((item) => item?.id).map((item) => [String(item.id), item]));
    const activeByName = new Map((activeEntities || []).filter((item) => item?.name).map((item) => [normalizeEntityCoreName(item.name), item]));
    const verifiedConnections = [];
    const connectionKeys = new Set();
    const addConnection = (connection) => {
      const key = connection.connectionType === 'shared_bridge'
        ? `shared:${connection.entityId}:${connection.bridge?.id || normalizeEntityCoreName(connection.bridge?.name)}`
        : `direct:${connection.entityId}:${connection.relation}:${connection.direction}`;
      if (connectionKeys.has(key)) return;
      connectionKeys.add(key);
      verifiedConnections.push(connection);
    };

    // Direct joins are retained for compatibility, but every one is a literal
    // Cala relationship, never a comparison edge inferred by the client.
    for (const relation of allRelations) {
      const active = activeById.get(String(relation.id || '')) || activeByName.get(normalizeEntityCoreName(relation.name));
      if (!active || sameEntity(active, entity)) continue;
      addConnection({
        connectionType: 'direct',
        entityId: String(active.id),
        entityName: active.name,
        relation: relation.relation,
        direction: relation.direction,
        role: relation.role,
        eventDate: relation.eventDate,
        sourceId: relation.sourceId || null,
        sourceTier: relation.sourceTier || null,
        sources: relation.sources || [],
        pathEntityIds: [String(entity.id), String(active.id)],
        path: [
          { id: String(entity.id), name: entity.name, entityType },
          { id: String(active.id), name: active.name, entityType: active.entity_type || active.entityType || 'Entity' }
        ]
      });
    }

    // Shared bridge paths expose the two verified Cala edges which connect this
    // dossier subject to another active map entity.  A path is not promoted to
    // a direct centre edge, so disconnected entities remain disconnected.
    const ownRelationsByTarget = new Map();
    for (const relation of allRelations) {
      const key = entityKey(relation);
      if (!key || sameEntity(relation, entity)) continue;
      const list = ownRelationsByTarget.get(key) || [];
      list.push(relation);
      ownRelationsByTarget.set(key, list);
    }
    for (const active of activeEntities || []) {
      if (!active?.id || sameEntity(active, entity)) continue;
      const activeGroups = normalizeRawRelationshipGroups(active);
      const activeRelations = [
        ...Object.entries(activeGroups.outgoing).flatMap(([relation, values]) => values.map((value) => ({ ...value, relation, direction: 'outgoing' }))),
        ...Object.entries(activeGroups.incoming).flatMap(([relation, values]) => values.map((value) => ({ ...value, relation, direction: 'incoming' })))
      ];
      for (const activeRelation of activeRelations) {
        const ownMatches = ownRelationsByTarget.get(entityKey(activeRelation));
        if (!ownMatches?.length || sameEntity(activeRelation, active) || sameEntity(activeRelation, entity)) continue;
        for (const ownRelation of ownMatches) {
          const bridge = {
            id: ownRelation.id || activeRelation.id || null,
            name: ownRelation.name || activeRelation.name,
            entityType: ownRelation.entityType || activeRelation.entityType || 'Entity'
          };
          addConnection({
            connectionType: 'shared_bridge',
            entityId: String(active.id),
            entityName: active.name,
            relation: `${ownRelation.relation} / ${activeRelation.relation}`,
            direction: `${ownRelation.direction} / ${activeRelation.direction}`,
            role: ownRelation.role || activeRelation.role || null,
            eventDate: ownRelation.eventDate || activeRelation.eventDate || null,
            sourceId: ownRelation.sourceId || activeRelation.sourceId || null,
            sourceTier: bestSourceTier(ownRelation.sourceTier, activeRelation.sourceTier),
            sources: mergeSources(ownRelation.sources || [], activeRelation.sources || []),
            bridge,
            pathEntityIds: [String(entity.id), String(bridge.id || bridge.name), String(active.id)],
            path: [
              { id: String(entity.id), name: entity.name, entityType },
              bridge,
              { id: String(active.id), name: active.name, entityType: active.entity_type || active.entityType || 'Entity' }
            ],
            relationships: [
              { relation: ownRelation.relation, direction: ownRelation.direction },
              { relation: activeRelation.relation, direction: activeRelation.direction }
            ]
          });
        }
      }
    }
    const investorRelations = allRelations.filter((relation) => relation.relation === 'INVESTED_IN');
    const portfolio = relationshipGroups.outgoing.INVESTED_IN || [];
    const peopleByKey = new Map();
    const addPerson = (person) => {
      if (!person?.name) return;
      // The hydrated Cala person id is not always repeated in the indexed
      // relationship coverage, so use the evidenced display identity to merge
      // the two representations rather than emitting duplicate people rows.
      const key = `${normalizeEntityCoreName(person.name)}:${person.relation || 'WORKS_AT'}`;
      const previous = peopleByKey.get(key) || {};
      const merged = { ...previous };
      for (const [field, value] of Object.entries(person)) {
        if (value !== null && value !== undefined && value !== '') merged[field] = value;
      }
      merged.sources = mergeSources(previous.sources || [], person.sources || []);
      peopleByKey.set(key, merged);
    };
    for (const person of [...(profile.leadership || []), ...(profile.worksAt || [])]) {
      addPerson({
        id: person.id || null,
        name: person.name,
        relation: person.relation || 'WORKS_AT',
        role: person.role || null,
        validSince: person.validSince || null,
        validUntil: person.validUntil || null,
        // Only relationship-backed previous employers are retained here.
        priorCompany: person.priorCompany || null,
        priorRole: person.priorRole || null,
        priorValidUntil: person.priorValidUntil || null,
        sourceRank: person.sourceRank || null,
        sourceId: person.sourceId || null,
        sources: person.sources || []
      });
    }
    for (const role of indexedCompany?.peopleCoverage?.roles || []) {
      addPerson({
        id: role.personId || null,
        name: role.name,
        relation: role.relation || 'WORKS_AT',
        role: role.role || null,
        validSince: role.validSince || role.startDate || null,
        validUntil: role.validUntil || role.endDate || null,
        // Engine ingestion derives this only from a Cala person/company edge;
        // no title/name fallback is used by the dossier.
        priorCompany: role.priorCompany || null,
        priorRole: role.priorRole || null,
        priorValidUntil: role.priorValidUntil || null,
        sourceRank: role.sourceRank || null,
        sourceId: role.sourceId || null,
        sources: resolveSources(role.sourceId ? [role.sourceId] : [])
      });
    }
    const people = [...peopleByKey.values()];
    const employeeCountSeries = indexedCompany?.employeeCountSeries || [];
    const financialMetrics = indexedCompany?.financialMetrics || [];
    const corporateEvents = (indexedCompany?.corporateEvents?.length ? indexedCompany.corporateEvents : profile.corporateEvents) || [];
    const hydratedRoundsFromGraph = [
      ...(relationshipGroups.outgoing.HAS_FUNDING_ROUND || []),
      ...(relationshipGroups.incoming.PARTICIPATES_IN_FUNDING_ROUND || []),
      ...(relationshipGroups.outgoing.RAISED || [])
    ].map((rel) => {
      const roundNode = liveEntitiesById.get(String(rel.id || '')) || null;
      const roundName = roundNode?.name || rel.name || rel.roundType || rel.type || 'Funding Round';
      const roundMeta = roundNode?.relationships ? normalizeRawRelationshipGroups(roundNode) : null;
      const roundInvestors = roundMeta
        ? [
            ...(roundMeta.incoming.PARTICIPATES_IN_FUNDING_ROUND || []),
            ...(roundMeta.incoming.INVESTED_IN || []),
            ...(roundMeta.incoming.LED_ROUND || [])
          ]
            .filter((p) => (p.entityType || p.entity_type || '').toLowerCase() !== 'company')
            .map((p) => ({ id: p.id || null, name: p.name, entityType: p.entityType || p.entity_type || 'Organization' }))
        : [];
      return {
        id: rel.id || roundNode?.id || null,
        type: roundName,
        roundType: roundName,
        date: rel.eventDate || rel.date || roundNode?.date || roundNode?.foundingDate || null,
        amount: rel.amount ?? roundNode?.amount ?? null,
        amountEurM: rel.amountEurM ?? null,
        currency: rel.currency || null,
        investors: roundInvestors,
        investorNames: roundInvestors.map((i) => i.name),
        sources: mergeSources(rel.sources || [], roundNode?.sources || [])
      };
    });
    const indexedRoundList = (indexedCompany?.rounds || []).map((round) => ({
      id: round.id,
      type: round.type,
      date: round.date || null,
      amountEurM: round.amountEurM ?? null,
      investorNames: round.investorNames || (round.investorIds || []).map((id) => indexedCompany.liveInvestorsMap?.[id] || PEER_INVESTORS[id] || id),
      sources: resolveSources(round.sourceIds || [])
    }));
    const profileRounds = [...(profile.issuerRounds || []), ...(profile.raisedRounds || [])];
    const rounds = indexedRoundList.length
      ? indexedRoundList
      : profileRounds.length
        ? profileRounds
        : hydratedRoundsFromGraph;
    const gaps = [
      !profile.description ? { field: 'Description', status: 'Not found in Cala' } : null,
      !profile.address ? { field: 'Headquarters address', status: 'Not found in Cala' } : null,
      !hasKnownNumericValue(indexedCompany?.employeeCount) && !employeeCountSeries.length && !profile.employeeCountRange
        ? { field: 'Employee count', status: 'Not found in Cala' }
        : null,
      !rounds.length ? { field: 'Funding rounds', status: 'Not found in Cala' } : null,
      !people.length ? { field: 'Leadership and people', status: 'Not found in Cala' } : null,
      !allRelations.length ? { field: 'Verified relationships', status: 'Not found in Cala' } : null
    ].filter(Boolean);

    return {
      ref: `${entityType}:${entity.id}`,
      identity: {
        id: entity.id,
        calaEntityId: entity.id,
        entityType,
        name: entity.name,
        legalName: profile.legalName,
        description: profile.description || 'Not found in Cala',
        website: profile.website || 'Not found in Cala',
        address: profile.address || 'Not found in Cala',
        operationalStatus: profile.operationalStatus || 'Not found in Cala',
        ownershipStatus: profile.ownershipStatus || 'Not found in Cala',
        fundingStage: profile.fundingStage || null,
        totalFunding: profile.totalFunding ?? null,
        totalFundingUnits: profile.totalFundingUnits || null,
        foundingDate: profile.foundingDate || indexedCompany?.foundingDate || null,
        employeeCount: hasKnownNumericValue(indexedCompany?.employeeCount) ? Number(indexedCompany.employeeCount) : null,
        employeeCountRange: profile.employeeCountRange || null
      },
      people,
      rounds,
      investors: investorRelations,
      portfolio,
      relationships: relationshipGroups,
      employeeCountSeries,
      financialMetrics,
      corporateEvents,
      sources: collectDossierSources(entity, indexedCompany),
      gaps,
      verifiedConnections,
      profile
    };
  };

  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      if (req.method === 'GET' && pathname === '/api/bootstrap') {
        sendJson(res, 200, {
          referenceDate: REFERENCE_DATE,
          funds: FUNDS.map((f) => ({
            id: f.id,
            calaEntityId: f.calaEntityId,
            name: f.name,
            hqCity: f.hqCity,
            country: f.country,
            region: f.region,
            teamSize: f.teamSize,
            statedThesis: f.statedThesis
          })),
          companies: COMPANIES.map((c) => ({
            id: c.id,
            name: c.name,
            sector: c.sector,
            country: c.country,
            region: c.region,
            latestStage:
              c.rounds[c.rounds.length - 1]?.type ||
              (c.entityCategory === 'established_corp' ? 'Public / Mature' : 'Registered (Unfunded)')
          })),
          coverageStats: {
            fundsIndexed: FUNDS.length,
            companiesIndexed: COMPANIES.length,
            roundsIndexed: COMPANIES.reduce((s, c) => s + c.rounds.length, 0),
            sourcesIndexed: Object.keys(SOURCES).length,
            companiesHouseIndexed: COMPANIES.filter((c) => Boolean(c.companiesHouseNumber)).length,
            registryEntitiesIndexed: COMPANIES.filter((c) => Boolean(c.isRegistryDiscovered)).length,
            timeSeriesPointsIndexed: COMPANIES.reduce((s, c) => s + (c.employeeCountSeries?.length || 0), 0),
            liveCalaConfigured: Boolean(process.env.CALA_API_KEY),
            anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY),
            calaBudget: calaClient.getBudgetStatus(),
            registryStatus: registryClient.getStatus()
          }
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/cala-budget') {
        sendJson(res, 200, calaClient.getBudgetStatus());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/entity-dossier') {
        const ref = reqUrl.searchParams.get('ref') || '';
        const entity = await resolveEntityReference(ref);
        if (!entity) {
          sendJson(res, 404, { error: 'Entity reference was not found in Cala.' });
          return;
        }
        const mapReferenceValues = [
          ...reqUrl.searchParams.getAll('activeRef'),
          ...String(reqUrl.searchParams.get('mapEntityIds') || '').split(',').map((value) => value.trim()).filter(Boolean),
          ...String(reqUrl.searchParams.get('activeEntityRefs') || '').split(',').map((value) => value.trim()).filter(Boolean)
        ];
        const mapEntitiesRaw = reqUrl.searchParams.get('mapEntities');
        if (mapEntitiesRaw) {
          try {
            const parsed = JSON.parse(mapEntitiesRaw);
            if (Array.isArray(parsed)) mapReferenceValues.push(...parsed);
          } catch {
            // A malformed optional map context should not prevent the dossier.
          }
        }
        const activeEntities = [];
        const seenActiveIds = new Set();
        for (const rawReference of mapReferenceValues) {
          const active = await resolveEntityReference(rawReference);
          if (!active?.id || seenActiveIds.has(String(active.id))) continue;
          seenActiveIds.add(String(active.id));
          activeEntities.push(active);
        }
        if (!seenActiveIds.has(String(entity.id))) activeEntities.push(entity);
        const dossier = buildEntityDossier(entity, activeEntities);
        sendJson(res, 200, {
          ...dossier,
          calaBudget: calaClient.getBudgetStatus()
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/cala-verify') {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim();
        const type = body.type === 'company' ? 'company' : body.type === 'event' ? 'event' : 'fund';
        const includeKnowledgeSearch = Boolean(body.includeKnowledgeSearch);
        if (!name) {
          sendJson(res, 400, { error: 'Missing required field: name.' });
          return;
        }

        const searchTypes = type === 'event' ? ['Event'] : [];
        const searchRes = await calaClient.calaEntitySearch(name, 5, searchTypes);
        const candidates = searchRes.data?.entities || [];
        const preferredType = type === 'event' ? 'Event' : type === 'fund' ? 'Organization' : 'Company';
        const matched = pickBestCalaEntity(candidates, preferredType, name);

        let introRes = null;
        let entityRes = null;
        let liveSummary = null;
        let knowledgeRes = null;

        if (matched) {
          const retrieved = await retrieveEntityWithIntrospection(calaClient, matched.id, type === 'event' ? 100 : 20);
          introRes = retrieved.introRes;
          entityRes = retrieved.entityRes;
          liveSummary = summarizeLiveCalaEntity(entityRes.data);
        }

        if (includeKnowledgeSearch) {
          const prompt =
            type === 'fund'
              ? `What companies and funding rounds has ${name} invested in recently?`
              : `What is the complete funding history, round dates, amounts, and investors of ${name}?`;
          knowledgeRes = await calaClient.calaKnowledgeSearch(prompt);
        }

        const verifyPool = [
          ...(entityRes?.data?.entity_type === 'Company' ? [entityRes.data] : []),
          ...(entityRes?.data?.relationships?.incoming?.PARTICIPATES_IN_EVENT || []),
          ...(knowledgeRes?.data?.entities || [])
        ].filter(Boolean);
        const verifyIng = ingestLiveCalaEntities(verifyPool, {
          slush2026: type === 'event' || /slush/i.test(name),
          allowGeneralCompanies: type === 'company'
        });
        const fundMatch = FUNDS.find((f) => f.name.toLowerCase() === String(entityRes?.data?.name || name || '').toLowerCase());
        const invPool = entityRes?.data?.relationships?.outgoing?.INVESTED_IN || [];
        const invIng = invPool.length
          ? ingestLiveCalaEntities(invPool, fundMatch ? { investorId: fundMatch.id } : {})
          : { ingestedCount: 0, enrichedCount: 0 };
        if (verifyIng.ingestedCount > 0 || verifyIng.enrichedCount > 0 || invIng.ingestedCount > 0 || invIng.enrichedCount > 0) {
          analysisCache.clear();
        }

        const anyLiveCall =
          !searchRes.fromCache ||
          (introRes && !introRes.fromCache) ||
          (entityRes && !entityRes.fromCache) ||
          (knowledgeRes && !knowledgeRes.fromCache);

        sendJson(res, 200, {
          queryName: name,
          type,
          fromCache: !anyLiveCall,
          matchedEntity: matched,
          candidateEntities: candidates,
          introspection: introRes?.data || null,
          liveSummary,
          knowledgeAnswer: knowledgeRes?.data || null,
          budget: calaClient.getBudgetStatus()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/search') {
        const q = reqUrl.searchParams.get('q') || '';
        const localResults = searchEntities(q);
        const shouldDiscoverLive = ['1', 'true', 'yes'].includes(String(reqUrl.searchParams.get('live') || '').toLowerCase());
        if (!shouldDiscoverLive || !String(q).trim()) {
          sendJson(res, 200, { ...localResults, entities: [] });
          return;
        }

        let discovery = null;
        try {
          discovery = await discoverStartupsFromCala(calaClient, {
            queryText: q,
            mode: 'query',
            cachedEntities: [...liveEntitiesById.values()],
            includeCachedPrefixMatches: true
          });
          rememberLiveEntities(discovery.entities || []);
          if (discovery.discoveredCount > 0 || discovery.enrichedCount > 0) analysisCache.clear();
        } catch {
          discovery = { entities: [], discoveredCount: 0, enrichedCount: 0, hydratedEntityCount: 0 };
        }

        const liveEntities = (discovery.entities || []).map(toLiveSearchEntity).filter(Boolean);
        const knownCompanyIds = new Set((localResults.companies || []).map((company) => String(company.calaEntityId || company.id)));
        const mergedCompanies = [
          ...(localResults.companies || []),
          ...liveEntities
            .filter((entity) => ['Company', 'Organization'].includes(entity.entityType) && !knownCompanyIds.has(String(entity.calaEntityId)))
            .map((entity) => ({
              id: entity.id,
              calaEntityId: entity.calaEntityId,
              name: entity.name,
              sector: entity.sector || 'Not found in Cala',
              country: entity.country || 'Not found in Cala',
              entityType: entity.entityType,
              entityCategory: entity.entityCategory,
              isLiveCalaDiscovered: true
            }))
        ];
        sendJson(res, 200, {
          ...localResults,
          companies: mergedCompanies,
          entities: liveEntities,
          liveEntities,
          live: {
            requested: true,
            discoveredCount: discovery.discoveredCount || 0,
            enrichedCount: discovery.enrichedCount || 0,
            hydratedEntityCount: discovery.hydratedEntityCount || 0
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/analyze') {
        const body = await readJsonBody(req);
        if (body.mode === 'entity') {
          const {
            entities,
            anchor,
            relatedEntities,
            perspectiveEntity,
            primaryTargetId,
            hydratedNeighbors
          } = await resolveEntityMapRequest(body);
          const result = runFullAnalysis(
            {
              mode: 'entity',
              entities,
              entity: anchor,
              relatedEntities: [...relatedEntities, ...(hydratedNeighbors || [])],
              perspectiveEntity,
              primaryTargetId,
              referenceDate: body.referenceDate || null
            },
            { hideMegaHubs: body.hideMegaHubs, expandAllEntities: Boolean(body.expandAllEntities) }
          );
          const { allRanked, ...publicPayload } = result;
          sendJson(res, 200, {
            ...publicPayload,
            analysisMode: publicPayload.bridgeMap?.analysisMode || null,
            perspectiveEntity: publicPayload.bridgeMap?.perspectiveEntity || null,
            entityProfile: summarizeLiveCalaEntity(anchor),
            focalEntities: entities.map(toLiveSearchEntity).filter(Boolean),
            comparedEntities: relatedEntities.map(toLiveSearchEntity).filter(Boolean),
            calaBudget: calaClient.getBudgetStatus()
          });
          return;
        }
        const result = getCachedAnalysis(body);
        const { allRanked, ...publicPayload } = result;
        sendJson(res, 200, {
          ...publicPayload,
          calaBudget: calaClient.getBudgetStatus()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/brief') {
        const startupId = reqUrl.searchParams.get('startupId');
        const fundId = reqUrl.searchParams.get('fundId');
        const narrate = reqUrl.searchParams.get('narrate');
        if (!startupId) {
          sendJson(res, 400, { error: 'Missing required query parameter: startupId.' });
          return;
        }
        const brief = buildStartupBrief(startupId, fundId);
        if (narrate === '1' || narrate === 'true') {
          const narrative = await narrateBriefWithCitationGate(brief);
          sendJson(res, 200, { ...brief, narrative });
          return;
        }
        sendJson(res, 200, brief);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/connection-insight') {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || (!body.title && !Array.isArray(body.facts))) {
          sendJson(res, 400, { error: 'Invalid connection insight packet.' });
          return;
        }
        const insight = await analyzeConnectionWithCitationGate(body);
        sendJson(res, 200, {
          ...insight,
          anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/cala-discover') {
        const body = await readJsonBody(req);
        const discovery = await discoverStartupsFromCala(calaClient, {
          queryText: body.queryText || '',
          fundId: body.fundId,
          mode: body.mode || 'ecosystem'
        });
        if (discovery.discoveredCount > 0 || discovery.enrichedCount > 0) {
          analysisCache.clear();
        }
        const analysis = getCachedAnalysis(body);
        const { allRanked, ...publicPayload } = analysis;
        const hideMegaHubs = body.hideMegaHubs !== undefined ? Boolean(body.hideMegaHubs) : true;
        const bridgeFamily = body.bridgeFamily || 'all';
        const contributionGroup = body.contributionGroup || 'all';
        const refined = body.queryText
          ? refineShortlist(analysis.thesis, allRanked, {
              region: body.region,
              stageFilter: body.stageFilter,
              excludeSector: body.excludeSector,
              raisingSoonOnly: body.raisingSoonOnly,
              untappedOnly: body.untappedOnly,
              highVelocityOnly: body.highVelocityOnly,
              feederOnly: body.feederOnly,
              filingOnly: body.filingOnly,
              alumniOnly: body.alumniOnly,
              bridgeFamily,
              contributionGroup,
              hideMegaHubs,
              entityScope: body.entityScope,
              sectors: body.sectors,
              countries: body.countries,
              maxEmployees: body.maxEmployees,
              slush2026Only: body.slush2026Only,
              preferWarm: body.preferWarm,
              queryText: body.queryText
            })
          : null;

        sendJson(res, 200, {
          ...publicPayload,
          shortlist: refined ? refined.shortlist : publicPayload.shortlist,
          bridgeMap: refined ? refined.bridgeMap : publicPayload.bridgeMap,
          relaxSuggestions: refined ? refined.relaxSuggestions : [],
          discoveredCount: discovery.discoveredCount,
          enrichedCount: discovery.enrichedCount,
          knowledgeAnswer: discovery.knowledgeAnswer,
          totalCompaniesIndexed: COMPANIES.length,
          calaBudget: calaClient.getBudgetStatus()
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/discover-registries') {
        const body = await readJsonBody(req);
        const regRes = await registryClient.discoverFromRegistries({
          queryText: body.queryText || '',
          companyQuery: body.companyQuery || '',
          country: body.country || '',
          sectors: Array.isArray(body.sectors) ? body.sectors : [],
          mode: body.mode || (body.queryText || body.companyQuery ? 'query' : 'sync_recent_startups'),
          maxResults: body.maxResults || 12
        });
        const ing = ingestRegistryEntities(regRes.companies);
        if (ing.ingestedCount > 0 || ing.enrichedCount > 0) {
          analysisCache.clear();
        }
        sendJson(res, 200, {
          ...regRes,
          ingestedCount: ing.ingestedCount,
          enrichedCount: ing.enrichedCount,
          totalCompaniesIndexed: COMPANIES.length,
          registryStatus: registryClient.getStatus(),
          calaBudget: calaClient.getBudgetStatus()
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/refine') {
        const body = await readJsonBody(req);
        let liveDiscoveredCount = 0;
        let knowledgeAnswer = null;
        let discovery = null;
        if (body.discoverLive === true && body.queryText && !/^\s*why not\s+/i.test(String(body.queryText))) {
          try {
            discovery = await discoverStartupsFromCala(calaClient, {
              queryText: body.queryText,
              fundId: body.fundId,
              mode: 'query'
            });
            liveDiscoveredCount = discovery.discoveredCount;
            knowledgeAnswer = discovery.knowledgeAnswer;
          } catch {
            // Non-fatal in offline/test environments
          }
        }
        const compiled = body.queryText
          ? await compileSearchQuery(body.queryText, {
              fundId: body.fundId,
              knownInvestors: Object.values(PEER_INVESTORS)
            })
          : { controlPlaneMode: 'deterministic-parser', filters: null, fromCache: false };
        const cf = compiled.filters || {};
        let effectiveEntityScope =
          body.entityScope === 'all' || cf.entityScope === 'all' ? 'all' : 'startups';
        let effectiveCompanyQuery = body.companyQuery || cf.companyQuery || null;
        if (!effectiveCompanyQuery && body.queryText && !cf.sectors?.length && !cf.investorQuery) {
          const fallbackTerm = extractRegistryLookupTerm(body.queryText);
          if (
            fallbackTerm.length >= 2 &&
            fallbackTerm.split(/\s+/).length <= 3 &&
            !/\b(slush|raising|untapped|founders|startups?|seed|series|nordics|dach|fintech|deeptech|healthtech|climate|saas)\b/i.test(fallbackTerm)
          ) {
            effectiveCompanyQuery = fallbackTerm;
          } else if (discovery?.matchedPersons?.length > 0) {
            effectiveCompanyQuery = discovery.matchedPersons[0];
          } else if (discovery?.matchedOrganizations?.length > 0 && discovery?.linkedCompanyNames?.length > 0) {
            effectiveCompanyQuery = discovery.matchedOrganizations[0];
          }
        }
        const queryMentionsCountryHint =
          cf.countryHint &&
          new RegExp(`\\b${cf.countryHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(body.queryText || ''));
        const effectiveCountries =
          Array.isArray(body.countries) && body.countries.length
            ? body.countries
            : cf.countryHint && (!discovery?.linkedCompanyNames?.length || queryMentionsCountryHint)
              ? [cf.countryHint]
              : undefined;
        const liveIncludeCompanyNames = [
          ...new Set([
            ...(effectiveCompanyQuery ? [effectiveCompanyQuery] : []),
            ...(discovery?.matchedCompanyNames || []),
            ...(discovery?.linkedCompanyNames || [])
          ])
        ];

        const refinementPayload = {
          entityScope: effectiveEntityScope,
          intent: body.intent || cf.intent,
          region: body.region && body.region !== 'all' ? body.region : (cf.region || body.region),
          stageFilter:
            body.stageFilter && body.stageFilter !== 'all' ? body.stageFilter : (cf.stageFilter || body.stageFilter),
          excludeSector:
            body.excludeSector && body.excludeSector !== 'none'
              ? body.excludeSector
              : (cf.excludeSector || body.excludeSector),
          raisingSoonOnly: Boolean(body.raisingSoonOnly || cf.raisingSoonOnly),
          untappedOnly: Boolean(body.untappedOnly || cf.untappedOnly),
          highVelocityOnly: body.highVelocityOnly,
          feederOnly: body.feederOnly,
          filingOnly: body.filingOnly,
          hideMegaHubs: body.hideMegaHubs !== undefined ? Boolean(body.hideMegaHubs) : true,
          bridgeFamily: body.bridgeFamily || 'all',
          contributionGroup: body.contributionGroup || 'all',
          alumniOnly: Boolean(body.alumniOnly || body.requireAlumniFounder || cf.requireAlumniFounder),
          requireAlumniFounder: Boolean(body.requireAlumniFounder || body.alumniOnly || cf.requireAlumniFounder),
          minHeadcountGrowthPct: body.minHeadcountGrowthPct ?? cf.minHeadcountGrowthPct,
          investorQuery: body.investorQuery || cf.investorQuery,
          companyQuery: effectiveCompanyQuery,
          linkedCompanyNames: discovery?.linkedCompanyNames || [],
          whyNotCompany: body.whyNotCompany || cf.whyNotCompany,
          expandedKeywords:
            Array.isArray(cf.expandedKeywords) && cf.expandedKeywords.length
              ? cf.expandedKeywords
              : body.expandedKeywords,
          sectors:
            compiled.controlPlaneMode === 'anthropic-query-compiler'
              ? cf.sectors || []
              : Array.isArray(body.sectors) && body.sectors.length
                ? body.sectors
                : cf.sectors,
          countries: effectiveCountries,
          maxEmployees: body.maxEmployees,
          slush2026Only: Boolean(body.slush2026Only || cf.slushOnly),
          preferWarm: body.preferWarm,
          limit: body.limit,
          queryText: body.queryText
        };

        let analysis = getCachedAnalysis({
          ...body,
          entityScope: effectiveEntityScope,
          includeCompanyNames: liveIncludeCompanyNames
        });
        let refined = refineShortlist(analysis.thesis, analysis.allRanked, refinementPayload);

        let registryDiscovery = null;
        const isWhyNot = refined.searchIntent === 'why_not' || /^\s*why not\s+/i.test(String(body.queryText || ''));
        const exactMatchesCount = refined.usedSoftFallback ? 0 : refined.totalMatches;
        const hasExactCompanyInIndex =
          effectiveCompanyQuery && COMPANIES.some((c) => isStrongEntityNameMatch(effectiveCompanyQuery, c.name));
        const hasPersonOrLinkedMatch = Boolean(discovery?.linkedCompanyNames?.length > 0 && exactMatchesCount > 0);
        const shouldDiscoverRegistries =
          !isWhyNot &&
          body.discoverRegistries !== false &&
          Boolean(String(body.queryText || '').trim()) &&
          !hasPersonOrLinkedMatch &&
          (exactMatchesCount === 0 ||
            Boolean(effectiveCompanyQuery && !hasExactCompanyInIndex) ||
            (effectiveEntityScope === 'all' && !hasExactCompanyInIndex));

        if (shouldDiscoverRegistries) {
          try {
            const regRes = await registryClient.discoverFromRegistries({
              queryText: body.queryText,
              companyQuery: effectiveCompanyQuery || '',
              country: cf.countryHint || (effectiveCountries?.[0] || ''),
              sectors: refinementPayload.sectors || [],
              mode: 'query',
              maxResults: 10
            });
            const regIng = ingestRegistryEntities(regRes.companies);
            if (regRes.companies.some((c) => c.entityCategory === 'established_corp')) {
              effectiveEntityScope = 'all';
              refinementPayload.entityScope = 'all';
            }
            if (regIng.ingestedCount > 0 || regIng.enrichedCount > 0 || effectiveEntityScope === 'all') {
              analysisCache.clear();
              const includeNames = [
                ...liveIncludeCompanyNames,
                ...regRes.companies.map((c) => c.name)
              ];
              analysis = getCachedAnalysis({
                ...body,
                entityScope: effectiveEntityScope,
                includeCompanyNames: includeNames
              });
              refined = refineShortlist(analysis.thesis, analysis.allRanked, refinementPayload);
            }
            registryDiscovery = {
              triggered: true,
              discoveredCount: regRes.companies.length,
              ingestedCount: regIng.ingestedCount,
              enrichedCount: regIng.enrichedCount,
              sourcesUsed: regRes.sourcesUsed,
              cacheHits: regRes.cacheHits,
              errors: regRes.errors
            };
            if (regRes.companies.length > 0) {
              refined.aiTrace.unshift(
                `Official Registries (${regRes.sourcesUsed.join(' + ') || 'PRH/GLEIF'}): fetched ${regRes.companies.length} corporate records (${regIng.ingestedCount} new)`
              );
            }
          } catch {
            // Non-fatal in offline/timeout environments
          }
        }

        if (discovery && (discovery.hydratedEntityCount > 0 || discovery.linkedCompanyNames.length > 0)) {
          refined.aiTrace.unshift(
            `Live Cala Graph: hydrated ${discovery.hydratedEntityCount} entities across Companies/Orgs/People (${discovery.discoveredCount} new, ${discovery.enrichedCount} enriched${discovery.matchedPersons.length ? `; Person bridges: ${discovery.matchedPersons.join(', ')}` : ''})`
          );
        }

        sendJson(res, 200, {
          ...refined,
          entityScope: effectiveEntityScope,
          controlPlaneMode: compiled.controlPlaneMode,
          compiledQuery: compiled.filters,
          liveDiscoveredCount,
          liveDiscovery: discovery
            ? {
                discoveredCount: discovery.discoveredCount,
                enrichedCount: discovery.enrichedCount,
                hydratedEntityCount: discovery.hydratedEntityCount,
                matchedPersons: discovery.matchedPersons,
                matchedOrganizations: discovery.matchedOrganizations,
                matchedCompanyNames: discovery.matchedCompanyNames,
                linkedCompanyNames: discovery.linkedCompanyNames
              }
            : null,
          knowledgeAnswer,
          registryDiscovery,
          totalCompaniesIndexed: COMPANIES.length,
          registryStatus: registryClient.getStatus(),
          calaBudget: calaClient.getBudgetStatus()
        });
        return;
      }

      if (req.method === 'GET') {
        await serveStatic(res, pathname);
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed.' });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message || 'Internal server error.' });
    }
  });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isEntrypoint) {
  hydrateEntitiesFromDiskCache();
  const port = Number(process.env.PORT) || 4173;
  const server = createAppServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Revealed Thesis Engine listening on port ${port}`);
  });
}
