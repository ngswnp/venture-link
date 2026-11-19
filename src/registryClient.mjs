import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_PATH = path.resolve(process.cwd(), '.cache', 'registry-cache.json');
const PRH_V3_BASE = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';
const GLEIF_BASE = 'https://api.gleif.org/api/v1/lei-records';
const UK_CH_BASE = 'https://api.company-information.service.gov.uk';
const DEFAULT_TIMEOUT_MS = 4500;

const COUNTRY_NAME_BY_ISO2 = {
  FI: { country: 'Finland', region: 'Nordics' },
  SE: { country: 'Sweden', region: 'Nordics' },
  NO: { country: 'Norway', region: 'Nordics' },
  DK: { country: 'Denmark', region: 'Nordics' },
  EE: { country: 'Estonia', region: 'Nordics' },
  GB: { country: 'United Kingdom', region: 'UK' },
  UK: { country: 'United Kingdom', region: 'UK' },
  DE: { country: 'Germany', region: 'DACH' },
  CH: { country: 'Switzerland', region: 'DACH' },
  AT: { country: 'Austria', region: 'DACH' },
  FR: { country: 'France', region: 'Western Europe' },
  NL: { country: 'Netherlands', region: 'Western Europe' },
  BE: { country: 'Belgium', region: 'Western Europe' },
  IE: { country: 'Ireland', region: 'Western Europe' },
  ES: { country: 'Spain', region: 'Western Europe' },
  US: { country: 'United States', region: 'Global' },
  CA: { country: 'Canada', region: 'Global' },
  SG: { country: 'Singapore', region: 'Global' },
  AU: { country: 'Australia', region: 'Global' },
  JP: { country: 'Japan', region: 'Global' }
};

function makeCacheKey(provider, params) {
  return `${provider}:${JSON.stringify(params)}`;
}

/**
 * Infers primary sector deterministically from TOL/SIC code and company description.
 */
export function inferRegistrySector(code = '', description = '', name = '') {
  const codeStr = String(code || '').trim();
  const hay = `${codeStr} ${description} ${name}`.toLowerCase();

  if (/^(62|63)/.test(codeStr) || /\b(ai\b|artificial intelligence|machine learning|llm|neural|software|saas|cloud|data platform)\b/.test(hay)) {
    return /\b(ai|ml|machine learning|neural|autonomous)\b/.test(hay) ? 'AI & ML' : 'B2B SaaS';
  }
  if (/^(72|26|303)/.test(codeStr) || /\b(quantum|photonics|robotics|semiconductor|hardware|space|satellite|biotech|deep\s*tech|materials)\b/.test(hay)) {
    return 'DeepTech';
  }
  if (/^(35|38|39)/.test(codeStr) || /\b(energy|solar|wind|battery|grid|carbon|climate|clean\s*tech|hydrogen|recycling)\b/.test(hay)) {
    return 'Climate Tech';
  }
  if (/^(64|65|66)/.test(codeStr) || /\b(fintech|payments|banking|treasury|lending|insurance|clearing|payroll)\b/.test(hay)) {
    return 'Fintech';
  }
  if (/^(21|86|87)/.test(codeStr) || /\b(health|medtech|clinical|hospital|pharma|diagnostics|therapeutics|medical)\b/.test(hay)) {
    return 'HealthTech';
  }
  if (/^(56|47|10|11)/.test(codeStr) || /\b(restaurant|food|chicken|burger|fast\s*food|beverage|retail|hospitality|store)\b/.test(hay)) {
    return 'Consumer & Food';
  }
  return 'Enterprise & Services';
}

function resolveCountryMeta(iso2, fallbackCity = '') {
  const code = String(iso2 || '').trim().toUpperCase();
  if (COUNTRY_NAME_BY_ISO2[code]) {
    return COUNTRY_NAME_BY_ISO2[code];
  }
  if (code) {
    return { country: code, region: 'Global' };
  }
  if (/helsinki|espoo|tampere|oulu|turku/i.test(fallbackCity)) {
    return { country: 'Finland', region: 'Nordics' };
  }
  return { country: 'Europe', region: 'Europe' };
}

function titleCaseCity(city) {
  const clean = String(city || '').trim();
  if (!clean) return 'Unknown Hub';
  if (clean === clean.toUpperCase() || clean === clean.toLowerCase()) {
    return clean
      .toLowerCase()
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return clean;
}

function classifyEntityCategory({ foundedYear, description, name, code }) {
  const yr = Number(foundedYear);
  const hay = `${description || ''} ${name || ''} ${code || ''}`.toLowerCase();
  const looksCorpOrNonTech =
    /\b(restaurant|holding|real estate|property|franchis|supermarket|retail|plc|corporation|inc\.|corp\.|limited partnership|pension|plan|barber|hairdresser|construction|transport|cleaning)\b/.test(
      hay
    ) ||
    /^(56|47|68|41|43|96)/.test(String(code || ''));
  if (Number.isFinite(yr) && yr < 2016) {
    return 'established_corp';
  }
  if (looksCorpOrNonTech) {
    return 'established_corp';
  }
  return 'startup';
}

async function fetchJsonWithTimeout(url, fetchFn, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutSignal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;
  const timer = setTimeout(() => controller.abort(new Error('Registry request timed out')), timeoutMs);
  let signal = controller.signal;
  if (timeoutSignal && typeof AbortSignal?.any === 'function') {
    signal = AbortSignal.any([controller.signal, timeoutSignal]);
  }
  try {
    const res = await fetchFn(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      const err = new Error(`Registry HTTP ${res.status} on ${url}`);
      err.statusCode = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes Finnish PRH / YTJ v3 records into canonical registry entity packets.
 */
export function normalizePrhCompanies(companies = [], maxResults = 12) {
  const out = [];
  for (const raw of companies || []) {
    if (out.length >= maxResults) break;
    const bizId = String(raw?.businessId?.value || '').trim();
    if (!bizId) continue;

    const names = Array.isArray(raw?.names) ? raw.names : [];
    const primaryName =
      names.find((n) => n?.type === '1' && !n?.endDate)?.name ||
      names.find((n) => n?.type === '1')?.name ||
      names[0]?.name;
    const cleanName = String(primaryName || '').trim();
    if (!cleanName) continue;

    const regDate = String(raw?.registrationDate || raw?.businessId?.registrationDate || '').slice(0, 10) || null;
    const foundedYear = regDate && /^\d{4}/.test(regDate) ? Number(regDate.slice(0, 4)) : null;

    const tolCode = String(raw?.mainBusinessLine?.type || '').trim();
    const descs = Array.isArray(raw?.mainBusinessLine?.descriptions) ? raw.mainBusinessLine.descriptions : [];
    const enDesc =
      descs.find((d) => d?.languageCode === '3')?.description ||
      descs.find((d) => d?.languageCode === '1')?.description ||
      descs[0]?.description ||
      '';

    const addrList = Array.isArray(raw?.addresses) ? raw.addresses : [];
    const addr = addrList.find((a) => a?.type === 1) || addrList[0] || {};
    const hqCity = titleCaseCity(addr?.city || addr?.postOffice || 'Helsinki');

    const forms = Array.isArray(raw?.companyForms) ? raw.companyForms : [];
    const legalForm =
      forms[0]?.descriptions?.find((d) => d?.languageCode === '3')?.description ||
      forms[0]?.descriptions?.[0]?.description ||
      'Limited company';

    const website = raw?.website?.url ? String(raw.website.url).trim() : null;
    const sector = inferRegistrySector(tolCode, enDesc, cleanName);
    const entityCategory = classifyEntityCategory({ foundedYear, description: enDesc, name: cleanName, code: tolCode });
    const slug = bizId.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const sourceId = `src-reg-prh-${slug}`;

    out.push({
      id: `reg-prh-${slug}`,
      name: cleanName,
      oneLiner: enDesc ? `${enDesc} (${legalForm}, registered in ${hqCity}, Finland).` : `${cleanName} registered with Finnish PRH (${hqCity}).`,
      description: `${cleanName} (${legalForm}, Business ID ${bizId}) registered in Finland${regDate ? ` on ${regDate}` : ''}.${enDesc ? ` Primary activity (TOL ${tolCode || 'N/A'}): ${enDesc}.` : ''}`,
      sector,
      subSectors: [tolCode ? `TOL ${tolCode}` : 'Finnish Trade Register', legalForm].filter(Boolean),
      country: 'Finland',
      region: 'Nordics',
      hqCity,
      foundedYear,
      foundingDate: regDate,
      website,
      entityCategory,
      registryInfo: {
        registryName: 'Finnish Trade Register (PRH / YTJ)',
        provider: 'prh_v3',
        registrationNumber: bizId,
        euId: raw?.euId?.value || null,
        legalForm,
        industryCode: tolCode || null,
        industryDescription: enDesc || null,
        status: raw?.tradeRegisterStatus === '1' || !raw?.endDate ? 'ACTIVE' : 'INACTIVE',
        registryUrl: `https://tietopalvelu.ytj.fi/yritys/${encodeURIComponent(bizId)}`
      },
      source: {
        id: sourceId,
        title: `Finnish Trade Register (PRH) #${bizId} — ${cleanName}`.replace(/\u2014/g, '-'),
        publisher: 'Finnish Patent and Registration Office (PRH)',
        url: `https://tietopalvelu.ytj.fi/yritys/${encodeURIComponent(bizId)}`,
        date: regDate || '2026-01-01',
        sourceRank: 'FILING',
        datePrecision: regDate ? 'day' : 'year',
        snippet: `${cleanName} statutory PRH/YTJ filing (${bizId})${enDesc ? `: ${enDesc}` : ''}.`
      }
    });
  }
  return out;
}

/**
 * Normalizes Global GLEIF LEI records into canonical registry entity packets.
 */
export function normalizeGleifRecords(records = [], maxResults = 8) {
  const out = [];
  const fundTrustRe = /\b(profit sharing|savings plan|retirement|pension fund|master trust)\b/i;
  const sorted = [...(records || [])].sort((a, b) => {
    const aName = String(a?.attributes?.entity?.legalName?.name || '');
    const bName = String(b?.attributes?.entity?.legalName?.name || '');
    const aPenalty = fundTrustRe.test(aName) ? 1 : 0;
    const bPenalty = fundTrustRe.test(bName) ? 1 : 0;
    return aPenalty - bPenalty;
  });

  for (const rec of sorted) {
    if (out.length >= maxResults) break;
    const lei = String(rec?.id || '').trim();
    const ent = rec?.attributes?.entity;
    const reg = rec?.attributes?.registration;
    if (!lei || !ent?.legalName?.name) continue;
    if (ent.status && ent.status !== 'ACTIVE') continue;

    const cleanName = String(ent.legalName.name).trim();
    const addr = ent.legalAddress || ent.headquartersAddress || {};
    const { country, region } = resolveCountryMeta(addr.country, addr.city);
    const hqCity = titleCaseCity(addr.city || country);
    const regDate = String(reg?.initialRegistrationDate || ent?.creationDate || '').slice(0, 10) || null;
    const foundedYear = regDate && /^\d{4}/.test(regDate) ? Number(regDate.slice(0, 4)) : null;
    const legalForm = ent?.legalForm?.other || ent?.category || 'Legal Entity';
    const sector = inferRegistrySector('', `${legalForm} ${cleanName}`, cleanName);
    const slug = lei.slice(-10).toLowerCase();
    const sourceId = `src-reg-gleif-${slug}`;

    out.push({
      id: `reg-gleif-${slug}`,
      name: cleanName,
      oneLiner: `${cleanName} (${country}, LEI ${lei.slice(0, 8)}...) verified in Global LEI Registry.`,
      description: `${cleanName} is an active legal entity registered in ${hqCity}, ${country} (Global LEI ${lei}, category: ${ent.category || 'GENERAL'}).`,
      sector,
      subSectors: ['Global LEI Registry', ent.category || 'GENERAL'].filter(Boolean),
      country,
      region,
      hqCity,
      foundedYear,
      foundingDate: regDate,
      website: null,
      entityCategory: classifyEntityCategory({ foundedYear: foundedYear && foundedYear < 2016 ? foundedYear : 2010, description: legalForm, name: cleanName }),
      registryInfo: {
        registryName: 'Global LEI Registry (GLEIF)',
        provider: 'gleif',
        registrationNumber: lei,
        legalForm: String(legalForm),
        industryCode: ent.category || null,
        industryDescription: null,
        status: ent.status || 'ACTIVE',
        registryUrl: `https://search.gleif.org/#/record/${encodeURIComponent(lei)}`
      },
      source: {
        id: sourceId,
        title: `GLEIF Global LEI Record ${lei} - ${cleanName}`,
        publisher: 'Global Legal Entity Identifier Foundation (GLEIF)',
        url: `https://search.gleif.org/#/record/${encodeURIComponent(lei)}`,
        date: regDate || '2026-01-01',
        sourceRank: 'FILING',
        datePrecision: regDate ? 'day' : 'year',
        snippet: `${cleanName} official GLEIF LEI filing (${lei}) in ${hqCity}, ${country}.`
      }
    });
  }
  return out;
}

/**
 * Normalizes UK Companies House API items into canonical registry entity packets.
 */
export function normalizeUkCompaniesHouseItems(items = [], maxResults = 10) {
  const out = [];
  for (const item of items || []) {
    if (out.length >= maxResults) break;
    const chNum = String(item?.company_number || '').trim();
    const cleanName = String(item?.title || item?.company_name || '').trim();
    if (!chNum || !cleanName) continue;
    if (item?.company_status && item.company_status !== 'active') continue;

    const regDate = String(item?.date_of_creation || '').slice(0, 10) || null;
    const foundedYear = regDate && /^\d{4}/.test(regDate) ? Number(regDate.slice(0, 4)) : null;
    const addr = item?.address || item?.registered_office_address || {};
    const hqCity = titleCaseCity(addr?.locality || addr?.postal_town || 'London');
    const sic = Array.isArray(item?.sic_codes) ? item.sic_codes[0] || '' : '';
    const desc = String(item?.description || item?.company_type || 'UK registered company').trim();
    const sector = inferRegistrySector(sic, desc, cleanName);
    const entityCategory = classifyEntityCategory({ foundedYear, description: desc, name: cleanName, code: sic });
    const slug = chNum.toLowerCase().replace(/[^a-z0-9]/g, '');
    const sourceId = `src-reg-ch-${slug}`;

    out.push({
      id: `reg-ch-${slug}`,
      name: cleanName,
      companiesHouseNumber: chNum,
      oneLiner: `${cleanName} (UK Companies House #${chNum}, ${hqCity}).`,
      description: `${cleanName} is an active UK entity (Companies House #${chNum})${regDate ? `, incorporated ${regDate}` : ''} in ${hqCity}.`,
      sector,
      subSectors: [sic ? `SIC ${sic}` : 'UK Companies House', item?.company_type || 'ltd'].filter(Boolean),
      country: 'United Kingdom',
      region: 'UK',
      hqCity,
      foundedYear,
      foundingDate: regDate,
      website: null,
      entityCategory,
      registryInfo: {
        registryName: 'UK Companies House',
        provider: 'uk_companies_house',
        registrationNumber: chNum,
        legalForm: item?.company_type || 'ltd',
        industryCode: sic || null,
        industryDescription: desc || null,
        status: item?.company_status || 'active',
        registryUrl: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(chNum)}`
      },
      source: {
        id: sourceId,
        title: `UK Companies House #${chNum} - ${cleanName}`,
        publisher: 'UK Companies House',
        url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(chNum)}`,
        date: regDate || '2026-01-01',
        sourceRank: 'FILING',
        datePrecision: regDate ? 'day' : 'year',
        snippet: `${cleanName} active UK Companies House record #${chNum}.`
      }
    });
  }
  return out;
}

/**
 * Extracts a clean company/entity search keyword from natural-language user queries.
 */
export function extractRegistryLookupTerm(rawQuery = '') {
  let clean = String(rawQuery || '').trim();
  clean = clean
    .replace(/^(?:why not|company:|investor:|find|search|show me|tell me about|lookup)\s+/i, '')
    .replace(/\?/g, '')
    .trim();
  if (!clean || clean.length < 2) return '';
  return clean;
}

/**
 * Creates a disk-backed Hybrid Corporate Registry Client combining:
 * - Finnish PRH / YTJ Open Data v3 (no key required)
 * - Global GLEIF LEI Registry (no key required)
 * - UK Companies House REST API (when `COMPANIES_HOUSE_API_KEY` is configured)
 */
export function createRegistryClient(options = {}) {
  const cachePath = options.cachePath || options.cacheFile || DEFAULT_CACHE_PATH;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cacheStore = {};
  let cacheHits = 0;

  function loadCache() {
    try {
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (parsed && typeof parsed === 'object') cacheStore = parsed;
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

  async function cachedFetch(provider, params, buildRequest) {
    const key = makeCacheKey(provider, params);
    if (cacheStore[key]) {
      cacheHits += 1;
      return { ...cacheStore[key], fromCache: true };
    }
    const { url, headers = {}, normalize } = buildRequest();
    const raw = await fetchJsonWithTimeout(url, fetchFn, headers, timeoutMs);
    const companies = normalize(raw);
    const entry = {
      provider,
      params,
      cachedAt: new Date().toISOString(),
      companies
    };
    cacheStore[key] = entry;
    saveCache();
    return { ...entry, fromCache: false };
  }

  async function searchPrh({ name = '', mainBusinessLine = '', registrationDateStart = '', companyForm = 'OY', maxResults = 10 } = {}) {
    const sp = new URLSearchParams();
    if (name) sp.set('name', name);
    if (mainBusinessLine) sp.set('mainBusinessLine', mainBusinessLine);
    if (registrationDateStart) sp.set('registrationDateStart', registrationDateStart);
    if (companyForm) sp.set('companyForm', companyForm);
    return cachedFetch('prh_v3', { name, mainBusinessLine, registrationDateStart, companyForm, maxResults }, () => ({
      url: `${PRH_V3_BASE}?${sp.toString()}`,
      headers: { Accept: 'application/json' },
      normalize: (data) => normalizePrhCompanies(data?.companies || [], maxResults)
    }));
  }

  async function searchGleif({ query = '', countryCode = '', maxResults = 6 } = {}) {
    const cleanQ = String(query || '').trim();
    if (!cleanQ) return { provider: 'gleif', companies: [], fromCache: true };
    const sp = new URLSearchParams();
    sp.set('filter[fulltext]', cleanQ);
    sp.set('page[size]', String(Math.max(1, Math.min(20, maxResults))));
    if (countryCode) sp.set('filter[entity.legalAddress.country]', countryCode.toUpperCase());
    return cachedFetch('gleif', { query: cleanQ, countryCode, maxResults }, () => ({
      url: `${GLEIF_BASE}?${sp.toString()}`,
      headers: { Accept: 'application/vnd.api+json, application/json' },
      normalize: (data) => normalizeGleifRecords(data?.data || [], maxResults)
    }));
  }

  async function searchUkCompaniesHouse({ query = '', sicCodes = '', incorporatedFrom = '', maxResults = 8 } = {}) {
    const apiKey = options.companiesHouseApiKey ?? process.env.COMPANIES_HOUSE_API_KEY ?? '';
    if (!apiKey) {
      return { provider: 'uk_companies_house', configured: false, companies: [], fromCache: false };
    }
    const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
    if (sicCodes || incorporatedFrom) {
      const sp = new URLSearchParams({ size: String(maxResults) });
      if (sicCodes) sp.set('sic_codes', sicCodes);
      if (incorporatedFrom) sp.set('incorporated_from', incorporatedFrom);
      return cachedFetch('uk_ch_adv', { sicCodes, incorporatedFrom, maxResults }, () => ({
        url: `${UK_CH_BASE}/advanced-search/companies?${sp.toString()}`,
        headers: { Authorization: authHeader, Accept: 'application/json' },
        normalize: (data) => normalizeUkCompaniesHouseItems(data?.items || [], maxResults)
      }));
    }
    const cleanQ = String(query || '').trim();
    if (!cleanQ) return { provider: 'uk_companies_house', configured: true, companies: [], fromCache: true };
    const sp = new URLSearchParams({ q: cleanQ, items_per_page: String(maxResults) });
    return cachedFetch('uk_ch', { query: cleanQ, maxResults }, () => ({
      url: `${UK_CH_BASE}/search/companies?${sp.toString()}`,
      headers: { Authorization: authHeader, Accept: 'application/json' },
      normalize: (data) => normalizeUkCompaniesHouseItems(data?.items || [], maxResults)
    }));
  }

  /**
   * Queries external corporate registries cleanly by company name/keywords or recent startup incorporations.
   */
  async function discoverFromRegistries({
    queryText = '',
    companyQuery = '',
    country = '',
    sectors = [],
    mode = 'query',
    maxResults = 12
  } = {}) {
    const companies = [];
    const sourcesUsed = [];
    const errors = [];

    const tasks = [];
    if (mode === 'sync_recent_startups') {
      tasks.push(
        searchPrh({ name: 'AI', mainBusinessLine: '62010', companyForm: 'OY', maxResults: 6 }),
        searchPrh({ name: 'Quantum', companyForm: 'OY', maxResults: 4 }),
        searchPrh({ name: 'Robotics', companyForm: 'OY', maxResults: 4 })
      );
      if (options.companiesHouseApiKey ?? process.env.COMPANIES_HOUSE_API_KEY) {
        tasks.push(
          searchUkCompaniesHouse({ sicCodes: '62012,62020,72190', incorporatedFrom: '2025-01-01', maxResults: 8 })
        );
      }
    } else {
      const lookupTerm = extractRegistryLookupTerm(companyQuery || queryText);
      const isSimpleNameLookup =
        lookupTerm.length >= 2 &&
        lookupTerm.split(/\s+/).length <= 4 &&
        !/\b(raising soon|slush|untapped|seed|series a|founders)\b/i.test(lookupTerm);

      if (isSimpleNameLookup) {
        tasks.push(searchPrh({ name: lookupTerm, maxResults: 6 }));
        tasks.push(searchGleif({ query: lookupTerm, maxResults: 6 }));
        if (options.companiesHouseApiKey ?? process.env.COMPANIES_HOUSE_API_KEY) {
          tasks.push(searchUkCompaniesHouse({ query: lookupTerm, maxResults: 6 }));
        }
      } else {
        const wantAi = sectors.includes('AI & ML') || sectors.includes('B2B SaaS') || /\b(ai|software|saas|grid)\b/i.test(queryText);
        const wantDeep = sectors.includes('DeepTech') || /\b(deep|quantum|biotech|photonics|battery|materials)\b/i.test(queryText);
        if (wantDeep) {
          tasks.push(searchPrh({ name: 'Quantum', companyForm: 'OY', maxResults: 6 }));
        }
        if (wantAi || !wantDeep) {
          tasks.push(searchPrh({ name: 'AI', mainBusinessLine: '62010', companyForm: 'OY', maxResults: 6 }));
        }
        if (country && /^united kingdom|uk$/i.test(country) && (options.companiesHouseApiKey ?? process.env.COMPANIES_HOUSE_API_KEY)) {
          tasks.push(searchUkCompaniesHouse({ sicCodes: '62012,72190', incorporatedFrom: '2025-01-01', maxResults: 6 }));
        }
      }
    }

    const settled = await Promise.allSettled(tasks);
    const seenNames = new Set();
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        errors.push(outcome.reason?.message || 'Registry lookup error');
        continue;
      }
      const res = outcome.value;
      if (res.configured === false) continue;
      if (res.provider && !sourcesUsed.includes(res.provider)) {
        sourcesUsed.push(res.provider);
      }
      for (const comp of res.companies || []) {
        const key = comp.name.toLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        companies.push(comp);
        if (companies.length >= maxResults) break;
      }
    }

    return {
      companies,
      sourcesUsed,
      errors,
      cacheHits,
      cachedEntries: Object.keys(cacheStore).length
    };
  }

  function getCachedCompanies() {
    const out = [];
    for (const entry of Object.values(cacheStore)) {
      if (Array.isArray(entry?.companies)) {
        out.push(...entry.companies);
      }
    }
    return out;
  }

  function getStatus() {
    const activeProviders = ['Finnish PRH / YTJ v3', 'Global GLEIF LEI'];
    if (options.companiesHouseApiKey ?? process.env.COMPANIES_HOUSE_API_KEY) {
      activeProviders.push('UK Companies House');
    }
    return {
      activeProviders,
      companiesHouseConfigured: Boolean(options.companiesHouseApiKey ?? process.env.COMPANIES_HOUSE_API_KEY),
      cachedQueries: Object.keys(cacheStore).length,
      cacheHits
    };
  }

  return {
    searchPrh,
    searchGleif,
    searchUkCompaniesHouse,
    discoverFromRegistries,
    getCachedCompanies,
    getStatus
  };
}
